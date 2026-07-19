import { access, constants as fsConstants } from 'node:fs';
import { stat, statfs } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import os from 'node:os';
import path from 'node:path';
import type { ResolvedFleetAgentOptions } from './config.js';
import { detectCodexReadiness, type CodexReadiness } from './capabilities.js';
import { AGENT_VERSION, PROTOCOL_VERSION } from './constants.js';
import { discoverRemoteDesktopAdapters } from './remote-desktop.js';
import { getTailscaleIdentity } from './tailscale.js';

interface DiagnosticCheck {
  name: string;
  status: 'pass' | 'warning' | 'fail';
  detail: string;
  remediation?: string;
}

export class DiagnosticRunner {
  constructor(private readonly options: ResolvedFleetAgentOptions) {}

  async run(kind: 'agent' | 'network' | 'storage' | 'compatibility', redact: boolean): Promise<unknown> {
    const checks = await this.checks(kind, redact);
    return {
      kind,
      state: checks.some((check) => check.status === 'fail') ? 'failed' : 'succeeded',
      redacted: redact,
      generatedAt: new Date().toISOString(),
      agentVersion: AGENT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      platform: `${process.platform}/${process.arch}`,
      checks,
    };
  }

  private async checks(kind: 'agent' | 'network' | 'storage' | 'compatibility', redact: boolean): Promise<DiagnosticCheck[]> {
    switch (kind) {
      case 'agent': return this.agentChecks(redact);
      case 'network': return this.networkChecks(redact);
      case 'storage': return this.storageChecks(redact);
      case 'compatibility': return this.compatibilityChecks();
    }
  }

  private async agentChecks(redact: boolean): Promise<DiagnosticCheck[]> {
    const checks: DiagnosticCheck[] = [
      { name: 'runtime', status: 'pass', detail: `Fleet Agent ${AGENT_VERSION}, protocol ${PROTOCOL_VERSION}, Node ${process.version}.` },
      { name: 'power-safety', status: this.options.allowPowerActions ? 'warning' : 'pass', detail: this.options.allowPowerActions ? 'Dangerous power actions are explicitly enabled.' : 'Dangerous power actions are disabled.' },
      { name: 'sleep-inhibition', status: 'pass', detail: this.options.preventSleepDuringJobs ? 'Sleep inhibition is enabled while jobs run.' : 'Sleep inhibition is disabled.' },
    ];
    checks.push(await writableCheck('agent-state', this.options.dataDir, redact));
    try {
      const credential = await stat(this.options.credentialFile);
      const mode = credential.mode & 0o777;
      checks.push({
        name: 'device-credential',
        status: process.platform === 'win32' || mode === 0o600 ? 'pass' : 'warning',
        detail: redact ? `Credential file exists with mode ${mode.toString(8)}.` : `${this.options.credentialFile} exists with mode ${mode.toString(8)}.`,
        ...(process.platform !== 'win32' && mode !== 0o600 ? { remediation: 'Set the credential file mode to 0600.' } : {}),
      });
    } catch {
      checks.push({ name: 'device-credential', status: this.options.enrollmentToken || this.options.token ? 'warning' : 'fail', detail: 'No persisted device credential was found.', remediation: 'Enroll the device with FLEET_ENROLLMENT_TOKEN.' });
    }
    return checks;
  }

  private async networkChecks(redact: boolean): Promise<DiagnosticCheck[]> {
    const url = new URL(this.options.coreUrl);
    const checks: DiagnosticCheck[] = [];
    try {
      const result = await lookup(url.hostname);
      checks.push({ name: 'core-dns', status: 'pass', detail: redact ? 'Fleet Core hostname resolves.' : `${url.hostname} resolves to ${result.address}.` });
    } catch (error) {
      checks.push({ name: 'core-dns', status: 'fail', detail: `Fleet Core hostname did not resolve: ${(error as Error).message}`, remediation: 'Check DNS, MagicDNS, and FLEET_CORE_URL.' });
    }
    const tailscale = await getTailscaleIdentity();
    checks.push({
      name: 'tailscale',
      status: tailscale.ip || tailscale.dnsName ? 'pass' : 'warning',
      detail: tailscale.ip || tailscale.dnsName
        ? redact ? 'Tailscale identity is available.' : `Tailscale identity: ${tailscale.dnsName ?? tailscale.ip}.`
        : 'No active Tailscale identity was detected.',
      ...(!tailscale.ip && !tailscale.dnsName ? { remediation: 'Start Tailscale and authenticate this device.' } : {}),
    });
    const externalInterfaces = Object.values(os.networkInterfaces()).flatMap((entries) => entries ?? []).filter((entry) => !entry.internal);
    checks.push({ name: 'network-interfaces', status: externalInterfaces.length ? 'pass' : 'fail', detail: `${externalInterfaces.length} external interface address(es) detected.` });
    return checks;
  }

