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

relay_table revoke "$1" < /dev/null
