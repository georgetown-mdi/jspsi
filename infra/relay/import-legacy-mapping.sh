#!/bin/bash
# Carry the exchange-key mapping an install from before the secrets table's
# own mapping kept as a text file into the table, and delete the file once the
# table, read back, accounts for every row of it.
#
#   import-legacy-mapping.sh
#
# The file holds every key in plaintext, so it is deleted rather than kept. A
# copy an earlier install set aside as exchange-keys.imported is checked the
# same way and deleted, never imported again: an exchange revoked since would
# come back. install.sh runs this once coturn has created the table.
#
# Exit status: 0 nothing to carry, or every file carried and deleted; 4 the
# table does not account for a row, and that file is kept; anything else the
# import failed, and the file is kept untouched.
set -uo pipefail

if [ "$#" -ne 0 ]; then
  printf 'usage: import-legacy-mapping.sh\n' >&2
  exit 2
fi
# shellcheck source=exchange-keys.sh
. "$(cd "$(dirname "$0")" && pwd)/exchange-keys.sh"

MAP_FILE="${ALCOVE_RELAY_LEGACY_MAPPING:-$ETC/exchange-keys}"
SET_ASIDE="$MAP_FILE.imported"

# Runs one relay_table.py command over a file, and deletes the file only when
# the command's own read-back succeeded.
carry() {
  local command="$1" file="$2" status=0
  relay_table "$command" "$file" < /dev/null || status=$?
  if [ "$status" -ne 0 ]; then
    printf 'kept %s, unchanged: it still holds exchange keys in plaintext\n' "$file" >&2
    return "$status"
  fi
  if ! rm -f "$file"; then
    printf 'could not delete %s, which holds exchange keys in plaintext; delete it by hand\n' "$file" >&2
    return 1
  fi
  printf 'deleted %s\n' "$file"
}

result=0
if [ -f "$MAP_FILE" ]; then
  carry import-mapping "$MAP_FILE" || result=$?
  [ "$result" -ne 0 ] || rm -f "$(dirname "$MAP_FILE")/exchange-keys.lock"
fi
if [ "$result" -eq 0 ] && [ -f "$SET_ASIDE" ]; then
  carry check-mapping "$SET_ASIDE" || result=$?
fi
exit "$result"
