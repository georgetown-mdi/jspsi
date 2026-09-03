#!/bin/bash
# Destroy everything this spike created in its own AWS account.
#
# THE SAFETY MECHANISM IS THE ACCOUNT PIN, not a tag. The script refuses to run
# unless the caller's account id matches ACCOUNT_ID beside this file. Earlier
# revisions scoped deletion by tag because they ran in an account holding real
# infrastructure; that scoping was rejected four times, twice for being unsafe
# and twice for blocking the workload. An account of its own removes the problem:
# everything here belongs to the spike, so everything here can go.
#
# DRY RUN unless --yes appears anywhere in the arguments.
#
# This deletes EVERY non-default VPC and, because the subnet, interface and
# gateway sweeps are account-wide rather than VPC-scoped, the default VPC's
# subnets and internet gateway go too. In a dedicated account that is correct.
# Default security groups, network ACLs and main route tables cannot be deleted
# independently and are skipped.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
EXPECT=$(tr -d '[:space:]' < "$HERE/ACCOUNT_ID" 2>/dev/null)
PROFILE="${AWS_PROFILE:-psilink-spike}"
REGION="${AWS_REGION:-us-west-2}"
[ "$REGION" = "us-west-2" ] || { echo "ABORTING: this spike lives in us-west-2; AWS_REGION is $REGION" >&2; exit 1; }
A=(--profile "$PROFILE" --region "$REGION")

GO=false
if [ $# -gt 0 ]; then for arg in "$@"; do [ "$arg" = "--yes" ] && GO=true; done; fi
$GO || echo "=== DRY RUN. Read-only. Re-run with --yes to destroy. ==="

die() { echo "ABORTING: $*" >&2; exit 1; }

[ -n "${EXPECT:-}" ] || die "no ACCOUNT_ID file beside this script; refusing to guess"
ACCT=$(aws "${A[@]}" sts get-caller-identity --query Account --output text 2>&1) \
  || die "credentials do not resolve for profile $PROFILE: $ACCT"
[ "$ACCT" = "$EXPECT" ] || die "WRONG ACCOUNT. This credential is in $ACCT, and this script only runs in $EXPECT. Nothing was touched."
echo "account $ACCT confirmed, region $REGION"

FAILED=0

# Read-only lookup, captured in the parent shell: the abort helper called inside
# a command substitution would kill only the subshell, so a throttled call would
# read as "nothing to delete".
look() {
  local out
  if ! out=$(aws "${A[@]}" ec2 "describe-$1" --query "$2" --output text 2>&1); then
    printf 'describe-%s: %s\n' "$1" "$out" >&2
    return 1
  fi
  [ "$out" = "None" ] && out=""
  printf '%s' "$out" | tr '\t' '\n' | grep -v '^$' || true
}

# Retries dependency errors, which are routine rather than exceptional: ENI and
# address release are eventually consistent. On final failure it records and
# CONTINUES, because giving up on the first error strands everything behind it.
run() {
  if ! $GO; then echo "WOULD RUN: aws ${A[*]} $*"; return 0; fi
  echo "+ aws ${A[*]} $*"
  local attempt out
  for attempt in 1 2 3 4 5; do
    if out=$(aws "${A[@]}" "$@" 2>&1); then return 0; fi
    case "$out" in
      *DependencyViolation*|*currently\ in\ use*|*RequestLimitExceeded*|*Throttling*|*IncorrectState*)
        echo "    attempt $attempt failed, retrying in $((attempt * 6))s"
        sleep $((attempt * 6)) ;;
      *) echo "    FAILED: $(printf '%s' "$out" | head -1)" >&2; FAILED=$((FAILED+1)); return 0 ;;
    esac
  done
  echo "    FAILED after 5 attempts: $(printf '%s' "$out" | head -1)" >&2
  FAILED=$((FAILED+1)); return 0
}

INSTANCES=$(look instances 'Reservations[].Instances[?State.Name!=`terminated`].InstanceId') \
  || die "instance lookup failed; nothing attempted"
for i in $INSTANCES; do run ec2 terminate-instances --instance-ids "$i"; done
if $GO && [ -n "${INSTANCES//[[:space:]]/}" ]; then
  echo "waiting for termination"
  # shellcheck disable=SC2086
  aws "${A[@]}" ec2 wait instance-terminated --instance-ids $INSTANCES \
    || echo "    warning: wait did not confirm termination; later deletes may retry"
