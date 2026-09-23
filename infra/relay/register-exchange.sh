#!/bin/bash
# Register one exchange's relay key in the relay's secrets table.
#
#   register-exchange.sh <exchange-id> <key-hex64>
#
# The key is the exchange's relay key (docs/spec/PROTOCOL.md, Relay credential
# derivation). coturn reads the table per request, so a credential minted under
# it authenticates from the next allocation on, with no restart. An exchange
# already registered has its prior key removed first, so the relay holds only
# the current one.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  printf 'usage: register-exchange.sh <exchange-id> <key-hex64>\n' >&2
  exit 2
fi
# shellcheck source=exchange-keys.sh
. "$(cd "$(dirname "$0")" && pwd)/exchange-keys.sh"

ID="$1"
KEY="$2"
check_exchange_id "$ID"
check_key "$KEY"

HOLDER="$(id_of_key "$KEY")"
if [ -n "$HOLDER" ] && [ "$HOLDER" != "$ID" ]; then
  die "key-hex64 is already registered for exchange $HOLDER; revoke that exchange first"
fi

PRIOR="$(key_of "$ID")"
if [ -n "$PRIOR" ]; then
  turnadmin -X "$PRIOR" >/dev/null || die "could not remove exchange $ID's prior key from the secrets table"
  write_mapping "$ID"
fi
turnadmin -s "$KEY" >/dev/null || die "could not add exchange $ID's key to the secrets table"
write_mapping "$ID" "$KEY"

if [ -n "$PRIOR" ]; then
  printf 'registered exchange %s (realm %s), replacing its prior key\n' "$ID" "$REALM"
else
  printf 'registered exchange %s (realm %s)\n' "$ID" "$REALM"
fi
