#!/bin/bash
# The run-session fixture: one VPC, two subnets, an internet gateway, route
# tables, the restricted subnet's network ACL, the CLI security group, a key
# pair, the image-cache volume, and the restricted CLI box with its software.
#
# Created ONCE per run session, not per cycle. Only the services box is
# ephemeral, which is what keeps the run inside the owner's two-instance ceiling:
# this fixture holds one instance and services-up.sh adds the second.
#
# Every create call carries --tag-specifications with psilink-spike=1 and
# psilink-spike-cycle=fixture. This credential cannot tag a resource afterwards,
# so a create that forgets the tag leaves something nuke.sh cannot reach.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

# Read by tagspec, which every create call below goes through.
# shellcheck disable=SC2034
CYCLE_ID=fixture
guard_account

if [ -n "$(state_get fixture VPC_ID || true)" ]; then
  die "a fixture already exists ($(state_file fixture)); run fixture-down.sh first"
fi

# The state file is not the only witness: a partial teardown drops it while the
# box it named keeps running, and launching a second one here is how the
# two-instance ceiling is exceeded. The tag is what still names the survivor.
STRANDED="$(tagged_instance_ids fixture)"
if [ -n "${STRANDED// /}" ]; then
  die "instance(s) $STRANDED already carry psilink-spike-cycle=fixture with no state file naming them. Terminate them (aws --profile $PROFILE --region $REGION ec2 terminate-instances --instance-ids $STRANDED) or run $AWS_DIR/nuke.sh --yes, then re-run."
fi

# The same live count services-up.sh makes, at the other place an instance is
# born. Untagged and hand-made instances are counted too: the ceiling is on what
# the account runs, not on what this tooling remembers creating.
LIVE="$(awsr ec2 describe-instances \
  --filters Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'length(Reservations[].Instances[])' --output text)"
[ "$LIVE" -lt 2 ] || die "$LIVE instances already exist; the ceiling is two. Tear a cycle down first."

# What this script launched, and what the trap below has to undo: nothing else in
# this directory tears the CLI box down, so a fixture-up that dies between the
# launch and its last line would leave a box billing on an unattended run.
LAUNCHED_INSTANCE=""
fixture_emergency() {
  local rc=$? id alloc
  if [ "$rc" -eq 0 ]; then exit 0; fi
  log "fixture-up failed (exit $rc); undoing what it launched"
  id="$(state_get fixture CLI_INSTANCE || true)"
  [ -n "$id" ] || id="$LAUNCHED_INSTANCE"
  if [ -n "$id" ]; then
    if awsm ec2 terminate-instances --instance-ids "$id" >/dev/null 2>&1; then
      awsr ec2 wait instance-terminated --instance-ids "$id" >/dev/null 2>&1 || true
      state_del fixture CLI_INSTANCE
      state_del fixture CLI_PUBLIC
      log "terminated $id; its auto-assigned public address went with it"
    else
      log "COULD NOT TERMINATE $id. It is billing. Run: aws --profile $PROFILE --region $REGION ec2 terminate-instances --instance-ids $id"
    fi
  else
    log "no instance had been launched yet; nothing to terminate"
  fi
  for key in ALLOC_TURN ALLOC_WEB; do
    alloc="$(state_get fixture "$key" || true)"
    [ -n "$alloc" ] || continue
    if awsm ec2 release-address --allocation-id "$alloc" >/dev/null 2>&1; then
      state_del fixture "$key"; log "released elastic address $alloc"
    else
      log "COULD NOT RELEASE $alloc; it bills by the hour whether attached or not"
    fi
  done
  local remaining
  remaining="$(sed -n 's/=.*//p' "$(state_file fixture)" 2>/dev/null | tr '\n' ' ')"
  if [ -n "$remaining" ]; then
    log "still recorded in $(state_file fixture): $remaining"
    log "the image-cache volume among them bills by the GiB-month; finish the cleanup with: $RUN_DIR/fixture-down.sh"
  else
    log "nothing else had been created"
  fi
  exit "$rc"
}
trap fixture_emergency EXIT

