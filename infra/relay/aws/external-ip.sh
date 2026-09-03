#!/bin/bash
# Print this EC2 instance's "<public>/<private>" address pair, which is the value
# coturn's external-ip takes.
#
# The one AWS-specific file the relay's own configuration depends on. Everything
# else here is cloud-neutral: render-config.sh calls whatever
# PSILINK_RELAY_EXTERNAL_IP_HELPER names and only requires this output shape, so
# Azure, on-prem, or a host with a statically known pair is a sibling of this
# file and no other change.
#
# IMDSv2 only: the token is requested first and every read carries it. A relay is
# exactly the box where an instance-metadata read that needs no credential
# matters -- a TURN allocation toward 169.254.169.254 is what turnserver.conf's
# denied-peer-ip rules exist to refuse, and asking for IMDSv1 here would be
# asking for the surface those rules close.
#
# UNTESTED LIVE: not run on an instance.
set -euo pipefail

IMDS="${PSILINK_RELAY_IMDS:-http://169.254.169.254}"
TTL=60

die() { printf 'ABORTING: %s\n' "$*" >&2; exit 1; }

TOKEN="$(curl -fsS --max-time 5 -X PUT "$IMDS/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: $TTL")" \
  || die "no IMDSv2 token from $IMDS; is this an EC2 instance, and is the hop limit at least 1?"

meta() {
  curl -fsS --max-time 5 -H "X-aws-ec2-metadata-token: $TOKEN" "$IMDS/latest/meta-data/$1"
}

PUBLIC="$(meta public-ipv4)" \
  || die "the instance has no public-ipv4 in its metadata; a relay needs a public address"
PRIVATE="$(meta local-ipv4)" || die "could not read local-ipv4"

[ -n "$PUBLIC" ] && [ -n "$PRIVATE" ] || die "metadata returned an incomplete pair: '$PUBLIC'/'$PRIVATE'"

printf '%s/%s\n' "$PUBLIC" "$PRIVATE"
