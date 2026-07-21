# Orchestra Agent installation

The Agent can run as a background service on macOS, Windows, Linux, and Raspberry Pi OS. An Agent makes an outbound connection to Core. The installers do not open a firewall port.

## Make a runtime bundle

Build the bundle on the same operating system and architecture as the target package.

```bash
npm run build -w @fleet/agent
node packages/agent/install/build-bundle.mjs --out /tmp/fleet-agent-bundle
```

The bundle contains the Agent and production dependencies. A full bundle includes `node-pty`.

Do not put a macOS ARM bundle in a Windows x64 or Linux package.

For a device without a native PTY, make an appliance bundle:

```bash
node packages/agent/install/build-bundle.mjs --out /tmp/fleet-agent-appliance --omit-pty
```

An appliance bundle does not give interactive terminals. It can still report telemetry, run jobs, and transfer files.

## Enrollment

Use a one-use enrollment token. Put the token in a file that only root or the administrator can read.

Do not put a token in a command argument. Process lists and package logs can show command arguments.

The service runs as its service identity. Put the necessary Codex, repository, NAS, and project permissions on that identity.

Do not copy a personal credential directory to the service account.

The Agent does not copy a personal Codex credential directory.

## Windows MSI

The MSI installs the Agent, Node.js 22, and WinSW. It registers the `FleetCanvasAgent` LocalSystem service.

Build on Windows x64:

```powershell
npm run build -w @fleet/agent
node packages/agent/install/build-bundle.mjs --out C:\build\fleet-agent-bundle
dotnet tool install --global wix --version 5.0.2

.\packages\agent\install\windows\build-msi.ps1 `
  -Bundle C:\build\fleet-agent-bundle `
  -WinSw C:\build\WinSW-x64.exe `
  -Version 2.0.0 `
  -Output C:\build\fleet-canvas-agent-2.0.0-x64.msi
```

Use WinSW 2.12.0 x64 only after you check this SHA-256 value:

```text
05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da
```

For unattended enrollment, make a restricted token file. Then, use `install-msi.ps1`.

```powershell
$tokenPath = 'C:\ProgramData\Fleet Canvas\enrollment-token'
New-Item -ItemType Directory -Force (Split-Path $tokenPath) | Out-Null
Set-Content -NoNewline -LiteralPath $tokenPath -Value '<one-time-token>'
$administratorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls.exe $tokenPath /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' "*$($administratorSid):F"
icacls.exe $tokenPath /setowner '*S-1-5-32-544'

.\install-msi.ps1 `
  -Msi .\fleet-canvas-agent-2.0.0-x64.msi `
  -CoreUrl 'https://fleet-core.example.ts.net:4780' `
  -Role worker `
  -CodexCommand 'C:\Tools\Codex\codex.exe' `
  -CodexHome 'C:\ProgramData\Fleet Canvas\codex' `
  -EnrollmentTokenFile $tokenPath `
  -ConsumeSecretFiles
```

`-CodexCommand` must be a full path to a regular executable. `-CodexHome` must be a full path.

Authenticate Codex for LocalSystem through an approved administrator process.

After enrollment, remove the bootstrap tokens:

```powershell
& "$env:ProgramFiles\Fleet Canvas\Agent\configure.ps1" -RemoveEnrollmentToken -RemoveToken
```

Use `uninstall-msi.ps1` for removal. Add `-Purge` only when you also want to delete credentials, state, and logs.

## Debian and Ubuntu

Build on the target architecture:

```bash
packages/agent/install/linux/deb/build-deb.sh \
  /tmp/fleet-agent-bundle \
  /tmp/fleet-canvas-agent_2.0.0_$(dpkg --print-architecture).deb
```

For initial installation, make a root-only preseed file:

```bash
sudo install -d -m 0750 -o root -g root /etc/fleet-canvas
sudo install -m 0600 packages/agent/install/linux/package-install.example.json \
  /etc/fleet-canvas/package-install.json
sudoedit /etc/fleet-canvas/package-install.json
sudo apt install /tmp/fleet-canvas-agent_2.0.0_amd64.deb
```

For an installed package, use a token file:

```bash
sudo install -m 0600 ./enrollment-token /run/fleet-enrollment-token
sudo fleet-agent-configure \
  --core-url 'https://fleet-core.example.ts.net:4780' \
  --role worker \
  --enrollment-token-file /run/fleet-enrollment-token \
  --consume-inputs \
  --restart
```

After enrollment, run this command:

```bash
sudo fleet-agent-configure --remove-enrollment-token --restart
```

A normal removal keeps configuration and state. `apt purge fleet-canvas-agent` removes package-created state.

## RPM

Build on the target architecture:

```bash
packages/agent/install/linux/rpm/build-rpm.sh /tmp/fleet-agent-bundle /tmp/rpms
```

The RPM uses the same `/etc/fleet-canvas/package-install.json` preseed file. Removal keeps configuration and state until an administrator deletes them.

## Standalone Linux and Raspberry Pi

```bash
sudo packages/agent/install/linux/install.sh \
  --bundle /tmp/fleet-agent-bundle \
  --core-url 'https://fleet-core.example.ts.net:4780' \
  --role worker \
  --enrollment-token-file /run/fleet-enrollment-token \
  --consume-inputs \
  --headless
```

Removal keeps configuration and state. Add `--purge` to delete them.

`--allow-power-actions` opens the Agent command gate. It does not give root permission to the service account.

Use a small audited polkit or sudo rule only when restart or shutdown is necessary.

## macOS

`macos/install.sh` installs a launchd service. `macos/build-pkg.sh` makes an unsigned package.

A headless package can read `/Library/Application Support/Fleet Canvas/package-install.env`. Set root ownership and mode `0600` on this file.

Production packages require Developer ID Installer signing and notarization.

## Synology DSM

`synology/install.sh` installs a user-mode Agent below the current DSM user home. It does not require root, `sudo`, or systemd.

Read [Synology installation](synology/README.md) for the complete procedure.

## Production signing

The GitHub workflow makes unsigned development packages. Production distribution requires these controls:

- macOS signing and notarization
- Windows Authenticode and a trusted timestamp
- Signed APT and RPM repositories
- An organization update-signing key on each Agent

Do not publish unsigned workflow files as stable packages.

## Privileged update handoff

The Agent downloads and checks an update. It writes these files:

```text
<FLEET_AGENT_DATA_DIR>/updates/active.json
<FLEET_AGENT_DATA_DIR>/updates/releases/<version>/manifest.json
<FLEET_AGENT_DATA_DIR>/updates/releases/<version>/release.package
```

The Agent does not run a privileged package manager. A separate root or SYSTEM service must do these steps:

The apply result is `pending-service-installer`.

A separate, explicitly enabled privileged supervisor installs the package.

This repository does not install or enable that privileged supervisor.

1. Read `active.json`.
2. Check the approved version and change period.
3. Make the release path from the validated version.
4. Recalculate SHA-256.
5. Check the manifest signature.
6. Check package identity, version, platform, architecture, and native signature.
7. Install the package from outside the Agent process.
8. Wait for the Agent to reconnect with the expected version.
9. Record the installer result outside Agent-writable state.
10. Keep the previous verified package for rollback.

On failure, pause the update. Require an explicit rollback approval.

This repository does not install the privileged service. Each organization must supply its own trust and maintenance policy.
