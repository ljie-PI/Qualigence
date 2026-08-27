# Qualigence Team Self-hosted deployment

A single-node Docker Compose topology for the **M2 Self-hosted** runtime
(PostgreSQL + S3-compatible object store + Runner enrollment), completing LS-11.
This is the multi-tenant Team stack — **not** the M1 single-tenant
`apps/local-launcher` (SQLite) target, which is a separate deployment.

## Topology

```
              ┌───────────────── proxy (Caddy, :443) ─────────────────┐
   client ──▶ │  TLS · strict CSP · /healthz · /api/readyz             │
              │    /api/*  ─▶ server:8080  (Public API, /v1/*)         │
              │    else    ─▶ console:8080 (static SPA bundle)         │
              └───────┬───────────────────────────────┬───────────────┘
                      │ internal network only          │
   runner ──mTLS────▶ ├──── server:50555 (Runner gRPC data plane)      │
                      │                                                │
             ┌────────▼────────┐              ┌─────────▼─────────┐
             │ server (Node)   │              │ worker (Node)     │
             │ Fastify /v1     │              │ Intelligence loop │
             │ Runner gRPC     │              │ readiness probe   │
             └───┬─────────┬───┘              └────┬─────────┬────┘
                 │         │                       │         │
           ┌─────▼───┐ ┌───▼──────┐          ┌─────▼───┐ ┌───▼──────┐
           │postgres │ │artifact  │          │postgres │ │  minio   │
           │  :5432  │ │ dataplane│          │  :5432  │ │  :9000   │
           └─────────┘ └──────────┘          └─────────┘ └──────────┘
```

- The proxy is the only public **HTTP** entrypoint (`:443`). Ticket 12 also
  publishes exactly one dedicated Runner gRPC host port (default `:50555`) so
  the Server receives the Runner's mTLS peer certificate directly. PostgreSQL
  and MinIO have **no** host ports.
- Runners connect **into** the Server over end-to-end mTLS using the enrollment
  CA (`runner_ca_*` plus `runner_server_*` TLS secrets); the Server's public HTTP
  routes are reached through the proxy under `/api`.
- The Server's Runner Artifact ACK data plane uses the durable `artifactdata`
  named volume mounted at `/var/lib/qualigence/artifacts`; readiness writes and
  reads that same store. MinIO remains private object-storage infrastructure,
  but it is not reported as the Runner Artifact ACK store in this Ticket 12
  topology.
- Skill-signing state uses the durable `skill_signing_data` named volume mounted
  at `/var/lib/qualigence/skill-signing`, so Server startup satisfies the
  read-only root filesystem constraint and survives container restart.
- Before the non-root, read-only Server starts, the one-shot
  `server-volume-permissions` Compose service runs as root with no network or
  public ports and only the `CHOWN` capability. It mounts only `artifactdata`
  and `skill_signing_data`, creates the Server state directories, temporarily
  restores directory ownership to root so mode correction is permitted, then
  chowns them back to the image's `node` user. The preparation is idempotent for
  retained volumes, so Artifact ACK bytes and skill-signing keys stay writable
  without widening the Server runtime privileges.
- The Console is a **static asset image** (Vite `dist/` served by Caddy), never
  a Node process.

## Security posture

- Every third-party image is **pinned by digest**; `latest` is never used.
- Application containers run **non-root**, **read-only root filesystem**,
  `cap_drop: ALL`, `no-new-privileges:true`, with CPU/memory/PID and
  log-rotation limits.
- **All secrets are file mounts** at `/run/secrets/*` (see
  [`secrets/README.md`](secrets/README.md)); no secret value is ever an
  environment variable or an image layer.
- The proxy sets the frozen strict CSP
  (`default-src 'self'; …; object-src 'none'; base-uri 'none';
  frame-ancestors 'none'`) plus `Referrer-Policy: no-referrer` and HSTS.

## Build the images

```sh
# From the repository root:
docker build -t qualigence/self-hosted:0.1.0 .
docker build -t qualigence/self-hosted-console:0.1.0 \
  -f deployments/self-hosted/docker/console.Dockerfile .
```

The Node image is role-dispatched by
[`docker/entrypoint.sh`](docker/entrypoint.sh):
`server` · `worker` · `migrate` · `doctor` · `backup` · `restore`.

## First bring-up

```sh
cd deployments/self-hosted/compose
cp .env.example .env                 # edit non-secret config
# populate ./secrets/* per secrets/README.md, then chmod 600 secrets/*

docker compose run --rm migrate      # provision schema + forced RLS + roles
docker compose run --rm doctor       # verify DB/RLS/S3/KMS/Server health
docker compose up -d                 # first runs server-volume-permissions, then starts postgres, minio, server, worker, console, proxy
```

Open `https://<host>/` for the Console; `https://<host>/healthz` for liveness,
`https://<host>/api/readyz` for dependency/loop readiness, and configure external
Runners to connect to `grpcs://<host>:${QUALIGENCE_RUNNER_GRPC_PORT:-50555}`.
Readiness is intentionally stronger than liveness: Server readiness checks
PostgreSQL, object-storage reachability, the actual durable Runner Artifact
data-plane volume, Runner gRPC, Mission dispatch loops, and the Intelligence
Result consumer; Compose healthchecks also probe Worker, Console, and proxy
dependencies. Every `docker compose up` reruns the idempotent permission-prep
dependency against retained or recreated named volumes before Server startup.

## Backup, restore & upgrade runbook

Backups are **byte-complete** for the currently wired PostgreSQL and S3 object
contracts: a consistent PostgreSQL snapshot plus the real bytes of every S3
object, content-addressed and checksummed in a target-bound index. Operators
must preserve the `backups`, `artifactdata`, and `skill_signing_data` named
volumes according to the same retention policy; `restore` revalidates the
PostgreSQL dump and every copied S3 object before it reports success.

```sh
# Consistent point-in-time backup into the `backups` volume.
docker compose run --rm backup

# --- Upgrade / rollback (binary-only rollback; never migrate down) ---
# 1. Take a fresh backup (above).
# 2. Pull/build the new image tag, update QUALIGENCE_IMAGE_TAG in .env.
# 3. docker compose run --rm migrate      # forward-only migration
# 4. docker compose up -d
# 5. docker compose run --rm doctor       # confirm green
# If the new binary misbehaves, roll the IMAGE TAG back and `up -d` again.
# Never run a down-migration; restore from backup instead if the schema moved.

# --- Disaster recovery: restore into a clean environment ---
docker compose down                       # stop app containers
# Keep backups, artifactdata, and skill_signing_data. Recreate only the DB and
# object-store backing volumes for a clean target.
docker volume rm qualigence-self-hosted_pgdata qualigence-self-hosted_miniodata
docker compose up -d postgres minio        # empty DB + object store
# restore provisions the configured empty object bucket if miniodata was recreated,
# verifies every backup byte before mutating, then restores DB + objects and
# re-verifies byte-for-byte.
docker compose run --rm restore
docker compose run --rm doctor
docker compose up -d
```

`restore` validates the entire backup (SQL dump + every object checksum) **before**
touching the target, re-uploads objects, reads each back and re-verifies its
sha256/size, and asserts forced row-level security survived the restore.

## Testing note (sandbox)

The focused non-E2E Gate validates the Compose config and component-level Server
wiring. Post-review acceptance lives under `tests/e2e/self-hosted/`: it must run
with Docker available, fail as `DockerUnavailable` when Docker is absent, assert
this Compose topology's security/durability invariants, and use an external
Runner process rather than in-process Server/Runner substitutes for completion
evidence.
