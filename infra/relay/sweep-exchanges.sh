#!/bin/bash
# Revoke every exchange whose registration has lapsed.
#
#   sweep-exchanges.sh
#
# A row registered with a max-age-days lapses that many days after its
# registration; the exchange's next registration replaces the row and restarts
# the count, so an exchange that keeps running is never swept. A row registered
# with none never lapses. psilink-relay-sweep.timer runs the same sweep hourly.
# One transaction, so a registration cannot land between finding a lapsed row
# and revoking it.
set -euo pipefail

if [ "$#" -ne 0 ]; then
  printf 'usage: sweep-exchanges.sh\n' >&2
  exit 2
fi
# shellcheck source=exchange-keys.sh
. "$(cd "$(dirname "$0")" && pwd)/exchange-keys.sh"

relay_table sweep < /dev/null
