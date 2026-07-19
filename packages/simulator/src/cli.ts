#!/usr/bin/env node
import { FleetSimulator, type SimulatorOptions } from './simulator.js';

const options: SimulatorOptions = {
  coreUrl: process.env.FLEET_CORE_URL ?? 'http://127.0.0.1:4780',
  token: process.env.FLEET_TOKEN ?? '',
  count: 5,
  intervalMs: 5_000,
  latencyMs: 100,
  failureRate: 0,
  prefix: 'virtual-device',
  codexUi: false,
};

for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index];
  if (flag === '--help') {
    process.stdout.write('Usage: fleet-simulator [--core URL] [--count N] [--interval MS] [--latency MS] [--failure-rate 0..1] [--prefix LABEL] [--codex-ui]\nUse FLEET_TOKEN instead of --token when possible. --codex-ui is presentation-only and never launches Codex.\n');
    process.exit(0);
  }
  if (flag === '--codex-ui') { options.codexUi = true; continue; }
  const value = process.argv[++index];
  if (!value) throw new Error(`Missing value for ${flag}.`);
  if (flag === '--core') options.coreUrl = value;
  else if (flag === '--token') options.token = value;
  else if (flag === '--count') options.count = Number(value);
  else if (flag === '--interval') options.intervalMs = Number(value);
  else if (flag === '--latency') options.latencyMs = Number(value);
  else if (flag === '--failure-rate') options.failureRate = Number(value);
  else if (flag === '--prefix') options.prefix = value;
  else throw new Error(`Unknown option: ${flag}`);
}

const simulator = new FleetSimulator(options);
simulator.start();
process.stdout.write(`[fleet-simulator] ${options.count} virtual development devices targeting ${options.coreUrl}\n`);
const stop = async (): Promise<void> => { await simulator.stop(); process.exit(0); };
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
