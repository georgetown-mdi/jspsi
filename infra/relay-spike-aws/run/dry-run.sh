#!/bin/bash
# Ask the live IAM evaluator whether every mutating EC2 call this directory makes
# would be authorized. Creates nothing and costs nothing: --dry-run asks the
# authorization question and stops.
#
# Three outcomes, and the third is the one relay-spike-aws/verify.sh warns about:
#   PASS  DryRunOperation      -- IAM was consulted and said yes.
#   FAIL  Unauthorized/Denied  -- IAM was consulted and said no. The run would break.
#   SKIP  anything else        -- AWS rejected the call on its parameters BEFORE
#                                consulting IAM, so nothing was proved either way.
#                                A SKIP is not a pass. Its message is printed so
#                                the reader can see what stopped it.
#
# Ids that do not exist are used deliberately where a real one would have to be
# created first. Where that turns a check into a SKIP, the line says so.
#
# Four calls -- attach-volume, detach-volume, terminate-instances, delete-volume
# -- cannot be asked at all until a real instance and volume exist: their id
# shapes are checked before IAM is, so an invented id comes back Malformed. They
# are counted and NAMED separately from the passes, never folded into them, and
# --with-fixture asks them once fixture-up.sh has made the two resources.
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

guard_account
WITH_FIXTURE=0
if [ "${1:-}" = "--with-fixture" ]; then WITH_FIXTURE=1; fi
# Four separate tallies, because they answer four different questions and one
# counter cannot. AUTHORIZED is what the run needs IAM to allow; DENIED_OK is
# what the guardrails must refuse and did; the two FAIL counters are each of
# those coming back the other way round; SKIP is a call AWS rejected on its
# parameters before IAM was consulted, which proves nothing either way.
AUTHORIZED=0; DENIED_OK=0; FAIL_AUTH=0; FAIL_DENY=0; SKIP=0
RPASS=0; RFAIL=0
UNASKABLE=()
FAKE_VPC=vpc-00000000000000000
FAKE_SUBNET=subnet-00000000000000000
FAKE_SG=sg-00000000000000000
FAKE_IGW=igw-00000000000000000
FAKE_RT=rtb-00000000000000000
FAKE_ACL=acl-00000000000000000
FAKE_ENI=eni-00000000000000000
FAKE_INSTANCE=i-00000000000000000
FAKE_ALLOC=eipalloc-00000000000000000
FAKE_ASSOC=eipassoc-00000000000000000
FAKE_ACL_ASSOC=aclassoc-00000000000000000

# Five id shapes reject an invented value on their format before IAM is
# consulted, so those checks would prove nothing. Real ids stand in for them:
# --dry-run creates, modifies and deletes nothing whatever id it is handed, and
# these five already exist in the account. Measured, not assumed: an invented
# security group, network ACL, gateway, instance or volume id comes back
# InvalidGroupId.Malformed and its kin, which the SKIP path below reports.
REAL_VPC="$(awsr ec2 describe-vpcs --query 'Vpcs[0].VpcId' --output text 2>/dev/null || echo "$FAKE_VPC")"
REAL_SUBNET="$(awsr ec2 describe-subnets --query 'Subnets[0].SubnetId' --output text 2>/dev/null || echo "$FAKE_SUBNET")"
REAL_SG="$(awsr ec2 describe-security-groups --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo "$FAKE_SG")"
REAL_IGW="$(awsr ec2 describe-internet-gateways --query 'InternetGateways[0].InternetGatewayId' --output text 2>/dev/null || echo "$FAKE_IGW")"
REAL_ACL="$(awsr ec2 describe-network-acls --query 'NetworkAcls[0].NetworkAclId' --output text 2>/dev/null || echo "$FAKE_ACL")"

# An instance and a volume exist only once the fixture does. --with-fixture
# re-runs the four checks that need them against the fixture's own ids.
REAL_INSTANCE="$(state_get fixture CLI_INSTANCE 2>/dev/null || true)"
REAL_VOLUME="$(state_get fixture CACHE_VOL 2>/dev/null || true)"

AMI="$(newest_ubuntu_ami)"
[ -n "$AMI" ] && [ "$AMI" != "None" ] || die "could not resolve an Ubuntu 24.04 arm64 image"
echo "image $AMI, tag specifications as the scripts write them"
echo

