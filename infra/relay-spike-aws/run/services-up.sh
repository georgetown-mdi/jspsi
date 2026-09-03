#!/bin/bash
# The ephemeral services box for one cycle: coturn, the web app with the broker
# at /api behind an nginx TLS front, and the class-B inspecting proxy, all on one
# t4g.micro.
#
# THE COLOCATION IS A STATED LIMIT, not a recommendation. The owner's ceiling is
# two instances, and the restricted CLI box holds one of them, so the relay, the
# signaling server and the interception point share a host and an instance-level
# failure takes all three. A real deployment separates them.
#
# coturn and nginx both want 443, so the instance carries two addresses on its
# first interface, each with its own elastic address, and each service binds to
# one. `aws ec2 describe-instance-types` reports t4g.micro at two interfaces and
# two IPv4 addresses per interface, which is exactly what this plan uses: two on
# the first interface for the services, one on a second interface for the proxy.
#
# The instance launches with NO public address. Its elastic addresses are
# attached as soon as it is running and everything else happens over SSH, so
# nothing depends on an auto-assigned address that an elastic one would replace
# underneath a running apt.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

CYCLE_ID="${1:?usage: services-up.sh <cycle-id>}"
export CYCLE_ID
guard_account
load_cloudflare_env

SUBNET_SERVICES="$(state_require fixture SUBNET_SERVICES)"
VPC_ID="$(state_require fixture VPC_ID)"
MYIP="$(state_require fixture MYIP)"
AMI="$(state_require fixture AMI)"
CACHE_VOL="$(state_require fixture CACHE_VOL)"
CDIR="$STATE/cycle-$CYCLE_ID"
mkdir -p "$CDIR"; chmod 700 "$CDIR"
mkdir -p "$ART/cycle-$CYCLE_ID"

if [ -n "$(state_get "cycle-$CYCLE_ID" SERVICES_INSTANCE || true)" ]; then
  die "cycle $CYCLE_ID already has a services box; run services-down.sh $CYCLE_ID first"
fi

# The owner's ceiling is two instances at any moment, and the fixture holds one.
# Counted BEFORE the first create, not just before run-instances: a refusal taken
# after the security group existed left the cycle tagged, which then read as a
# dirty cycle and blocked the next run until services-down.sh was run by hand.
# Untagged and hand-made instances are counted too: the ceiling is on what the
# account runs, not on what this tooling remembers creating.
LIVE="$(awsr ec2 describe-instances \
  --filters Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'length(Reservations[].Instances[])' --output text)"
[ "$LIVE" -lt 2 ] || die "$LIVE instances already exist; the ceiling is two. Tear a cycle down first."

# Written only once the run is going ahead: it is what all.sh's emergency trap
# and fixture-down.sh read to find a services box that needs tearing down, and a
# refusal above this line has nothing for them to tear down.
printf '%s' "$CYCLE_ID" > "$STATE/active-cycle"

# What this script created, and what the trap below has to undo. services-down.sh
# is the teardown: it deletes by state key, waits, and keeps the state file when
# something survives, so a failure anywhere below leaves either nothing or a
# retryable cycle -- never a billing box nobody is watching.
CREATED=0
services_emergency() {
  local rc=$?
  if [ "$rc" -eq 0 ]; then exit 0; fi
  if [ "$CREATED" -eq 0 ]; then
    log "services-up failed (exit $rc) before it created anything"
    exit "$rc"
  fi
  log "services-up failed (exit $rc); tearing this cycle's resources down"
  "$RUN_DIR/services-down.sh" "$CYCLE_ID" \
    || log "the teardown itself failed. Retry: $RUN_DIR/services-down.sh $CYCLE_ID, then $AWS_DIR/nuke.sh --yes"
  exit "$rc"
}
trap services_emergency EXIT

# A fresh static-auth-secret per cycle: a credential minted under one cycle's
# secret is worthless under the next.
SECRET_FILE="$(cycle_secret_file "$CDIR")"
openssl rand -hex 24 > "$SECRET_FILE"
chmod 600 "$SECRET_FILE"

CREATED=1
SG="$(awsm ec2 create-security-group --group-name "psilink-spike-svc-$CYCLE_ID-$(date -u +%s)" \
  --description "psilink relay spike services, cycle $CYCLE_ID" --vpc-id "$VPC_ID" \
  --tag-specifications "$(tagspec security-group "psilink-spike-svc-$CYCLE_ID")" \
  --query GroupId --output text)"
