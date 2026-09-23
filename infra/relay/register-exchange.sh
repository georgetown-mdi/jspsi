#!/bin/bash
# Register one exchange's relay key in the relay's secrets table.
#
#   register-exchange.sh <exchange-id> <key-hex64>
#
# The key is the exchange's relay key (docs/spec/PROTOCOL.md, Relay credential
# derivation). coturn reads the table per request, so a credential minted under
# it authenticates from the next allocation on, with no restart. An exchange
# already registered has its new key added before its prior key is removed, so
# both keys allocate for a moment and the exchange is never left without one.
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
if [ "$PRIOR" = "$KEY" ]; then
  printf 'exchange %s (realm %s) already has this key registered\n' "$ID" "$REALM"
  exit 0
fi

turnadmin -s "$KEY" >/dev/null || die "could not add exchange $ID's key to the secrets table"
write_mapping "$ID" "$KEY" ||
  die "added exchange $ID's new key to the secrets table, but could not record it in $MAP_FILE, which is unchanged; the new key authenticates until removed: $(list_table_hint) and remove with turnadmin -X, the same way, the one key no line of $MAP_FILE holds"

if [ -z "$PRIOR" ]; then
  printf 'registered exchange %s (realm %s)\n' "$ID" "$REALM"
  exit 0
fi
turnadmin -X "$PRIOR" >/dev/null ||
  die "registered exchange $ID's new key and pointed $MAP_FILE at it, but could not remove its prior key from the secrets table, where it still authenticates: $(list_table_hint) and remove with turnadmin -X, the same way, the one key no line of $MAP_FILE holds"
printf 'registered exchange %s (realm %s), replacing its prior key\n' "$ID" "$REALM"