TAGS_INSTANCE="$(tagspec instance dry-run fixture)"
TAGS_VOLUME="$(tagspec volume dry-run fixture)"
TAGS_ENI="$(tagspec network-interface dry-run fixture)"

check() {
  local label="$1"; shift
  local out status
  out="$(aws --profile "$PROFILE" --region "$REGION" "$@" 2>&1)"
  status=$?
  case "$out" in
    *DryRunOperation*)
      printf '  PASS  %-56s\n' "$label"; AUTHORIZED=$((AUTHORIZED + 1)) ;;
    *UnauthorizedOperation*|*AccessDenied*|*"not authorized"*|*"explicit deny"*)
      printf '  FAIL  %-56s %s\n' "$label" "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-110)"
      FAIL_AUTH=$((FAIL_AUTH + 1)) ;;
    *)
      printf '  SKIP  %-56s exit %s: %s\n' "$label" "$status" \
        "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-110)"
      SKIP=$((SKIP + 1)) ;;
  esac
}

echo "### fixture-up.sh"
check "create-vpc" ec2 create-vpc --dry-run --cidr-block "$VPC_CIDR" \
  --tag-specifications "$(tagspec vpc dry-run fixture)"
check "create-subnet" ec2 create-subnet --dry-run --vpc-id "$FAKE_VPC" \
  --cidr-block "$SERVICES_CIDR" --availability-zone "$AZ" \
  --tag-specifications "$(tagspec subnet dry-run fixture)"
check "create-internet-gateway" ec2 create-internet-gateway --dry-run \
  --tag-specifications "$(tagspec internet-gateway dry-run fixture)"
check "attach-internet-gateway" ec2 attach-internet-gateway --dry-run \
  --internet-gateway-id "$REAL_IGW" --vpc-id "$FAKE_VPC"
check "create-route-table" ec2 create-route-table --dry-run --vpc-id "$FAKE_VPC" \
  --tag-specifications "$(tagspec route-table dry-run fixture)"
check "create-route to the gateway" ec2 create-route --dry-run --route-table-id "$FAKE_RT" \
  --destination-cidr-block 0.0.0.0/0 --gateway-id "$FAKE_IGW"
check "associate-route-table" ec2 associate-route-table --dry-run \
  --route-table-id "$FAKE_RT" --subnet-id "$FAKE_SUBNET"
check "create-network-acl" ec2 create-network-acl --dry-run --vpc-id "$FAKE_VPC" \
  --tag-specifications "$(tagspec network-acl dry-run fixture)"
check "replace-network-acl-association" ec2 replace-network-acl-association --dry-run \
  --association-id "$FAKE_ACL_ASSOC" --network-acl-id "$REAL_ACL"
check "create-security-group" ec2 create-security-group --dry-run \
  --group-name dry-run-probe --description probe --vpc-id "$FAKE_VPC" \
  --tag-specifications "$(tagspec security-group dry-run fixture)"
check "authorize-security-group-ingress (ssh)" ec2 authorize-security-group-ingress --dry-run \
  --group-id "$REAL_SG" --protocol tcp --port 22 --cidr 203.0.113.1/32
check "authorize-security-group-ingress (--ip-permissions)" ec2 authorize-security-group-ingress \
  --dry-run --group-id "$REAL_SG" \
  --ip-permissions 'IpProtocol=udp,FromPort=49152,ToPort=49200,IpRanges=[{CidrIp=203.0.113.1/32}]'
check "create-key-pair" ec2 create-key-pair --dry-run --key-name dry-run-probe \
  --key-type ed25519 --tag-specifications "$(tagspec key-pair dry-run fixture)"
check "create-volume (16 GiB gp3)" ec2 create-volume --dry-run --availability-zone "$AZ" \
  --size "$CACHE_VOLUME_GIB" --volume-type gp3 --tag-specifications "$TAGS_VOLUME"
# --key-name is omitted: the key pair does not exist before fixture-up.sh runs,
# and RunInstances rejects a missing one before consulting IAM. No IAM condition
# key binds the key name, so the authorization decision is the same without it.
check "run-instances t4g.nano, as fixture-up writes it (minus --key-name)" ec2 run-instances --dry-run \
  --image-id "$AMI" --instance-type "$INSTANCE_TYPE_CLI" \
  --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":$ROOT_VOLUME_GIB,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
  --network-interfaces "AssociatePublicIpAddress=true,DeviceIndex=0,SubnetId=$REAL_SUBNET,Groups=$REAL_SG,PrivateIpAddress=$IP_CLI,DeleteOnTermination=true" \
  --tag-specifications "$TAGS_INSTANCE" "$TAGS_VOLUME" "$TAGS_ENI"
