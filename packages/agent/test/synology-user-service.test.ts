import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const installRoot = path.resolve(import.meta.dirname, '..', 'install', 'synology');
const temporaryRoots: string[] = [];

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const reserveLoopbackPort = async () => new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      reject(new Error('Unable to reserve a loopback port'));
      return;
    }
    const { port } = address;
    server.close((error) => error ? reject(error) : resolve(port));
  });
});

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform !== 'win32')('Synology user-mode Agent service', () => {
  it('keeps all POSIX shell entry points syntax-valid', async () => {
    await execute('sh', ['-n', path.join(installRoot, 'install.sh')]);
    await execute('sh', ['-n', path.join(installRoot, 'fleet-agent-user.sh')]);
    await execute('sh', ['-n', path.join(installRoot, 'fleet-boot-stack-user.sh')]);
  });

  it('starts, detects, and stops a detached user-owned process', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-synology-control-'));
    temporaryRoots.push(root);
    await Promise.all([
      mkdir(path.join(root, 'bin'), { recursive: true }),
      mkdir(path.join(root, 'runtime', 'dist'), { recursive: true }),
      mkdir(path.join(root, 'config'), { recursive: true }),
    ]);

    const control = path.join(root, 'bin', 'fleet-agent-user');
    await cp(path.join(installRoot, 'fleet-agent-user.sh'), control);
    await cp(process.execPath, path.join(root, 'bin', 'node'));
    await chmod(control, 0o700);
    await chmod(path.join(root, 'bin', 'node'), 0o700);
    await writeFile(path.join(root, 'runtime', 'dist', 'cli.js'), `
      process.on('SIGTERM', () => process.exit(0));
      setInterval(() => {}, 1_000);
    `);
    await writeFile(path.join(root, 'config', 'core-url'), 'http://127.0.0.1:4780\n', { mode: 0o600 });
    await writeFile(path.join(root, 'config', 'role'), 'storage\n', { mode: 0o600 });

    try {
      const started = await execute(control, ['start']);
      expect(started.stdout).toContain('Fleet Agent started');
      const status = await execute(control, ['status']);
      expect(status.stdout).toContain('Fleet Agent is running');
      const stopped = await execute(control, ['stop']);
      expect(stopped.stdout).toContain('Fleet Agent stopped');
      await expect(execute(control, ['status'])).rejects.toMatchObject({ code: 3 });
    } finally {
      await execute(control, ['stop']).catch(() => undefined);
    }
  }, 15_000);

  it('supervises a protected SSH forward, starts the Agent after it, and repairs tunnel loss', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-synology-stack-'));
    temporaryRoots.push(root);
    await Promise.all([
      mkdir(path.join(root, 'bin'), { recursive: true }),
      mkdir(path.join(root, 'runtime', 'dist'), { recursive: true }),
      mkdir(path.join(root, 'config'), { recursive: true }),
    ]);

    const agentControl = path.join(root, 'bin', 'fleet-agent-user');
    const stackControl = path.join(root, 'bin', 'fleet-boot-stack-user');
    const node = path.join(root, 'bin', 'node');
    await Promise.all([
      cp(path.join(installRoot, 'fleet-agent-user.sh'), agentControl),
      cp(path.join(installRoot, 'fleet-boot-stack-user.sh'), stackControl),
      cp(process.execPath, node),
    ]);
    await Promise.all([agentControl, stackControl, node].map((file) => chmod(file, 0o700)));
    await writeFile(path.join(root, 'runtime', 'dist', 'cli.js'), `
      process.on('SIGTERM', () => process.exit(0));
      setInterval(() => {}, 1_000);
    `);
    await writeFile(path.join(root, 'config', 'core-url'), 'http://127.0.0.1:4780\n', { mode: 0o600 });
    await writeFile(path.join(root, 'config', 'role'), 'storage\n', { mode: 0o600 });

    const fakeSsh = path.join(root, 'fake-ssh');
    await writeFile(fakeSsh, `#!${process.execPath}
      const net = require('node:net');
      const index = process.argv.indexOf('-L');
      const [host, port] = process.argv[index + 1].split(':');
      const server = net.createServer((socket) => socket.end());
      server.once('error', () => process.exit(2));
      server.listen(Number(port), host);
      process.on('SIGTERM', () => server.close(() => process.exit(0)));
      setInterval(() => {}, 1_000);
    `, { mode: 0o700 });
    const identity = path.join(root, 'identity');
    const knownHosts = path.join(root, 'known-hosts');
    await writeFile(identity, 'PRIVATE-TEST-MATERIAL-MUST-NOT-PRINT\n', { mode: 0o600 });
    await writeFile(knownHosts, 'HOST-KEY-MATERIAL-MUST-NOT-PRINT\n', { mode: 0o600 });
    const localPort = await reserveLoopbackPort();

    try {
      const configured = await execute(stackControl, [
        'configure-tunnel',
        '--ssh-host', 'relay.test',
        '--ssh-user', 'fleet-tunnel',
        '--identity-file', identity,
        '--known-hosts-file', knownHosts,
        '--local-port', String(localPort),
        '--target-host', '100.64.0.10',
        '--target-port', '4780',
        '--ssh-command', fakeSsh,
        '--monitor-interval', '2',
        '--start-timeout', '5',
      ]);
      expect(configured.stdout).toContain('Protected SSH tunnel configuration saved');
      expect(configured.stdout).not.toContain('PRIVATE-TEST-MATERIAL');
      expect(configured.stdout).not.toContain('HOST-KEY-MATERIAL');
      expect((await stat(path.join(root, 'config', 'tunnel-identity'))).mode & 0o777).toBe(0o600);
      expect((await stat(path.join(root, 'config', 'tunnel-known-hosts'))).mode & 0o777).toBe(0o600);

      const started = await execute(stackControl, ['start']);
      expect(started.stdout).toContain('Fleet boot stack started');
      const initialStatus = await execute(stackControl, ['status']);
      expect(initialStatus.stdout).toContain('Boot stack monitor: running');
      expect(initialStatus.stdout).toContain('SSH tunnel: healthy');
      expect(initialStatus.stdout).toContain('Fleet Agent: running');
      expect(initialStatus.stdout).not.toContain('PRIVATE-TEST-MATERIAL');
      expect(initialStatus.stdout).not.toContain('HOST-KEY-MATERIAL');

      const originalTunnelPid = Number((await readFile(path.join(root, 'run', 'ssh-tunnel.pid'), 'utf8')).trim());
      process.kill(originalTunnelPid, 'SIGTERM');
      let repaired = false;
      for (let attempt = 0; attempt < 15; attempt += 1) {
        await delay(1_000);
        const replacement = Number((await readFile(path.join(root, 'run', 'ssh-tunnel.pid'), 'utf8').catch(() => '')).trim());
        if (replacement > 1 && replacement !== originalTunnelPid) {
          const status = await execute(stackControl, ['status']).catch(() => undefined);
          if (status?.stdout.includes('SSH tunnel: healthy') && status.stdout.includes('Fleet Agent: running')) {
            repaired = true;
            break;
          }
        }
      }
      expect(repaired).toBe(true);

      const stopped = await execute(stackControl, ['stop']);
      expect(stopped.stdout).toContain('Fleet boot stack stopped');
      await expect(execute(stackControl, ['status'])).rejects.toMatchObject({ code: 3 });
    } finally {
      await execute(stackControl, ['stop']).catch(() => undefined);
      await execute(agentControl, ['stop']).catch(() => undefined);
    }
  }, 30_000);

  it.runIf(typeof process.getuid !== 'function' || process.getuid() !== 0)('installs, consumes a protected token, and restarts on the device credential', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'fleet-synology-install-'));
    temporaryRoots.push(home);
    const bundle = path.join(home, 'bundle');
    await mkdir(path.join(bundle, 'dist'), { recursive: true });
    await mkdir(path.join(bundle, 'node_modules', 'ws'), { recursive: true });
    await writeFile(path.join(bundle, 'node_modules', 'ws', 'package.json'), '{}\n');
    await writeFile(path.join(bundle, '.fleet-agent-omit-pty'), 'fleet-agent-omit-pty-v1\n');
    await writeFile(path.join(bundle, 'dist', 'cli.js'), `
      const fs = require('node:fs');
      const path = require('node:path');
      const credential = path.join(process.env.FLEET_AGENT_DATA_DIR, 'device-credential.json');
      fs.mkdirSync(path.dirname(credential), { recursive: true });
      fs.writeFileSync(credential, '{"credential":"test"}\\n', { mode: 0o600 });
      process.on('SIGTERM', () => process.exit(0));
      setInterval(() => {}, 1_000);
    `);

    const nodeWrapper = path.join(home, 'node');
    await writeFile(nodeWrapper, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
    const token = path.join(home, 'enrollment-token');
    await writeFile(token, 'fle_test-one-use-token\n', { mode: 0o600 });

    const installer = path.join(installRoot, 'install.sh');
    const environment = { ...process.env, HOME: home };
    const installed = path.join(home, '.fleet-canvas-agent');
    const control = path.join(installed, 'bin', 'fleet-agent-user');
    const stackControl = path.join(installed, 'bin', 'fleet-boot-stack-user');
    try {
      const result = await execute(installer, [
        '--bundle', bundle,
        '--node', nodeWrapper,
        '--core-url', 'http://100.64.0.1:4780',
        '--role', 'storage',
        '--enrollment-token-file', token,
        '--enrollment-timeout', '10',
        '--headless',
      ], { env: environment });
      expect(result.stdout).toContain('Fleet Agent started');
      await expect(readFile(token, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(path.join(installed, 'config', 'enrollment-token'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(path.join(installed, 'data', 'device-credential.json'), 'utf8')).toContain('test');
      expect((await execute(control, ['status'], { env: environment })).stdout).toContain('is running');
      const stackStatus = await execute(stackControl, ['status'], { env: environment });
      expect(stackStatus.stdout).toContain('Boot stack monitor: running');
      expect(stackStatus.stdout).toContain('SSH tunnel: disabled');
    } finally {
      await execute(control, ['uninstall', '--purge'], { env: environment }).catch(() => undefined);
    }
  }, 20_000);

  it('documents protected enrollment and required DSM reboot persistence', async () => {
    const [installer, documentation] = await Promise.all([
      readFile(path.join(installRoot, 'install.sh'), 'utf8'),
      readFile(path.join(installRoot, 'README.md'), 'utf8'),
    ]);
    expect(installer).toContain('entry.mode & 0o077');
    expect(installer).toContain('rm -f "$TOKEN_FILE"');
    expect(installer).toContain('rm -f "$CONFIG_DIR/enrollment-token"');
    expect(documentation).toContain('DSM Task Scheduler is required');
    expect(documentation).toContain('same DSM user');
    expect(documentation).toContain('--omit-pty');
    expect(documentation).toContain('configure-tunnel');
    expect(documentation).toContain('fleet-boot-stack-user');
  });
});
