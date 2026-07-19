import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const preloadPath = join(desktopRoot, 'out', 'preload', 'index.cjs');
const mainPath = join(desktopRoot, 'out', 'main', 'index.cjs');
const [preload, main] = await Promise.all([
  readFile(preloadPath, 'utf8'),
  readFile(mainPath, 'utf8'),
]);

assert.doesNotMatch(preload, /^\s*(?:import|export)\s/m, 'sandboxed preload must not contain ESM imports or exports');
assert.match(preload, /require\(["']electron["']\)/, 'sandboxed preload must use Electron\'s restricted CommonJS loader');
assert.match(preload, /exposeInMainWorld\(["']fleetDesktop["']/, 'preload must expose the Fleet desktop bridge');
assert.match(main, /\.\.\/preload\/index\.cjs/, 'main process must load the emitted CommonJS preload');
assert.match(preload, /fleet:codex-micro:start-voice-capture/, 'preload must expose native voice capture');
assert.match(preload, /fleet:codex-micro:set-active-session/, 'preload must synchronize the visible Codex session');
new vm.Script(preload, { filename: preloadPath });

if (process.platform === 'darwin') {
  const voiceBundle = join(desktopRoot, 'out/native/Codex Micro Voice.app');
  const voicePlist = join(voiceBundle, 'Contents/Info.plist');
  await access(join(voiceBundle, 'Contents/MacOS/Codex Micro Voice'));
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', voiceBundle], { stdio: 'pipe' });
  assert.ok(execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :NSMicrophoneUsageDescription', voicePlist], { encoding: 'utf8' }).trim());
  assert.ok(execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :NSSpeechRecognitionUsageDescription', voicePlist], { encoding: 'utf8' }).trim());
}

process.stdout.write('Verified sandbox-compatible Fleet preload bridge and signed native voice helper.\n');