  private async storageChecks(redact: boolean): Promise<DiagnosticCheck[]> {
    return Promise.all(this.options.projectRoots.map(async (root, index) => {
      try {
        const filesystem = await statfs(root);
        const availableBytes = filesystem.bavail * filesystem.bsize;
        const totalBytes = filesystem.blocks * filesystem.bsize;
        const writable = await isWritable(root);
        const percentFree = totalBytes ? availableBytes / totalBytes * 100 : 0;
        return {
          name: `project-root-${index + 1}`,
          status: !writable ? 'warning' : percentFree < 5 ? 'fail' : percentFree < 10 ? 'warning' : 'pass',
          detail: `${redact ? `Project root ${index + 1}` : root}: ${(availableBytes / 1024 ** 3).toFixed(1)} GiB free (${percentFree.toFixed(1)}%), ${writable ? 'writable' : 'read-only'}.`,
          ...(percentFree < 10 ? { remediation: 'Free storage space before starting large jobs or transfers.' } : {}),
        } satisfies DiagnosticCheck;
      } catch (error) {
        return { name: `project-root-${index + 1}`, status: 'fail', detail: `${redact ? 'Project root' : root} is unavailable: ${(error as Error).message}`, remediation: 'Mount or recreate the configured project root.' } satisfies DiagnosticCheck;
      }
    }));
  }

  private async compatibilityChecks(): Promise<DiagnosticCheck[]> {
    const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    const [codex, adapters] = await Promise.all([detectCodexReadiness(this.options.codexCommand), discoverRemoteDesktopAdapters()]);
    return [
      { name: 'node-version', status: nodeMajor >= 22 ? 'pass' : 'fail', detail: `Node ${process.versions.node} is installed.`, ...(nodeMajor < 22 ? { remediation: 'Install Node.js 22 or newer.' } : {}) },
      { name: 'operating-system', status: ['darwin', 'win32', 'linux'].includes(process.platform) ? 'pass' : 'warning', detail: `${os.type()} ${os.release()} on ${process.arch}.` },
      codexCliDiagnostic(codex),
      codexAuthenticationDiagnostic(codex),
      { name: 'remote-desktop', status: adapters.some((adapter) => adapter.available) ? 'pass' : 'warning', detail: `${adapters.filter((adapter) => adapter.available).map((adapter) => adapter.name).join(', ') || 'No remote desktop adapters'} detected.` },
    ];
  }
}

export function codexCliDiagnostic(codex: CodexReadiness): DiagnosticCheck {
  return {
    name: 'codex-cli',
    status: codex.installed ? 'pass' : 'warning',
    detail: codex.installed ? 'Codex CLI is installed.' : 'Codex CLI is unavailable.',
    ...(!codex.installed ? { remediation: 'Install Codex CLI to enable Codex sessions and jobs.' } : {}),
  };
}

export function codexAuthenticationDiagnostic(codex: CodexReadiness): DiagnosticCheck {
  if (codex.authenticated) return { name: 'codex-authentication', status: 'pass', detail: 'Codex CLI is authenticated and ready for sessions and jobs.' };
  const detail = codex.reason === 'status-timeout'
    ? 'Codex CLI authentication status timed out.'
    : codex.reason === 'status-error'
      ? 'Codex CLI authentication status could not be checked.'
      : codex.installed
        ? 'Codex CLI is installed but not authenticated.'
        : 'Codex authentication cannot be checked until the CLI is installed.';
  return {
    name: 'codex-authentication',
    status: 'warning',
    detail,
    remediation: codex.installed ? 'Run codex login on this device.' : 'Install Codex CLI, then run codex login on this device.',
  };
}

async function writableCheck(name: string, target: string, redact: boolean): Promise<DiagnosticCheck> {
  const writable = await isWritable(target);
  return {
    name,
    status: writable ? 'pass' : 'fail',
    detail: `${redact ? path.basename(target) : target} is ${writable ? 'writable' : 'not writable'}.`,
    ...(!writable ? { remediation: 'Correct directory ownership and permissions.' } : {}),
  };
}

async function isWritable(target: string): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => access(target, fsConstants.W_OK, (error) => error ? reject(error) : resolve()));
    return true;
  } catch {
    return false;
  }
}
