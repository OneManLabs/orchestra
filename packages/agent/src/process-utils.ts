import { spawn } from 'node:child_process';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export async function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      finish({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: null });
    }, options.timeoutMs ?? 5_000);
    timeout.unref();

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', rejectOnce);
    child.once('close', (exitCode) => finish({
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      exitCode,
    }));

    function finish(result: CommandResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    }

    function rejectOnce(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    }
  });
}

export async function commandExists(command: string, args = ['--version']): Promise<boolean> {
  try {
    const result = await runCommand(command, args, { timeoutMs: 3_000 });
    return result.exitCode === 0;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT' ? false : false;
  }
}

export function shellInvocation(command: string, configuredShell?: string): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    const shell = configuredShell ?? process.env.ComSpec ?? 'powershell.exe';
    const base = shell.toLowerCase().includes('powershell') || shell.toLowerCase().includes('pwsh')
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']
      : ['/d', '/s', '/c'];
    return { shell, args: [...base, command] };
  }
  const shell = configuredShell ?? process.env.SHELL ?? '/bin/sh';
  return { shell, args: ['-lc', command] };
}
