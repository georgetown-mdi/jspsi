#!/bin/bash
# Mint one time-limited TURN credential for one exchange.
#
#   mint-credential.sh [name] [ttl-seconds]
#
# The credential model coturn's use-auth-secret implements, and the one the relay
# measurement ran on (docs/notes/webrtc-relay-deployment.md, question 3): the
# username is <unix-expiry>:<name> and the password is the base64 HMAC-SHA1 of
# that username under the static secret. coturn recomputes the HMAC on every
# request, so nothing is registered here -- minting is arithmetic over the
# secret, and the credential simply stops working at its expiry.
#
# One hour by default. That is what a leaked credential is worth: the length of
# one exchange rather than the life of the deployment.
#
# The static secret is read at mode 600 and never printed. What goes to stdout is
# the credential and the URL, which are what a partner needs and which expire.
set -euo pipefail

ETC="${PSILINK_RELAY_ETC:-/etc/psilink-relay}"
ENV_FILE="${PSILINK_RELAY_ENV_FILE:-$ETC/relay.env}"

die() { printf 'ABORTING: %s\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "no $ENV_FILE; this host has not been installed as a relay"
# shellcheck disable=SC1090
. "$ENV_FILE"

REALM="${PSILINK_RELAY_REALM:-}"
[ -n "$REALM" ] || die "PSILINK_RELAY_REALM is unset in $ENV_FILE"

SECRET_FILE="${PSILINK_RELAY_SECRET_FILE:-$ETC/static-auth-secret}"
[ -r "$SECRET_FILE" ] || die "cannot read $SECRET_FILE; mint as the account that owns it"

NAME="${1:-psilink}"
TTL="${2:-3600}"
case "$NAME" in
  *:*) die "a credential name cannot contain ':', which separates it from the expiry" ;;
esac
case "$TTL" in
  ''|*[!0-9]*) die "ttl must be whole seconds; got '$TTL'" ;;
esac

SECRET="$(cat "$SECRET_FILE")"
[ -n "$SECRET" ] || die "$SECRET_FILE is empty"

EXPIRY=$(( $(date -u +%s) + TTL ))
USERNAME="$EXPIRY:$NAME"
# openssl takes the HMAC key as an argument, so the static secret is visible in
# this host's process table for the length of one dgst call. openssl offers no
# route that reads the key from a file or a descriptor, and the exposure is
# bounded to the host that holds the secret at rest anyway; it is stated rather
# than worked around with a reimplementation of HMAC in shell.
CREDENTIAL="$(printf '%s' "$USERNAME" \
  | openssl dgst -sha1 -hmac "$SECRET" -binary | openssl base64 | tr -d '\n')"

cat <<CRED
username:   $USERNAME
credential: $CREDENTIAL
url:        turns:$REALM:443?transport=tcp
expires:    $(date -u -d "@$EXPIRY" +%FT%TZ 2>/dev/null || date -u -r "$EXPIRY" +%FT%TZ)

The connection's turn entry, for a psilink.yaml (docs/EXCHANGE_REFERENCE.md,
connection.turn). Write the credential to a mode-600 file and reference it as
"@/run/secrets/turn.key" rather than inline, so it does not sit in a config
file a later exchange reuses:

  connection:
    turn:
      - url: "turns:$REALM:443?transport=tcp"
        username: "$USERNAME"
        credential: "$CREDENTIAL"
        credential_type: hmac-sha1
CRED
