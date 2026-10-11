#!/bin/sh
# B2-L3: splits DATABASE_URL into PG* env vars so pg_dump / pg_restore /
# psql never receive the credential-bearing URL as a command-line argument
# (visible to other local users via `ps`). Source from backup.sh/restore.sh:
#
#   # shellcheck source=_pg_env.sh
#   . "$(dirname "$0")/_pg_env.sh"
#
# Sets PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE and unsets DATABASE_URL
# in the calling shell. Handles percent-encoded userinfo and passwords
# containing '@' (split on the LAST '@'). IPv6 host literals are not
# supported — use a hostname.
#
# D4-H-1: pure POSIX sh — the backup sidecar runs on postgres:16-alpine,
# which has NO bash (busybox sh only). No [[ ]], no arrays, no ${var//},
# no `local`, no `source`, no pipefail.
set -eu

: "${DATABASE_URL:?DATABASE_URL must be set}"

_pg_urldecode() {
  # Percent-decode a URL component. '+' -> space; valid %HH hex escapes
  # become the corresponding byte. Malformed '%' sequences (no valid hex
  # after them) are passed through literally.
  #
  # D4-H-1: POSIX sh only. Implemented in awk (a POSIX-mandated utility —
  # present in postgres:16-alpine's busybox): dash and busybox sh do NOT
  # expand \xHH in printf %b (a bash-ism the old script relied on), and
  # expr(1) is unsuitable (it exits 1 whenever a result is "0", which
  # `set -e` turns into a crash — e.g. decoding %40's second digit).
  printf '%s' "$1" | awk '
    {
      s = $0; out = ""
      while (length(s) > 0) {
        c = substr(s, 1, 1)
        if (c == "+") { out = out " "; s = substr(s, 2) }
        else if (c == "%") {
          h = substr(s, 2, 2)
          if (h ~ /^[0-9A-Fa-f][0-9A-Fa-f]$/) {
            d = 0
            for (i = 1; i <= 2; i++) {
              v = index("0123456789ABCDEF", toupper(substr(h, i, 1))) - 1
              d = d * 16 + v
            }
            out = out sprintf("%c", d)
            s = substr(s, 4)
          } else { out = out "%"; s = substr(s, 2) }
        }
        else { out = out c; s = substr(s, 2) }
      }
      printf "%s", out
    }'
}

_pg_rest="${DATABASE_URL#*://}" # strip scheme
case "$_pg_rest" in
  *"@"*)
    _pg_userinfo="${_pg_rest%@*}" # up to the LAST '@'
    _pg_rest="${_pg_rest##*@}"   # host part after the LAST '@'
    _pg_user="${_pg_userinfo%%:*}"
    case "$_pg_userinfo" in
      *":"*) _pg_pass="${_pg_userinfo#*:}" ;;
      *) _pg_pass="" ;;
    esac
    PGUSER="$(_pg_urldecode "$_pg_user")"
    PGPASSWORD="$(_pg_urldecode "$_pg_pass")"
    export PGUSER PGPASSWORD
    ;;
esac
_pg_hostport="${_pg_rest%%/*}"
_pg_db="${_pg_rest#*/}"
_pg_db="${_pg_db%%\?*}" # strip query string
PGHOST="${_pg_hostport%%:*}"
export PGHOST
case "$_pg_hostport" in
  *":"*)
    PGPORT="${_pg_hostport##*:}"
    export PGPORT
    ;;
esac
PGDATABASE="$(_pg_urldecode "$_pg_db")"
export PGDATABASE

# Scrub the URL-bearing variable so `ps`/`set` in this shell can't leak it.
unset DATABASE_URL
unset _pg_rest _pg_userinfo _pg_user _pg_pass _pg_hostport _pg_db
unset -f _pg_urldecode