if [ -n "$REAL_INSTANCE" ] && [ -n "$REAL_VOLUME" ] && [ "$WITH_FIXTURE" = 1 ]; then
  check "attach-volume" ec2 attach-volume --dry-run --volume-id "$REAL_VOLUME" \
    --instance-id "$REAL_INSTANCE" --device /dev/sdf
  check "detach-volume" ec2 detach-volume --dry-run --volume-id "$REAL_VOLUME"
  check "terminate-instances" ec2 terminate-instances --dry-run --instance-ids "$REAL_INSTANCE"
  check "delete-volume" ec2 delete-volume --dry-run --volume-id "$REAL_VOLUME"
else
  for c in attach-volume detach-volume terminate-instances delete-volume; do
    printf '  UNASKABLE  %-51s no instance or volume exists yet; re-run with --with-fixture\n' "$c"
    UNASKABLE+=("$c")
  done
fi

echo
echo "### services-up.sh"
check "run-instances t4g.micro, two private addresses (minus --key-name)" ec2 run-instances --dry-run \
  --image-id "$AMI" --instance-type "$INSTANCE_TYPE_SERVICES" \
  --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":$ROOT_VOLUME_GIB,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
  --network-interfaces "DeviceIndex=0,SubnetId=$REAL_SUBNET,Groups=$REAL_SG,DeleteOnTermination=true,PrivateIpAddresses=[{Primary=true,PrivateIpAddress=$IP_TURN},{Primary=false,PrivateIpAddress=$IP_WEB}]" \
  --tag-specifications "$TAGS_INSTANCE" "$TAGS_VOLUME" "$TAGS_ENI"
check "allocate-address" ec2 allocate-address --dry-run --domain vpc \
  --tag-specifications "$(tagspec elastic-ip dry-run fixture)"
check "associate-address to a secondary address" ec2 associate-address --dry-run \
  --allocation-id "$FAKE_ALLOC" --network-interface-id "$FAKE_ENI" --private-ip-address "$IP_WEB"
check "create-network-interface (the proxy next hop)" ec2 create-network-interface --dry-run \
  --subnet-id "$REAL_SUBNET" --private-ip-address "$IP_PROXY" --groups "$REAL_SG" \
  --description probe --tag-specifications "$TAGS_ENI"
check "modify-network-interface-attribute --no-source-dest-check" \
  ec2 modify-network-interface-attribute --dry-run --network-interface-id "$FAKE_ENI" \
  --no-source-dest-check
check "attach-network-interface" ec2 attach-network-interface --dry-run \
  --network-interface-id "$FAKE_ENI" --instance-id "$FAKE_INSTANCE" --device-index 1

echo
echo "### set-class.sh"
check "create-network-acl-entry (deny udp)" ec2 create-network-acl-entry --dry-run \
  --network-acl-id "$REAL_ACL" --rule-number 90 --protocol 17 --rule-action deny \
  --cidr-block 0.0.0.0/0 --egress --port-range From=1,To=65535
check "create-network-acl-entry (allow tcp 443)" ec2 create-network-acl-entry --dry-run \
  --network-acl-id "$REAL_ACL" --rule-number 100 --protocol 6 --rule-action allow \
  --cidr-block "$IP_TURN/32" --ingress --port-range From=443,To=443
check "delete-network-acl-entry" ec2 delete-network-acl-entry --dry-run \
  --network-acl-id "$REAL_ACL" --rule-number 100 --egress
check "create-route to an interface (class B)" ec2 create-route --dry-run \
  --route-table-id "$FAKE_RT" --destination-cidr-block "$SERVICES_CIDR" \
  --network-interface-id "$FAKE_ENI"
check "delete-route" ec2 delete-route --dry-run --route-table-id "$FAKE_RT" \
  --destination-cidr-block "$SERVICES_CIDR"

