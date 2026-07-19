#!/usr/bin/env node
import { parseRole, type FleetAgentOptions } from './config.js';
import { startFleetAgent } from './fleet-agent.js';

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const agent = await startFleetAgent(options.agent);
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`[fleet-agent] Received ${signal}; shutting down.\n`);
    await agent.stop();
  };
  process.once('SIGINT', () => void shutdown('SIGINT').then(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown('SIGTERM').then(() => process.exit(0)));
}

interface ParsedArguments {
  help: boolean;
  agent: FleetAgentOptions;
}

export function parseArguments(args: string[]): ParsedArguments {
  const options: FleetAgentOptions = {};
  const roots: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (argument === '--help' || argument === '-h') return { help: true, agent: options };
    const [flag, inlineValue] = splitArgument(argument);
    if (flag === '--allow-power-actions') { options.allowPowerActions = true; continue; }
    if (flag === '--prevent-sleep-during-jobs') { options.preventSleepDuringJobs = true; continue; }
    if (flag === '--no-prevent-sleep-during-jobs') { options.preventSleepDuringJobs = false; continue; }
    if (flag === '--require-signed-updates') { options.requireSignedUpdates = true; continue; }
    if (flag === '--allow-unsigned-development-updates') { options.requireSignedUpdates = false; continue; }
    const value = inlineValue ?? args[++index];
    if (!value) throw new Error(`Missing value for ${flag}.`);
    switch (flag) {
      case '--core':
      case '--core-url': options.coreUrl = value; break;
      case '--token': options.token = value; break;
      case '--enrollment-token': options.enrollmentToken = value; break;
      case '--credential-file': options.credentialFile = value; break;
      case '--name': options.deviceName = value; break;
      case '--id': options.deviceId = value; break;
      case '--role': options.role = parseRole(value); break;
      case '--project-root': roots.push(value); break;
      case '--heartbeat': options.heartbeatIntervalMs = parseInteger(value, flag); break;
      case '--data-dir': options.dataDir = value; break;
      case '--shell': options.shell = value; break;
      case '--codex-command': options.codexCommand = value; break;
      case '--update-public-key': options.updatePublicKey = value; break;
      case '--max-file-chunk-bytes': options.maxFileChunkBytes = parseInteger(value, flag); break;
      case '--max-update-bytes': options.maxUpdateBytes = parseInteger(value, flag); break;
      case '--wol-port': options.wolPort = parseInteger(value, flag); break;
      default: throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (roots.length) options.projectRoots = roots;
  return { help: false, agent: options };
}

function splitArgument(argument: string): [string, string | undefined] {
  const equals = argument.indexOf('=');
  return equals === -1 ? [argument, undefined] : [argument.slice(0, equals), argument.slice(equals + 1)];
}

function parseInteger(value: string, flag: string): number {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${flag} requires a positive integer.`);
  return number;
}

const HELP = `Orchestra Agent

Usage: fleet-agent [options]

Options:
  --core, --core-url <url>   Orchestra Core URL (default: http://127.0.0.1:4780)
  --token <token>            Shared Fleet token (prefer FLEET_TOKEN)
  --enrollment-token <token> One-time enrollment token for first install
  --credential-file <path>  Persisted per-device credential path
  --name <name>              Friendly device name
  --id <id>                  Override the persistent device ID
  --role <role>              core|gpu|worker|gateway|storage|workstation|phone|unknown
  --project-root <path>      Allowed project root; may be repeated
  --heartbeat <ms>           Metrics interval in milliseconds
  --data-dir <path>          Persistent agent state directory
  --shell <path>             Interactive and job shell
  --codex-command <path>     Codex CLI executable (default: codex)
  --allow-power-actions      Enable sleep/restart/shutdown/lock/logout
  --prevent-sleep-during-jobs Keep the machine awake while jobs are active
  --no-prevent-sleep-during-jobs Disable job sleep inhibition
  --update-public-key <pem-or-path> Ed25519 public key used to verify update digests
  --require-signed-updates   Require verified signatures for every channel (default)
  --allow-unsigned-development-updates Allow checksum-only development releases
  --max-file-chunk-bytes <n> Maximum file read/write chunk size
  --max-update-bytes <n>     Maximum staged update download size
  --wol-port <port>          Wake-on-LAN UDP port (default: 9)
  -h, --help                 Show this help

Environment:
  FLEET_TOKEN, FLEET_CORE_URL, FLEET_DEVICE_NAME, FLEET_DEVICE_ROLE,
  FLEET_PROJECT_ROOTS, FLEET_AGENT_DATA_DIR, FLEET_HEARTBEAT_INTERVAL_MS,
  FLEET_ENROLLMENT_TOKEN, FLEET_ALLOW_POWER_ACTIONS,
  FLEET_PREVENT_SLEEP_DURING_JOBS, FLEET_UPDATE_PUBLIC_KEY,
  FLEET_REQUIRE_SIGNED_UPDATES
`;

void main().catch((error) => {
  process.stderr.write(`[fleet-agent] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
