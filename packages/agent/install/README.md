# Orchestra Agent installation and packages

Orchestra Agent can run as a native background service on macOS, Windows, Debian/Ubuntu, RPM-based Linux, and Raspberry Pi OS. Agents make outbound connections to Core; none of these installers opens a firewall port.

## Runtime bundle

Build the Agent, then create the runtime bundle on the same operating system and architecture as the target package. By default, the bundle contains compiled Agent code and all production dependencies, including the native `node-pty` module.

```bash
npm run build -w @fleet/agent
node packages/agent/install/build-bundle.mjs --out /tmp/fleet-agent-bundle
```

Do not move a macOS/ARM bundle into a Windows/x64 MSI or a Linux/x64 bundle into an ARM Raspberry Pi package. `build-bundle.mjs` validates its output directory, installs production dependencies, and normalizes secure portable permissions before returning. That final pass restores executable modes for native helpers and signed binaries when an upstream package archive loses them, removes group/other write access, and rejects links that escape the bundle. POSIX installer copy paths preserve those normalized modes.

For an appliance that cannot build or load the native PTY binding, create an intentionally terminal-free bundle:

```bash
node packages/agent/install/build-bundle.mjs --out /tmp/fleet-agent-appliance --omit-pty
```

The appliance bundle includes a validated marker so native installers can distinguish this supported mode from a damaged full bundle. It can still report telemetry, run jobs, transfer files, and perform its other configured duties, but it does not advertise `feature:terminal`; interactive terminal commands return an explicit unsupported-runtime error. Full bundles continue to require `node-pty` by default.

## Enrollment configuration

Prefer one-time enrollment over a shared static token. Put the token in a root/administrator-only input file, let the installer consume it, then remove `FLEET_ENROLLMENT_TOKEN` from the installed service configuration after enrollment. The Agent stores its device-bound credential separately with owner-only permissions.

Never pass enrollment or recovery tokens directly on a command line in unattended production automation: process arguments and package-manager logs can expose them.

Native services execute Codex and shell jobs as the service identity, not as the currently logged-in desktop user. Put Codex authentication, repository credentials, NAS permissions, and project-root ACLs in that identity deliberately: `LocalSystem` for the stock Windows MSI, `fleet-agent` for the Linux packages, and the selected launchd user on macOS. Do not copy a personal credential directory into a service account as a shortcut.

## Windows MSI

The WiX definition installs the complete Windows runtime bundle, a private Node.js 22 executable, and WinSW. Windows Installer registers `FleetCanvasAgent` as an automatic LocalSystem service and removes the runtime and service registration on uninstall. `%ProgramData%\Fleet Canvas\agent` is intentionally retained unless the purge wrapper is used. A bare MSI install leaves the service in a non-running retry state until the protected service configuration exists; the headless wrapper writes and locks that configuration before starting MSI installation.

Build on Windows x64:

```powershell
npm run build -w @fleet/agent
node packages/agent/install/build-bundle.mjs --out C:\build\fleet-agent-bundle
dotnet tool install --global wix --version 5.0.2

# WinSW 2.12.0 x64; verify SHA-256 before use:
# 05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da
.\packages\agent\install\windows\build-msi.ps1 `
  -Bundle C:\build\fleet-agent-bundle `
  -WinSw C:\build\WinSW-x64.exe `
  -Version 2.0.0 `
  -Output C:\build\fleet-canvas-agent-2.0.0-x64.msi
```

`build-msi.ps1` generates one deterministic WiX component for every bundled runtime file, so `dist`, `node_modules`, `node.exe`, the service host, dependency license notices, and configuration utility are all placed in the MSI cabinet. It also copies the headless install/uninstall wrappers beside the MSI.

For unattended enrollment, create a one-line token file readable only by the invoking administrator, then use the wrapper. This keeps the token out of `msiexec` properties and Windows Installer logs.

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

