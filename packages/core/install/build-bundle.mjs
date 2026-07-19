#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(here, '..');
const outputIndex = process.argv.indexOf('--out');
if (outputIndex === -1 || !process.argv[outputIndex + 1]) {
  process.stderr.write('Usage: node build-bundle.mjs --out <directory>\n');
  process.exit(2);
}

const output = path.resolve(process.argv[outputIndex + 1]);
const marker = path.join(output, '.fleet-core-runtime-bundle');
if (output === path.parse(output).root || packageDirectory === output || packageDirectory.startsWith(`${output}${path.sep}`)) {
  throw new Error(`Refusing unsafe bundle output path: ${output}`);
}

try {
  const information = await lstat(output);
  if (information.isSymbolicLink() || !information.isDirectory()) throw new Error(`Bundle output already exists and is not a directory: ${output}`);
  const value = await readFile(marker, 'utf8').catch(() => '');
  if (value.trim() !== 'fleet-core-runtime-bundle-v1') throw new Error(`Refusing to replace an unmarked directory: ${output}`);
  await rm(output, { recursive: true, force: true });
} catch (error) {
  if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
}

const sourcePackage = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
const runtimeDependencies = Object.fromEntries(
  Object.entries(sourcePackage.dependencies ?? {}).filter(([name]) => name !== '@fleet/shared'),
);

await mkdir(output, { recursive: true, mode: 0o700 });
await writeFile(marker, 'fleet-core-runtime-bundle-v1\n', { mode: 0o600 });
await cp(path.join(packageDirectory, 'dist'), path.join(output, 'dist'), { recursive: true });
await writeFile(path.join(output, 'package.json'), `${JSON.stringify({
  name: '@fleet/core-runtime',
  version: sourcePackage.version,
  private: true,
  type: 'module',
  engines: sourcePackage.engines ?? { node: '>=22' },
  bin: { 'fleet-core': './dist/cli.js' },
  dependencies: runtimeDependencies,
}, null, 2)}\n`);

if (process.platform === 'win32') {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await run(process.execPath, [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund'], output);
} else {
  await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], output);
}
for (const dependency of Object.keys(runtimeDependencies)) {
  await readFile(path.join(output, 'node_modules', dependency, 'package.json'), 'utf8');
}
process.stdout.write(`${output}\n`);

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${signal ?? code}).`)));
  });
}
