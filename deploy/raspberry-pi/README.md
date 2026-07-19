# Fleet Canvas Raspberry Pi gateway

This deployment turns a Raspberry Pi running Raspberry Pi OS Lite 64-bit into
an always-on Fleet gateway. It installs Tailscale, advertises the home LAN
`192.168.4.0/22` and exit-node capability, installs the appliance-mode Fleet
Agent, provides Wake-on-LAN and network monitoring, and stages Network UPS
Tools safely in `MODE=none` until the exact UPS is identified.

## First boot

1. Connect the Pi to the home router/switch with Ethernet and power it on.
2. Wait up to 15 minutes for upgrades and first-boot provisioning.
3. From the Mac, connect with:

   ```sh
   ssh -i ~/.ssh/fleet_gateway_ed25519 fleetadmin@fleet-gateway.local
   ```

4. Join Tailscale and configure routing:

   ```sh
   sudo fleet-tailscale-login
   ```

5. In the Tailscale admin console, approve `192.168.4.0/22` and approve this
   device as an exit node. After configuring `TagOwners`/grants, optionally tag
   this trusted appliance as `tag:gateway`; do not disable key expiry casually
   on an untagged user device.
6. Authenticate Codex for the unprivileged Fleet service identity:

   ```sh
   sudo fleet-codex-login
   ```

The Fleet Agent then enrolls itself with the one-use credential embedded by the
trusted provisioning Mac, and automatically deletes that bootstrap credential
after receiving its device-bound credential.

Run `sudo fleet-gateway-status` for a compact health report. The generated
admin recovery password can be retrieved on the provisioning Mac with:

```sh
security find-generic-password -s com.fleetcanvas.raspberrypi \
  -a fleetadmin-password -w
```

The SD image intentionally contains no Tailscale auth key, OpenAI credential,
or reusable Fleet recovery token. Home Assistant is not installed.
