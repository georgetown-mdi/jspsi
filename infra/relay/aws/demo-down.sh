#!/bin/bash
# Stop the always-on demo box.
#
# The demo box carries the demo SFTP server and nothing that has to be reachable
# between demonstrations. It is not the relay: pointing this at the relay's
# dedicated instance would drop every allocation on it and leave partners unable
# to connect with nothing to tell them why.
#
# Safe to run twice. An instance that is already stopped is reported and left
# alone.
#
# UNTESTED LIVE: not run against an account.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${PSILINK_DEMO_ENV:-$HERE/env}"

die() { printf 'ABORTING: %s\n' "$*" >&2; exit 1; }
log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

[ -f "$ENV_FILE" ] || die "no $ENV_FILE; copy env.example beside this script, chmod 600, and fill it in"
# shellcheck disable=SC1090
. "$ENV_FILE"

for required in PSILINK_DEMO_INSTANCE_ID PSILINK_DEMO_REGION PSILINK_DEMO_PROFILE; do
  eval "value=\${$required:-}"
  [ -n "$value" ] || die "$required is unset in $ENV_FILE; refusing to guess which instance to stop"
done

aws_demo() {
  aws --profile "$PSILINK_DEMO_PROFILE" --region "$PSILINK_DEMO_REGION" "$@"
}

BEFORE="$(aws_demo ec2 describe-instances --instance-ids "$PSILINK_DEMO_INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].State.Name' --output text)" \
  || die "could not read $PSILINK_DEMO_INSTANCE_ID in $PSILINK_DEMO_REGION"

case "$BEFORE" in
  stopped)
    log "$PSILINK_DEMO_INSTANCE_ID is already stopped"
    exit 0
    ;;
  stopping)
    log "$PSILINK_DEMO_INSTANCE_ID is already stopping; waiting"
    ;;
  running|pending)
    log "stopping $PSILINK_DEMO_INSTANCE_ID"
    aws_demo ec2 stop-instances --instance-ids "$PSILINK_DEMO_INSTANCE_ID" >/dev/null
    ;;
  *)
    die "$PSILINK_DEMO_INSTANCE_ID is '$BEFORE'; stop it by hand or wait for it to settle"
    ;;
esac

aws_demo ec2 wait instance-stopped --instance-ids "$PSILINK_DEMO_INSTANCE_ID"
log "$PSILINK_DEMO_INSTANCE_ID is stopped. Its root volume still bills; only the instance hours stop"
