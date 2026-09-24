#!/bin/bash
# Shared by register-exchange.sh, revoke-exchange.sh, and sweep-exchanges.sh;
# sourced, not run.
#
# coturn's turn_secret table is keyed (realm, value) and holds no exchange id,
# so the id -> key mapping lives beside it in a text file, one line per
# registered exchange (write_mapping below). It is root's alone, under the
# mode-700 /etc directory, rather than in the data directory the container's
# account can write.

ETC=/etc/psilink-relay
ENV_FILE="${PSILINK_RELAY_ENV_FILE:-$ETC/relay.env}"
IMAGE="${PSILINK_RELAY_IMAGE:-localhost/psilink-relay:installed}"

die() { printf 'ABORTING: %s\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "no $ENV_FILE; this host has not been installed as a relay"
# shellcheck disable=SC1090
. "$ENV_FILE"

REALM="${PSILINK_RELAY_REALM:-}"
[ -n "$REALM" ] || die "PSILINK_RELAY_REALM is unset in $ENV_FILE"
# A literal, as in the unit files that mount it.
DATA_DIR=/var/lib/psilink-relay
MAP_FILE="${PSILINK_RELAY_EXCHANGE_KEYS:-$ETC/exchange-keys}"
RUNTIME="${PSILINK_RELAY_RUNTIME:-}"
case "$RUNTIME" in
  podman|docker) ;;
  *) die "PSILINK_RELAY_RUNTIME is '$RUNTIME' in $ENV_FILE; install.sh records podman or docker there" ;;
esac

# No leading '-', so the id cannot be read as a flag, and no whitespace, so it
# stays one field of the mapping file. An id containing a run of 64 hex
# characters is refused, so a key passed in the id's place, alone or inside a
# longer id, is never registered as an id or printed back.
# The refusals do not print the value.
check_exchange_id() {
  case "$1" in
    ''|-*|*[!A-Za-z0-9._-]*)
      die "exchange-id must be 1 to 128 of [A-Za-z0-9._-], not starting with '-'" ;;
  esac
  [ "${#1}" -le 128 ] || die "exchange-id is ${#1} characters; the limit is 128"
  if printf '%s\n' "$1" | LC_ALL=C grep -Eq '[0-9A-Fa-f]{64}'; then
    die "exchange-id contains a run of 64 hex characters, the shape of a relay key; give the exchange's id there, and its key only as register-exchange.sh's second argument"
  fi
}

# The form coturn HMACs as ASCII (docs/spec/PROTOCOL.md, Relay credential
# derivation).
check_key() {
  case "$1" in
    *[!0-9a-f]*|'') die "key-hex64 must be 64 lowercase hex characters [0-9a-f]" ;;
  esac
  [ "${#1}" -eq 64 ] || die "key-hex64 must be 64 lowercase hex characters; got ${#1}"
}

# A row's lapse in whole days: the managed-exchange record's tokenMaxAgeDays,
# whose ceiling is MAX_TOKEN_MAX_AGE_DAYS in packages/core/src/config/connection.ts.
MAX_AGE_DAYS_CEILING=36500
check_max_age_days() {
  case "$1" in
    ''|0*|*[!0-9]*) die "max-age-days must be a whole number of days from 1 to $MAX_AGE_DAYS_CEILING" ;;
  esac
  { [ "${#1}" -le "${#MAX_AGE_DAYS_CEILING}" ] && [ "$1" -le "$MAX_AGE_DAYS_CEILING" ]; } ||
    die "max-age-days must be a whole number of days from 1 to $MAX_AGE_DAYS_CEILING"
}

# The relay image's own turnadmin against the SQLite file the server reads. It
# runs as the image's account, which owns DATA_DIR, so the file it creates on
# first use is one the server can read.
turnadmin() {
  "$RUNTIME" run --rm --network none -v "$DATA_DIR:/var/lib/coturn" \
    --entrypoint turnadmin "$IMAGE" "$@" -r "$REALM" -b /var/lib/coturn/turndb
}

# turnadmin exits 0 when a write fails, printing its error to stdout, so a write
# is judged by listing the table afterwards. The listing is one "<key>[<realm>]"
# line per row and holds every key, so it stays in a variable and is never
# printed. Returns 0 when the key is listed, 1 when it is not, and 2 when the
# table could not be read.
table_lists_key() {
  local listing errors rows
  listing="$(turnadmin -S 2>&1)" || return 2
  errors="$(printf '%s\n' "$listing" | grep -vF -- "[$REALM]" | grep -c ERROR || true)"
  [ "$errors" -eq 0 ] || return 2
  rows="$(printf '%s\n' "$listing" | grep -cxF -- "$1[$REALM]" || true)"
  [ "$rows" -gt 0 ]
}

