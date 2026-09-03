#!/bin/bash
# Put a freshly issued certificate where the relay reads it, hand the key to the
# account inside the container, and restart the relay.
#
# The chown is load-bearing, not tidiness. The relay measurement recorded coturn
# silently falling back to its defaults on a private key it could not read --
# no error at the point of failure, and the first symptom is a party that cannot
# gather a relay candidate (docs/notes/webrtc-relay-deployment.md, question 1,
# where werift is shown refusing an unverifiable chain). A renewal that lands a
# root-owned key would take the relay out that way, at renewal time, with nothing
# in the journal naming the cause.
#
# Restart rather than reload: whether coturn re-reads its certificate on a signal
# is a question nobody has driven against the real server, so this does the thing
# that certainly works. A relay restart drops any allocation in flight, which is
# why the renewal timer runs at a fixed early hour rather than on exchange time.
#
# UNTESTED LIVE: no certificate has been deployed through this script.
set -euo pipefail

ETC="${PSILINK_RELAY_ETC:-/etc/psilink-relay}"
ENV_FILE="${PSILINK_RELAY_ENV_FILE:-$ETC/relay.env}"
DEST="${PSILINK_RELAY_CERT_DIR:-$ETC/certs}"

die() { printf 'ABORTING: %s\n' "$*" >&2; exit 1; }
log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

[ -f "$ENV_FILE" ] || die "no $ENV_FILE; this host has not been installed as a relay"
# shellcheck disable=SC1090
. "$ENV_FILE"

SRC_CRT="${PSILINK_RELAY_CERT_SOURCE:-}"
SRC_KEY="${PSILINK_RELAY_KEY_SOURCE:-}"
[ -s "$SRC_CRT" ] || die "PSILINK_RELAY_CERT_SOURCE names no certificate"
[ -s "$SRC_KEY" ] || die "PSILINK_RELAY_KEY_SOURCE names no private key"

UID_IN_IMAGE="${PSILINK_RELAY_IMAGE_UID:-}"
[ -n "$UID_IN_IMAGE" ] || die "PSILINK_RELAY_IMAGE_UID is unset in $ENV_FILE; install.sh reads it from the image"

install -d -m 755 "$DEST"
install -m 644 "$SRC_CRT" "$DEST/fullchain.pem"
install -m 600 "$SRC_KEY" "$DEST/privkey.pem"
chown "$UID_IN_IMAGE" "$DEST/privkey.pem" "$DEST/fullchain.pem"
log "certificate deployed to $DEST, key owned by uid $UID_IN_IMAGE"

# Nothing has started yet on a first install; install.sh starts it afterwards.
if systemctl is-active --quiet psilink-relay.service; then
  systemctl restart psilink-relay.service
  log "psilink-relay.service restarted onto the new certificate"
fi
