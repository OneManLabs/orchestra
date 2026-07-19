import os from 'node:os';
import type { DeviceCapabilities } from '@fleet/shared';
import { commandExists, runCommand } from './process-utils.js';
import { isTailscaleInstalled } from './tailscale.js';

export interface CodexReadiness {
  installed: boolean;
  authenticated: boolean;
  reason: 'ready' | 'not-installed' | 'not-authenticated' | 'status-timeout' | 'status-error';
}

type CommandRunner = typeof runCommand;

export async function detectCapabilities(codexCommand = 'codex', configuredShell?: string): Promise<DeviceCapabilities> {
  const [codex, git, docker, tailscale, nvidia, mlx, wakeOnLan] = await Promise.all([
    detectCodexReadiness(codexCommand),
    commandExists('git'),
    commandExists('docker'),
    isTailscaleInstalled(),
    commandExists('nvidia-smi'),
    detectMlx(),
    detectWakeOnLan(),
  ]);
  const shell = configuredShell ?? defaultInteractiveShell();
  const labels = [
    `os:${normalizePlatform(process.platform)}`,
    `arch:${process.arch}`,
    `memory:${Math.max(1, Math.round(os.totalmem() / 1024 ** 3))}gb`,
    'node:true',
    ...codexCapabilityLabels(codex),
    ...(git ? ['git:true'] : []),
    ...(docker ? ['docker:true'] : []),
    ...(tailscale ? ['tailscale:true'] : []),
    ...(nvidia ? ['gpu:nvidia', 'cuda:true'] : []),
    ...(mlx ? ['mlx:true'] : []),
  ];

  return {
    // `codex` means Fleet can start work now, not merely that a binary was
    // found. Binary presence remains available through `codex:installed`.
    codex: codex.authenticated,
    git,
    docker,
    tailscale,
    cuda: nvidia,
    mlx,
    node: true,
    wakeOnLan,
    shell,
    labels,
  };
}

/**
 * Probe only local CLI state. `codex login status` reads the configured local
 * credential state and does not make an API request, so capability discovery
 * remains deterministic even when the device cannot reach the internet.
 */
export async function detectCodexReadiness(
  codexCommand = 'codex',
  runner: CommandRunner = runCommand,
): Promise<CodexReadiness> {
  try {
    const version = await runner(codexCommand, ['--version'], { timeoutMs: 3_000 });
    if (version.exitCode !== 0) return { installed: false, authenticated: false, reason: 'not-installed' };
  } catch {
    return { installed: false, authenticated: false, reason: 'not-installed' };
  }

  try {
    const status = await runner(codexCommand, ['login', 'status'], { timeoutMs: 3_000 });
    if (status.exitCode === 0) return { installed: true, authenticated: true, reason: 'ready' };
    if (status.exitCode === null) return { installed: true, authenticated: false, reason: 'status-timeout' };
    return { installed: true, authenticated: false, reason: 'not-authenticated' };
  } catch {
    return { installed: true, authenticated: false, reason: 'status-error' };
  }
}

export function codexCapabilityLabels(readiness: CodexReadiness): string[] {
  return [
    ...(readiness.installed ? ['codex:installed'] : []),
    ...(readiness.authenticated ? ['codex:authenticated', 'codex:ready', 'codex:true'] : []),
  ];
}

export function defaultInteractiveShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec ?? 'powershell.exe';
  return process.env.SHELL ?? '/bin/sh';
}

async function detectMlx(): Promise<boolean> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return false;
  for (const python of ['python3', 'python']) {
    try {
      const result = await runCommand(python, ['-c', 'import importlib.util; raise SystemExit(0 if importlib.util.find_spec("mlx") else 1)']);
      if (result.exitCode === 0) return true;
    } catch {
      // Try the next available Python executable.
    }
  }
  return false;
}

async function detectWakeOnLan(): Promise<boolean> {
  for (const command of process.platform === 'win32' ? ['wol.exe', 'WakeMeOnLan.exe'] : ['wakeonlan', 'etherwake']) {
    try {
      await runCommand(command, ['--help'], { timeoutMs: 2_000 });
      return true;
    } catch {
      // Continue through known utilities.
    }
  }
  return false;
}

function normalizePlatform(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return platform;
}
