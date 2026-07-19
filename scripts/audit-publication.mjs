#!/usr/bin/env node

import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { spawnSync } from 'node:child_process';

const listed = spawnSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' },
);

if (listed.status !== 0) {
  process.stderr.write(listed.stderr || 'Unable to enumerate repository files.\n');
  process.exit(1);
}

const files = listed.stdout.split('\0').filter(Boolean);
const forbiddenExtensions = new Set([
  '.key', '.p8', '.p12', '.pfx', '.pem', '.mobileprovision', '.keystore', '.jks',
]);
const forbiddenNames = new Set([
  '.env', '.npmrc', '.pypirc', '.netrc', 'fleet-state.json', 'device-credential.json',
]);
const highConfidencePatterns = [
  ['private key material', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['OpenAI-style secret key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ['Tailscale auth key', /\btskey-[A-Za-z0-9_-]{10,}\b/g],
  ['personal macOS home path', /\/Users\/(?!example(?:\/|\b)|_fleetagent(?:\/|\b))[^/\s"'`]+/gi],
  ['URI-encoded personal macOS home path', /%2FUsers%2F(?!example(?:%2F|\b)|_fleetagent(?:%2F|\b))[^%\s"'`]+/gi],
  ['personal Windows home path', /[A-Za-z]:\\Users\\(?!example(?:\\|\b))[^\\\s"'`]+/gi],
];

const findings = [];

for (const file of files) {
  const name = file.split('/').at(-1) ?? file;
  if (forbiddenNames.has(name) && !file.endsWith('.env.example')) {
    findings.push(`${file}: sensitive filename must not be published`);
  }
  if (forbiddenExtensions.has(extname(file).toLowerCase())) {
    findings.push(`${file}: sensitive key or signing-file extension`);
  }

  let stats;
  try { stats = statSync(file); } catch { continue; }
  if (!stats.isFile() || stats.size > 5_000_000) continue;

  let contents;
  try { contents = readFileSync(file, 'utf8'); } catch { continue; }
  if (contents.includes('\0')) continue;
  if (file === 'scripts/audit-publication.mjs') continue;

  for (const [label, pattern] of highConfidencePatterns) {
    pattern.lastIndex = 0;
    for (const match of contents.matchAll(pattern)) {
      const line = contents.slice(0, match.index).split('\n').length;
      findings.push(`${file}:${line}: possible ${label}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write('Publication audit failed:\n\n');
  process.stderr.write(`${findings.map((finding) => `- ${finding}`).join('\n')}\n`);
  process.stderr.write('\nRemove the material and rotate any real credential before publishing.\n');
  process.exit(1);
}

process.stdout.write(`Publication audit passed for ${files.length} non-ignored files.\n`);