# The baseline the teardown is checked against. inventory.sh lists the default
# VPC's subnets and gateway too, so "empty" means "back to this", not "nothing".
# The full sweep, not --fast: fixture-down.sh diffs its own full sweep against
# this file, and two listings of different scopes do not subtract.
if [ ! -f "$ART/baseline-inventory.txt" ]; then
  log "recording the pre-provision baseline (full sweep)"
  "$AWS_DIR/inventory.sh" 2>&1 | artifact_write "$ART/baseline-inventory.txt" || true
fi

MYIP="$(my_public_ip)"
AMI="$(newest_ubuntu_ami)"
[ -n "$AMI" ] && [ "$AMI" != "None" ] || die "could not resolve an Ubuntu 24.04 arm64 image"
log "operator address $MYIP/32, image $AMI, availability zone $AZ"
state_put fixture MYIP "$MYIP"
state_put fixture AMI "$AMI"

T_START=$(now)

VPC_ID="$(awsm ec2 create-vpc --cidr-block "$VPC_CIDR" \
  --tag-specifications "$(tagspec vpc psilink-spike-vpc)" \
  --query Vpc.VpcId --output text)"
state_put fixture VPC_ID "$VPC_ID"; log "vpc $VPC_ID"

SUBNET_SERVICES="$(awsm ec2 create-subnet --vpc-id "$VPC_ID" --cidr-block "$SERVICES_CIDR" \
  --availability-zone "$AZ" --tag-specifications "$(tagspec subnet psilink-spike-services)" \
  --query Subnet.SubnetId --output text)"
SUBNET_RESTRICTED="$(awsm ec2 create-subnet --vpc-id "$VPC_ID" --cidr-block "$RESTRICTED_CIDR" \
  --availability-zone "$AZ" --tag-specifications "$(tagspec subnet psilink-spike-restricted)" \
  --query Subnet.SubnetId --output text)"
state_put fixture SUBNET_SERVICES "$SUBNET_SERVICES"
state_put fixture SUBNET_RESTRICTED "$SUBNET_RESTRICTED"
log "subnets $SUBNET_SERVICES (services), $SUBNET_RESTRICTED (restricted)"

IGW_ID="$(awsm ec2 create-internet-gateway \
  --tag-specifications "$(tagspec internet-gateway psilink-spike-igw)" \
  --query InternetGateway.InternetGatewayId --output text)"
state_put fixture IGW_ID "$IGW_ID"
awsm ec2 attach-internet-gateway --internet-gateway-id "$IGW_ID" --vpc-id "$VPC_ID" >/dev/null

# Two route tables, because the restricted subnet's is the one class B rewrites:
# the services subnet must keep a plain local route or the proxy's onward
# connection to coturn would be routed back into the proxy.
for pair in "services:$SUBNET_SERVICES" "restricted:$SUBNET_RESTRICTED"; do
  what="${pair%%:*}"; sn="${pair#*:}"
  rt="$(awsm ec2 create-route-table --vpc-id "$VPC_ID" \
    --tag-specifications "$(tagspec route-table "psilink-spike-rt-$what")" \
    --query RouteTable.RouteTableId --output text)"
  awsm ec2 create-route --route-table-id "$rt" --destination-cidr-block 0.0.0.0/0 \
    --gateway-id "$IGW_ID" >/dev/null
  awsm ec2 associate-route-table --route-table-id "$rt" --subnet-id "$sn" >/dev/null
  state_put fixture "RT_${what}" "$rt"
  log "route table $rt for the $what subnet"
done

ACL_ID="$(awsm ec2 create-network-acl --vpc-id "$VPC_ID" \
  --tag-specifications "$(tagspec network-acl psilink-spike-restricted-acl)" \
  --query NetworkAcl.NetworkAclId --output text)"
