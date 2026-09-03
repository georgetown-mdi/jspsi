#!/bin/bash
# Tear the cycle's services box down and prove what is left.
#
# Order matters: DNS first so no record outlives the address, then the instance,
# then the interface and the addresses it held, then the security group, which
# cannot be deleted while anything still references it. Everything waits rather
# than assuming, because an orphan count taken before termination completes
# measures nothing.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

CYCLE_ID="${1:?usage: services-down.sh <cycle-id>}"
export CYCLE_ID
guard_account
load_cloudflare_env

SCOPE="cycle-$CYCLE_ID"
LEFTOVER=0
mkdir -p "$ART/cycle-$CYCLE_ID"

"$RUN_DIR/cloudflare.sh" dns-down "$CYCLE_ID" || log "DNS teardown reported a problem; see the cycle's cloudflare.log"

# Class B's route points at an interface that is about to stop existing. Its
# destination is the services subnet's whole CIDR, the only shape a route more
# specific than the VPC's local route may take, so that is what set-class.sh
# created and what has to be deleted here.
RT_RESTRICTED="$(state_get fixture RT_restricted || true)"
if [ -n "$RT_RESTRICTED" ]; then
  awsm ec2 delete-route --route-table-id "$RT_RESTRICTED" \
    --destination-cidr-block "$SERVICES_CIDR" >/dev/null 2>&1 || true
fi

INSTANCE_ID="$(state_get "$SCOPE" SERVICES_INSTANCE || true)"
if [ -n "$INSTANCE_ID" ]; then
  awsm ec2 terminate-instances --instance-ids "$INSTANCE_ID" >/dev/null
  log "waiting for $INSTANCE_ID to terminate"
  awsr ec2 wait instance-terminated --instance-ids "$INSTANCE_ID"
fi

PROXY_ENI="$(state_get "$SCOPE" PROXY_ENI || true)"
if [ -n "$PROXY_ENI" ]; then
  # Termination detaches it but does not delete it: the interface was created
  # separately, so DeleteOnTermination is false and it would be the orphan.
  for _ in $(seq 1 20); do
    status="$(awsr ec2 describe-network-interfaces --network-interface-ids "$PROXY_ENI" \
      --query 'NetworkInterfaces[0].Status' --output text 2>/dev/null || echo gone)"
    case "$status" in gone|available) break ;; esac
    sleep 5
  done
  awsm ec2 delete-network-interface --network-interface-id "$PROXY_ENI" >/dev/null 2>&1 \
    || { log "proxy interface $PROXY_ENI did not delete; it is counted as an orphan"; LEFTOVER=$((LEFTOVER + 1)); }
fi

for what in TURN WEB; do
  alloc="$(state_get "$SCOPE" "ALLOC_$what" || true)"
  [ -n "$alloc" ] || continue
  assoc="$(awsr ec2 describe-addresses --allocation-ids "$alloc" \
    --query 'Addresses[0].AssociationId' --output text 2>/dev/null || echo None)"
  if [ -n "$assoc" ] && [ "$assoc" != "None" ]; then
    awsm ec2 disassociate-address --association-id "$assoc" >/dev/null 2>&1 || true
  fi
  awsm ec2 release-address --allocation-id "$alloc" >/dev/null \
    || { log "elastic address $alloc did not release; it is counted as an orphan"; LEFTOVER=$((LEFTOVER + 1)); }
done

CACHE_VOL="$(state_get fixture CACHE_VOL || true)"
if [ -n "$CACHE_VOL" ]; then
  awsr ec2 wait volume-available --volume-ids "$CACHE_VOL" 2>/dev/null \
    || awsm ec2 detach-volume --volume-id "$CACHE_VOL" >/dev/null 2>&1 || true
fi

SG="$(state_get "$SCOPE" SG || true)"
if [ -n "$SG" ]; then
  ok=false
  for _ in $(seq 1 12); do
    if awsm ec2 delete-security-group --group-id "$SG" >/dev/null 2>&1; then ok=true; break; fi
    sleep 10
  done
  $ok || { log "security group $SG did not delete; it is counted as an orphan"; LEFTOVER=$((LEFTOVER + 1)); }
fi

# The state file and the active-cycle marker are what a later services-down.sh,
# fixture-down.sh or all.sh uses to RETRY, so neither goes on the strength of the
# delete calls returning: they go when the tag says nothing of this cycle's is
# left. Dropping active-cycle while a proxy interface survived is what made a
# stranded resource unretryable, and it then blocked the subnet delete.
REMAIN="$(wait_cycle_clear "$CYCLE_ID" 60)"
if [ "$REMAIN" = "0" ]; then
  rm -f "$(state_file "$SCOPE")" "$STATE/active-cycle"
  # This cycle's coturn secret, its minted credentials and its certificates.
  # The Let's Encrypt copy under state/le is deliberately kept and reused: its
  # duplicate-certificate limit is five per week.
  rm -rf "$STATE/cycle-$CYCLE_ID"
  log "removed this cycle's secrets and certificates ($STATE/cycle-$CYCLE_ID)"
  log "kept under $STATE: $(ls -A "$STATE" 2>/dev/null | tr '\n' ' ')"
else
  log "$REMAIN resource(s) still carry psilink-spike-cycle=$CYCLE_ID ($LEFTOVER delete call(s) failed here)."
  log "$(state_file "$SCOPE") and $STATE/active-cycle are KEPT so the ids survive. Retry with: $RUN_DIR/services-down.sh $CYCLE_ID"
  log "this cycle's secrets under $STATE/cycle-$CYCLE_ID are kept too, because a retry needs them"
fi

log "what the working region still shows:"
"$AWS_DIR/inventory.sh" --brief 2>&1 | artifact_tee "$ART/cycle-$CYCLE_ID/inventory-after-teardown.txt"