state_put "cycle-$CYCLE_ID" SG "$SG"
for rule in "tcp:22:22:$MYIP/32" \
            "tcp:443:443:$MYIP/32" "tcp:443:443:$VPC_CIDR" \
            "udp:443:443:$MYIP/32" "udp:443:443:$VPC_CIDR" \
            "tcp:3478:3478:$MYIP/32" "tcp:3478:3478:$VPC_CIDR" \
            "udp:3478:3478:$MYIP/32" "udp:3478:3478:$VPC_CIDR" \
            "udp:49152:49200:$MYIP/32" "udp:49152:49200:$VPC_CIDR"; do
  IFS=: read -r proto from to cidr <<< "$rule"
  awsm ec2 authorize-security-group-ingress --group-id "$SG" --ip-permissions \
    "IpProtocol=$proto,FromPort=$from,ToPort=$to,IpRanges=[{CidrIp=$cidr}]" >/dev/null
done
log "services security group $SG"

T_API=$(now)
INSTANCE_ID="$(awsm ec2 run-instances --image-id "$AMI" --instance-type "$INSTANCE_TYPE_SERVICES" \
  --key-name "$KEY_NAME" \
  --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":$ROOT_VOLUME_GIB,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
  --network-interfaces "DeviceIndex=0,SubnetId=$SUBNET_SERVICES,Groups=$SG,DeleteOnTermination=true,PrivateIpAddresses=[{Primary=true,PrivateIpAddress=$IP_TURN},{Primary=false,PrivateIpAddress=$IP_WEB}]" \
  --tag-specifications "$(tagspec instance "psilink-spike-services-$CYCLE_ID")" \
                       "$(tagspec volume "psilink-spike-services-root-$CYCLE_ID")" \
                       "$(tagspec network-interface "psilink-spike-services-eni-$CYCLE_ID")" \
  --query 'Instances[0].InstanceId' --output text)"
state_put "cycle-$CYCLE_ID" SERVICES_INSTANCE "$INSTANCE_ID"
log "services box $INSTANCE_ID launching"

awsr ec2 wait instance-running --instance-ids "$INSTANCE_ID"
T_RUNNING=$(now)
phase "$CYCLE_ID" 1-api-to-running "$T_API" "$T_RUNNING"

ENI0="$(awsr ec2 describe-instances --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].NetworkInterfaces[0].NetworkInterfaceId' --output text)"
state_put "cycle-$CYCLE_ID" ENI0 "$ENI0"

for pair in "TURN:$IP_TURN" "WEB:$IP_WEB"; do
  what="${pair%%:*}"; priv="${pair#*:}"
  alloc="$(awsm ec2 allocate-address --domain vpc \
    --tag-specifications "$(tagspec elastic-ip "psilink-spike-$(printf '%s' "$what" | tr 'A-Z' 'a-z')-$CYCLE_ID")" \
    --query AllocationId --output text)"
  assoc="$(awsm ec2 associate-address --allocation-id "$alloc" \
    --network-interface-id "$ENI0" --private-ip-address "$priv" \
    --query AssociationId --output text)"
  ip="$(awsr ec2 describe-addresses --allocation-ids "$alloc" \
    --query 'Addresses[0].PublicIp' --output text)"
  state_put "cycle-$CYCLE_ID" "ALLOC_$what" "$alloc"
  state_put "cycle-$CYCLE_ID" "ASSOC_$what" "$assoc"
  state_put "cycle-$CYCLE_ID" "EIP_$what" "$ip"
  log "elastic address $ip -> $priv ($what)"
done
EIP_TURN="$(state_require "cycle-$CYCLE_ID" EIP_TURN)"
EIP_WEB="$(state_require "cycle-$CYCLE_ID" EIP_WEB)"

# The proxy's interface. Source/destination checking has to be off: a class-B
# packet arrives here addressed to the coturn or nginx address, not to this
# interface's own, and AWS drops that while the check is on.
PROXY_ENI="$(awsm ec2 create-network-interface --subnet-id "$SUBNET_SERVICES" \
  --private-ip-address "$IP_PROXY" --groups "$SG" \
  --description "psilink relay spike class-B proxy next hop, cycle $CYCLE_ID" \
  --tag-specifications "$(tagspec network-interface "psilink-spike-proxy-eni-$CYCLE_ID")" \
  --query NetworkInterface.NetworkInterfaceId --output text)"
state_put "cycle-$CYCLE_ID" PROXY_ENI "$PROXY_ENI"
awsm ec2 modify-network-interface-attribute --network-interface-id "$PROXY_ENI" \
  --no-source-dest-check >/dev/null
ATTACH_ID="$(awsm ec2 attach-network-interface --network-interface-id "$PROXY_ENI" \
  --instance-id "$INSTANCE_ID" --device-index 1 --query AttachmentId --output text)"
state_put "cycle-$CYCLE_ID" PROXY_ENI_ATTACH "$ATTACH_ID"

wait_ssh "$EIP_TURN" 420 || die "the services box never answered SSH at $EIP_TURN"
T_SSH=$(now)
phase "$CYCLE_ID" 2-running-to-ssh "$T_RUNNING" "$T_SSH"

