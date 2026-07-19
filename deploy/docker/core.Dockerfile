# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
WORKDIR /workspace
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/core/package.json packages/core/package.json
RUN npm ci --include=dev --workspace @fleet/core --workspace @fleet/shared
COPY packages/shared packages/shared
COPY packages/core packages/core
RUN npm run build --workspace @fleet/shared \
    && npm run build --workspace @fleet/core \
    && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    FLEET_HOST=0.0.0.0 \
    FLEET_PORT=4780 \
    FLEET_DATA_DIR=/var/lib/fleet-canvas
RUN groupadd --system fleet && useradd --system --gid fleet --home-dir /var/lib/fleet-canvas fleet \
    && mkdir -p /var/lib/fleet-canvas && chown -R fleet:fleet /var/lib/fleet-canvas
WORKDIR /app
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages/shared/dist ./packages/shared/dist
COPY --from=build /workspace/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /workspace/packages/core/dist ./packages/core/dist
COPY --from=build /workspace/packages/core/package.json ./packages/core/package.json
COPY deploy/docker/core-entrypoint.sh /usr/local/bin/fleet-core-entrypoint
USER fleet
EXPOSE 4780
VOLUME ["/var/lib/fleet-canvas"]
HEALTHCHECK --interval=20s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4780/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/fleet-core-entrypoint"]
CMD ["node", "packages/core/dist/cli.js"]
