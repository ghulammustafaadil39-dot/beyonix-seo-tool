#!/usr/bin/env bash
# C-06: database restore script.
#
# Usage:
#   DATABASE_URL=<target> ./scripts/restore.sh <backup-file> [extra restore args...]
#
# The target database is taken from DATABASE_URL (NEVER default it: restoring
# into the wrong database is a data-loss event). For custom-format archives
# this runs pg_restore; for plain-SQL dumps it runs psql.
#
# Examples:
#   DATABASE_URL=postgres://bseo@/bseo_restore ./scripts/restore.sh /backups/bseo-2026-10-11.dump
#   DATABASE_URL=... ./scripts/restore.sh /tmp/probe.sql -t restore_probe
set -euo pipefail

IN="${1:?usage: restore.sh <backup-file> [extra restore args...]}"
shift

: "${DATABASE_URL:?DATABASE_URL must be set — refusing to guess the restore target}"
[[ -f "$IN" ]] || { echo "restore: file not found: $IN" >&2; exit 1; }

if head -c 5 "$IN" | grep -q "PGDMP"; then
  # Custom format: drop-and-recreate objects from the archive. --if-exists
  # keeps --clean idempotent; --no-owner avoids superuser-only ALTER OWNER.
  pg_restore --clean --if-exists --no-owner --no-privileges \
    --dbname="$DATABASE_URL" "$@" "$IN"
else
  # Plain SQL dump: replay through psql. ON_ERROR_STOP so a partial
  # restore fails loudly instead of silently half-applying.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@" -f "$IN"
fi

echo "restore ok: $IN -> ${DATABASE_URL%@*}@<redacted>"