echo
echo "### services-down.sh and fixture-down.sh"
check "delete-network-interface" ec2 delete-network-interface --dry-run --network-interface-id "$FAKE_ENI"
check "disassociate-address" ec2 disassociate-address --dry-run --association-id "$FAKE_ASSOC"
check "release-address" ec2 release-address --dry-run --allocation-id "$FAKE_ALLOC"
check "delete-security-group" ec2 delete-security-group --dry-run --group-id "$REAL_SG"
check "delete-subnet" ec2 delete-subnet --dry-run --subnet-id "$FAKE_SUBNET"
check "delete-network-acl" ec2 delete-network-acl --dry-run --network-acl-id "$REAL_ACL"
check "delete-route-table" ec2 delete-route-table --dry-run --route-table-id "$FAKE_RT"
check "detach-internet-gateway" ec2 detach-internet-gateway --dry-run \
  --internet-gateway-id "$REAL_IGW" --vpc-id "$FAKE_VPC"
check "delete-internet-gateway" ec2 delete-internet-gateway --dry-run --internet-gateway-id "$REAL_IGW"
check "delete-vpc" ec2 delete-vpc --dry-run --vpc-id "$FAKE_VPC"
check "delete-key-pair" ec2 delete-key-pair --dry-run --key-name dry-run-probe

echo
echo "### the guardrails must still bite on what these scripts must never do"
check_deny() {
  local label="$1"; shift
  local out
  out="$(aws --profile "$PROFILE" --region "$REGION" "$@" 2>&1)"
  case "$out" in
    *UnauthorizedOperation*|*AccessDenied*|*"not authorized"*|*"explicit deny"*)
      printf '  PASS  %-56s (denied, as it must be)\n' "$label"; DENIED_OK=$((DENIED_OK + 1)) ;;
    *DryRunOperation*)
      printf '  FAIL  %-56s ALLOWED, and it must not be\n' "$label"; FAIL_DENY=$((FAIL_DENY + 1)) ;;
    *)
      printf '  SKIP  %-56s %s\n' "$label" "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-110)"
      SKIP=$((SKIP + 1)) ;;
  esac
}
check_deny "run-instances at a size the budget cannot carry" ec2 run-instances --dry-run \
  --image-id "$AMI" --instance-type m6g.large
check_deny "create-volume above the 16 GiB cap" ec2 create-volume --dry-run \
  --availability-zone "$AZ" --size 64 --volume-type gp3 \
  --tag-specifications "$(tagspec volume dry-run fixture)"
check_deny "create-image (there is no AMI baking path)" ec2 create-image --dry-run \
  --instance-id "${REAL_INSTANCE:-$FAKE_INSTANCE}" --name probe
check_deny "create-nat-gateway (it bills by the hour)" ec2 create-nat-gateway --dry-run \
  --subnet-id "$REAL_SUBNET" --connectivity-type private

echo
echo "### what the deployed policy actually permits, reported not judged"
echo "  relay-spike-aws/README.md describes a tagging guardrail split across three policies. Only"
echo "  spike-policy-allow.json and spike-policy-guardrails.json exist beside it, and the"
echo "  guardrails file carries no tagging statement. These two lines measure what is"
echo "  really attached; they are INFO, because which posture the account should have is"
echo "  the owner's call, not this script's."
info() {
  local label="$1"; shift
  local out
  out="$(aws --profile "$PROFILE" --region "$REGION" "$@" 2>&1)"
  case "$out" in
    *DryRunOperation*) printf '  INFO  %-56s ALLOWED\n' "$label" ;;
    *UnauthorizedOperation*|*AccessDenied*|*"not authorized"*|*"explicit deny"*)
      printf '  INFO  %-56s denied\n' "$label" ;;
    *) printf '  INFO  %-56s unclear: %s\n' "$label" \
         "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-90)" ;;
  esac
}
info "tag a pre-existing resource this spike did not create" \
  ec2 create-tags --dry-run --resources "$REAL_VPC" --tags Key=psilink-spike,Value=1
info "delete a pre-existing VPC this spike did not create" \
  ec2 delete-vpc --dry-run --vpc-id "$REAL_VPC"

