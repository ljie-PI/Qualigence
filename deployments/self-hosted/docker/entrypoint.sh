#!/bin/sh
# Role dispatcher for the immutable Qualigence Node image. The first argument
# selects the process; migrate/doctor/backup/restore forward their remaining
# arguments to the admin CLI. An unknown role fails closed.
set -eu

role="${1:-server}"
shift || true

case "$role" in
  server)
    exec node /app/apps/server/dist/main.js "$@"
    ;;
  worker)
    exec node /app/apps/intelligence-worker/dist/main.js "$@"
    ;;
  migrate | doctor | backup | restore)
    exec node /app/apps/admin-cli/dist/main.js "$role" "$@"
    ;;
  *)
    echo "unknown role: $role (expected server|worker|migrate|doctor|backup|restore)" >&2
    exit 64
    ;;
esac