fi

# Every volume, not only the available ones: an in-use volume skipped here was
# invisible to the failure count and the run still exited 0 with it billing.
VOLUMES=$(look volumes 'Volumes[].VolumeId') || die "volume lookup failed"
for v in $VOLUMES; do run ec2 delete-volume --volume-id "$v"; done

if ! ADDRS=$(aws "${A[@]}" ec2 describe-addresses \
      --query 'Addresses[].[AllocationId,AssociationId]' --output text 2>&1); then
  die "describe-addresses failed: $ADDRS"
fi
while read -r alloc assoc; do
  if [ -z "${alloc:-}" ] || [ "$alloc" = "None" ]; then continue; fi
  if [ -n "${assoc:-}" ] && [ "$assoc" != "None" ]; then
    run ec2 disassociate-address --association-id "$assoc"
  fi
  run ec2 release-address --allocation-id "$alloc"
done <<< "$ADDRS"

NICS=$(look network-interfaces 'NetworkInterfaces[?Status==`available`].NetworkInterfaceId') \
  || die "network interface lookup failed"
for n in $NICS; do run ec2 delete-network-interface --network-interface-id "$n"; done

SGS=$(look security-groups 'SecurityGroups[?GroupName!=`default`].GroupId') \
  || die "security group lookup failed"
for g in $SGS; do run ec2 delete-security-group --group-id "$g"; done

SUBNETS=$(look subnets 'Subnets[].SubnetId') || die "subnet lookup failed"
for s in $SUBNETS; do run ec2 delete-subnet --subnet-id "$s"; done

# Subnets first: a custom network ACL still associated with a subnet cannot be
# deleted, and deleting the subnet drops the association.
ACLS=$(look network-acls 'NetworkAcls[?!IsDefault].NetworkAclId') || die "network ACL lookup failed"
for acl in $ACLS; do run ec2 delete-network-acl --network-acl-id "$acl"; done

RTBS=$(look route-tables 'RouteTables[?length(Associations[?Main==`true`])==`0`].RouteTableId') \
  || die "route table lookup failed"
for r in $RTBS; do run ec2 delete-route-table --route-table-id "$r"; done

IGWS=$(look internet-gateways 'InternetGateways[].InternetGatewayId') || die "gateway lookup failed"
for igw in $IGWS; do
  if ! att=$(aws "${A[@]}" ec2 describe-internet-gateways --internet-gateway-ids "$igw" \
        --query 'InternetGateways[].Attachments[].VpcId' --output text 2>&1); then
    echo "    FAILED reading attachments for $igw" >&2; FAILED=$((FAILED+1)); continue
  fi
  [ "$att" = "None" ] && att=""
  for v in $att; do run ec2 detach-internet-gateway --internet-gateway-id "$igw" --vpc-id "$v"; done
  run ec2 delete-internet-gateway --internet-gateway-id "$igw"
done

PCX=$(look vpc-peering-connections 'VpcPeeringConnections[?Status.Code!=`deleted`].VpcPeeringConnectionId') \
  || die "peering lookup failed"
for p in $PCX; do run ec2 delete-vpc-peering-connection --vpc-peering-connection-id "$p"; done

VPCS=$(look vpcs 'Vpcs[?!IsDefault].VpcId') || die "VPC lookup failed"
for v in $VPCS; do run ec2 delete-vpc --vpc-id "$v"; done

KEYS=$(look key-pairs 'KeyPairs[].KeyName') || die "key pair lookup failed"
for k in $KEYS; do run ec2 delete-key-pair --key-name "$k"; done

echo
echo "=== what remains in $REGION ==="
if ! "$HERE/inventory.sh" --brief; then
  echo "    warning: the closing inventory could not run, so what remains is UNKNOWN"
  FAILED=$((FAILED + 1))
fi

if [ "$FAILED" -gt 0 ]; then
  echo
  echo "$FAILED delete(s) failed. Teardown INCOMPLETE. Re-run; dependency errors"
  echo "usually clear once the resources ahead of them are gone."
  exit 1
fi
$GO && echo && echo "teardown complete, nothing failed"
exit 0
