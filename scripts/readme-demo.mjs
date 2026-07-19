#!/usr/bin/env node

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const stateDirectory = await mkdtemp(join(tmpdir(), 'fleet-readme-demo-'));
const corePort = await availablePort();
const webPort = await availablePort();
const token = `fleet-readme-demo-${randomBytes(24).toString('hex')}`;
const coreUrl = `http://127.0.0.1:${corePort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const children = [];
let stopping = false;

try {
  const core = launch('core', [
    'run', 'dev', '-w', '@fleet/core', '--',
    '--host', '127.0.0.1',
    '--port', String(corePort),
    '--token', token,
    '--data-dir', stateDirectory,
    '--allow-unauthenticated-loopback',
    '--readme-demo',
  ], cleanEnvironment());
  children.push(core);

  await waitForCore(coreUrl, core);

  const simulator = launch('simulator', [
    'run', 'dev', '-w', '@fleet/simulator', '--',
    '--count', '8',
    '--prefix', 'demo-node',
    '--codex-ui',
  ], cleanEnvironment({ FLEET_CORE_URL: coreUrl, FLEET_TOKEN: token }));
  children.push(simulator);

  const web = launch('web', [
    'run', 'dev:web', '-w', '@fleet/desktop', '--',
    '--port', String(webPort),
    '--strictPort',
  ], cleanEnvironment({ VITE_FLEET_CORE_URL: coreUrl }));
  children.push(web);

  await waitForUrl(webUrl, web);

  process.stdout.write('\nFleet Canvas README demo is ready.\n');
  process.stdout.write(`Open: ${webUrl}\n`);
  process.stdout.write('Data: eight synthetic demo-node devices in temporary local state.\n');
  process.stdout.write('Isolation: loopback only; no real Agent is started or contacted.\n');
  process.stdout.write('Press Ctrl+C to stop and remove the temporary state.\n\n');

  await new Promise((resolve, reject) => {
    for (const child of children) {
      child.once('exit', (code, signal) => {
        if (stopping) return;
        reject(new Error(`${child.demoLabel} exited unexpectedly (${signal ?? code ?? 'unknown'}).`));
      });
    }
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
} finally {
  stopping = true;
  for (const child of [...children].reverse()) child.kill('SIGTERM');
  await Promise.all(children.map((child) => waitForExit(child, 5_000)));
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await rm(stateDirectory, { recursive: true, force: true });
  process.stdout.write('README demo stopped; temporary state removed.\n');
}

function cleanEnvironment(additions = {}) {
  const environment = { ...process.env };
  for (const name of [
    'FLEET_AGENT_ID', 'FLEET_DEVICE_ID', 'FLEET_DEVICE_NAME', 'FLEET_DEVICE_ROLE',
    'FLEET_CORE_URL', 'FLEET_ENROLLMENT_TOKEN', 'FLEET_MASTER_KEY', 'FLEET_PROJECT_ROOTS',
    'FLEET_PUBLIC_URL', 'FLEET_STATE_DIR', 'FLEET_TOKEN', 'VITE_FLEET_CORE_URL',
  ]) delete environment[name];
  Object.assign(environment, additions);
  return environment;
}

function launch(label, arguments_, environment) {
  const child = spawn('npm', arguments_, {
    cwd: process.cwd(),
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.demoLabel = label;
  child.stdout.on('data', (chunk) => prefixOutput(label, chunk));
  child.stderr.on('data', (chunk) => prefixOutput(label, chunk));
  return child;
}

function prefixOutput(label, chunk) {
  const text = String(chunk);
  for (const line of text.split('\n')) {
    if (line) process.stdout.write(`[demo:${label}] ${line}\n`);
  }
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate a demo port.');
  const { port } = address;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForCore(url, child) {
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error('Demo Core exited during startup.');
    const response = await fetch(`${url}/api/health`).catch(() => undefined);
    return response?.ok === true;
  }, 20_000, 'Timed out waiting for the isolated demo Core.');
}

async function waitForUrl(url, child) {
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error('Demo web client exited during startup.');
    const response = await fetch(url).catch(() => undefined);
    return response?.ok === true;
  }, 20_000, 'Timed out waiting for the demo web client.');
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