"$RUN_DIR/mkcerts.sh" "$CYCLE_ID"
"$RUN_DIR/cloudflare.sh" dns-up "$CYCLE_ID" "$EIP_TURN" "$EIP_WEB"
TURN_HOST="$(turn_host "$EIP_TURN")"
WEB_HOST="$(web_host "$EIP_WEB")"
state_put "cycle-$CYCLE_ID" TURN_HOST "$TURN_HOST"
state_put "cycle-$CYCLE_ID" WEB_HOST "$WEB_HOST"

PAYLOAD="$CDIR/payload"
rm -rf "$PAYLOAD"; mkdir -p "$PAYLOAD"
cp "$RUN_DIR/remote/services-bringup.sh" "$RUN_DIR/remote/intercept.mjs" "$PAYLOAD/"
cp -r "$CDIR/certs" "$PAYLOAD/certs"
sed -e "s#__IP_TURN__#$IP_TURN#g" -e "s#__EIP_TURN__#$EIP_TURN#g" \
    -e "s#__SECRET__#$(cat "$SECRET_FILE")#g" \
    -e "s#__REALM__#${TURN_HOST}#g" \
    "$RUN_DIR/remote/turnserver.conf.tmpl" > "$PAYLOAD/turnserver.conf"
sed -e "s#__IP_WEB__#$IP_WEB#g" -e "s#__WEB_HOST__#$WEB_HOST#g" \
    "$RUN_DIR/remote/nginx.conf.tmpl" > "$PAYLOAD/nginx.conf"
chmod 600 "$PAYLOAD/turnserver.conf"
artifact_write "$ART/cycle-$CYCLE_ID/turnserver.conf" < "$PAYLOAD/turnserver.conf"
artifact_write "$ART/cycle-$CYCLE_ID/nginx.conf" < "$PAYLOAD/nginx.conf"

awsm ec2 attach-volume --volume-id "$CACHE_VOL" --instance-id "$INSTANCE_ID" \
  --device "$CACHE_DEVICE" >/dev/null
awsr ec2 wait volume-in-use --volume-ids "$CACHE_VOL"

sshx "$EIP_TURN" 'sudo mkdir -p /opt/spike && sudo chown -R ubuntu /opt/spike'
scpx -r "$PAYLOAD/." "$SSH_USER@$EIP_TURN:/opt/spike/"
# By the volume id the device carries as its NVMe serial, not by size order:
# the sizes are 12 and 16 GiB and a lexical sort of those columns is right by
# accident. The probe fails on the box when nothing matches.
CACHE_DEV="$(sshx "$EIP_TURN" "$(cache_dev_snippet "$CACHE_VOL")")"
[ -n "$CACHE_DEV" ] || die "the services box could not name the image-cache volume $CACHE_VOL"
log "image-cache volume $CACHE_VOL presents as $CACHE_DEV on the services box"

PROXY_MAC="$(awsr ec2 describe-network-interfaces --network-interface-ids "$PROXY_ENI" \
  --query 'NetworkInterfaces[0].MacAddress' --output text)"
sshx "$EIP_TURN" "SPIKE_IP_TURN=$IP_TURN SPIKE_IP_WEB=$IP_WEB SPIKE_IP_PROXY=$IP_PROXY \
  SPIKE_TURN_HOST=$TURN_HOST SPIKE_WEB_HOST=$WEB_HOST SPIKE_CACHE_DEV=$CACHE_DEV \
  SPIKE_PROXY_MAC=$PROXY_MAC SPIKE_IMAGES='${SERVICES_IMAGES[*]}' \
  bash /opt/spike/services-bringup.sh" 2>&1 | artifact_tee "$ART/cycle-$CYCLE_ID/services-bringup.log"
T_TLS=$(now)
phase "$CYCLE_ID" 3-ssh-to-services-tls "$T_SSH" "$T_TLS"

# The sub-phases the bring-up measured for itself, so the report can say what
# was AWS and what was software delivery. A real deployment replaces the image
# load with a registry pull or a baked image and pays neither.
while IFS=' ' read -r _ name secs; do
  [ -n "${secs:-}" ] || continue
  printf '%s\t%s\t%s\t%s\t%s\n' "$(isots)" "3-sub-$name" 0 0 "$secs" \
    | artifact_append "$ART/cycle-$CYCLE_ID/timing.tsv"
done < <(grep -E '^TIMING ' "$ART/cycle-$CYCLE_ID/services-bringup.log" || true)

phase "$CYCLE_ID" services-up-total "$T_API" "$T_TLS"
log "services box up for cycle $CYCLE_ID: turn $TURN_HOST ($EIP_TURN), web $WEB_HOST ($EIP_WEB)"