echo
echo "### redact() self-test: the artifacts must not carry a credential"
# lib.sh's redact is what stands between a minted TURN credential and
# relay-spike-aws/artifacts. A value-shaped rule missed base64url once, so the shapes that
# broke it are checked here rather than asserted in a comment.
SECRET_A='kQ8v-Z3xJ0aB7cD9eF1gH2iJ3kL4mN5oP'
SECRET_B='YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo='
redact_case() {
  local label="$1" line="$2" needle="$3" out
  out="$(printf '%s' "$line" | redact)"
  if printf '%s' "$out" | grep -qF -- "$needle"; then
    printf '  FAIL  %-56s survived redaction: %s\n' "$label" "$out"; RFAIL=$((RFAIL + 1))
  else
    printf '  PASS  %-56s\n' "$label"; RPASS=$((RPASS + 1))
  fi
}
# The other direction. A path and a zone name are not secrets, and an artifact
# that redacts them is a worse artifact; the intersection an exchange resolves is
# compared against expected/, so redaction has to leave it byte for byte.
redact_keeps() {
  local label="$1" line="$2" needle="$3" out
  out="$(printf '%s' "$line" | redact)"
  if printf '%s' "$out" | grep -qF -- "$needle"; then
    printf '  PASS  %-56s\n' "$label"; RPASS=$((RPASS + 1))
  else
    printf '  FAIL  %-56s over-redacted: %s\n' "$label" "$out"; RFAIL=$((RFAIL + 1))
  fi
}
redact_case "base64url credential in a JSON response" \
  "{\"iceServers\":{\"username\":\"u\",\"credential\":\"$SECRET_A\"}}" "$SECRET_A"
redact_case "standard base64 credential in a JSON response" \
  "{\"iceServers\":{\"credential\":\"$SECRET_B\"}}" "$SECRET_B"
redact_case "credential embedded in a URL query" \
  "turns:relay.example:443?transport=tcp&credential=$SECRET_A" "$SECRET_A"
redact_case "credential in URL userinfo" \
  "https://party:$SECRET_A@relay.example/path" "$SECRET_A"
redact_case "YAML credential: line" \
  "  credential: \"$SECRET_A\"" "$SECRET_A"
redact_case "coturn static secret" \
  "static-auth-secret=$SECRET_B" "$SECRET_B"

# The two literals, read from the files the run's own writers create, at the
# paths they create them at. Standard base64 with +, / and a trailing = is the
# alphabet a self-hosted credential is minted in, and the literal list has to
# carry it. The credential is written through party_secret_file rather than
# spelled out here so that a glob naming a different directory from the writer
# fails this check, which a test spelling the path itself would not catch.
SELFTEST_CYCLE="$STATE/cycle-redact-selftest"
SELFTEST_PARTY="$SELFTEST_CYCLE/work/dry-run/a"
trap 'rm -rf "$SELFTEST_CYCLE"' EXIT
mkdir -p "$SELFTEST_PARTY"
SECRET_MINTED='en5RNWvLR9cRmc/chpt+AbYvNt7Y='
SECRET_COTURN='f3a9c1d0e7b45a2c9d8e0f1ab2c3d4e5'
printf '%s' "$SECRET_MINTED" > "$(party_secret_file "$SELFTEST_PARTY")"
printf '%s\n' "$SECRET_COTURN" > "$(cycle_secret_file "$SELFTEST_CYCLE")"
redact_case "minted credential in prose, from the writer's own path" \
  "peer offered $SECRET_MINTED now" "$SECRET_MINTED"
redact_case "coturn secret in prose, from the writer's own path" \
  "realm psilink secret $SECRET_COTURN accepted" "$SECRET_COTURN"
redact_keeps "a pkey= value is a file path, not key material" \
  "pkey=/opt/spike/certs/turn.key" "/opt/spike/certs/turn.key"
redact_keeps "the intersection an exchange writes survives byte for byte" \
  "row_id,their_row_id" "row_id,their_row_id"

