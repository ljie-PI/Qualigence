# Self-hosted secret files

Place one file per secret in this directory before running Compose. Keep file
permissions restrictive (`chmod 600 secrets/*`) and never commit real secret
values. The directory is git-ignored; this README is the only tracked file.

Required files:

- `pg_admin_password`
- `pg_server_password`
- `pg_worker_password`
- `s3_access_key_id`
- `s3_secret_access_key`
- `kms_root_key` (32-byte KMS root key encoded as base64; the Admin CLI also tolerates raw or hex during maintenance)
- `oidc_claim_map.json`
- `runner_ca_cert.pem`
- `runner_ca_key.pem`
- `runner_server_cert.pem`
- `runner_server_key.pem`
- `worker_model_api_key`
- `tls_cert.pem`
- `tls_key.pem`

Production JWKS is configured with `QUALIGENCE_OIDC_JWKS_URI` in `.env`; do not
use a static JWKS secret as a production-ready path. A local `oidc_jwks.json`
file may be mounted only by explicit non-production test fixtures that also set
`SERVER_OIDC_ALLOW_STATIC_JWKS_NON_PRODUCTION=true`.

`runner_server_cert.pem` and `runner_server_key.pem` are the TLS identity for
the dedicated Runner gRPC listener. Sign that certificate with the Runner CA (or
another CA bundle trusted by enrolled Runners) and include a DNS/IP SAN matching
the hostname Runners use. Do not route Runner gRPC through the Caddy TLS
terminator; the Server must receive the Runner client certificate over mTLS.

The `server-volume-permissions` one-shot mounts no secrets. It touches only the
`artifactdata` and `skill_signing_data` named volumes before Server startup, and
its idempotent permission repair does not require mounting secret files. The
non-root Server can write Artifact ACK bytes and skill-signing keys while all
secret material remains file-mounted under `/run/secrets`.
