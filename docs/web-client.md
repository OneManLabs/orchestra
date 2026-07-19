# Responsive web and mobile client

Fleet Canvas ships the same responsive React control surface as a static PWA. The production build never embeds a Fleet credential. Operators enter a scoped API token at runtime; it remains in JavaScript memory and is discarded on refresh or close. Only the non-secret Core URL is retained for the browser session.

## Build

```bash
npm run build:web
```

Serve `apps/desktop/dist-web` from an HTTPS origin. The recommended topology is a same-origin reverse proxy:

```text
https://fleet.example.ts.net/       -> static dist-web files
https://fleet.example.ts.net/api/   -> http://127.0.0.1:4780/api/
https://fleet.example.ts.net/ws/    -> ws://127.0.0.1:4780/ws/ (upgrade enabled)
```

With that layout the client discovers Core from `window.location.origin`; no build-time URL or token is needed. Configure the reverse proxy to preserve WebSocket upgrades, cap request sizes, restrict the site to the tailnet, and send a production Content Security Policy appropriate to the final Core/media origins. The packaged Electron renderer receives its own restrictive build-time CSP; the static web build deliberately leaves that deployment-specific header to the HTTPS reverse proxy. Core still performs its own bearer/scope, origin, and policy checks.

For a separate web origin, set `VITE_FLEET_CORE_URL` only to the public Core origin at build time and add the exact web origin to `FLEET_ALLOWED_ORIGINS` on Core. Never set `VITE_FLEET_TOKEN`: Fleet Canvas deliberately has no build-time token path.

## Operator access

1. Create a short-lived API token with only the required read/write and sensitive-family scopes.
2. Open the PWA and enter the Core HTTPS URL and token.
3. Install the PWA from Safari/Chrome if desired.
4. Re-enter the token after a page refresh or process restart.

The service worker caches only static shell assets. It bypasses `/api/` and `/ws/`; snapshots, telemetry, artifacts, logs, and credentials are never added to the browser cache.

Browser notifications work while the client is open and the operator grants permission. Background APNs/Web Push delivery is not part of the self-hosted Core and requires a separately configured push provider.

## Development

`npm run dev:web` starts Core, a real local Agent, and Vite. Vite proxies `/api` and `/ws` to loopback Core, so the browser uses the same-origin path and no mock fleet data. This command deliberately starts Core with `--allow-unauthenticated-loopback` for the local development proxy only. Never reuse that switch with a production/shared reverse proxy; run Core with normal authentication and enter a scoped API token in the PWA instead.