state_put fixture ACL_ID "$ACL_ID"
ASSOC="$(awsr ec2 describe-network-acls --filters "Name=association.subnet-id,Values=$SUBNET_RESTRICTED" \
  --query "NetworkAcls[].Associations[?SubnetId=='$SUBNET_RESTRICTED'].NetworkAclAssociationId" --output text)"
[ -n "$ASSOC" ] || die "could not read the restricted subnet's current network ACL association"
NEW_ASSOC="$(awsm ec2 replace-network-acl-association --association-id "$ASSOC" \
  --network-acl-id "$ACL_ID" --query NewAssociationId --output text)"
state_put fixture ACL_ASSOC "$NEW_ASSOC"
log "network ACL $ACL_ID now governs the restricted subnet"

SG_CLI="$(awsm ec2 create-security-group --group-name "psilink-spike-cli-$(date -u +%s)" \
  --description "psilink relay spike, restricted CLI box" --vpc-id "$VPC_ID" \
  --tag-specifications "$(tagspec security-group psilink-spike-cli)" \
  --query GroupId --output text)"
state_put fixture SG_CLI "$SG_CLI"
awsm ec2 authorize-security-group-ingress --group-id "$SG_CLI" --protocol tcp --port 22 \
  --cidr "$MYIP/32" >/dev/null
log "security group $SG_CLI, SSH from $MYIP/32 only"

# The class the box provisions under. cloud-init needs the open network for apt,
# and the image tarballs arrive over SSH, so the ACL starts permissive.
"$RUN_DIR/set-class.sh" open

if [ ! -f "$KEY_FILE" ]; then
  awsm ec2 create-key-pair --key-name "$KEY_NAME" --key-type ed25519 \
    --tag-specifications "$(tagspec key-pair "$KEY_NAME")" \
    --query KeyMaterial --output text > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  log "key pair $KEY_NAME written to $KEY_FILE"
fi

CACHE_VOL="$(awsm ec2 create-volume --availability-zone "$AZ" --size "$CACHE_VOLUME_GIB" \
  --volume-type gp3 --tag-specifications "$(tagspec volume psilink-spike-image-cache)" \
  --query VolumeId --output text)"
state_put fixture CACHE_VOL "$CACHE_VOL"
log "image-cache volume $CACHE_VOL ($CACHE_VOLUME_GIB GiB gp3)"

USERDATA="$STATE/userdata-cli.yaml"
cat > "$USERDATA" <<'CLOUDINIT'
#cloud-config
package_update: true
packages:
  - docker.io
runcmd:
  - [ systemctl, enable, --now, docker ]
CLOUDINIT

INSTANCE_ID="$(awsm ec2 run-instances --image-id "$AMI" --instance-type "$INSTANCE_TYPE_CLI" \
  --key-name "$KEY_NAME" --user-data "file://$USERDATA" \
  --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":$ROOT_VOLUME_GIB,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
  --network-interfaces "AssociatePublicIpAddress=true,DeviceIndex=0,SubnetId=$SUBNET_RESTRICTED,Groups=$SG_CLI,PrivateIpAddress=$IP_CLI,DeleteOnTermination=true" \
  --tag-specifications "$(tagspec instance psilink-spike-cli)" \
                       "$(tagspec volume psilink-spike-cli-root)" \
                       "$(tagspec network-interface psilink-spike-cli-eni)" \
  --query 'Instances[0].InstanceId' --output text)"
state_put fixture CLI_INSTANCE "$INSTANCE_ID"
LAUNCHED_INSTANCE="$INSTANCE_ID"
log "restricted CLI box $INSTANCE_ID launching"

awsr ec2 wait instance-running --instance-ids "$INSTANCE_ID"
T_RUNNING=$(now)
CLI_PUBLIC="$(awsr ec2 describe-instances --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
state_put fixture CLI_PUBLIC "$CLI_PUBLIC"
phase fixture api-to-running "$T_START" "$T_RUNNING"

