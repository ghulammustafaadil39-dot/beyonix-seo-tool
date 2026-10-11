#!/usr/bin/env bash
# B2-L3: splits DATABASE_URL into PG* env vars so pg_dump / pg_restore /
# psql never receive the credential-bearing URL as a command-line argument
# (visible to other local users via `ps`). Source from backup.sh/restore.sh:
#
#   # shellcheck source=_pg_env.sh
#   source "$(dirname "$0")/_pg_env.sh"
#
# Sets PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE and unsets DATABASE_URL
# in the calling shell. Handles percent-encoded userinfo and passwords
# containing '@' (split on the LAST '@'). IPv6 host literals are not
# supported — use a hostname.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"

_pg_urldecode() {
  local s="${1//+/ }"
  printf '%b' "${s//%/\\x}"
}

_pg_rest="${DATABASE_URL#*://}" # strip scheme
if [[ "$_pg_rest" == *"@"* ]]; then
  _pg_userinfo="${_pg_rest%@*}" # up to the LAST '@'
  _pg_rest="${_pg_rest##*@}"   # host part after the LAST '@'
  _pg_user="${_pg_userinfo%%:*}"
  if [[ "$_pg_userinfo" == *":"* ]]; then
    _pg_pass="${_pg_userinfo#*:}"
  else
    _pg_pass=""
  fi
  export PGUSER="$(_pg_urldecode "$_pg_user")"
  export PGPASSWORD="$(_pg_urldecode "$_pg_pass")"
fi
_pg_hostport="${_pg_rest%%/*}"
_pg_db="${_pg_rest#*/}"
_pg_db="${_pg_db%%\?*}" # strip query string
export PGHOST="${_pg_hostport%%:*}"
if [[ "$_pg_hostport" == *":"* ]]; then
  export PGPORT="${_pg_hostport##*:}"
fi
export PGDATABASE="$(_pg_urldecode "$_pg_db")"

# Scrub the URL-bearing variable so `ps`/`set` in this shell can't leak it.
unset DATABASE_URL
unset _pg_rest _pg_userinfo _pg_user _pg_pass _pg_hostport _pg_db
unset -f _pg_urldecode
