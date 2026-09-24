#!/bin/bash
# Shared by register-exchange.sh, revoke-exchange.sh, sweep-exchanges.sh, and
# verify.sh; sourced, not run. Loads relay.env and runs relay_table.py beside
# this file, which holds every read and write of the secrets table
# (README.md, Per-exchange keys).

ETC=/etc/psilink-relay
ENV_FILE="${PSILINK_RELAY_ENV_FILE:-$ETC/relay.env}"
RELAY_TABLE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/relay_table.py"

die() { printf 'ABORTING: %s\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "no $ENV_FILE; this host has not been installed as a relay"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

relay_table() {
  python3 -B "$RELAY_TABLE" "$@"
}

# Reads one exchange's key into KEY: without echo from a terminal, otherwise
# the first line of standard input.
read_key() {
  KEY=
  if [ -t 0 ]; then
    IFS= read -rs -p 'key-hex64 (not echoed): ' KEY || true
    printf '\n' >&2
  else
    IFS= read -r KEY || true
  fi
}
