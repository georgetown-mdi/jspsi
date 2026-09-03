#!/bin/bash
# Prove the guardrails behave as claimed, against the live IAM evaluator, before
# anything is created.
#
# Every EC2 check uses --dry-run, which asks IAM the authorization question and
# creates nothing: "DryRunOperation" means the call WOULD have succeeded,
# "UnauthorizedOperation" means a policy denied it. This is the only way to
# settle how a condition behaves when its key is absent, which three static
# reviews of this policy answered three different ways. Costs nothing.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
EXPECT=$(tr -d '[:space:]' < "$HERE/ACCOUNT_ID" 2>/dev/null)
PROFILE="${AWS_PROFILE:-psilink-spike}"
REGION=us-west-2
PASS=0; FAIL=0; SKIP=0

acct=$(aws --profile "$PROFILE" --region "$REGION" sts get-caller-identity \
  --query Account --output text 2>&1) || { echo "credentials do not resolve: $acct"; exit 1; }
[ "$acct" = "$EXPECT" ] || { echo "WRONG ACCOUNT: $acct, expected $EXPECT"; exit 1; }
echo "account $acct"

# The newest Amazon Linux 2023 arm64 image, resolved from SSM so no id is pinned.
AMI=$(aws --profile "$PROFILE" --region "$REGION" ssm get-parameters \
  --names /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
  --query 'Parameters[0].Value' --output text 2>/dev/null)
if [ -z "${AMI:-}" ] || [ "$AMI" = "None" ]; then
  AMI=$(aws --profile "$PROFILE" --region "$REGION" ec2 describe-images \
    --owners amazon --filters Name=name,Values='al2023-ami-2023*arm64' \
    --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text 2>/dev/null)
fi
[ -n "${AMI:-}" ] && [ "$AMI" != "None" ] || { echo "could not resolve an Amazon Linux AMI"; exit 1; }
AMI_X86=$(aws --profile "$PROFILE" --region "$REGION" ec2 describe-images --owners amazon \
  --filters Name=name,Values='al2023-ami-2023*x86_64' Name=state,Values=available \
  --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text 2>/dev/null)
UBUNTU_X86=$(aws --profile "$PROFILE" --region "$REGION" ec2 describe-images --owners 099720109477 \
  --filters Name=name,Values='ubuntu/images/hvm-ssd*amd64*' Name=state,Values=available \
  --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text 2>/dev/null)
echo "arm64 $AMI, x86_64 $AMI_X86, third-party $UBUNTU_X86"
echo

# check <expectation allow|deny> <label> <aws args...>
check() {
  local want="$1" label="$2"; shift 2
  local out got status
  out=$(aws --profile "$PROFILE" --region "$REGION" "$@" 2>&1)
  status=$?
  case "$out" in
    *DryRunOperation*) got=allow ;;
    *UnauthorizedOperation*|*AccessDenied*|*not\ authorized*|*explicit\ deny*)
      got=deny ;;
    *) if [ "$status" -eq 0 ]; then got=allow; else got="UNCLEAR"; fi ;;
  esac
  if [ "$got" = "$want" ]; then
    printf '  PASS  %-52s (%s)\n' "$label" "$got"; PASS=$((PASS+1))
  else
    printf '  FAIL  %-52s wanted %s, got %s\n' "$label" "$want" "$got"; FAIL=$((FAIL+1))
    printf '        exit %s: %s\n' "$status" "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-150)"
  fi
}

echo "### the workload must be permitted"
check allow "launch t4g.nano, no block device mapping" \
  ec2 run-instances --dry-run --image-id "$AMI" --instance-type t4g.nano
check allow "create a VPC" ec2 create-vpc --dry-run --cidr-block 10.99.0.0/16
check allow "create a security group" \
  ec2 create-security-group --dry-run --group-name verify-probe --description probe
check allow "allocate an elastic IP" ec2 allocate-address --dry-run
check allow "describe in another region (for the escape sweep)" \
  ec2 describe-instances --region us-east-1 --max-items 1

echo
echo "### the cost guardrails must bite"
check deny "launch an oversized ARM instance (m6g.large)" \
  ec2 run-instances --dry-run --image-id "$AMI" --instance-type m6g.large
check deny "launch an oversized x86 instance (m5.large)" \
  ec2 run-instances --dry-run --image-id "$AMI_X86" --instance-type m5.large
check deny "launch with a 100 GiB root volume" \
  ec2 run-instances --dry-run --image-id "$AMI" --instance-type t4g.nano \
    --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":100,"VolumeType":"gp3"}}]'
check deny "launch with an io2 volume" \
  ec2 run-instances --dry-run --image-id "$AMI" --instance-type t4g.nano \
    --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":8,"VolumeType":"io2","Iops":10000}}]'
check deny "launch with dedicated tenancy (where it bills)" \
  ec2 run-instances --dry-run --image-id "$AMI_X86" --instance-type t3.micro \
    --placement Tenancy=dedicated
check deny "reach AWS Marketplace at all" \
  marketplace-catalog list-entities --region us-east-1 --catalog AWSMarketplace --entity-type Offer
check deny "create a VPC peering connection" \
  ec2 create-vpc-peering-connection --dry-run --vpc-id vpc-00000000000000000
check deny "create a placement group" \
  ec2 create-placement-group --dry-run --group-name probe --strategy cluster
check deny "create a launch template" \
  ec2 create-launch-template --dry-run --launch-template-name probe \
    --launch-template-data '{"InstanceType":"t3.micro"}'
check deny "create a VPN gateway" ec2 create-vpn-gateway --dry-run --type ipsec.1
REAL_VPC=$(aws --profile "$PROFILE" --region "$REGION" ec2 describe-vpcs \
  --query 'Vpcs[0].VpcId' --output text 2>/dev/null)
if [ -n "${REAL_VPC:-}" ] && [ "$REAL_VPC" != "None" ]; then
  check deny "create flow logs" \
    ec2 create-flow-logs --dry-run --resource-type VPC --resource-ids "$REAL_VPC" \
      --traffic-type ALL --log-destination-type s3 \
      --log-destination arn:aws:s3:::psilink-spike-probe
else
  printf '  SKIP  %-52s no VPC exists yet to test against\n' "create flow logs"
  SKIP=$((SKIP+1))
fi

check allow "launch a free third-party AMI (measured: NOT restricted)" \
  ec2 run-instances --dry-run --image-id "$UBUNTU_X86" --instance-type t3.micro

echo
echo "### escalation and region must be shut"
check deny "list IAM users" iam list-users
check deny "create an IAM user" iam create-user --user-name probe
check deny "create a VPC in us-east-1" \
  ec2 create-vpc --dry-run --region us-east-1 --cidr-block 10.97.0.0/16
check deny "delete the CloudTrail trail" cloudtrail delete-trail --name probe
check deny "reach S3 at all" s3api list-buckets

echo
echo "  passed $PASS, failed $FAIL, skipped $SKIP"
[ "$SKIP" -gt 0 ] && echo "  A skipped check was never asked of IAM. Re-run once the VPC exists."
if [ "$FAIL" -gt 0 ]; then
  echo "  DO NOT USE THIS CREDENTIAL until every line passes."
  exit 1
fi
echo "  every guardrail behaved as claimed."
