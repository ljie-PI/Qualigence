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
- `kms_root_key`
- `oidc_jwks.json`
- `oidc_claim_map.json`
- `runner_ca_cert.pem`
- `runner_ca_key.pem`
- `runner_server_cert.pem`
- `runner_server_key.pem`
- `worker_model_api_key`
- `tls_cert.pem`
- `tls_key.pem`

`runner_server_cert.pem` and `runner_server_key.pem` are the TLS identity for
the dedicated Runner gRPC listener. Sign that certificate with the Runner CA (or
another CA bundle trusted by enrolled Runners) and include a DNS/IP SAN matching
the hostname Runners use. Do not route Runner gRPC through the Caddy TLS
terminator; the Server must receive the Runner client certificate over mTLS.

The `server-volume-permissions` one-shot mounts no secrets. It touches only the
`artifactdata` and `skill_signing_data` named volumes before Server startup so
the non-root Server can write Artifact ACK bytes and skill-signing keys while
keeping all secret material file-mounted under `/run/secrets`.
