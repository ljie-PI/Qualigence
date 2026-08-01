# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Qualigence Self-hosted Node image.
#
# One immutable OCI image runs the Server, the Intelligence Worker and every
# admin operation (migrate / doctor / backup / restore) — the role is selected
# by the entrypoint command, exactly as the design pins it:
#   docker run <image> server|worker|migrate|doctor|backup|restore
#
# The Web Console is NOT a Node process; it is a static bundle served by the
# reverse proxy (see deployments/self-hosted/docker/console.Dockerfile).
# ---------------------------------------------------------------------------

# Base image pinned by digest — never `latest`, so the deployment records an
# immutable provenance for the runtime.
FROM node:24-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /workspace

# ---- Dependencies -------------------------------------------------------------
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
# Copy every workspace manifest so the lockfile resolves without the sources.
COPY packages ./packages
COPY apps ./apps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --config.trust-lockfile=true

# ---- Build --------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json tsconfig.json tsconfig.test.json vitest.config.ts ./
RUN pnpm build

# ---- Runtime ------------------------------------------------------------------
FROM node:24-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS runtime
ENV NODE_ENV=production
# The admin role's backup/restore commands shell out to the real PostgreSQL
# client binaries; install only those, then drop back to the unprivileged user.
RUN apt-get update \
    && apt-get install --no-install-recommends -y postgresql-client tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /workspace /app
COPY --chown=node:node deployments/self-hosted/docker/entrypoint.sh /usr/local/bin/qualigence-entrypoint
RUN chmod +x /usr/local/bin/qualigence-entrypoint
USER node
ENTRYPOINT ["tini", "--", "/usr/local/bin/qualigence-entrypoint"]
CMD ["server"]
