import { describe, expect, it } from 'vitest';
import { PowerController, buildMagicPacket, normalizeMacAddress } from '../src/power-controller.js';

describe('power safety', () => {
  it('constructs a standards-compliant Wake-on-LAN packet', () => {
    const packet = buildMagicPacket('00-11-22-33-44-55');
    expect(packet).toHaveLength(102);
    expect(packet.subarray(0, 6)).toEqual(Buffer.alloc(6, 0xff));
    expect(packet.subarray(6, 12).toString('hex')).toBe('001122334455');
    expect(normalizeMacAddress('00:11:22:33:44:55')).toBe('00:11:22:33:44:55');
  });

  it('never schedules a dangerous action without the explicit local gate', async () => {
    const controller = new PowerController(false, 9);
    await expect(controller.perform({ action: 'restart' })).rejects.toThrow(/FLEET_ALLOW_POWER_ACTIONS/);
  });
});