# Prints a table write's captured output, which holds coturn's own error line,
# to stderr with every occurrence of the key replaced.
show_turnadmin_output() {
  [ -z "$1" ] || printf '%s\n' "${1//"$2"/<key>}" >&2
}

# Every comparison is between concatenations, which awk compares as strings: a
# bare field or -v value that looks numeric compares numerically, so "1.0"
# would match "1" and "01" would match "1e0".
key_of() {
  [ -f "$MAP_FILE" ] || return 0
  awk -v id="$1" '($1 "") == (id "") { print $2 }' "$MAP_FILE"
}

id_of_key() {
  [ -f "$MAP_FILE" ] || return 0
  awk -v key="$1" '($2 "") == (key "") { print $1 }' "$MAP_FILE"
}

# Rewrites the mapping without the exchange's line, plus
# "<id> <key> <registered-at> <max-age-days>" when a key is given, through a
# mode-600 temporary so a failure leaves the prior mapping and no temporary.
# registered-at is the Unix time of the write; max-age-days is "-" for a row
# with no lapse, which lapsed_exchanges never lists.
write_mapping() {
  local id="$1" key="${2:-}" max_age_days="${3:--}" now tmp
  now="$(date -u +%s)" || return 1
  tmp="$(mktemp "$MAP_FILE.XXXXXX")" || return 1
  if ! {
    chmod 600 "$tmp" &&
      { [ ! -f "$MAP_FILE" ] || awk -v id="$id" '($1 "") != (id "")' "$MAP_FILE" > "$tmp"; } &&
      { [ -z "$key" ] || printf '%s %s %s %s\n' "$id" "$key" "$now" "$max_age_days" >> "$tmp"; } &&
      mv "$tmp" "$MAP_FILE"
  }; then
    rm -f "$tmp"
    return 1
  fi
}

# Removes a key from the table by its value, whether or not a mapping line holds
# it; turnadmin -X of a value the table does not hold exits 0 and changes
# nothing. Prints nothing, and returns as table_lists_key does: 1 once the key
# is gone, 0 while it is listed, 2 when the table could not be read.
remove_key_by_value() {
  turnadmin -X "$1" > /dev/null 2>&1 || true
  table_lists_key "$1"
}

# How to find and remove by hand a row no mapping line accounts for.
list_table_hint() {
  printf "list the table with '%s run --rm --network none -v %s:/var/lib/coturn --entrypoint turnadmin %s -S -r %s -b /var/lib/coturn/turndb', compare it against %s, and remove each listed key no line of %s holds with turnadmin -X, run the same way" \
    "$RUNTIME" "$DATA_DIR" "$IMAGE" "$REALM" "$MAP_FILE" "$MAP_FILE"
}

# Removes the exchange's key from the table, then its line from the mapping. On
# failure sets REVOKE_ERROR to the reason, which never names the key, and
# returns 1; the mapping keeps the line whenever the key may still be listed.
REVOKE_ERROR=
revoke_exchange() {
  local id="$1" key out listed=0
  key="$(key_of "$id")"
  if [ -z "$key" ]; then
    REVOKE_ERROR="exchange-id $id is not registered on this relay"
    return 1
  fi
  out="$(turnadmin -X "$key" 2>&1)" || true
  table_lists_key "$key" || listed=$?
  if [ "$listed" -ne 1 ]; then
    show_turnadmin_output "$out" "$key"
    if [ "$listed" -eq 2 ]; then
      REVOKE_ERROR="could not read the secrets table to confirm exchange $id's key left it, so treat the key as still authenticating; $MAP_FILE keeps the exchange's line, so run revoke-exchange.sh $id again once the table can be read"
    else
      REVOKE_ERROR="exchange $id's key is still in the secrets table and still authenticates; $MAP_FILE keeps the exchange's line, so check that $DATA_DIR/turndb is writable by the relay image's account, then run revoke-exchange.sh $id again"
    fi
    return 1
  fi
  if ! write_mapping "$id"; then
    REVOKE_ERROR="removed exchange $id's key from the secrets table, but could not remove its line from $MAP_FILE; delete the line starting '$id ' from that file by hand"
    return 1
  fi
}

# The ids whose row is at least its max-age-days old at the Unix time given. A
# row with no lapse ("-", or a line with no stamp) is never listed. Ages compare
# as numbers; ids are only printed, never compared.
lapsed_exchanges() {
  [ -f "$MAP_FILE" ] || return 0
  awk -v now="$1" '
    $3 ~ /^[0-9]+$/ && $4 ~ /^[0-9]+$/ && now - $3 >= $4 * 86400 { print $1 }
  ' "$MAP_FILE"
}

# One register, revoke, or sweep at a time, so two runs cannot interleave their
# table and mapping edits.
exec 9>"$MAP_FILE.lock"
flock 9 || die "could not lock $MAP_FILE.lock"
