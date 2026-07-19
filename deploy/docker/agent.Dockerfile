# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/agent/package.json packages/agent/package.json
RUN npm ci --include=dev --workspace @fleet/agent --workspace @fleet/shared
COPY packages/shared packages/shared
COPY packages/agent packages/agent
RUN npm run build --workspace @fleet/shared \
    && npm run build --workspace @fleet/agent \
    && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    FLEET_AGENT_DATA_DIR=/var/lib/fleet-canvas/agent \
    FLEET_PROJECT_ROOTS=/workspaces
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system fleet && useradd --system --gid fleet --home-dir /var/lib/fleet-canvas fleet \
    && mkdir -p /var/lib/fleet-canvas/agent /workspaces && chown -R fleet:fleet /var/lib/fleet-canvas /workspaces
WORKDIR /app
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages/shared/dist ./packages/shared/dist
COPY --from=build /workspace/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /workspace/packages/agent/dist ./packages/agent/dist
COPY --from=build /workspace/packages/agent/package.json ./packages/agent/package.json
COPY deploy/docker/agent-entrypoint.sh /usr/local/bin/fleet-agent-entrypoint
USER fleet
VOLUME ["/var/lib/fleet-canvas/agent", "/workspaces"]
ENTRYPOINT ["/usr/local/bin/fleet-agent-entrypoint"]
CMD ["node", "packages/agent/dist/cli.js"]
