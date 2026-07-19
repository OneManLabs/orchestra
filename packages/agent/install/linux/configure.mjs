#!/usr/bin/node
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, chown, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const jsonMappings = {
  coreUrl: 'FLEET_CORE_URL',
  role: 'FLEET_DEVICE_ROLE',
  deviceName: 'FLEET_DEVICE_NAME',
  dataDir: 'FLEET_AGENT_DATA_DIR',
  credentialFile: 'FLEET_CREDENTIAL_FILE',
  projectRoots: 'FLEET_PROJECT_ROOTS',
  enrollmentToken: 'FLEET_ENROLLMENT_TOKEN',
  token: 'FLEET_TOKEN',
  allowPowerActions: 'FLEET_ALLOW_POWER_ACTIONS',
  preventSleepDuringJobs: 'FLEET_PREVENT_SLEEP_DURING_JOBS',
  updatePublicKey: 'FLEET_UPDATE_PUBLIC_KEY',
  requireSignedUpdates: 'FLEET_REQUIRE_SIGNED_UPDATES',
};
const allowedEnvironment = Object.fromEntries(Object.values(jsonMappings).map((name) => [name, true]));

const argumentsList = process.argv.slice(2);
if (argumentsList.includes('--help')) {
  process.stdout.write(`Usage: fleet-agent-configure [options]

  --config-file PATH          Root-owned 0600 JSON configuration
  --core-url URL              Fleet Core URL
  --role ROLE                 Device role
  --device-name NAME          Device display name
  --project-roots PATHS       Colon/comma-separated project roots
  --enrollment-token-file P   Root-owned one-line enrollment token
  --token-file PATH           Root-owned one-line static token
  --update-public-key KEY     Signed-update public key
  --service-group GROUP       Service group (default: fleet-agent)
  --allow-power-actions       Permit power commands
  --prevent-sleep             Inhibit sleep while jobs run
  --allow-unsigned-updates    Development only
  --remove-enrollment-token   Remove the consumed enrollment token
  --consume-inputs            Delete config/token inputs after success
  --restart                   Restart fleet-canvas-agent.service
`);
  process.exit(0);
}
if (process.getuid?.() !== 0) throw new Error('Run fleet-agent-configure as root.');

const options = parseArguments(argumentsList);
const serviceGroup = options.serviceGroup ?? 'fleet-agent';
if (!/^[a-z_][a-z0-9_-]*$/.test(serviceGroup)) throw new Error(`Invalid service group: ${serviceGroup}`);
const output = '/etc/fleet-canvas/agent.env';
const config = await readExisting(output);
Object.assign(config, {
  FLEET_CORE_URL: config.FLEET_CORE_URL ?? 'http://127.0.0.1:4780',
  FLEET_DEVICE_ROLE: config.FLEET_DEVICE_ROLE ?? 'worker',
  FLEET_AGENT_DATA_DIR: config.FLEET_AGENT_DATA_DIR ?? '/var/lib/fleet-canvas-agent',
  FLEET_REQUIRE_SIGNED_UPDATES: config.FLEET_REQUIRE_SIGNED_UPDATES ?? 'true',
});

const consumed = [];
if (options.configFile) {
  if (path.resolve(options.configFile) === output) throw new Error('Config file must be a separate preseed, not the installed environment file.');
  await assertSecretFile(options.configFile);
  const incoming = JSON.parse(await readFile(options.configFile, 'utf8'));
  applyJson(config, incoming);
  consumed.push(options.configFile);
}
if (options.coreUrl) config.FLEET_CORE_URL = validateCoreUrl(options.coreUrl);
if (options.role) config.FLEET_DEVICE_ROLE = validateRole(options.role);
if (options.deviceName) config.FLEET_DEVICE_NAME = validateLine(options.deviceName, 'device name');
if (options.projectRoots) config.FLEET_PROJECT_ROOTS = validateLine(options.projectRoots, 'project roots');
if (options.updatePublicKey) config.FLEET_UPDATE_PUBLIC_KEY = validateLine(options.updatePublicKey, 'update public key');
if (options.enrollmentTokenFile) {
  config.FLEET_ENROLLMENT_TOKEN = await readSecret(options.enrollmentTokenFile);
  consumed.push(options.enrollmentTokenFile);
}
if (options.tokenFile) {
  config.FLEET_TOKEN = await readSecret(options.tokenFile);
  consumed.push(options.tokenFile);
}
if (options.allowPowerActions) config.FLEET_ALLOW_POWER_ACTIONS = 'true';
if (options.preventSleep) config.FLEET_PREVENT_SLEEP_DURING_JOBS = 'true';
if (options.allowUnsignedUpdates) config.FLEET_REQUIRE_SIGNED_UPDATES = 'false';
if (options.removeEnrollmentToken) delete config.FLEET_ENROLLMENT_TOKEN;

validateCoreUrl(config.FLEET_CORE_URL);
validateRole(config.FLEET_DEVICE_ROLE);
for (const [name, value] of Object.entries(config)) validateLine(value, name);

