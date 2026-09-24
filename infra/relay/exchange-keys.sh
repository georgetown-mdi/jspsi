#!/bin/bash
# Shared by register-exchange.sh and revoke-exchange.sh; sourced, not run.
#
# coturn's turn_secret table is keyed (realm, value) and holds no exchange id,
# so the id -> key mapping lives beside it in a text file, one "<id> <key>" line
# per registered exchange. It is root's alone, under the mode-700 /etc directory,
# rather than in the data directory the container's account can write.

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
# stays one field of the mapping file.
check_exchange_id() {
  case "$1" in
    ''|-*|*[!A-Za-z0-9._-]*)
      die "exchange-id '$1' must be 1 to 128 of [A-Za-z0-9._-], not starting with '-'" ;;
  esac
  [ "${#1}" -le 128 ] || die "exchange-id is ${#1} characters; the limit is 128"
}

# The form coturn HMACs as ASCII (docs/spec/PROTOCOL.md, Relay credential
# derivation).
check_key() {
  case "$1" in
    *[!0-9a-f]*|'') die "key-hex64 must be 64 lowercase hex characters [0-9a-f]" ;;
  esac
  [ "${#1}" -eq 64 ] || die "key-hex64 must be 64 lowercase hex characters; got ${#1}"
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

# Rewrites the mapping without the exchange's line, plus "<id> <key>" when a key
# is given, through a mode-600 temporary so a failure leaves the prior mapping
# and no temporary.
write_mapping() {
  local id="$1" key="${2:-}" tmp
  tmp="$(mktemp "$MAP_FILE.XXXXXX")" || return 1
  if ! {
    chmod 600 "$tmp" &&
      { [ ! -f "$MAP_FILE" ] || awk -v id="$id" '($1 "") != (id "")' "$MAP_FILE" > "$tmp"; } &&
      { [ -z "$key" ] || printf '%s %s\n' "$id" "$key" >> "$tmp"; } &&
      mv "$tmp" "$MAP_FILE"
  }; then
    rm -f "$tmp"
    return 1
  fi
}

# How to list the table by hand, for a message that leaves a row to remove.
list_table_hint() {
  printf "list the table with '%s run --rm --network none -v %s:/var/lib/coturn --entrypoint turnadmin %s -S -r %s -b /var/lib/coturn/turndb'" \
    "$RUNTIME" "$DATA_DIR" "$IMAGE" "$REALM"
}

# One register or revoke at a time, so two runs cannot interleave their table
# and mapping edits.
exec 9>"$MAP_FILE.lock"
flock 9 || die "could not lock $MAP_FILE.lock"