echo
echo "### every artifact under relay-spike-aws/artifacts is written by a function that redacts"
# Five remote logs -- a.log, b.log, coturn.log, proxy.log and cli.log -- are
# copied off their hosts into relay-spike-aws/artifacts carrying the run's own secrets,
# which is the surface the literal list above backstops. One set of functions
# writes artifacts, and this check is what holds that rather than a comment
# claiming it. Per script: follow the assignments out from ART to every variable
# that names a path under relay-spike-aws/artifacts, then require each write aimed at one
# of them to name an artifact function. The write forms are > >> tee cp scp mv,
# and python3 or node handed such a path -- an interpreter writes whatever it is
# given -- so a read goes through artifact_read to tell the two apart. mkdir and
# touch create no content and are not counted.
ARTIFACT_BAD=0
artifact_write_check() {
  local f vars prev pat ref hits
  for f in "$RUN_DIR"/*.sh; do
    vars="ART"; prev=""
    while [ "$vars" != "$prev" ]; do
      prev="$vars"
      pat="$(printf '%s' "$vars" | tr ' ' '|')"
      ref="[\$][{]?($pat)([^A-Za-z0-9_]|\$)"
      # shellcheck disable=SC2086
      vars="$( { printf '%s\n' $vars
                 grep -oE "^[[:space:]]*(local |export |declare )?[A-Za-z_][A-Za-z0-9_]*=\"?$ref" "$f"
               } | sed -E 's/^[[:space:]]*(local |export |declare )?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/' \
                 | sort -u | tr '\n' ' ' | sed -E 's/[[:space:]]+$//' )"
    done
    pat="$(printf '%s' "$vars" | tr ' ' '|')"
    ref="[\$][{]?($pat)([^A-Za-z0-9_]|\$)"
    hits="$( { grep -nE "(>>?[[:space:]]*\"?|(^|[^A-Za-z0-9_])(tee|cp|scp|mv)[^|]*)$ref" "$f" \
                 | grep -vE 'artifact_(write|append|tee)'
               grep -nE '(^|[^A-Za-z0-9_])(python3|node)([^A-Za-z0-9_]|$)' "$f" \
                 | grep -E "$ref" | grep -vE 'artifact_(write|append|tee|read)'
             } | sort -n -u )"
    if [ -n "$hits" ]; then
      printf '  FAIL  %s writes an artifact outside the artifact_ functions:\n' "$(basename "$f")"
      printf '%s\n' "$hits" | sed 's/^/          /'
      ARTIFACT_BAD=$((ARTIFACT_BAD + 1))
    else
      printf '  PASS  %-34s artifact paths: %s\n' "$(basename "$f")" "$vars"
    fi
  done
}
artifact_write_check

echo
echo "  IAM: authorized $AUTHORIZED, correctly denied $DENIED_OK, unaskable ${#UNASKABLE[@]}, unexpected skips $SKIP"
if [ "$FAIL_AUTH" -gt 0 ] || [ "$FAIL_DENY" -gt 0 ]; then
  echo "  WRONG WAY ROUND: $FAIL_AUTH call(s) this run makes were denied, and $FAIL_DENY call(s) the guardrails must refuse were allowed"
fi
echo "  redact(): $RPASS checks right, $RFAIL wrong (a secret through, or a path or a name blanked)"
echo "  artifact writes: $ARTIFACT_BAD script(s) write under relay-spike-aws/artifacts without redacting"
if [ "${#UNASKABLE[@]}" -gt 0 ]; then
  echo "  Never asked of IAM, because AWS checks their id shapes before it consults IAM:"
  printf '    %s\n' "${UNASKABLE[@]}"
  echo "  These are NOT passes, and terminate-instances is among them: the call every"
  echo "  teardown depends on. Ask them with ./dry-run.sh --with-fixture once"
  echo "  fixture-up.sh has created the instance and the volume."
fi
if [ "$SKIP" -gt 0 ]; then
  echo "  $SKIP other line(s) were rejected on their parameters and prove nothing either way."
fi
if [ "$RFAIL" -gt 0 ]; then
  echo "  DO NOT RUN all.sh: redact() does not do what the artifacts depend on it doing."
  exit 1
fi
if [ "$ARTIFACT_BAD" -gt 0 ]; then
  echo "  DO NOT RUN all.sh: an artifact is written with no redaction in the path."
  exit 1
fi
if [ "$FAIL_AUTH" -gt 0 ] || [ "$FAIL_DENY" -gt 0 ]; then
  echo "  DO NOT RUN all.sh until every line passes."
  exit 1
fi
if [ "${#UNASKABLE[@]}" -eq 0 ] && [ "$SKIP" -eq 0 ]; then
  echo "  every mutating call these scripts make was asked of IAM and authorized, and every"
  echo "  call the guardrails must refuse was asked and refused."
else
  echo "  $AUTHORIZED mutating calls were asked of IAM and authorized, and $DENIED_OK calls the"
  echo "  guardrails must refuse were asked and refused;"
  echo "  $(( ${#UNASKABLE[@]} + SKIP )) never reached IAM. That is not a clean bill."
fi
