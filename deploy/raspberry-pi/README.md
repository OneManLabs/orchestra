# Orchestra Raspberry Pi gateway

This installation makes a Raspberry Pi an Orchestra gateway. It requires Raspberry Pi OS Lite 64-bit.

The installation does these tasks:

- Installs Tailscale.
- Advertises the configured LAN route.
- Advertises exit-node support.
- Installs the Orchestra Agent in appliance mode.
- Enables Wake-on-LAN and network monitoring.
- Installs Network UPS Tools with `MODE=none`.

Do not enable a UPS mode until you identify and configure the exact UPS.

## First start

1. Connect the Pi to the router or switch with Ethernet.
2. Connect power.
3. Wait 15 minutes for the first-start procedure.
4. Connect from the Mac.

   ```sh
   ssh -i ~/.ssh/fleet_gateway_ed25519 fleetadmin@fleet-gateway.local
   ```

5. Connect Tailscale and set the routes.

   ```sh
   sudo fleet-tailscale-login
   ```

6. In the Tailscale console, approve the LAN route.
7. Approve the device as an exit node.
8. Add `tag:gateway` only after you configure the applicable grants.
9. Authenticate Codex for the Orchestra service user.

   ```sh
   sudo fleet-codex-login
   ```

The Agent uses the one-use enrollment credential. It deletes that credential after it gets a device credential.

## Status and recovery password

Use this command on the Pi:

```sh
sudo fleet-gateway-status
```

Use this command on the provisioning Mac to get the generated administrator password:

```sh
security find-generic-password -s com.fleetcanvas.raspberrypi \
  -a fleetadmin-password -w
```

The SD image does not contain a Tailscale key, an OpenAI credential, or a reusable recovery token. It does not install Home Assistant.
