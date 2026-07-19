import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, '..');
const installRoot = path.join(packageRoot, 'install');

describe('native installer assets', () => {
  it('generates WiX components for every runtime file and excludes the service-owned pair', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-wix-'));
    try {
      const staging = path.join(root, 'staging');
      await mkdir(path.join(staging, 'dist'), { recursive: true });
      await writeFile(path.join(staging, 'dist', 'cli.js'), '');
      await writeFile(path.join(staging, 'node.exe'), '');
      await writeFile(path.join(staging, 'FleetCanvasAgentService.exe'), '');
      await writeFile(path.join(staging, 'FleetCanvasAgentService.xml'), '');
      const output = path.join(root, 'RuntimeFiles.wxs');
      await execute(process.execPath, [path.join(installRoot, 'windows', 'generate-wix-fragment.mjs'), staging, output]);
      const xml = await readFile(output, 'utf8');
      expect(xml).toContain('$(var.StagingDir)\\dist\\cli.js');
      expect(xml).toContain('$(var.StagingDir)\\node.exe');
      expect(xml).not.toContain('$(var.StagingDir)\\FleetCanvasAgentService.exe');
      expect(xml).toContain('<ComponentGroup Id="RuntimeComponents">');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('rejects symlinks in MSI staging', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-wix-link-'));
    try {
      const staging = path.join(root, 'staging');
      await mkdir(staging);
      await writeFile(path.join(root, 'outside'), '');
      await symlink(path.join(root, 'outside'), path.join(staging, 'linked'));
      await expect(execute(process.execPath, [path.join(installRoot, 'windows', 'generate-wix-fragment.mjs'), staging, path.join(root, 'out.wxs')])).rejects.toThrow(/symbolic links/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ships secure Linux preseed, purge, and reconfiguration paths', async () => {
    const [postinst, postrm, helper, service] = await Promise.all([
      readFile(path.join(installRoot, 'linux', 'deb', 'DEBIAN', 'postinst'), 'utf8'),
      readFile(path.join(installRoot, 'linux', 'deb', 'DEBIAN', 'postrm'), 'utf8'),
      readFile(path.join(installRoot, 'linux', 'configure.mjs'), 'utf8'),
      readFile(path.join(installRoot, 'linux', 'systemd', 'fleet-canvas-agent.service'), 'utf8'),
    ]);
    expect(postinst).toContain('/etc/fleet-canvas/package-install.json');
    expect(postinst).toContain('--consume-inputs');
    expect(postrm).toContain('/etc/fleet-canvas/.deb-created-user');
    expect(helper).toContain('mode 0600');
    expect(service).toContain('UMask=0077');
    expect(service).toContain('ProtectSystem=full');
  });

  it('keeps platform update installation an explicit external handoff', async () => {
    const documentation = await readFile(path.join(installRoot, 'README.md'), 'utf8');
    expect(documentation).toContain('pending-service-installer');
    expect(documentation).toContain('separate, explicitly enabled privileged supervisor');
    expect(documentation).toContain('does not install or enable that privileged supervisor');
  });

  it('supports explicitly marked terminal-free appliance bundles without weakening full-bundle checks', async () => {
    const files = await Promise.all([
      'build-bundle.mjs',
      'linux/install.sh',
      'linux/deb/build-deb.sh',
      'linux/rpm/build-rpm.sh',
      'macos/install.sh',
      'macos/build-pkg.sh',
      'windows/install.ps1',
      'windows/build-msi.ps1',
    ].map((file) => readFile(path.join(installRoot, file), 'utf8')));
    const [builder, ...installers] = files;

    expect(builder).toContain("argument === '--omit-pty'");
    expect(builder).toContain("name === 'node-pty'");
    expect(builder).toContain(".fleet-agent-omit-pty");
    for (const installer of installers) {
      expect(installer).toContain('node-pty');
      expect(installer).toContain('.fleet-agent-omit-pty');
      expect(installer).toContain('fleet-agent-omit-pty-v1');
    }
  });

  it('preserves normalized runtime modes through every POSIX bundle copy path', async () => {
    const installers = await Promise.all([
      'macos/install.sh',
      'macos/build-pkg.sh',
      'linux/install.sh',
      'linux/deb/build-deb.sh',
      'linux/rpm/build-rpm.sh',
      'synology/install.sh',
    ].map((file) => readFile(path.join(installRoot, file), 'utf8')));

    for (const installer of installers) {
      const bundleCopies = installer.split('\n').filter((line) => /cp\s+-.+\$BUNDLE/.test(line));
      expect(bundleCopies.length).toBeGreaterThan(0);
      for (const copy of bundleCopies) {
        expect(copy).toMatch(/cp\s+-pR\b/);
        expect(copy).not.toMatch(/cp\s+-R\b/);
      }
    }
  });

  it('uses locale-independent Windows ACL identities and atomic protected secret writes', async () => {
    const [configure, installer, receiver, preparation] = await Promise.all([
      'windows/configure.ps1',
      'windows/install.ps1',
      'windows/receive-enrollment-token.ps1',
      'windows/prepare-development.ps1',
    ].map((file) => readFile(path.join(installRoot, file), 'utf8')));

    for (const script of [configure, installer, receiver, preparation]) {
      expect(script).toContain('*S-1-5-18:');
      expect(script).toContain('*S-1-5-32-544:');
      expect(script).not.toMatch(/['"]SYSTEM:/);
      expect(script).not.toMatch(/['"]Administrators:/);
    }
    expect(receiver).not.toContain('$env:USERNAME');
    expect(receiver).toContain('$Identity.User.Value');
    expect(receiver).toContain('WindowsBuiltInRole]::Administrator');
    expect(receiver).toContain('Enrollment token directory must not be a symbolic link or reparse point.');
    expect(receiver).toContain("/setowner '*S-1-5-32-544'");
    expect(configure).toContain("/setowner '*S-1-5-32-544'");
    expect(installer).toContain("/setowner '*S-1-5-32-544'");
    expect(receiver.indexOf('icacls.exe $Temporary')).toBeLessThan(receiver.indexOf('Move-Item -LiteralPath $Temporary'));
    expect(configure.indexOf('icacls.exe $Temporary')).toBeLessThan(configure.indexOf('Move-Item -LiteralPath $Temporary'));
    expect(installer.indexOf('icacls.exe $TemporaryConfig')).toBeLessThan(installer.indexOf('Move-Item -LiteralPath $TemporaryConfig'));
  });

  it('rejects Windows preseed reparse points and prepares verified downloads in a protected directory', async () => {
    const [configure, installer, preparation] = await Promise.all([
      'windows/configure.ps1',
      'windows/install.ps1',
      'windows/prepare-development.ps1',
    ].map((file) => readFile(path.join(installRoot, file), 'utf8')));

    expect(configure).toContain('[IO.FileAttributes]::ReparsePoint');
    expect(installer).toContain('[IO.FileAttributes]::ReparsePoint');
    expect(configure).toContain('Fleet Agent state directory must not be a symbolic link or reparse point.');
    expect(installer).toContain('InstallDir must not be a symbolic link or reparse point.');
    expect(installer.indexOf("ExistingInstallDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint")).toBeLessThan(installer.indexOf('& $ServiceExe stop'));
    expect(configure).toContain('Assert-SafeInputFile $ConfigPath');
    expect(preparation).toContain('Run this preparation command as Administrator.');
    expect(preparation).toContain('function Receive-FileAtomic');
    expect(preparation).toContain('function Assert-RegularNonReparseFile');
    expect(preparation).toContain("NodeArchiveSha256 = 'b1fdb5635ba860f6bf71474f2ca882459a582de49b1d869451e3ad188e3943eb'");
    expect(preparation).toContain('Published Node.js checksum does not match the pinned bootstrap checksum.');
    expect(preparation).toContain('Node.js archive checksum verification failed.');
    expect(preparation).toContain('Node.js extraction destination must not be a symbolic link or reparse point.');
    expect(preparation.indexOf('icacls.exe $BootstrapRoot')).toBeLessThan(preparation.indexOf('Invoke-WebRequest'));
  });

  it('configures an explicit Windows service Codex runtime without copying user credentials', async () => {
    const [configure, installer, msiInstaller, serviceHost, example, documentation] = await Promise.all([
      'windows/configure.ps1',
      'windows/install.ps1',
      'windows/install-msi.ps1',
      'windows/service-host.mjs',
      'windows/service-config.example.json',
      'README.md',
    ].map((file) => readFile(path.join(installRoot, file), 'utf8')));

    for (const script of [configure, installer, msiInstaller]) {
      expect(script).toContain('[string]$CodexCommand');
      expect(script).toContain('[string]$CodexHome');
    }
    for (const script of [configure, installer]) {
      expect(script).toContain("'FLEET_CODEX_COMMAND'");
      expect(script).toContain("'CODEX_HOME'");
      expect(script).toContain('Resolve-AbsoluteWindowsPath');
      expect(script).toContain('Assert-RegularCodexCommand');
      expect(script).toContain('Initialize-SecureCodexHome');
      expect(script).toContain("/setowner '*S-1-5-18'");
      expect(script).not.toMatch(/Copy-Item[^\r\n]*(?:CodexHome|CODEX_HOME)/i);
    }
    expect(serviceHost).toContain("'FLEET_CODEX_COMMAND'");
    expect(serviceHost).toContain("'CODEX_HOME'");
    expect(serviceHost).toContain('isFullyQualifiedWindowsPath');
    expect(example).toContain('"FLEET_CODEX_COMMAND"');
    expect(example).toContain('"CODEX_HOME"');
    expect(documentation).toContain('does not copy a personal Codex credential directory');
  });

  it('normalizes existing Windows CodexHome descendants without breaking hard-linked executables', async () => {
    const [configure, installer] = await Promise.all([
      'windows/configure.ps1',
      'windows/install.ps1',
    ].map((file) => readFile(path.join(installRoot, file), 'utf8')));

    for (const script of [configure, installer]) {
      expect(script).toContain('packages\\standalone\\current as a reparse point');
      expect(script).toContain('function Get-CodexHomeDescendantsNoFollow([string]$Path)');
      expect(script).toContain('$PendingDirectories = [Collections.Generic.Stack[string]]::new()');
      expect(script).toContain('Get-ChildItem -LiteralPath $Directory -Force -ErrorAction Stop');
      expect(script).not.toContain('Get-ChildItem -LiteralPath $FullPath -Force -Recurse');
      expect(script).toContain('$Child.PSIsContainer -and ($Child.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0');
      expect(script).toContain('$Descendants = @(Get-CodexHomeDescendantsNoFollow $FullPath)');
      expect(script).toContain('$RegularDescendants = @($Descendants | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 })');
      expect(script).toContain('$Acl.SetAccessRuleProtection($true, $false)');
      expect(script).toContain('$Acl.RemoveAccessRuleSpecific($Rule)');
      expect(script).toContain("@('S-1-5-18', 'S-1-5-32-544', $Identity.User.Value) | Select-Object -Unique");
      expect(script).toContain('[Security.AccessControl.FileSystemRights]::FullControl');
      expect(script).toContain('hard-linked between CodexHome and Program Files');
      expect(script).toContain('FullControl preserves executable access for all three identities');
      expect(script.indexOf('$RegularDescendants = @($Descendants')).toBeLessThan(script.indexOf('foreach ($Item in @($Information)'));
    }
  });

  it.runIf(process.platform === 'win32')('does not descend through the official standalone current junction fixture', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-codex-current-'));
    try {
      const standalone = path.join(root, 'packages', 'standalone');
      const release = path.join(standalone, 'releases', '0.144.5-x86_64-pc-windows-msvc');
      await mkdir(path.join(release, 'bin'), { recursive: true });
      await writeFile(path.join(release, 'bin', 'codex.exe'), 'fixture');
      const current = path.join(standalone, 'current');
      await symlink(release, current, 'junction');

      const configure = await readFile(path.join(installRoot, 'windows', 'configure.ps1'), 'utf8');
      const start = configure.indexOf('function Get-CodexHomeDescendantsNoFollow');
      const end = configure.indexOf('\nfunction Initialize-SecureCodexHome', start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const functionSource = configure.slice(start, end);
      const harness = path.join(root, 'walk-fixture.ps1');
      const quotedRoot = root.replaceAll("'", "''");
      await writeFile(harness, `${functionSource}\nGet-CodexHomeDescendantsNoFollow '${quotedRoot}' | ForEach-Object { $_.FullName }\n`);
      const { stdout } = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness]);
      const visited = stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).map((entry) => entry.toLowerCase());
      const currentKey = current.toLowerCase();
      expect(visited).toContain(currentKey);
      expect(visited.some((entry) => entry.startsWith(`${currentKey}${path.sep}`))).toBe(false);
      expect(visited).toContain(path.join(release, 'bin', 'codex.exe').toLowerCase());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a relative Codex path at the Windows service boundary', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-service-config-'));
    try {
      const configDirectory = path.join(root, 'Fleet Canvas', 'agent');
      await mkdir(configDirectory, { recursive: true });
      for (const config of [{ FLEET_CODEX_COMMAND: 'codex' }, { CODEX_HOME: 'relative-codex-home' }]) {
        await writeFile(path.join(configDirectory, 'service-config.json'), JSON.stringify(config));
        await expect(execute(process.execPath, [path.join(installRoot, 'windows', 'service-host.mjs')], {
          env: { ...process.env, ProgramData: root },
        })).rejects.toThrow(/absolute Windows path/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('can remove every Windows bootstrap token after device enrollment', async () => {
    const [configure, installer, documentation] = await Promise.all([
      'windows/configure.ps1',
      'windows/install.ps1',
      'README.md',
    ].map((file) => readFile(path.join(installRoot, file), 'utf8')));

    expect(configure).toContain('[switch]$RemoveEnrollmentToken');
    expect(configure).toContain('[switch]$RemoveToken');
    expect(configure).toContain("$Config.Remove('FLEET_ENROLLMENT_TOKEN')");
    expect(configure).toContain("$Config.Remove('FLEET_TOKEN')");
    expect(installer).toContain('remove FLEET_ENROLLMENT_TOKEN and FLEET_TOKEN');
    expect(documentation).toContain('-RemoveEnrollmentToken -RemoveToken');
  });
});
