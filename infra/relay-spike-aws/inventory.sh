#!/bin/bash
# What exists in the spike's own AWS account, and what it has cost.
# Read-only. Pinned to the account id in ACCOUNT_ID beside this file.
#
# Because the account holds nothing but this spike, "orphan count" after a
# teardown is simply whatever this prints. Tags are a convenience for telling
# one provision cycle from the next, not a security control.
#
# Every region is reported CLEAN, FOUND or UNCHECKED. A region whose call was
# denied is never called clean: that distinction is the whole point of the sweep.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
EXPECT=$(tr -d '[:space:]' < "$HERE/ACCOUNT_ID" 2>/dev/null)
[ -n "${EXPECT:-}" ] || { echo "ABORTING: no ACCOUNT_ID file beside this script" >&2; exit 1; }
PROFILE="${AWS_PROFILE:-psilink-spike}"
HOME_REGION="${AWS_REGION:-us-west-2}"
BRIEF=false; FAST=false
if [ $# -gt 0 ]; then for arg in "$@"; do [ "$arg" = "--brief" ] && BRIEF=true; [ "$arg" = "--fast" ] && FAST=true; done; fi
die() { echo "ABORTING: $*" >&2; exit 1; }

ACCT=$(aws --profile "$PROFILE" --region "$HOME_REGION" sts get-caller-identity \
  --query Account --output text 2>&1) || die "credentials do not resolve: $ACCT"
[ "$ACCT" = "$EXPECT" ] || die "WRONG ACCOUNT: credential is in $ACCT, expected $EXPECT"
echo "account $ACCT, region $HOME_REGION"

echo
echo "### EC2 resources in $HOME_REGION (a dedicated account, so anything here is the spike's)"
for pair in \
  "instances:Reservations[].Instances[?State.Name!=\`terminated\`].[InstanceId,InstanceType,State.Name]" \
  "volumes:Volumes[].[VolumeId,VolumeType,Size,State]" \
  "addresses:Addresses[].[PublicIp,AllocationId,AssociationId]" \
  "network-interfaces:NetworkInterfaces[].[NetworkInterfaceId,Status]" \
  "security-groups:SecurityGroups[?GroupName!=\`default\`].[GroupId,GroupName]" \
  "subnets:Subnets[].[SubnetId,CidrBlock]" \
  "network-acls:NetworkAcls[?!IsDefault].[NetworkAclId]" \
  "route-tables:RouteTables[?length(Associations[?Main==\`true\`])==\`0\`].[RouteTableId]" \
  "internet-gateways:InternetGateways[].[InternetGatewayId]" \
  "vpcs:Vpcs[?!IsDefault].[VpcId,CidrBlock,InstanceTenancy]" \
  "key-pairs:KeyPairs[].[KeyName]" ; do
  what="${pair%%:*}"; q="${pair#*:}"
  if out=$(aws --profile "$PROFILE" --region "$HOME_REGION" ec2 "describe-$what" \
            --query "$q" --output text 2>&1); then
    if [ -n "${out//[[:space:]]/}" ] && [ "$out" != "None" ]; then
      printf '  %-20s\n' "$what"; printf '%s\n' "$out" | sed 's/^/      /'
    else
      printf '  %-20s none\n' "$what"
    fi
  else
    printf '  %-20s UNCHECKED: %s\n' "$what" "$(printf '%s' "$out" | head -1 | cut -c1-70)"
  fi
done

TEN=$(aws --profile "$PROFILE" --region "$HOME_REGION" ec2 describe-vpcs \
  --query 'Vpcs[?InstanceTenancy!=`default`].[VpcId,InstanceTenancy]' --output text 2>/dev/null)
if [ -n "${TEN//[[:space:]]/}" ] && [ "$TEN" != "None" ]; then
  echo
  echo "  WARNING: a VPC here is not default tenancy. Instances launched into it"
  echo "  inherit dedicated tenancy and carry a per-region hourly fee. Delete it."
  printf '%s\n' "$TEN" | sed 's/^/      /'
fi

$BRIEF && exit 0
if $FAST; then echo; echo "(--fast: cross-region sweep skipped)"; fi

if ! REGIONS=$(aws --profile "$PROFILE" --region "$HOME_REGION" ec2 describe-regions \
      --query 'Regions[].RegionName' --output text 2>&1); then
  echo "COULD NOT ENUMERATE REGIONS: $REGIONS"
  echo "The sweep below covers $HOME_REGION only."
  REGIONS="$HOME_REGION"
fi

echo
ALLR=$(aws --profile "$PROFILE" --region "$HOME_REGION" ec2 describe-regions --all-regions \
  --query 'length(Regions)' --output text 2>/dev/null)
ENR=$(printf '%s' "$REGIONS" | wc -w | tr -d ' ')
echo "### every ENABLED region, for anything that escaped $HOME_REGION"
if [ -n "${ALLR:-}" ] && [ "$ALLR" != "None" ]; then
  echo "    $ENR enabled of $ALLR; a region this account has not opted into cannot hold a resource."
fi
echo "    CLEAN means no instances and no elastic IPs. The full listing above covers $HOME_REGION."
UNCHECKED=0; FOUND=0
for r in $REGIONS; do
  $FAST && break
  ok=true; lines=""; err=""
  if out=$(aws --profile "$PROFILE" --region "$r" ec2 describe-instances \
      --filters Name=instance-state-name,Values=pending,running,stopping,stopped \
      --query 'Reservations[].Instances[].[`instance`,InstanceId,InstanceType]' \
      --output text 2>&1); then [ -n "$out" ] && lines+="$out"$'\n'
  else ok=false; err="$out"; fi
  if $ok && out=$(aws --profile "$PROFILE" --region "$r" ec2 describe-addresses \
      --query 'Addresses[].[`eip`,PublicIp]' --output text 2>&1); then
    [ -n "$out" ] && lines+="$out"$'\n'
  elif $ok; then ok=false; err="$out"; fi

  if ! $ok; then
    UNCHECKED=$((UNCHECKED+1))
    printf '  %-16s UNCHECKED  %s\n' "$r" "$(printf '%s' "$err" | head -1 | cut -c1-80)"
  elif [ -n "${lines//[[:space:]]/}" ]; then
    FOUND=$((FOUND+1)); printf '  %-16s FOUND\n' "$r"; printf '%s' "$lines" | sed 's/^/      /'
  else
    printf '  %-16s CLEAN\n' "$r"
  fi
done
echo "  regions with resources: $FOUND   could not be checked: $UNCHECKED"
if [ "$UNCHECKED" -gt 0 ]; then
  echo "  An UNCHECKED region is not a clean region."
fi

echo
echo "### month-to-date spend for this account"
START=$(date -u +%Y-%m-01)
if command -v gdate >/dev/null 2>&1; then END=$(gdate -u -d tomorrow +%Y-%m-%d)
elif date -u -v+1d +%Y-%m-%d >/dev/null 2>&1; then END=$(date -u -v+1d +%Y-%m-%d)
else END=$(date -u -d tomorrow +%Y-%m-%d); fi
if COST=$(aws --profile "$PROFILE" --region us-east-1 ce get-cost-and-usage \
    --time-period Start="$START",End="$END" --granularity MONTHLY --metrics UnblendedCost \
    --query 'ResultsByTime[].Total.UnblendedCost.Amount' --output text 2>&1); then
  echo "  $START to $END: \$$COST"
else
  case "$COST" in
    *AccessDenied*|*not\ authorized*) echo "  Cost Explorer DENIED. Spend UNKNOWN, not zero." ;;
    *DataUnavailable*|*not\ enabled*|*OptIn*) echo "  Cost Explorer not enabled here. Spend UNKNOWN, not zero." ;;
    *) echo "  Cost Explorer failed, spend UNKNOWN: $(printf '%s' "$COST" | head -1)" ;;
  esac
fi

echo
echo "### budget"
if B=$(aws --profile "$PROFILE" --region us-east-1 budgets describe-budgets --account-id "$ACCT" \
    --query 'Budgets[].[BudgetName,BudgetLimit.Amount,CalculatedSpend.ActualSpend.Amount]' \
    --output text 2>&1); then
  if [ -n "${B//[[:space:]]/}" ]; then printf '%s\n' "$B" | sed 's/^/  /'
  else echo "  No budget on this account."; fi
else
  echo "  Budget state UNKNOWN: $(printf '%s' "$B" | head -1)"
fi
