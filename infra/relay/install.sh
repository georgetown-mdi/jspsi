#!/bin/bash
# Install the psilink standing relay on this host. Idempotent: run it again after
# an edit to the template, the unit, or the Dockerfile and it converges.
#
#   install.sh [--skip-verify]
#
# What it does, in order: installs podman and the ACME client, mints a static
# authentication secret if this host has none, builds the image from the pinned
# Dockerfile beside this file, obtains a certificate if none is present, renders
# the configuration, installs the Quadlet unit and the two timers, and starts the
# relay. It then runs verify.sh, which is the only step that says whether the
# result carries an exchange.
#
# It refuses to run without /etc/psilink-relay/relay.env, which names the realm.
# Nothing here defaults to a hostname: a realm that does not match what
# mint-credential.sh signs against fails every credential, quietly, at the point
# an exchange needs the relay.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ETC="${PSILINK_RELAY_ETC:-/etc/psilink-relay}"
ENV_FILE="${PSILINK_RELAY_ENV_FILE:-$ETC/relay.env}"
LIBEXEC="${PSILINK_RELAY_LIBEXEC:-/opt/psilink-relay}"
IMAGE="${PSILINK_RELAY_IMAGE:-localhost/psilink-relay:installed}"
QUADLET_DIR=/etc/containers/systemd
UNIT_DIR=/etc/systemd/system

SKIP_VERIFY=0
for arg in "$@"; do
  case "$arg" in
    --skip-verify) SKIP_VERIFY=1 ;;
    *) printf 'usage: install.sh [--skip-verify]\n' >&2; exit 2 ;;
  esac
done

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { printf '[%s] ABORTING: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "install.sh writes under /etc and /opt; run it as root"

[ -f "$ENV_FILE" ] || die "no $ENV_FILE. Copy relay.env.example there, set the realm, and run again"
# shellcheck disable=SC1090
. "$ENV_FILE"
[ -n "${PSILINK_RELAY_REALM:-}" ] || die "PSILINK_RELAY_REALM is unset in $ENV_FILE; refusing to guess a realm"
log "installing the relay for realm $PSILINK_RELAY_REALM"

# Checked here rather than at the certificate step, which is past the package
# install and the image build: a missing provider credential is the one failure
# this script can see coming.
if [ ! -s "$ETC/certs/fullchain.pem" ] && [ ! -f "${PSILINK_RELAY_ACME_ENV:-$ETC/acme.env}" ]; then
  die "no certificate and no ${PSILINK_RELAY_ACME_ENV:-$ETC/acme.env}. Copy certs/env.example there at mode 600 and fill in the DNS provider credential"
fi

# --- packages ---------------------------------------------------------------
# podman only. There is no container daemon on this box: systemd supervises the
# relay through the Quadlet unit and nothing else does.
if ! command -v podman >/dev/null 2>&1; then
  log "installing podman"
  dnf -y install podman
fi
command -v openssl >/dev/null 2>&1 || dnf -y install openssl
command -v curl >/dev/null 2>&1 || dnf -y install curl

# --- the static secret ------------------------------------------------------
SECRET_FILE="${PSILINK_RELAY_SECRET_FILE:-$ETC/static-auth-secret}"
install -d -m 700 "$ETC"
install -d -m 755 "$ETC/certs"
if [ ! -f "$SECRET_FILE" ]; then
  log "minting a static authentication secret at $SECRET_FILE"
  ( umask 077; openssl rand -hex 32 > "$SECRET_FILE" )
fi
chmod 600 "$SECRET_FILE"

# --- the image --------------------------------------------------------------
log "building $IMAGE from the pinned base in $HERE/Dockerfile"
podman build --pull=newer -t "$IMAGE" "$HERE"

# The account the image runs as, asked of the image rather than assumed: the ACME
# deploy hook has to hand it a readable private key, and the measurement record
# has coturn falling back to its defaults on a key it cannot read
# (docs/notes/webrtc-relay-deployment.md).
IMAGE_UID="$(podman run --rm --entrypoint id "$IMAGE" -u | tr -d '[:space:]')"
case "$IMAGE_UID" in
  ''|*[!0-9]*) die "could not read the image's uid; got '$IMAGE_UID'" ;;
esac
log "the image runs as uid $IMAGE_UID"
if ! grep -q '^PSILINK_RELAY_IMAGE_UID=' "$ENV_FILE"; then
  printf 'PSILINK_RELAY_IMAGE_UID=%s\n' "$IMAGE_UID" >> "$ENV_FILE"
else
  sed -i "s/^PSILINK_RELAY_IMAGE_UID=.*/PSILINK_RELAY_IMAGE_UID=$IMAGE_UID/" "$ENV_FILE"
fi

# --- the scripts this host runs ---------------------------------------------
install -d -m 755 "$LIBEXEC" "$LIBEXEC/aws" "$LIBEXEC/certs"
install -m 755 "$HERE/render-config.sh" "$HERE/verify.sh" "$HERE/mint-credential.sh" "$LIBEXEC/"
install -m 644 "$HERE/turnserver.conf.tmpl" "$LIBEXEC/"
install -m 755 "$HERE/aws/external-ip.sh" "$LIBEXEC/aws/"
install -m 755 "$HERE/certs/renew.sh" "$HERE/certs/deploy-hook.sh" "$LIBEXEC/certs/"

# --- the certificate --------------------------------------------------------
if [ ! -s "$ETC/certs/fullchain.pem" ] || [ ! -s "$ETC/certs/privkey.pem" ]; then
  log "no certificate yet; obtaining one by DNS-01"
  "$LIBEXEC/certs/renew.sh" || die "certificate issuance failed; see Certificates in infra/relay/README.md"
fi

# --- the configuration ------------------------------------------------------
"$LIBEXEC/render-config.sh"

# --- units ------------------------------------------------------------------
install -d -m 755 "$QUADLET_DIR"
install -m 644 "$HERE/psilink-relay.container" "$QUADLET_DIR/"
install -m 644 "$HERE/certs/psilink-relay-cert.service" "$HERE/certs/psilink-relay-cert.timer" "$UNIT_DIR/"
install -m 644 "$HERE/psilink-relay-verify.service" "$HERE/psilink-relay-verify.timer" "$UNIT_DIR/"

systemctl daemon-reload
systemctl enable --now psilink-relay-cert.timer
systemctl enable --now psilink-relay-verify.timer

# A Quadlet-generated service is enabled by the unit's own [Install] section at
# generation time, so it is started rather than enabled here.
systemctl restart psilink-relay.service
log "psilink-relay.service started"

if [ "$SKIP_VERIFY" = 1 ]; then
  log "--skip-verify: nothing has confirmed this relay carries an allocation"
  exit 0
fi

log "verifying"
"$LIBEXEC/verify.sh"
