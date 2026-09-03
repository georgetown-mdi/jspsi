#!/bin/bash
# One ephemeral cycle end to end: stand the services box up, run one exchange,
# tear it down, and count what survived.
#
# usage: cycle.sh <n> [--class a|b] [--relay self|cloudflare] [--interrupt]
#
# The teardown is on a trap, so a failure anywhere between still destroys the
# instance and the two elastic addresses. A cycle that dies with its services box
# running is the failure mode that bills.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

N="${1:?usage: cycle.sh <n> [--class a|b] [--relay self|cloudflare] [--interrupt]}"
shift
CLASS=a; RELAY=self; INTERRUPT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --class)     CLASS="$2"; shift 2 ;;
    --relay)     RELAY="$2"; shift 2 ;;
    --interrupt) INTERRUPT=1; shift ;;
    *) die "unknown argument $1" ;;
  esac
done

CYCLE_ID="c$N"
export CYCLE_ID
guard_account

DIR="$ART/cycle-$CYCLE_ID"
mkdir -p "$DIR"

cleanup() {
  local rc=$?
  if [ -n "$(state_get "cycle-$CYCLE_ID" SERVICES_INSTANCE 2>/dev/null || true)" ]; then
    log "tearing the services box down (exit $rc)"
    "$RUN_DIR/services-down.sh" "$CYCLE_ID" || log "teardown itself failed; run nuke.sh"
  fi
  count_orphans
  exit "$rc"
}

# The orphan count question 2 asks for: what still carries this cycle's tag once
# the cycle is over. The cycle tag is what separates it from the fixture, which
# carries the same psilink-spike=1 tag and is meant to survive.
count_orphans() {
  {
    printf 'orphans for cycle %s, taken %s\n' "$CYCLE_ID" "$(isots)"
    printf 'tag filter: psilink-spike-cycle=%s\n\n' "$CYCLE_ID"
    printf '%-22s %s\n' instances "$(awsr ec2 describe-instances \
      --filters "Name=tag:psilink-spike-cycle,Values=$CYCLE_ID" \
                Name=instance-state-name,Values=pending,running,stopping,stopped \
      --query 'length(Reservations[].Instances[])' --output text 2>/dev/null || echo UNKNOWN)"
    printf '%-22s %s\n' volumes "$(awsr ec2 describe-volumes \
      --filters "Name=tag:psilink-spike-cycle,Values=$CYCLE_ID" \
      --query 'length(Volumes)' --output text 2>/dev/null || echo UNKNOWN)"
    printf '%-22s %s\n' addresses "$(awsr ec2 describe-addresses \
      --filters "Name=tag:psilink-spike-cycle,Values=$CYCLE_ID" \
      --query 'length(Addresses)' --output text 2>/dev/null || echo UNKNOWN)"
    printf '%-22s %s\n' network-interfaces "$(awsr ec2 describe-network-interfaces \
      --filters "Name=tag:psilink-spike-cycle,Values=$CYCLE_ID" \
      --query 'length(NetworkInterfaces)' --output text 2>/dev/null || echo UNKNOWN)"
    printf '%-22s %s\n' security-groups "$(awsr ec2 describe-security-groups \
      --filters "Name=tag:psilink-spike-cycle,Values=$CYCLE_ID" \
      --query 'length(SecurityGroups)' --output text 2>/dev/null || echo UNKNOWN)"
    printf '%-22s %s\n' dns-records "$(dns_record_count)"
    printf '%-22s %s\n' local-certificates "$(find "$STATE/cycle-$CYCLE_ID/certs" -type f 2>/dev/null | wc -l | tr -d ' ')"
    printf '\ntag:GetResources, every resource this cycle tagged:\n'
    awsr resourcegroupstaggingapi get-resources \
      --tag-filters "Key=psilink-spike-cycle,Values=$CYCLE_ID" \
      --query 'ResourceTagMappingList[].ResourceARN' --output text 2>/dev/null \
      || printf '  tag:GetResources UNAVAILABLE, so this line is unknown rather than zero\n'
  } 2>&1 | artifact_write "$DIR/orphans.txt"
  log "orphan count written to $DIR/orphans.txt"
  cat "$DIR/orphans.txt"
}

dns_record_count() {
  load_cloudflare_env
  if [ "$CF_DNS" != true ]; then printf 'n/a (no DNS configured)'; return; fi
  if no_mutate; then printf '0 (SPIKE_NO_MUTATE: no record was created)'; return; fi
  local zid n=0 name
  zid="$(curl -fsS -H "Authorization: Bearer $CF_DNS_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/zones?name=$CF_ZONE_NAME" | jq -r '.result[0].id // empty')"
  [ -n "$zid" ] || { printf 'UNKNOWN'; return; }
  for name in "spike-turn.$CF_ZONE_NAME" "spike-web.$CF_ZONE_NAME"; do
    n=$(( n + $(curl -fsS -H "Authorization: Bearer $CF_DNS_API_TOKEN" \
      "https://api.cloudflare.com/client/v4/zones/$zid/dns_records?type=A&name=$name" \
      | jq -r '.result | length') ))
  done
  printf '%s' "$n"
}

trap cleanup EXIT

"$RUN_DIR/services-up.sh" "$CYCLE_ID"

T_FIRST_FRAME_BASE=$(now)
if [ "$INTERRUPT" = 1 ]; then
  SPIKE_INTERRUPT=1 "$RUN_DIR/exchange.sh" "$CYCLE_ID" "$CLASS" ephemeral "$RELAY" \
    || log "the interrupted exchange returned non-zero, which is expected"
else
  "$RUN_DIR/exchange.sh" "$CYCLE_ID" "$CLASS" ephemeral "$RELAY"
fi
phase "$CYCLE_ID" 4-exchange "$T_FIRST_FRAME_BASE" "$(now)"
