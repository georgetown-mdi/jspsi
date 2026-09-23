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

key_of() {
  [ -f "$MAP_FILE" ] || return 0
  awk -v id="$1" '$1 == id { print $2 }' "$MAP_FILE"
}

id_of_key() {
  [ -f "$MAP_FILE" ] || return 0
  awk -v key="$1" '$2 == key { print $1 }' "$MAP_FILE"
}

# Rewrites the mapping without the exchange's line, plus "<id> <key>" when a key
# is given, through a mode-600 temporary so a failure leaves the prior mapping.
write_mapping() {
  local id="$1" key="${2:-}" tmp
  tmp="$(mktemp "$MAP_FILE.XXXXXX")"
  chmod 600 "$tmp"
  if [ -f "$MAP_FILE" ]; then
    awk -v id="$id" '$1 != id' "$MAP_FILE" > "$tmp"
  fi
  [ -z "$key" ] || printf '%s %s\n' "$id" "$key" >> "$tmp"
  mv "$tmp" "$MAP_FILE"
}

# One register or revoke at a time, so two runs cannot interleave their table
# and mapping edits.
exec 9>"$MAP_FILE.lock"
flock 9 || die "could not lock $MAP_FILE.lock"
