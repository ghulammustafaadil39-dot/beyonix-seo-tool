#!/usr/bin/env bash
# C-06: database backup script.
#
# Usage:
#   DATABASE_URL=... ./scripts/backup.sh <output-file> [extra pg_dump args...]
#
# Examples:
#   ./scripts/backup.sh /backups/bseo-2026-10-11.dump
#   ./scripts/backup.sh /tmp/probe.sql -t restore_probe --format=plain
#
# Full backups default to pg_dump's custom format (-Fc): compressed,
# restorable table-by-table with pg_restore. The script refuses to run
# without DATABASE_URL and verifies the archive with pg_restore --list.
set -euo pipefail

OUT="${1:?usage: backup.sh <output-file> [extra pg_dump args...]}"
shift

: "${DATABASE_URL:?DATABASE_URL must be set}"

# B2-L3: split DATABASE_URL into PG* env vars — the password must never
# appear as a command-line argument (visible via `ps`).
# shellcheck source=_pg_env.sh
source "$(dirname "$0")/_pg_env.sh"

EXTRA=("$@")
if [[ ${#EXTRA[@]} -eq 0 ]]; then
  EXTRA=(--format=custom --compress=6)
fi

mkdir -p "$(dirname "$OUT")"
pg_dump "${EXTRA[@]}" --file="$OUT"

# Integrity check: a custom-format archive must list cleanly.
if [[ "$OUT" == *.dump ]]; then
  pg_restore --list "$OUT" > /dev/null
  echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"
else
  echo "backup ok: $OUT"
fi
