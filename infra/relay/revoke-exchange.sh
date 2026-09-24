#!/bin/bash
# Remove one exchange's relay key from the relay's secrets table.
#
#   revoke-exchange.sh <exchange-id>
#
# New allocations under the key are refused from the next request on. An
# allocation already open is not cut (infra/relay/README.md, Per-exchange keys).
set -euo pipefail

if [ "$#" -ne 1 ]; then
  printf 'usage: revoke-exchange.sh <exchange-id>\n' >&2
  exit 2
fi
# shellcheck source=exchange-keys.sh
. "$(cd "$(dirname "$0")" && pwd)/exchange-keys.sh"

ID="$1"
check_exchange_id "$ID"

KEY="$(key_of "$ID")"
[ -n "$KEY" ] || die "exchange-id $ID is not registered on this relay"
OUT="$(turnadmin -X "$KEY" 2>&1)" || true
LISTED=0
table_lists_key "$KEY" || LISTED=$?
if [ "$LISTED" -ne 1 ]; then
  show_turnadmin_output "$OUT" "$KEY"
  if [ "$LISTED" -eq 2 ]; then
    die "could not read the secrets table to confirm exchange $ID's key left it, so treat the key as still authenticating; $MAP_FILE keeps the exchange's line, so run revoke-exchange.sh $ID again once the table can be read"
  fi
  die "exchange $ID's key is still in the secrets table and still authenticates; $MAP_FILE keeps the exchange's line, so check that $DATA_DIR/turndb is writable by the relay image's account, then run revoke-exchange.sh $ID again"
fi
write_mapping "$ID" ||
  die "removed exchange $ID's key from the secrets table, but could not remove its line from $MAP_FILE; delete the line starting '$ID ' from that file by hand"
printf 'revoked exchange %s (realm %s)\n' "$ID" "$REALM"
