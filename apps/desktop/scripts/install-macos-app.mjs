import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCodesignIdentity } from './codesign-identity.mjs';

if (process.platform !== 'darwin') throw new Error('The Orchestra Canvas macOS installer can only run on macOS.');

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, '..');
const workspaceDirectory = resolve(desktopDirectory, '../..');
const sourceApp = join(workspaceDirectory, 'node_modules/electron/dist/Electron.app');
const builtDesktop = join(desktopDirectory, 'out');
const legacyApp = resolve(join(process.env.HOME, 'Applications/Fleet Canvas.app'));
const targetApp = resolve(process.env.ORCHESTRA_MACOS_APP_PATH || process.env.FLEET_MACOS_APP_PATH || join(process.env.HOME, 'Applications/Orchestra Canvas.app'));
const resources = join(targetApp, 'Contents/Resources');
const plist = join(targetApp, 'Contents/Info.plist');
const packagedApp = join(resources, 'app');
const executableName = 'Orchestra Canvas';
const bundleIdentifier = 'com.fleetcanvas.desktop';
const targetExecutable = join(targetApp, 'Contents/MacOS', executableName);
const legacyExecutable = join(legacyApp, 'Contents/MacOS', 'Fleet Canvas');
const obsoleteLauncherLabel = 'com.fleetcanvas.desktop.runtime';
const obsoleteLauncherDomain = `gui/${typeof process.getuid === 'function' ? process.getuid() : 0}`;
const obsoleteLaunchAgent = join(process.env.HOME, 'Library/LaunchAgents', `${obsoleteLauncherLabel}.plist`);
const signingIdentity = resolveCodesignIdentity();

function targetIsRunning() {
  const processes = execFileSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' });
  return processes.split('\n').some((command) => {
    const executable = command.trimStart();
    return executable.startsWith(targetExecutable)
      || executable.startsWith(`${targetExecutable}.bin`)
      || executable.startsWith(legacyExecutable);
  });
}

const relaunchAfterInstall = targetIsRunning();
if (relaunchAfterInstall) {
  try {
    execFileSync('/usr/bin/osascript', ['-e', `tell application id "${bundleIdentifier}" to quit`], { timeout: 5_000 });
  } catch { /* The process check below is authoritative. */ }
  for (let attempt = 0; attempt < 50 && targetIsRunning(); attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (targetIsRunning()) throw new Error('Orchestra Canvas is still running. Quit it before installing the update.');
}

try { execFileSync('/bin/launchctl', ['bootout', `${obsoleteLauncherDomain}/${obsoleteLauncherLabel}`]); } catch {}
await rm(obsoleteLaunchAgent, { force: true });

await access(sourceApp);
await access(join(builtDesktop, 'main', 'index.cjs'));
await access(join(builtDesktop, 'preload', 'index.cjs'));
await access(join(builtDesktop, 'renderer', 'index.html'));
await mkdir(dirname(targetApp), { recursive: true });
await rm(targetApp, { recursive: true, force: true });
// ditto preserves the relative symlinks inside Electron Framework.framework.
// Node's fs.cp resolves them to absolute source-tree links, which macOS rejects
// as unsealed framework content during signing.
execFileSync('/usr/bin/ditto', [sourceApp, targetApp]);
await rename(join(targetApp, 'Contents/MacOS/Electron'), targetExecutable);

for (const [key, value] of [
  ['CFBundleIdentifier', bundleIdentifier],
  ['CFBundleExecutable', executableName],
  ['CFBundleName', 'Orchestra Canvas'],
  ['CFBundleDisplayName', 'Orchestra Canvas'],
  ['CFBundleSpokenName', 'Orchestra Canvas'],
  ['NSInputMonitoringUsageDescription', 'Orchestra Canvas uses Input Monitoring to receive Codex Micro agent, command, dial, and joystick controls while the app is in the background.'],
  ['NSMicrophoneUsageDescription', 'Orchestra Canvas records the system-selected microphone while the Codex Micro MIC key is active.'],
  ['NSSpeechRecognitionUsageDescription', 'Orchestra Canvas transcribes Codex Micro voice prompts with Apple Speech Recognition.']
]) {
  try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, plist]); } catch {}
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist]);
}

await rm(join(resources, 'default_app.asar'), { force: true });
await mkdir(packagedApp, { recursive: true });
await writeFile(join(packagedApp, 'package.json'), `${JSON.stringify({
  name: 'orchestra-canvas-macos',
  productName: 'Orchestra Canvas',
  version: '2.0.0',
  private: true,
  main: 'out/main/index.cjs'
}, null, 2)}\n`);
execFileSync('/usr/bin/ditto', [builtDesktop, join(packagedApp, 'out')]);

const voiceHelper = join(packagedApp, 'out/native/Codex Micro Voice.app');
await access(voiceHelper);
execFileSync('/usr/bin/codesign', ['--force', '--sign', signingIdentity, '--identifier', 'com.fleetcanvas.desktop.codex-micro-voice', voiceHelper], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', signingIdentity, targetApp], { stdio: 'inherit' });
if (legacyApp !== targetApp) await rm(legacyApp, { recursive: true, force: true });
execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', targetApp]);

const bundleId = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist], { encoding: 'utf8' }).trim();
if (relaunchAfterInstall) execFileSync('/usr/bin/open', [targetApp]);
console.log(JSON.stringify({
  app: targetApp,
  bundleId,
  relaunched: relaunchAfterInstall,
  selfContained: true,
  signingIdentity: signingIdentity === '-' ? 'ad-hoc' : signingIdentity,
}));
