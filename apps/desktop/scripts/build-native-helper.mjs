import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCodesignIdentity } from './codesign-identity.mjs';

if (process.platform === 'darwin') {
  const signingIdentity = resolveCodesignIdentity();
  const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const bundle = join(desktop, 'out/native/Codex Micro Voice.app');
  const contents = join(bundle, 'Contents');
  const executable = join(contents, 'MacOS/Codex Micro Voice');
  await rm(bundle, { recursive: true, force: true });
  await mkdir(dirname(executable), { recursive: true });
  await copyFile(join(desktop, 'native/Info.plist'), join(contents, 'Info.plist'));
  execFileSync('/usr/bin/xcrun', [
    'swiftc', '-swift-version', '5', '-O', '-parse-as-library',
    '-framework', 'AVFoundation', '-framework', 'Speech',
    join(desktop, 'native/CodexMicroVoice.swift'), '-o', executable,
  ], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--force', '--sign', signingIdentity, '--identifier', 'com.fleetcanvas.desktop.codex-micro-voice', bundle], { stdio: 'inherit' });
  process.stdout.write(`Built signed native voice helper with ${signingIdentity === '-' ? 'an ad-hoc signature' : signingIdentity}: ${bundle}\n`);
}
