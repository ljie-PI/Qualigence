# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Qualigence Self-hosted application image.
#
# One immutable OCI image runs the Server, the Intelligence Worker and every
# admin operation (migrate / doctor / backup / restore). The role is selected by
# the entrypoint command:
#   docker run <image> server|worker|migrate|doctor|backup|restore
#
# Runtime layers copy only production deploy roots produced by
# `corepack pnpm deploy --prod`; source workspaces, tests, the pnpm store and
# root development node_modules never enter the final image.
# ---------------------------------------------------------------------------

FROM node:24-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /workspace

# ---- Dependencies -------------------------------------------------------------
FROM base AS deps
# Native workspace deps (for example better-sqlite3 in local-only packages) need
# a compiler during install. Build tools live only in this builder stage.
RUN apt-get update \
    && apt-get install --no-install-recommends -y python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages ./packages
COPY apps ./apps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    corepack pnpm install --frozen-lockfile --config.trust-lockfile=true

# ---- Build and production deploy roots ---------------------------------------
FROM deps AS build
COPY tsconfig.base.json tsconfig.json tsconfig.test.json vitest.config.ts ./
RUN corepack pnpm build
RUN corepack pnpm --filter @qualigence/server deploy --prod /out/server
RUN corepack pnpm --filter @qualigence/intelligence-worker deploy --prod /out/worker
RUN corepack pnpm --filter @qualigence/admin-cli deploy --prod /out/admin
RUN find /out -mindepth 2 -maxdepth 2 -type d \( -name src -o -name test -o -name tests -o -name __tests__ \) -prune -exec rm -rf {} + \
    && find /out -path '/out/*/node_modules/@qualigence/*/src' -type d -prune -exec rm -rf {} + \
    && find /out -type d \( -name test -o -name tests -o -name __tests__ \) -prune -exec rm -rf {} + \
    && find /out -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.map' -o -name '*.tsbuildinfo' \) -delete

# ---- Runtime ------------------------------------------------------------------
FROM node:24-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS runtime
ENV NODE_ENV=production
# The admin role's backup/restore commands shell out to the real PostgreSQL
# client binaries; install only those, then drop back to the unprivileged user.
RUN apt-get update \
    && apt-get install --no-install-recommends -y postgresql-client tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /out/server /app/server
COPY --from=build --chown=node:node /out/worker /app/worker
COPY --from=build --chown=node:node /out/admin /app/admin
COPY --chown=node:node deployments/self-hosted/docker/entrypoint.sh /usr/local/bin/qualigence-entrypoint
RUN chmod +x /usr/local/bin/qualigence-entrypoint
USER node
ENTRYPOINT ["tini", "--", "/usr/local/bin/qualigence-entrypoint"]
CMD ["server"]
