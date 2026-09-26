#!/bin/bash
# Carry the exchange-key mapping an install from before the secrets table's
# own mapping kept as a text file into the table, and delete the file once the
# table, read back, accounts for every row of it.
#
#   import-legacy-mapping.sh
#
# The file holds every key in plaintext, so it is deleted rather than kept.
# It is imported at most once: once the import has landed, a file the table
# does not account for is moved to exchange-keys.imported, and that copy is
# only ever checked the same way and deleted, never imported again, since an
# exchange revoked or swept since would come back. install.sh runs this once
# coturn has created the table.
#
# Exit status: 0 nothing to carry, or every file carried and deleted; 4 the
# table does not account for a row, and the file is kept as
# exchange-keys.imported; anything else the import failed, and the file is
# kept untouched.
set -uo pipefail

if [ "$#" -ne 0 ]; then
  printf 'usage: import-legacy-mapping.sh\n' >&2
  exit 2
fi
# shellcheck source=exchange-keys.sh
. "$(cd "$(dirname "$0")" && pwd)/exchange-keys.sh"

MAP_FILE="${ALCOVE_RELAY_LEGACY_MAPPING:-$ETC/exchange-keys}"
SET_ASIDE="$MAP_FILE.imported"

# Moves a file whose import landed to the set-aside name, so no later run
# imports it again; a set-aside copy already there keeps its rows, and the
# file's own are appended after them.
set_aside() {
  local file="$1"
  if [ -e "$SET_ASIDE" ]; then
    if [ -n "$(tail -c 1 "$SET_ASIDE")" ] && ! printf '\n' >> "$SET_ASIDE"; then
      return 1
    fi
    cat "$file" >> "$SET_ASIDE" && rm -f "$file"
  else
    mv "$file" "$SET_ASIDE"
  fi
}

result=0
if [ -f "$MAP_FILE" ]; then
  relay_table import-mapping "$MAP_FILE" < /dev/null || result=$?
  case "$result" in
    0)
      if ! rm -f "$MAP_FILE"; then
        printf 'could not delete %s, which holds exchange keys in plaintext; delete it by hand\n' "$MAP_FILE" >&2
        exit 1
      fi
      printf 'deleted %s\n' "$MAP_FILE"
      rm -f "$(dirname "$MAP_FILE")/exchange-keys.lock"
      ;;
    4)
      if ! set_aside "$MAP_FILE"; then
        printf 'could not move %s to %s; move it by hand before the next run, which would otherwise import it again\n' "$MAP_FILE" "$SET_ASIDE" >&2
        exit 1
      fi
      printf 'moved %s to %s, which still holds exchange keys in plaintext: fix the rows named above there, and the next run checks it rather than importing it again\n' "$MAP_FILE" "$SET_ASIDE" >&2
      exit 4
      ;;
    *)
      printf 'kept %s, unchanged: it still holds exchange keys in plaintext\n' "$MAP_FILE" >&2
      exit "$result"
      ;;
  esac
fi
if [ -f "$SET_ASIDE" ]; then
  relay_table check-mapping "$SET_ASIDE" < /dev/null || result=$?
  if [ "$result" -ne 0 ]; then
    printf 'kept %s, unchanged: it still holds exchange keys in plaintext\n' "$SET_ASIDE" >&2
    exit "$result"
  fi
  if ! rm -f "$SET_ASIDE"; then
    printf 'could not delete %s, which holds exchange keys in plaintext; delete it by hand\n' "$SET_ASIDE" >&2
    exit 1
  fi
  printf 'deleted %s\n' "$SET_ASIDE"
fi
exit 0
