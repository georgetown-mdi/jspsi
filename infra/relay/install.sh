#!/bin/bash
# Install the psilink standing relay on this host. Idempotent: run it again after
# an edit to the template, the unit, or the Dockerfile and it converges.
#
#   install.sh [--skip-verify]
#
# What it does, in order: installs a container runtime, mints a static
# authentication secret if this host has none, builds the image from the pinned
# Dockerfile beside this file, obtains a certificate if none is present, renders
# the configuration, installs the relay's unit and the two timers, and starts the
# relay. It then runs verify.sh, which is the only step that says whether the
# result carries an exchange.
#
# The runtime is podman where the distribution carries it and docker where it
# does not, and that decides one thing: which file defines psilink-relay.service.
# Everything else -- the image, its flags and mounts, the uid probe, the
# certificate hook, both timers -- is the same on either.
#
# It refuses to run without /etc/psilink-relay/relay.env, which names the realm.
# Nothing here defaults to a hostname: a realm that does not match what
# mint-credential.sh signs against fails every credential, quietly, at the point
# an exchange needs the relay.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# Both paths are literals here and in the unit files, which cannot read a
# variable this script was given: a configurable root would move the scripts and
# leave the units pointing at the old one, splitting the install in half.
ETC=/etc/psilink-relay
LIBEXEC=/opt/psilink-relay
ENV_FILE="${PSILINK_RELAY_ENV_FILE:-$ETC/relay.env}"
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

# Write a value this script derived back into the env file the other scripts and
# the timers read. A hand-edited file need not end in a newline, and an append
# onto one would land on the end of whatever the operator typed last. Both values
# written this way come from a fixed alphabet -- a uid's digits, a runtime name
# out of a two-value case -- so neither carries a character the sed reads as
# syntax.
record_env_value() {
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i "s/^$1=.*/$1=$2/" "$ENV_FILE"
  else
    if [ -s "$ENV_FILE" ] && [ -n "$(tail -c 1 "$ENV_FILE")" ]; then
      printf '\n' >> "$ENV_FILE"
    fi
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}

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

# --- the container runtime --------------------------------------------------
# podman where the distribution carries it, docker where it does not. Measured on
# the Amazon Linux 2023 arm64 AMI aws/provision.md prescribes: `dnf install
# podman` fails with no match there -- AL2023 publishes no podman package and no
# EPEL -- while `dnf install docker` installs Docker Engine.
#
# A runtime already on the host wins over one dnf could add, so a converge run
# never moves a running relay from one supervisor to the other. The value this
# script records in the env file is read back on the next run and pins it.
RUNTIME="${PSILINK_RELAY_RUNTIME:-}"
if [ -z "$RUNTIME" ]; then
  if command -v podman >/dev/null 2>&1; then
    RUNTIME=podman
  elif command -v docker >/dev/null 2>&1; then
    RUNTIME=docker
  else
    log "no container runtime on this host; asking dnf for podman"
    if dnf -y install podman; then
      RUNTIME=podman
    else
      log "dnf has no podman on this distribution; installing docker instead"
      dnf -y install docker \
        || die "this host has neither podman nor docker and dnf could install neither; install one by hand and run again, or set PSILINK_RELAY_RUNTIME in $ENV_FILE"
      RUNTIME=docker
    fi
  fi
fi
case "$RUNTIME" in
  podman|docker) ;;
  *) die "PSILINK_RELAY_RUNTIME is '$RUNTIME'; this reference drives podman or docker" ;;
esac
command -v "$RUNTIME" >/dev/null 2>&1 || die "the runtime is $RUNTIME, which is not on PATH"
log "container runtime: $RUNTIME"
# verify.sh runs the same image on the same runtime, from a timer that does no
# detection of its own.
record_env_value PSILINK_RELAY_RUNTIME "$RUNTIME"

if [ "$RUNTIME" = docker ]; then
  # podman needs no daemon. docker's has to be up for the build below, and
  # psilink-relay-docker.service requires it besides.
  systemctl enable --now docker.service \
    || die "docker.service did not enable and start, so nothing can build or run the relay image; journalctl -u docker.service"
  # systemd takes an absolute path in ExecStart, and psilink-relay-docker.service
  # carries the path the distribution package uses. Caught here rather than at
  # the first start, which reports it as a unit that cannot locate an executable.
  DOCKER_BIN="$(command -v docker)"
  [ "$DOCKER_BIN" = /usr/bin/docker ] \
    || die "docker is at $DOCKER_BIN and psilink-relay-docker.service names /usr/bin/docker; point its ExecStart lines at $DOCKER_BIN and run again"
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
# The one runtime invocation whose spelling differs: podman takes --pull=newer,
# while docker's --pull is a boolean that rejects that value before it reaches
# the daemon (measured against the docker CLI: exit 125, `invalid argument
# "newer" for "--pull" flag`).
case "$RUNTIME" in
  podman) podman build --pull=newer -t "$IMAGE" "$HERE" ;;
  docker) docker build --pull -t "$IMAGE" "$HERE" ;;