`-CodexCommand` must name an existing, non-reparse executable using a fully qualified Windows path. `-CodexHome` must also be fully qualified; the installer creates it without traversing reparse points, recursively replaces the access rules on regular existing descendants, and grants full control only to LocalSystem, Administrators, and the invoking administrator. Descendant reparse points such as the official `packages\standalone\current` compatibility link are preserved and never followed during ACL normalization. This makes pre-existing logs, package caches, and authentication databases usable by both the service and an administrator performing device authentication. Files receive full control rather than a data-only permission, so a standalone Codex executable hard-linked between the home and its visible command path remains executable. Fleet does not copy a personal Codex credential directory into it, so authenticate Codex deliberately as the LocalSystem service identity using an approved administrative workflow. Protect the configured Codex executable from non-administrative modification.

The alternative `service-config.example.json` format uses `FLEET_*` keys plus `CODEX_HOME`. Keep a preseed file administrator-owned with no non-administrative write ACL, pass `-ConfigFile`, and use `-ConsumeInputFiles` when the preseed should be removed after configuration. Reconfigure an installed service with the companion or installed `configure.ps1`. After successful enrollment, remove both bootstrap token forms so the Agent uses its device-bound credential:

```powershell
& "$env:ProgramFiles\Fleet Canvas\Agent\configure.ps1" -RemoveEnrollmentToken -RemoveToken
```

Use `uninstall-msi.ps1 -Msi <path>` for a silent uninstall and add `-Purge` only when the device credential, logs, and state should also be destroyed. The separate `install.ps1`/`uninstall.ps1` pair remains available for an administrator-managed, non-MSI installation.

## Debian and Ubuntu

Build on the target architecture:

```bash
packages/agent/install/linux/deb/build-deb.sh \
  /tmp/fleet-agent-bundle \
  /tmp/fleet-canvas-agent_2.0.0_$(dpkg --print-architecture).deb
```

For atomic headless enrollment, preseed a root-only JSON file before installing. The package consumes and deletes it during `postinst`:

```bash
sudo install -d -m 0750 -o root -g root /etc/fleet-canvas
sudo install -m 0600 packages/agent/install/linux/package-install.example.json \
  /etc/fleet-canvas/package-install.json
sudoedit /etc/fleet-canvas/package-install.json
sudo apt install /tmp/fleet-canvas-agent_2.0.0_amd64.deb
```

If the package is already installed, use token files for unattended changes:

```bash
sudo install -m 0600 ./enrollment-token /run/fleet-enrollment-token
sudo fleet-agent-configure \
  --core-url 'https://fleet-core.example.ts.net:4780' \
  --role worker \
  --enrollment-token-file /run/fleet-enrollment-token \
  --consume-inputs \
  --restart
```

After enrollment, run `sudo fleet-agent-configure --remove-enrollment-token --restart`. A normal package removal preserves `/etc/fleet-canvas`, `/var/lib/fleet-canvas-agent`, and a pre-existing service account. `apt purge fleet-canvas-agent` removes package-created state and the package-created account.

## RPM distributions

Build with `rpmbuild` on the target architecture:

```bash
packages/agent/install/linux/rpm/build-rpm.sh /tmp/fleet-agent-bundle /tmp/rpms
```

The RPM consumes the same root-owned `/etc/fleet-canvas/package-install.json` preseed and installs `/usr/sbin/fleet-agent-configure`. RPM erase preserves `/etc/fleet-canvas`, `/var/lib/fleet-canvas-agent`, and the service identity by design; remove those explicitly only when decommissioning the device.

## Standalone Linux and Raspberry Pi

The standalone installer accepts `--config-file`, `--enrollment-token-file`, `--token-file`, `--consume-inputs`, `--headless`, service role/user, project-root, power, sleep, and update-signing options. It installs `/usr/local/sbin/fleet-agent-configure`. Raspberry Pi defaults to the `gateway` role and enables job sleep inhibition.