const groupId = lookupGroupId(serviceGroup);
await mkdir(path.dirname(output), { recursive: true, mode: 0o750 });
const outputDirectory = await lstat(path.dirname(output));
if (!outputDirectory.isDirectory() || outputDirectory.isSymbolicLink()) throw new Error('Fleet configuration directory must be a regular directory.');
await chown(path.dirname(output), 0, groupId);
await chmod(path.dirname(output), 0o750);
const temporary = `${output}.${process.pid}.${Date.now()}.tmp`;
const contents = `${Object.entries(config).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => `${name}=${quoteEnvironment(value)}`).join('\n')}\n`;
await writeFile(temporary, contents, { mode: 0o640, flag: 'wx' });
await chmod(temporary, 0o640);
await chown(temporary, 0, groupId);
await rename(temporary, output);

if (options.consumeInputs) {
  for (const file of new Set(consumed)) await rm(file, { force: true });
}
if (options.restart) run('/bin/systemctl', ['restart', 'fleet-canvas-agent.service']);
process.stdout.write(`Fleet Agent configuration written to ${output}\n`);

function parseArguments(values) {
  const parsed = {};
  const take = (index, name) => {
    const value = values[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    return value;
  };
  for (let index = 0; index < values.length; index += 1) {
    switch (values[index]) {
      case '--config-file': parsed.configFile = take(index, values[index]); index += 1; break;
      case '--core-url': parsed.coreUrl = take(index, values[index]); index += 1; break;
      case '--role': parsed.role = take(index, values[index]); index += 1; break;
      case '--device-name': parsed.deviceName = take(index, values[index]); index += 1; break;
      case '--project-roots': parsed.projectRoots = take(index, values[index]); index += 1; break;
      case '--enrollment-token-file': parsed.enrollmentTokenFile = take(index, values[index]); index += 1; break;
      case '--token-file': parsed.tokenFile = take(index, values[index]); index += 1; break;
      case '--update-public-key': parsed.updatePublicKey = take(index, values[index]); index += 1; break;
      case '--service-group': parsed.serviceGroup = take(index, values[index]); index += 1; break;
      case '--allow-power-actions': parsed.allowPowerActions = true; break;
      case '--prevent-sleep': parsed.preventSleep = true; break;
      case '--allow-unsigned-updates': parsed.allowUnsignedUpdates = true; break;
      case '--remove-enrollment-token': parsed.removeEnrollmentToken = true; break;
      case '--consume-inputs': parsed.consumeInputs = true; break;
      case '--restart': parsed.restart = true; break;
      default: throw new Error(`Unknown option: ${values[index]}`);
    }
  }
  return parsed;
}

function applyJson(target, input) {
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error('Configuration JSON must be an object.');
  for (const [name, value] of Object.entries(input)) {
    const environmentName = jsonMappings[name];
    if (!environmentName) throw new Error(`Unsupported configuration property: ${name}`);
    if (name === 'projectRoots' && Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      target[environmentName] = value.join(':');
      continue;
    }
    if (typeof value === 'boolean') target[environmentName] = String(value);
    else if (typeof value === 'string') target[environmentName] = value;
    else throw new Error(`Configuration property must be a string or boolean: ${name}`);
  }
}

async function readExisting(file) {
  try {
    const result = {};
    const information = await lstat(file);
    if (!information.isFile() || information.isSymbolicLink() || information.uid !== 0 || (information.mode & 0o022) !== 0) {
      throw new Error(`Existing environment file must be a root-owned, non-writable regular file: ${file}`);
    }
    const content = await readFile(file, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const assignment = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (!assignment || !(assignment[1] in allowedEnvironment)) throw new Error(`Invalid existing environment entry: ${rawLine}`);
      const quoted = /^"((?:\\.|[^"\\])*)"$/.exec(assignment[2]);
      if (quoted) result[assignment[1]] = quoted[1].replace(/\\([\\"])/g, '$1');
      else {
        if (!/^[A-Za-z0-9_./:+,=@-]*$/.test(assignment[2])) throw new Error(`Unsafe unquoted environment value: ${rawLine}`);
        result[assignment[1]] = assignment[2];
      }
    }
    return result;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
}

async function assertSecretFile(file) {
  const absolute = path.resolve(file);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Secure input must be a regular file: ${absolute}`);
  if (info.uid !== 0 || (info.mode & 0o077) !== 0) throw new Error(`Secure input must be root-owned and mode 0600 (or stricter): ${absolute}`);
  await access(absolute, constants.R_OK);
}

async function readSecret(file) {
  await assertSecretFile(file);
  const value = (await readFile(file, 'utf8')).trim();
  if (!value || value.includes('\r') || value.includes('\n') || value.includes('\0')) throw new Error(`Secret file must contain one non-empty line: ${file}`);
  return value;
}

function validateCoreUrl(value) {
  const url = new URL(validateLine(value, 'Core URL'));
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new Error('Core URL must use http(s) or ws(s) and contain no embedded credentials.');
  return value;
}

function validateRole(value) {
  if (!['core', 'gpu', 'worker', 'gateway', 'storage', 'workstation', 'phone', 'unknown'].includes(value)) throw new Error(`Invalid device role: ${value}`);
  return value;
}

function validateLine(value, name) {
  if (typeof value !== 'string' || value.includes('\r') || value.includes('\n') || value.includes('\0')) throw new Error(`${name} must be a single-line string.`);
  return value;
}

function quoteEnvironment(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function lookupGroupId(group) {
  const result = spawnSync('/usr/bin/getent', ['group', group], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Service group does not exist: ${group}`);
  const groupId = Number.parseInt(result.stdout.split(':')[2], 10);
  if (!Number.isInteger(groupId)) throw new Error(`Unable to resolve service group: ${group}`);
  return groupId;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}.`);
}
