#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE="${FLEET_PI_IMAGE:-$SCRIPT_DIR/fleet-gateway-raspios-trixie-arm64.img}"
DISK="${1:-/dev/disk10}"

diskutil_with_timeout() {
  local seconds="$1"
  shift
  local output_file pid step
  output_file="$(mktemp -t fleet-diskutil)"
  diskutil "$@" >"$output_file" 2>&1 &
  pid=$!
  step=0
  while kill -0 "$pid" 2>/dev/null; do
    if [[ "$step" -ge $((seconds * 4)) ]]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      rm -f "$output_file"
      echo "diskutil did not respond within ${seconds}s. Reinsert the SD card, then run this script again." >&2
      return 124
    fi
    sleep 0.25
    step=$((step + 1))
  done
  if wait "$pid"; then
    cat "$output_file"
    rm -f "$output_file"
    return 0
  fi
  cat "$output_file" >&2
  rm -f "$output_file"
  return 1
}

[[ -f "$IMAGE" ]] || { echo "Image not found: $IMAGE" >&2; exit 1; }
[[ "$DISK" =~ ^/dev/disk[0-9]+$ ]] || { echo "Pass a whole disk such as /dev/disk10, never a partition." >&2; exit 1; }

if ! INFO="$(diskutil_with_timeout 15 info "$DISK")"; then exit 1; fi
grep -qE 'Device Location:[[:space:]]+External' <<<"$INFO" || { echo "$DISK is not external; refusing." >&2; exit 1; }
grep -qE 'Whole:[[:space:]]+Yes' <<<"$INFO" || { echo "$DISK is not a whole disk; refusing." >&2; exit 1; }
BYTES="$(awk '/Disk Size:/ {gsub(/[()]/,""); for(i=1;i<=NF;i++) if($i ~ /^[0-9]+$/ && $(i+1)=="Bytes") {print $i; exit}}' <<<"$INFO")"
[[ "$BYTES" =~ ^[0-9]+$ && "$BYTES" -ge 8000000000 && "$BYTES" -le 256000000000 ]] || {
  echo "Unexpected removable disk size; refusing: ${BYTES:-unknown} bytes" >&2; exit 1;
}

echo "About to erase and flash:"
sed -n -E '/Device Node|Device Location|Media Name|Disk Size|Removable Media|Solid State/p' <<<"$INFO"
echo "Image: $IMAGE"
read -r -p "Type ${DISK#/dev/} to confirm: " CONFIRM
[[ "$CONFIRM" == "${DISK#/dev/}" ]] || { echo "Cancelled."; exit 1; }

sudo -v
diskutil_with_timeout 30 unmountDisk "$DISK"
RAW="/dev/r${DISK#/dev/}"
echo "Writing approximately $(( $(stat -f%z "$IMAGE") / 1024 / 1024 )) MiB. Press Ctrl-T for dd progress."
sudo dd if="$IMAGE" of="$RAW" bs=4m conv=sync
sync

echo "Verifying every byte written..."
sudo cmp -n "$(stat -f%z "$IMAGE")" "$IMAGE" "$RAW"
diskutil_with_timeout 30 eject "$DISK"
echo "Verified and ejected. Insert the SD card into the Pi and connect wired Ethernet before powering it on."
