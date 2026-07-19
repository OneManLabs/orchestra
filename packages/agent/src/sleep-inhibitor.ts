import { spawn, type ChildProcess } from 'node:child_process';
import type { FleetLogger } from './logger.js';

export class SleepInhibitor {
  private references = 0;
  private child?: ChildProcess;

  constructor(private readonly enabled: boolean, private readonly logger: FleetLogger) {}

  acquire(): void {
    if (!this.enabled) return;
    this.references += 1;
    if (this.references > 1 || this.child) return;
    const invocation = inhibitorInvocation();
    if (!invocation) {
      this.logger.warn(`Sleep inhibition is not supported on ${process.platform}.`);
      return;
    }
    const child = spawn(invocation.command, invocation.args, { stdio: 'ignore', windowsHide: true });
    this.child = child;
    child.once('error', (error) => {
      if (this.child === child) this.child = undefined;
      this.logger.warn('Unable to start the sleep inhibitor.', error.message);
    });
    child.once('exit', () => {
      if (this.child === child) this.child = undefined;
    });
  }

  release(): void {
    if (!this.enabled) return;
    this.references = Math.max(0, this.references - 1);
    if (this.references === 0) this.stopChild();
  }

  shutdown(): void {
    this.references = 0;
    this.stopChild();
  }

  private stopChild(): void {
    if (!this.child) return;
    this.child.kill('SIGTERM');
    this.child = undefined;
  }
}

export function inhibitorInvocation(): { command: string; args: string[] } | undefined {
  if (process.platform === 'darwin') return { command: '/usr/bin/caffeinate', args: ['-dimsu'] };
  if (process.platform === 'linux') return { command: 'systemd-inhibit', args: ['--what=sleep', '--mode=block', '--why=Fleet Canvas job running', 'sleep', 'infinity'] };
  if (process.platform === 'win32') {
    const script = '$sig="[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);"; Add-Type -MemberDefinition $sig -Name Native -Namespace Fleet; [Fleet.Native]::SetThreadExecutionState(0x80000003) | Out-Null; while ($true) { Start-Sleep -Seconds 30 }';
    return { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script] };
  }
  return undefined;
}
