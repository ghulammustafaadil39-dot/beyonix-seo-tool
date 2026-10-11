#!/bin/sh
# C-06: database backup script.
#
# D4-H-1: pure POSIX sh — the backup sidecar runs on postgres:16-alpine,
# which has NO bash (busybox sh only). The old `#!/usr/bin/env bash`
# shebang plus bash-only arrays/[[ ]] made the sidecar crash-loop with
# zero backups on a wiped-machine deploy.
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
set -eu

OUT="${1:?usage: backup.sh <output-file> [extra pg_dump args...]}"
shift

: "${DATABASE_URL:?DATABASE_URL must be set}"

# B2-L3: split DATABASE_URL into PG* env vars — the password must never
# appear as a command-line argument (visible via `ps`).
# shellcheck source=_pg_env.sh
. "$(dirname "$0")/_pg_env.sh"

if [ "$#" -eq 0 ]; then
  set -- --format=custom --compress=6
fi

mkdir -p "$(dirname "$OUT")"
pg_dump "$@" --file="$OUT"

# Integrity check: a custom-format archive must list cleanly.
case "$OUT" in
  *.dump)
    pg_restore --list "$OUT" > /dev/null
    echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"
    ;;
  *)
    echo "backup ok: $OUT"
    ;;
esac
