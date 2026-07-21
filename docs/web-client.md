# Web and mobile client

Orchestra supplies the React interface as a static PWA. The production build does not contain an Orchestra credential.

The user enters a scoped API token at runtime. The browser keeps the token in memory. It removes the token after a refresh or close.

The browser session keeps only the non-secret Core URL.

## Build

```bash
npm run build:web
```

Serve `apps/desktop/dist-web` from HTTPS. Use a same-origin proxy when possible:

```text
https://fleet.example.ts.net/       -> static files
https://fleet.example.ts.net/api/   -> http://127.0.0.1:4780/api/
https://fleet.example.ts.net/ws/    -> ws://127.0.0.1:4780/ws/
```

Configure WebSocket upgrades and request-size limits. Restrict the site to the tailnet. Add a Content Security Policy for the final origins.

Core still checks bearer scopes, origins, and policy.

For a separate web origin, set `VITE_FLEET_CORE_URL` to the public Core origin. Add the exact web origin to `FLEET_ALLOWED_ORIGINS`.

Do not set `VITE_FLEET_TOKEN`. Orchestra has no build-time token path.

## User access

1. Make a short-life token with only the necessary scopes.
2. Open the PWA.
3. Enter the Core HTTPS URL and token.
4. Install the PWA if necessary.
5. Enter the token again after a refresh or restart.

The service worker caches only static interface files. It does not cache API data, telemetry, artifacts, logs, or credentials.

Browser notifications work while the client is open. Hosted background push is not included.

## Development

`npm run dev:web` starts Core, one real local Agent, and Vite. Vite sends `/api` and `/ws` to loopback Core.

This command uses `--allow-unauthenticated-loopback` only for the local development proxy. Do not use this option with a shared proxy.
