#!/bin/bash
# Register one exchange's relay key in the relay's secrets table.
#
#   register-exchange.sh <exchange-id> <max-age-days|none>   key on stdin
#
# The key is the exchange's relay key (docs/spec/PROTOCOL.md, Relay credential
# derivation), read from standard input -- typed without echo at a terminal, or
# piped -- so it is never on a command line. coturn reads the table per request,
# so a credential minted under it authenticates from the next allocation on,
# with no restart. An exchange already registered has its prior key replaced in
# the same transaction. With a number of days, the sweep revokes the row that
# many days after this registration unless a later one replaces it; with none,
# it never lapses (README.md, Per-exchange keys). Registering the key the
# exchange already holds renews its row.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  printf 'usage: register-exchange.sh <exchange-id> <max-age-days|none>   (the key on standard input)\n' >&2
  exit 2
fi
# shellcheck source=exchange-keys.sh
. "$(cd "$(dirname "$0")" && pwd)/exchange-keys.sh"

read_key
printf '%s\n' "$KEY" | relay_table register "$1" "$2"
