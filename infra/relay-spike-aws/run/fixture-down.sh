#!/bin/bash
# Destroy the run-session fixture and prove the account is back where it started.
#
# usage: fixture-down.sh [--nuke]
#
# Deletion is by recorded id, in dependency order, so nothing outside this run
# session is touched. --nuke hands the job to relay-spike-aws/nuke.sh instead, which deletes
# by account rather than by id and is the backstop for a fixture whose state file
# has been lost.
#
# "Empty" is measured against relay-spike-aws/artifacts/baseline-inventory.txt, recorded
# before the first resource was created: inventory.sh lists the default VPC's
# subnets and gateway too, so a bare listing is never empty and a diff is the
# only honest check.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

# Read by tagspec.
# shellcheck disable=SC2034
CYCLE_ID=fixture
guard_account

if [ "${1:-}" = "--nuke" ]; then
  log "handing teardown to nuke.sh"
  "$AWS_DIR/nuke.sh" --yes
  "$AWS_DIR/inventory.sh" | artifact_tee "$ART/inventory-after-fixture-down.txt"
  exit 0
fi

ACTIVE="$(cat "$STATE/active-cycle" 2>/dev/null || true)"
if [ -n "$ACTIVE" ]; then
  log "cycle $ACTIVE still has a services box; tearing it down first"
  "$RUN_DIR/services-down.sh" "$ACTIVE"
fi

# Delete one recorded resource, and forget its id ONLY when the delete returned.
# A teardown that drops the id of something it did not delete leaves an orphan
# reachable by nothing but nuke.sh, which deletes by account.
FAILED=0
drop() {
  local what="$1" key="$2"; shift 2
  local id a
  local -a args=()
  id="$(state_get fixture "$key" || true)"
  [ -n "$id" ] || return 0
  for a in "$@"; do args+=("${a//@ID@/$id}"); done
  if awsm "${args[@]}" >/dev/null 2>&1; then
    state_del fixture "$key"
  else
    log "$what $id did not delete; its id STAYS in $(state_file fixture) so it can be retried"
    FAILED=$((FAILED + 1))
  fi
}

INSTANCE_ID="$(state_get fixture CLI_INSTANCE || true)"
if [ -n "$INSTANCE_ID" ]; then
  if awsm ec2 terminate-instances --instance-ids "$INSTANCE_ID" >/dev/null 2>&1; then
    log "waiting for $INSTANCE_ID to terminate"
    awsr ec2 wait instance-terminated --instance-ids "$INSTANCE_ID"
    state_del fixture CLI_INSTANCE
    state_del fixture CLI_PUBLIC
  else
    log "instance $INSTANCE_ID did not terminate; its id STAYS in $(state_file fixture). It is billing."
    FAILED=$((FAILED + 1))
  fi
fi

CACHE_VOL="$(state_get fixture CACHE_VOL || true)"
if [ -n "$CACHE_VOL" ]; then
  awsr ec2 wait volume-available --volume-ids "$CACHE_VOL" 2>/dev/null || true
  drop volume CACHE_VOL ec2 delete-volume --volume-id @ID@
fi

SG_CLI="$(state_get fixture SG_CLI || true)"
if [ -n "$SG_CLI" ]; then
  ok=false
  for _ in $(seq 1 12); do
    if awsm ec2 delete-security-group --group-id "$SG_CLI" >/dev/null 2>&1; then ok=true; break; fi
    sleep 10
  done
  if $ok; then
    state_del fixture SG_CLI
  else
    log "security group $SG_CLI did not delete; its id STAYS in $(state_file fixture)"
    FAILED=$((FAILED + 1))
  fi
fi

# Subnets before the network ACL: a custom ACL still associated with a subnet
# cannot be deleted, and deleting the subnet drops the association.
drop subnet SUBNET_SERVICES   ec2 delete-subnet --subnet-id @ID@
drop subnet SUBNET_RESTRICTED ec2 delete-subnet --subnet-id @ID@
drop network-acl ACL_ID ec2 delete-network-acl --network-acl-id @ID@
drop route-table RT_services   ec2 delete-route-table --route-table-id @ID@
drop route-table RT_restricted ec2 delete-route-table --route-table-id @ID@

IGW_ID="$(state_get fixture IGW_ID || true)"
VPC_ID="$(state_get fixture VPC_ID || true)"
if [ -n "$IGW_ID" ] && [ -n "$VPC_ID" ]; then
  awsm ec2 detach-internet-gateway --internet-gateway-id "$IGW_ID" --vpc-id "$VPC_ID" >/dev/null 2>&1 || true
fi
drop internet-gateway IGW_ID ec2 delete-internet-gateway --internet-gateway-id @ID@
drop vpc VPC_ID ec2 delete-vpc --vpc-id @ID@

if awsm ec2 delete-key-pair --key-name "$KEY_NAME" >/dev/null 2>&1; then
  rm -f "$KEY_FILE"
else
  log "key pair $KEY_NAME did not delete; $KEY_FILE is KEPT, because a surviving instance is only reachable with it"
  FAILED=$((FAILED + 1))
fi

# Local material. The cached Let's Encrypt certificate under state/le is
# deliberately kept and reused across runs: its duplicate-certificate limit is
# five per week. Everything else this run minted goes.
if [ "$FAILED" -eq 0 ]; then
  rm -f "$(state_file fixture)" "$STATE/userdata-cli.yaml" "$STATE/.synthetic-counter"
  for d in "$STATE"/cycle-*/; do
    [ -d "$d" ] || continue
    scope="$(basename "$d")"
    if [ -f "$(state_file "$scope")" ]; then
      log "keeping $d: $(state_file "$scope") still names resources to retry"
      continue
    fi
    rm -rf "$d"
    log "removed the leftover secrets and certificates in $d"
  done
else
  log "$FAILED resource(s) did not delete. $(state_file fixture) is KEPT with their ids; re-run $0, or $0 --nuke."
fi
log "kept under $STATE: $(ls -A "$STATE" 2>/dev/null | tr '\n' ' ')"

log "closing inventory (the full sweep, cross-region included, not --fast):"
"$AWS_DIR/inventory.sh" 2>&1 | artifact_tee "$ART/inventory-after-fixture-down.txt"
if [ -f "$ART/baseline-inventory.txt" ]; then
  echo
  log "difference from the pre-provision baseline (nothing below means the account is back where it started):"
  diff "$ART/baseline-inventory.txt" "$ART/inventory-after-fixture-down.txt" \
    | artifact_tee "$ART/inventory-diff.txt" || true
fi
[ "$FAILED" -eq 0 ] || exit 1
