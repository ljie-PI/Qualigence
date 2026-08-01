# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Qualigence Web Console static-asset image.
#
# The Console is a static SPA (Vite build). This image builds the immutable
# bundle and serves it with Caddy's file server (SPA fallback to index.html) on
# an internal port. The edge reverse proxy (deployments/self-hosted/compose)
# terminates TLS, applies the strict CSP and routes /api/* to the Server while
# everything else is proxied to this static image. There is NO Node process for
# the Console at runtime.
# ---------------------------------------------------------------------------

FROM node:24-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /workspace
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages ./packages
COPY apps ./apps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --config.trust-lockfile=true
COPY tsconfig.base.json tsconfig.json ./
RUN pnpm --filter @qualigence/web-console run build

# ---- Runtime: a lightweight static file server -------------------------------
FROM caddy:2.8-alpine@sha256:af32e97399febea808609119bb21544d0265c58a02836576e32a2d082c262c17 AS runtime
COPY --from=build /workspace/apps/web-console/dist /srv
COPY deployments/self-hosted/docker/console.Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080