```bash
sudo packages/agent/install/linux/install.sh \
  --bundle /tmp/fleet-agent-bundle \
  --core-url 'https://fleet-core.example.ts.net:4780' \
  --role worker \
  --enrollment-token-file /run/fleet-enrollment-token \
  --consume-inputs \
  --headless
```

Standalone uninstall preserves configuration/state by default. Add `--purge` to remove it; the uninstaller deletes the service account only if that exact installer created it. When a custom install directory or service user was used, pass the same values to `linux/uninstall.sh`.

`--allow-power-actions` enables the Agent-side command gate; it does not silently grant the unprivileged Linux service account root power. If restart/shutdown is required, deploy a narrowly scoped, audited polkit/sudo rule through system management. Keep it disabled otherwise.

## macOS

`macos/install.sh` installs a launchd service and `macos/build-pkg.sh` builds an unsigned package. A headless `.pkg` can read root-owned mode-0600 values from `/Library/Application Support/Fleet Canvas/package-install.env`; its postinstall consumes that file. Production packages need Developer ID Installer signing and notarization.

## Synology DSM without root

`synology/install.sh` installs a runtime bundle and a selected Node.js 22+
executable below the current DSM user's home. Its POSIX `sh` lifecycle helper
provides `start`, `stop`, `restart`, `status`, `logs`, and `uninstall` without
`sudo` or `systemd`; it runs the Agent with `nohup` so an SSH disconnect does
not stop it. A protected owner-only enrollment token file is consumed only
after the device credential has been issued, and the Agent is restarted without
the token in its environment.

This user-mode helper does not create a native DSM boot service. Configure its
absolute `start` command as a boot-up task under the same user in DSM Task
Scheduler. See [`synology/README.md`](synology/README.md) for architecture,
terminal-free bundle, enrollment, persistence, and uninstall details.

## Signing and release boundary

The checked-in workflow builds unsigned development candidates only. Production distribution additionally requires:

- macOS Developer ID Installer signing and notarization;
- Windows Authenticode signing for the MSI and service executables, plus a trusted timestamp;
- signed APT/RPM repositories and repository metadata;
- an organization-owned update signing key configured on every Agent.

Agent update staging refuses unsigned releases by default. Do not promote the unsigned workflow artifacts to stable channels.

## Staged-update service handoff

Agent deliberately does not invoke a privileged package manager. `update.prepare` downloads the artifact, verifies its SHA-256 digest and configured release signature, and writes a manifest. `update.apply` moves that release into the active update directory and returns `pending-service-installer`; it does **not** replace the running installation, restart the host, or report the rollout successful.

The selected release is recorded under:

```text
<FLEET_AGENT_DATA_DIR>/updates/active.json
<FLEET_AGENT_DATA_DIR>/updates/releases/<version>/manifest.json
<FLEET_AGENT_DATA_DIR>/updates/releases/<version>/release.package
```

A production deployment needs a separate, explicitly enabled privileged supervisor (MDM, SCCM/Intune, launchd/systemd root service, or configuration-management agent). That supervisor must:

1. Read `active.json` and require an approved version/change window.
2. Construct the release path from the validated version; never trust an arbitrary `artifactPath` outside the release directory.
3. Recompute the artifact SHA-256 and independently verify the manifest signature with a root-owned public key.
4. Inspect native package identity, version, platform, architecture, and native code/repository signature.
5. Install from a process outside the Orchestra Agent service/runtime (`installer -pkg`, `msiexec /i`, `dpkg -i`, or `rpm -Uvh`).
6. Wait for the upgraded Agent to reconnect and report the expected version/protocol before marking success.
7. Record installer exit status outside Agent-writable state and retain the previous verified package as the rollback candidate.
8. On failure, leave the rollout paused and require an explicit rollback approval; do not repeatedly install from a restart loop.

This repository does not install or enable that privileged supervisor because its identity, approval source, maintenance policy, native signing trust, and rollback health check are deployment-specific security decisions. The checked-in rollout remains truthfully paused until this external handoff completes.
