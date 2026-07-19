import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { isIPv4 } from 'node:net';
import type { DevicePowerAction } from '@fleet/shared';

export interface PowerCommand {
  command: string;
  args: string[];
}

export class PowerController {
  constructor(private readonly allowPowerActions: boolean, private readonly wolPort: number) {}

  async perform(input: { action: DevicePowerAction; macAddress?: string; broadcastAddress?: string; force?: boolean }): Promise<unknown> {
    if (input.action === 'wake') {
      if (!input.macAddress) throw new Error('Wake-on-LAN requires a MAC address.');
      const broadcastAddress = input.broadcastAddress ?? '255.255.255.255';
      await sendWakeOnLan(input.macAddress, broadcastAddress, this.wolPort);
      return { action: 'wake', macAddress: normalizeMacAddress(input.macAddress), broadcastAddress, port: this.wolPort, sent: true };
    }
    if (!this.allowPowerActions) {
      throw new Error(`Power action "${input.action}" is disabled. Set FLEET_ALLOW_POWER_ACTIONS=true on the agent to enable it.`);
    }
    const plan = powerCommand(input.action, Boolean(input.force));
    const scheduledAt = new Date(Date.now() + 750).toISOString();
    const timer = setTimeout(() => {
      const child = spawn(plan.command, plan.args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', () => {});
      child.unref();
    }, 750);
    timer.unref();
    return { action: input.action, scheduled: true, scheduledAt };
  }
}

export async function sendWakeOnLan(macAddress: string, broadcastAddress: string, port = 9): Promise<void> {
  if (!isIPv4(broadcastAddress)) throw new Error('Wake-on-LAN broadcast address must be IPv4.');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Wake-on-LAN port is invalid.');
  const packet = buildMagicPacket(macAddress);
  await new Promise<void>((resolve, reject) => {
    const socket = createSocket('udp4');
    socket.once('error', (error) => { socket.close(); reject(error); });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, port, broadcastAddress, (error) => {
        socket.close();
        if (error) reject(error); else resolve();
      });
    });
  });
}

export function buildMagicPacket(macAddress: string): Buffer {
  const mac = Buffer.from(normalizeMacAddress(macAddress).split(':').map((part) => Number.parseInt(part, 16)));
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => mac)]);
}

export function normalizeMacAddress(value: string): string {
  const compact = value.trim().replace(/[:-]/g, '').toLowerCase();
  if (!/^[a-f0-9]{12}$/.test(compact)) throw new Error('Invalid Wake-on-LAN MAC address.');
  return compact.match(/.{2}/g)?.join(':') ?? compact;
}

export function powerCommand(action: Exclude<DevicePowerAction, 'wake'>, force: boolean): PowerCommand {
  if (process.platform === 'win32') {
    switch (action) {
      case 'sleep': return { command: 'rundll32.exe', args: ['powrprof.dll,SetSuspendState', '0,1,0'] };
      case 'restart': return { command: 'shutdown.exe', args: ['/r', '/t', '0', ...(force ? ['/f'] : [])] };
      case 'shutdown': return { command: 'shutdown.exe', args: ['/s', '/t', '0', ...(force ? ['/f'] : [])] };
      case 'lock': return { command: 'rundll32.exe', args: ['user32.dll,LockWorkStation'] };
      case 'logout': return { command: 'shutdown.exe', args: ['/l', ...(force ? ['/f'] : [])] };
    }
  }
  if (process.platform === 'darwin') {
    switch (action) {
      case 'sleep': return { command: '/usr/bin/pmset', args: ['sleepnow'] };
      case 'restart': return { command: '/sbin/shutdown', args: ['-r', 'now'] };
      case 'shutdown': return { command: '/sbin/shutdown', args: ['-h', 'now'] };
      case 'lock': return { command: '/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession', args: ['-suspend'] };
      case 'logout': return { command: '/usr/bin/osascript', args: ['-e', 'tell application "System Events" to log out'] };
    }
  }
  switch (action) {
    case 'sleep': return { command: 'systemctl', args: ['suspend'] };
    case 'restart': return { command: 'systemctl', args: ['reboot', ...(force ? ['--force'] : [])] };
    case 'shutdown': return { command: 'systemctl', args: ['poweroff', ...(force ? ['--force'] : [])] };
    case 'lock': return { command: 'loginctl', args: ['lock-session'] };
    case 'logout': {
      const user = process.env.USER ?? process.env.LOGNAME;
      if (!user) throw new Error('Unable to determine the current user for logout.');
      return { command: 'loginctl', args: ['terminate-user', user] };
    }
  }
}
