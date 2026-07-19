#!/usr/bin/env node
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

const allowedVariables = new Set([
  'FLEET_CORE_URL',
  'FLEET_DEVICE_ROLE',
  'FLEET_DEVICE_NAME',
  'FLEET_AGENT_DATA_DIR',
  'FLEET_CREDENTIAL_FILE',
  'FLEET_PROJECT_ROOTS',
  'FLEET_ENROLLMENT_TOKEN',
  'FLEET_TOKEN',
  'FLEET_ALLOW_POWER_ACTIONS',
  'FLEET_PREVENT_SLEEP_DURING_JOBS',
  'FLEET_UPDATE_PUBLIC_KEY',
  'FLEET_REQUIRE_SIGNED_UPDATES',
  'FLEET_CODEX_COMMAND',
  'CODEX_HOME',
]);

function isFullyQualifiedWindowsPath(value) {
  const driveQualified = /^[A-Za-z]:[\\/]/.test(value);
  const uncQualified = /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value);
  const deviceNamespace = /^\\\\[?.][\\/]/.test(value);
  return (driveQualified || uncQualified) && !deviceNamespace && path.win32.isAbsolute(value);
}

const programData = process.env.ProgramData;
if (!programData) throw new Error('ProgramData is unavailable to the Fleet Canvas service.');
const configPath = path.join(programData, 'Fleet Canvas', 'agent', 'service-config.json');

try {
  const information = await lstat(configPath);
  if (!information.isFile() || information.isSymbolicLink()) throw new Error('Service configuration must be a regular file.');
  const config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''));
  if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('Service configuration must be a JSON object.');
  for (const [name, value] of Object.entries(config)) {
    if (!allowedVariables.has(name)) throw new Error(`Unsupported service configuration key: ${name}`);
    if (typeof value !== 'string' || value.includes('\0') || value.includes('\r') || value.includes('\n')) {
      throw new Error(`Invalid service configuration value: ${name}`);
    }
    if ((name === 'FLEET_CODEX_COMMAND' || name === 'CODEX_HOME') && value !== '' && !isFullyQualifiedWindowsPath(value)) {
      throw new Error(`Service configuration requires an absolute Windows path: ${name}`);
    }
    if (value !== '') process.env[name] = value;
  }
} catch (error) {
  if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  throw new Error(`Fleet Canvas Agent is not configured. Run configure.ps1 as Administrator (${configPath}).`);
}

await import('./dist/cli.js');
