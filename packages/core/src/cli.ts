#!/usr/bin/env node
import { startFleetCore, type FleetCoreOptions } from './server.js';

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { process.stdout.write(HELP); return; }
  const core = await startFleetCore(options.core);
  process.stdout.write(`[fleet-core] Listening at ${core.url}\n`);
  if (core.recoveryTokenPath) process.stdout.write(`[fleet-core] Local recovery credential: ${core.recoveryTokenPath}\n`);
  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`[fleet-core] Received ${signal}; shutting down.\n`);
    await core.close();
  };
  process.once('SIGINT', () => void stop('SIGINT').then(() => process.exit(0)));
  process.once('SIGTERM', () => void stop('SIGTERM').then(() => process.exit(0)));
}

export function parseArguments(args: string[]): { help: boolean; core: FleetCoreOptions } {
  const core: FleetCoreOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (argument === '-h' || argument === '--help') return { help: true, core };
    if (argument === '--allow-unauthenticated-loopback') { core.allowUnauthenticatedLoopback = true; continue; }
    if (argument === '--readme-demo') { core.readmeDemo = true; continue; }
    const equal = argument.indexOf('=');
    const flag = equal === -1 ? argument : argument.slice(0, equal);
    const value = equal === -1 ? args[++index] : argument.slice(equal + 1);
    if (!value) throw new Error(`Missing value for ${flag}.`);
    if (flag === '--host') core.host = value;
    else if (flag === '--port') core.port = Number.parseInt(value, 10);
    else if (flag === '--token') core.token = value;
    else if (flag === '--data-dir') core.dataDir = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  return { help: false, core };
}

const HELP = `Orchestra Core

Usage: fleet-core [options]

Options:
  --host <address>   Listen address (default: 127.0.0.1)
  --port <number>    Listen port (default: 4780)
  --token <token>    Shared Fleet token (prefer FLEET_TOKEN)
  --data-dir <path>  Persistent control-plane state directory
  --allow-unauthenticated-loopback  Development only; bypass auth for local requests
  --readme-demo       Seed a synthetic documentation-only Orchestra System transcript
  -h, --help         Show this help
`;

void main().catch((error) => {
  process.stderr.write(`[fleet-core] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
