#!/usr/bin/env bash
set -Eeuo pipefail

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

PAYLOAD_DIR="/boot/firmware/fleet-payload"
STATE_DIR="/var/lib/fleet-gateway"
LOG_FILE="/var/log/fleet-gateway-bootstrap.log"
MARKER="$STATE_DIR/bootstrap-v2.complete"

install -d -m 0750 "$STATE_DIR"
touch "$LOG_FILE"
chmod 0640 "$LOG_FILE"
exec >>"$LOG_FILE" 2>&1

log() { printf '%s [fleet-bootstrap] %s\n' "$(date --iso-8601=seconds)" "$*"; }
trap 'log "FAILED at line $LINENO; systemd will retry. Run: sudo journalctl -u fleet-gateway-bootstrap -n 200"' ERR

if [[ -f "$MARKER" ]]; then
  log "Bootstrap is already complete."
  exit 0
fi

[[ -d "$PAYLOAD_DIR" ]] || { log "Missing $PAYLOAD_DIR"; exit 1; }
(cd "$PAYLOAD_DIR" && sha256sum --check SHA256SUMS)

log "Waiting for working DNS and package mirrors."
for attempt in {1..30}; do
  if getent ahostsv4 deb.debian.org >/dev/null 2>&1; then break; fi
  [[ "$attempt" -lt 30 ]] || { log "DNS did not become ready."; exit 1; }
  sleep 10
done

log "Updating Raspberry Pi OS and installing gateway packages."
apt-get update
apt-get -y full-upgrade
apt-get install -y --no-install-recommends \
  avahi-daemon bubblewrap ca-certificates curl dnsutils etherwake ethtool \
  fping git gnupg iputils-ping jq lm-sensors logrotate netcat-openbsd \
  nut smartmontools tcpdump traceroute unattended-upgrades \
  usbutils wakeonlan

systemctl enable --now ssh.service avahi-daemon.service

log "Enabling IPv4/IPv6 forwarding for Tailscale routing."
install -m 0644 "$PAYLOAD_DIR/config/99-tailscale.conf" /etc/sysctl.d/99-tailscale.conf
sysctl --system

log "Installing Tailscale from its signed Debian Trixie repository."
install -d -m 0755 /usr/share/keyrings /etc/apt/sources.list.d
TAILSCALE_KEY_DETAILS="$(gpg --show-keys --with-colons "$PAYLOAD_DIR/tailscale/tailscale-archive-keyring.gpg")"
grep -Eq '^(fpr:::::::::)?(2596A99EAAB33821893C0A79458CA832957F5868|2F625B3A774B946822EDDBEEB1547A3DDAAF03C6):' \
  <<<"$TAILSCALE_KEY_DETAILS" || {
    log "Staged Tailscale signing key fingerprint is not recognized."; exit 1;
  }
install -m 0644 "$PAYLOAD_DIR/tailscale/tailscale-archive-keyring.gpg" \
  /usr/share/keyrings/tailscale-archive-keyring.gpg
install -m 0644 "$PAYLOAD_DIR/tailscale/tailscale.list" \
  /etc/apt/sources.list.d/tailscale.list
apt-get update
apt-get install -y tailscale
systemctl enable --now tailscaled.service

log "Installing verified Node.js 22 ARM64 runtime."
NODE_FILE="$(<"$PAYLOAD_DIR/node/FILENAME")"
[[ "$NODE_FILE" =~ ^node-v22\.[0-9]+\.[0-9]+-linux-arm64\.tar\.xz$ ]] || {
  log "Unexpected Node archive name: $NODE_FILE"; exit 1;
}
(cd "$PAYLOAD_DIR/node" && grep " $NODE_FILE$" SHASUMS256.txt | sha256sum -c -)
NODE_DIR="/opt/${NODE_FILE%.tar.xz}"
if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  tar -xJf "$PAYLOAD_DIR/node/$NODE_FILE" -C /opt
fi
ln -sfn "$NODE_DIR/bin/node" /usr/local/bin/node
ln -sfn "$NODE_DIR/bin/npm" /usr/local/bin/npm
ln -sfn "$NODE_DIR/bin/npx" /usr/local/bin/npx
# The hardened Fleet service intentionally uses this stable absolute path.
ln -sfn "$NODE_DIR/bin/node" /usr/bin/node
node --version

log "Installing Codex CLI for Linux ARM64. Authentication is completed after Tailscale login."
npm_config_prefix=/usr/local npm install --global @openai/codex@0.144.5
codex --version

log "Installing the lightweight Fleet Agent and its one-use enrollment credential."
if [[ -f /opt/fleet-canvas/agent/dist/cli.js \
  && -f /etc/fleet-canvas/agent.env \
  && -f /etc/systemd/system/fleet-canvas-agent.service ]]; then
  log "Fleet Agent installation already exists; preserving its bootstrap/device credential state."
else
  install -m 0600 "$PAYLOAD_DIR/fleet-enrollment-token" /run/fleet-enrollment-token
  /bin/bash "$PAYLOAD_DIR/agent-install/linux/install.sh" \
    --bundle "$PAYLOAD_DIR/fleet-agent-appliance" \
    --core-url "http://100.64.0.10:4780" \
    --enrollment-token-file /run/fleet-enrollment-token \
    --consume-inputs \
    --project-roots /srv/fleet-jobs \
    --role gateway \
    --prevent-sleep-during-jobs \
    --headless
fi
install -d -o fleet-agent -g fleet-agent -m 0750 /srv/fleet-jobs
# Remove the provisioning copy. The installed root-owned service config retains
# it only until the device exchanges it for a device-bound credential.
rm -f "$PAYLOAD_DIR/fleet-enrollment-token"

log "Installing routing, monitoring, Wake-on-LAN, UPS placeholder, and cleanup services."
/bin/sh "$PAYLOAD_DIR/gateway-services/install.sh"

install -d -m 0700 -o fleet-agent -g fleet-agent /var/lib/fleet-canvas-agent/.codex
install -m 0755 "$PAYLOAD_DIR/helpers/fleet-tailscale-login" /usr/local/sbin/fleet-tailscale-login
install -m 0755 "$PAYLOAD_DIR/helpers/fleet-codex-login" /usr/local/sbin/fleet-codex-login
install -m 0755 "$PAYLOAD_DIR/helpers/fleet-gateway-status" /usr/local/sbin/fleet-gateway-status

log "Applying safe NUT default. UPS shutdown remains disarmed until the exact UPS is detected."
printf 'MODE=none\n' >/etc/nut/nut.conf
chmod 0644 /etc/nut/nut.conf
systemctl disable --now nut-monitor.service nut-server.service 2>/dev/null || true

log "Enabling automatic security upgrades."
cat >/etc/apt/apt.conf.d/52fleet-unattended-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
Unattended-Upgrade::Automatic-Reboot "false";
EOF
systemctl enable --now unattended-upgrades.service

cat >"$MARKER" <<EOF
completed_at=$(date --iso-8601=seconds)
node=$(node --version)
codex=$(codex --version 2>/dev/null || true)
tailscale=$(tailscale version | head -1)
fleet_agent=2.0.0-appliance
EOF
chmod 0640 "$MARKER"

log "Bootstrap complete. Run 'sudo fleet-tailscale-login', approve the device/routes, then run 'sudo fleet-codex-login'."
systemctl try-restart fleet-gateway-route-advertisement.service 2>/dev/null || true
