#!/bin/bash
# Put the ACME client's certificate where the relay reads it, hand the key to the
# account inside the container, and restart the relay and the registrar when
# either changed.
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
# that certainly works. A restart drops any allocation in flight, and renew.sh
# calls this hook daily whether or not the client renewed, so the restart runs
# only when the certificate or key differs from the deployed copy in content or
# owner. The comparison reads the files, not the ACME client's exit status or
# output, so it is the same for lego and acme.sh.
#
# A real Let's Encrypt certificate has been deployed through this script, on
# the 2026-09-03/04 live run (infra/relay/README.md, Provenance).
set -euo pipefail

ETC=/etc/alcove-relay
ENV_FILE="${ALCOVE_RELAY_ENV_FILE:-$ETC/relay.env}"
DEST="${ALCOVE_RELAY_CERT_DIR:-$ETC/certs}"

die() { printf 'ABORTING: %s\n' "$*" >&2; exit 1; }
log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

[ -f "$ENV_FILE" ] || die "no $ENV_FILE; this host has not been installed as a relay"
# shellcheck disable=SC1090
. "$ENV_FILE"

SRC_CRT="${ALCOVE_RELAY_CERT_SOURCE:-}"
SRC_KEY="${ALCOVE_RELAY_KEY_SOURCE:-}"
[ -s "$SRC_CRT" ] || die "ALCOVE_RELAY_CERT_SOURCE names no certificate"
[ -s "$SRC_KEY" ] || die "ALCOVE_RELAY_KEY_SOURCE names no private key"

UID_IN_IMAGE="${ALCOVE_RELAY_IMAGE_UID:-}"
[ -n "$UID_IN_IMAGE" ] || die "ALCOVE_RELAY_IMAGE_UID is unset in $ENV_FILE; install.sh reads it from the image"

# GNU stat on the relay host; BSD stat, which has no -c, where its test suite runs
# on macOS.
if stat -c %u / >/dev/null 2>&1; then
  owner_uid() { stat -c %u "$1"; }
else
  owner_uid() { stat -f %u "$1"; }
fi
same_file() { [ -f "$2" ] && cmp -s "$1" "$2" && [ "$(owner_uid "$2")" = "$UID_IN_IMAGE" ]; }
CHANGED=yes
if same_file "$SRC_CRT" "$DEST/fullchain.pem" && same_file "$SRC_KEY" "$DEST/privkey.pem"; then
  CHANGED=
fi

install -d -m 755 "$DEST"
install -m 644 "$SRC_CRT" "$DEST/fullchain.pem"
install -m 600 "$SRC_KEY" "$DEST/privkey.pem"
chown "$UID_IN_IMAGE" "$DEST/privkey.pem" "$DEST/fullchain.pem"
log "certificate deployed to $DEST, key owned by uid $UID_IN_IMAGE"

if [ -z "$CHANGED" ]; then
  if systemctl is-active --quiet alcove-relay.service; then
    log "certificate and key unchanged; alcove-relay.service left running"
  else
    log "certificate and key unchanged; alcove-relay.service is not running and was not started"
  fi
  exit 0
fi

# Nothing has started yet on a first install; install.sh starts it afterwards.
if systemctl is-active --quiet alcove-relay.service; then
  systemctl restart alcove-relay.service
  log "alcove-relay.service restarted onto the new certificate"
fi
# The registrar reads the same certificate at start; try-restart leaves a
# registrar that is not running stopped.
systemctl try-restart alcove-relay-registrar.service ||
  log "alcove-relay-registrar.service did not restart onto the new certificate; journalctl -u alcove-relay-registrar.service"
