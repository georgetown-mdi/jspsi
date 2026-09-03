#!/bin/bash
# Start the always-on demo box, wait for it, print the address it came back on,
# and re-point its DNS record if a zone is configured.
#
# The demo box carries the demo SFTP server. It is not the relay: the relay has a
# dedicated instance provisioned from this directory's reference (../README.md),
# and these two scripts must never be pointed at it -- stopping a relay drops
# every allocation on it, and a relay that is stopped between exchanges is not a
# standing relay.
#
# Safe to run twice. An instance that is already running is waited for and
# reported, not started again.
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
  [ -n "$value" ] || die "$required is unset in $ENV_FILE; refusing to guess which instance to start"
done

aws_demo() {
  aws --profile "$PSILINK_DEMO_PROFILE" --region "$PSILINK_DEMO_REGION" "$@"
}

state() {
  aws_demo ec2 describe-instances --instance-ids "$PSILINK_DEMO_INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].State.Name' --output text
}

BEFORE="$(state)" || die "could not read $PSILINK_DEMO_INSTANCE_ID in $PSILINK_DEMO_REGION"
case "$BEFORE" in
  running)
    log "$PSILINK_DEMO_INSTANCE_ID is already running"
    ;;
  stopped)
    log "starting $PSILINK_DEMO_INSTANCE_ID"
    aws_demo ec2 start-instances --instance-ids "$PSILINK_DEMO_INSTANCE_ID" >/dev/null
    ;;
  pending)
    log "$PSILINK_DEMO_INSTANCE_ID is already starting"
    ;;
  *)
    die "$PSILINK_DEMO_INSTANCE_ID is '$BEFORE'; start it by hand or wait for it to settle"
    ;;
esac

log "waiting for it to run"
aws_demo ec2 wait instance-running --instance-ids "$PSILINK_DEMO_INSTANCE_ID"

PUBLIC_IP="$(aws_demo ec2 describe-instances --instance-ids "$PSILINK_DEMO_INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
[ -n "$PUBLIC_IP" ] && [ "$PUBLIC_IP" != "None" ] \
  || die "the instance is running but has no public address"
log "$PSILINK_DEMO_INSTANCE_ID is running on $PUBLIC_IP"

if [ -z "${PSILINK_DEMO_DNS_NAME:-}" ] || [ -z "${CF_ZONE_NAME:-}" ] || [ -z "${CF_DNS_API_TOKEN:-}" ]; then
  printf '%s\n' "$PUBLIC_IP"
  log "no zone configured; DNS was not touched"
  exit 0
fi

CF_API=https://api.cloudflare.com/client/v4
ZONE_ID="$(curl -fsS -H "Authorization: Bearer $CF_DNS_API_TOKEN" \
  "$CF_API/zones?name=$CF_ZONE_NAME" | jq -r '.result[0].id // empty')"
[ -n "$ZONE_ID" ] || die "could not resolve the zone id for $CF_ZONE_NAME"

RECORD_ID="$(curl -fsS -H "Authorization: Bearer $CF_DNS_API_TOKEN" \
  "$CF_API/zones/$ZONE_ID/dns_records?type=A&name=$PSILINK_DEMO_DNS_NAME" \
  | jq -r '.result[0].id // empty')"

# A 60 s TTL, because the address changes on every start and a partner's resolver
# holding the last one is exactly the shape that made a per-exchange name
# unworkable in the relay measurement.
BODY="$(jq -nc --arg name "$PSILINK_DEMO_DNS_NAME" --arg ip "$PUBLIC_IP" \
  '{type:"A", name:$name, content:$ip, ttl:60, proxied:false}')"

# Upsert: a PUT when the record exists, a POST when it does not, so a demo box
# whose record was deleted comes back with one rather than failing.
if [ -n "$RECORD_ID" ]; then
  RESP="$(curl -fsS -X PUT -H "Authorization: Bearer $CF_DNS_API_TOKEN" \
    -H 'Content-Type: application/json' --data "$BODY" \
    "$CF_API/zones/$ZONE_ID/dns_records/$RECORD_ID")"
else
  RESP="$(curl -fsS -X POST -H "Authorization: Bearer $CF_DNS_API_TOKEN" \
    -H 'Content-Type: application/json' --data "$BODY" \
    "$CF_API/zones/$ZONE_ID/dns_records")"
fi
[ "$(printf '%s' "$RESP" | jq -r '.success')" = "true" ] \
  || die "the DNS update failed: $(printf '%s' "$RESP" | jq -c '.errors')"

log "$PSILINK_DEMO_DNS_NAME now points at $PUBLIC_IP (TTL 60)"
printf '%s\n' "$PUBLIC_IP"
