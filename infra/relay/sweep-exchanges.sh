#!/bin/bash
# Revoke every exchange whose registration has lapsed.
#
#   sweep-exchanges.sh
#
# A row registered with a max-age-days lapses that many days after its
# registration; the exchange's next registration replaces the row and restarts
# the count, so an exchange that keeps running is never swept. A row registered
# without one never lapses. Run by psilink-relay-sweep.timer. Holds the mapping
# lock for the whole sweep, so a registration cannot land between finding a
# lapsed row and revoking it.
set -euo pipefail

if [ "$#" -ne 0 ]; then
  printf 'usage: sweep-exchanges.sh\n' >&2
  exit 2
fi
# shellcheck source=exchange-keys.sh
. "$(cd "$(dirname "$0")" && pwd)/exchange-keys.sh"

NOW="$(date -u +%s)"
mapfile -t LAPSED < <(lapsed_exchanges "$NOW")

SWEPT=0
FAILED=0
for ID in "${LAPSED[@]}"; do
  if revoke_exchange "$ID" < /dev/null; then
    printf 'revoked exchange %s (realm %s): its registration lapsed\n' "$ID" "$REALM"
    SWEPT=$((SWEPT + 1))
  else
    printf 'could not revoke lapsed exchange %s: %s\n' "$ID" "$REVOKE_ERROR" >&2
    FAILED=$((FAILED + 1))
  fi
done

printf 'swept %s lapsed exchange(s) (realm %s), %s failed\n' "$SWEPT" "$REALM" "$FAILED"
[ "$FAILED" -eq 0 ]