esac

# The account the image runs as, asked of the image rather than assumed: the ACME
# deploy hook has to hand it a readable private key, and the measurement record
# has coturn falling back to its defaults on a key it cannot read
# (docs/notes/webrtc-relay-deployment.md).
IMAGE_UID="$("$RUNTIME" run --rm --entrypoint id "$IMAGE" -u | tr -d '[:space:]')"
case "$IMAGE_UID" in
  ''|*[!0-9]*) die "could not read the image's uid; got '$IMAGE_UID'" ;;
esac
log "the image runs as uid $IMAGE_UID"
record_env_value PSILINK_RELAY_IMAGE_UID "$IMAGE_UID"

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
else
  # A re-run with a certificate already here skips renew.sh, and the deploy hook
  # with it, so nothing else re-owns the key to the uid probed above. A rebuilt
  # image that moved that uid would hand coturn a key it cannot read, which it
  # answers by falling back to its defaults rather than failing
  # (docs/notes/webrtc-relay-deployment.md): the relay starts, and the first
  # symptom is a party that cannot gather a relay candidate.
  log "certificate already present; re-owning it to uid $IMAGE_UID"
  chown "$IMAGE_UID" "$ETC/certs" "$ETC/certs/fullchain.pem" "$ETC/certs/privkey.pem" \
    || die "could not give uid $IMAGE_UID the certificate in $ETC/certs; coturn would start on defaults rather than fail"
fi

# --- the configuration ------------------------------------------------------
"$LIBEXEC/render-config.sh"

# --- units ------------------------------------------------------------------
# One service name whichever runtime this is: certs/deploy-hook.sh restarts
# psilink-relay.service by name and psilink-relay-verify.service requires it, so
# only the file that defines it differs.
if [ "$RUNTIME" = podman ]; then
  install -d -m 755 "$QUADLET_DIR"
  install -m 644 "$HERE/psilink-relay.container" "$QUADLET_DIR/"
  STALE_UNIT="$UNIT_DIR/psilink-relay.service"
else
  install -m 644 "$HERE/psilink-relay-docker.service" "$UNIT_DIR/psilink-relay.service"
  STALE_UNIT="$QUADLET_DIR/psilink-relay.container"
fi
# A unit left by an install on the other runtime would supervise a second
# container on the same ports, and a plain unit of this name shadows the Quadlet
# generator's output besides.
if [ -e "$STALE_UNIT" ]; then
  log "removing $STALE_UNIT, left by an install on the other runtime"
  systemctl stop psilink-relay.service || true
  rm -f "$STALE_UNIT"
fi
install -m 644 "$HERE/certs/psilink-relay-cert.service" "$HERE/certs/psilink-relay-cert.timer" "$UNIT_DIR/"
install -m 644 "$HERE/psilink-relay-verify.service" "$HERE/psilink-relay-verify.timer" "$UNIT_DIR/"

systemctl daemon-reload || die "systemctl daemon-reload failed, so systemd has not read the relay's unit; check systemd-analyze verify and run again"
systemctl enable --now psilink-relay-cert.timer \
  || die "psilink-relay-cert.timer did not start; the certificate would expire unrenewed. journalctl -u psilink-relay-cert.timer"
systemctl enable --now psilink-relay-verify.timer \
  || die "psilink-relay-verify.timer did not start; nothing would notice a relay that stopped allocating. journalctl -u psilink-relay-verify.timer"

if [ "$RUNTIME" = docker ]; then
  # A Quadlet-generated service is enabled by the unit's own [Install] section at
  # generation time. A plain unit file is not enabled by being installed, and a
  # host that rebooted without this would come up with no relay.
  systemctl enable psilink-relay.service \
    || die "psilink-relay.service could not be enabled; the relay would not come back after a reboot"
fi
systemctl restart psilink-relay.service \
  || die "psilink-relay.service did not start; journalctl -u psilink-relay.service carries coturn's own output"
log "psilink-relay.service started"

if [ "$SKIP_VERIFY" = 1 ]; then
  log "--skip-verify: nothing has confirmed this relay carries an allocation"
  exit 0
fi

log "verifying"
"$LIBEXEC/verify.sh"