wait_ssh "$CLI_PUBLIC" 420 || die "the CLI box never answered SSH at $CLI_PUBLIC"
T_SSH=$(now)
phase fixture running-to-ssh "$T_RUNNING" "$T_SSH"

awsm ec2 attach-volume --volume-id "$CACHE_VOL" --instance-id "$INSTANCE_ID" \
  --device "$CACHE_DEVICE" >/dev/null
awsr ec2 wait volume-in-use --volume-ids "$CACHE_VOL"

scpx -r "$RUN_DIR/remote" "$SSH_USER@$CLI_PUBLIC:/tmp/spike-remote"
sshx "$CLI_PUBLIC" 'sudo mkdir -p /opt/spike && sudo cp -r /tmp/spike-remote/. /opt/spike/ && sudo chmod +x /opt/spike/*.sh && sudo chown -R ubuntu /opt/spike'

# Nitro renames the attached device, so it is found by the volume id it carries
# as its NVMe serial rather than by size order. cache_dev_snippet fails on the
# box when nothing matches, which is what stops seed-cache.sh from formatting
# the wrong disk.
CACHE_DEV="$(sshx "$CLI_PUBLIC" "$(cache_dev_snippet "$CACHE_VOL")")"
[ -n "$CACHE_DEV" ] || die "the CLI box could not name the image-cache volume $CACHE_VOL"
log "image-cache volume $CACHE_VOL presents as $CACHE_DEV on the CLI box"
state_put fixture CACHE_DEV "$CACHE_DEV"
sshx "$CLI_PUBLIC" "/opt/spike/seed-cache.sh $CACHE_DEV"

# Images are shipped once, into the cache volume, and every later ephemeral
# services box loads them from it. Compressed in flight, stored uncompressed, so
# a cycle pays a local read rather than a network transfer.
T_IMG=$(now)
for spec in "${CLI_IMAGES[@]}" "${SERVICES_IMAGES[@]}"; do
  file="${spec%%=*}"; image="${spec#*=}"
  log "shipping $image to /mnt/imgcache/$file"
  if no_mutate; then
    log "SPIKE_NO_MUTATE, would run: docker save $image | gzip -1 | ssh ... tee /mnt/imgcache/$file"
    continue
  fi
  docker save "$image" | gzip -1 \
    | sshx "$CLI_PUBLIC" "gunzip -c | sudo tee /mnt/imgcache/$file >/dev/null"
done
sshx "$CLI_PUBLIC" 'sudo sync; ls -l /mnt/imgcache'
T_IMG_END=$(now)
phase fixture image-upload "$T_IMG" "$T_IMG_END"

sshx "$CLI_PUBLIC" "SPIKE_CACHE_DEV=$CACHE_DEV SPIKE_IMAGES='${CLI_IMAGES[*]}' /opt/spike/cli-bringup.sh" \
  | artifact_tee "$ART/fixture-cli-bringup.log"
# Docker's own packages, downloaded once here while this box still has the open
# network, so each ephemeral services box installs them offline from the volume
# rather than waiting on apt. A failure is not fatal: the services box falls back
# to installing over the network and says which path it took.
sshx "$CLI_PUBLIC" 'sudo mkdir -p /mnt/imgcache/deb
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --reinstall --download-only docker.io >/dev/null 2>&1 || true
  sudo cp /var/cache/apt/archives/*.deb /mnt/imgcache/deb/ 2>/dev/null || true
  ls /mnt/imgcache/deb | head -20' | artifact_tee "$ART/fixture-deb-cache.log"

sshx "$CLI_PUBLIC" 'sudo sync; sudo umount /mnt/imgcache || true'
awsm ec2 detach-volume --volume-id "$CACHE_VOL" >/dev/null
awsr ec2 wait volume-available --volume-ids "$CACHE_VOL"
phase fixture total "$T_START" "$(now)"

log "fixture up. restricted CLI box $INSTANCE_ID at $CLI_PUBLIC, class open."
log "next: services-up.sh <cycle-id>"
