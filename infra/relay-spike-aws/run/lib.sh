#!/bin/bash
# Shared guards, logging and helpers for the AWS half of the relay spike.
#
# Sourced by every script in this directory. Nothing here makes an AWS call on
# its own; the account and region guard runs when a script calls guard_account.
#
# Three rules the whole directory depends on:
#   - every mutating AWS command is written to relay-spike-aws/artifacts/commands.log,
#     verbatim and redacted, BEFORE it runs, because the owner reads that log;
#   - every created resource carries psilink-spike=1 and psilink-spike-cycle=<id>
#     in --tag-specifications at creation, because this credential cannot tag a
#     resource afterwards (relay-spike-aws/README.md, "Stated limits");
#   - SPIKE_NO_MUTATE=1 walks the whole flow. Every mutating call prints what it
#     would run and hands back a synthetic id, so a reviewer exercises every
#     branch, trap and state transition with nothing created and nothing billed.
#     Its state and artifacts go to their own directories so a walk cannot
#     overwrite a real run's.

# Every name below is read by the scripts that source this file, not by this
# file, which is what SC2034 would otherwise flag on each one.
# shellcheck disable=SC2034
RUN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AWS_DIR="$(cd "$RUN_DIR/.." && pwd)"
# The working material a run reads and writes -- the Cloudflare environment file,
# the party input CSVs, the private CA, artifacts and state -- is untracked, and
# the directory's .gitignore keeps it that way. Point SPIKE_ROOT elsewhere to
# keep it outside the repository entirely.
SPIKE_ROOT="$(cd "${SPIKE_ROOT:-$AWS_DIR}" && pwd)" ||
  { echo "ABORTING: SPIKE_ROOT is set to a directory that does not exist" >&2; exit 1; }
ART="$AWS_DIR/artifacts"
STATE="$RUN_DIR/state"

no_mutate() { [ "${SPIKE_NO_MUTATE:-0}" = "1" ]; }

if no_mutate; then
  ART="$AWS_DIR/artifacts/no-mutate"
  STATE="$RUN_DIR/state/no-mutate"
fi
CMDLOG="$ART/commands.log"

PROFILE="${AWS_PROFILE:-psilink-spike}"
REGION="${SPIKE_REGION:-us-west-2}"
AZ="${SPIKE_AZ:-us-west-2a}"

# The whole address plan, so a certificate can be minted before an instance
# exists and a network ACL entry can name a host rather than a subnet.
VPC_CIDR="10.90.0.0/16"
SERVICES_CIDR="10.90.1.0/24"
RESTRICTED_CIDR="10.90.2.0/24"
IP_TURN="10.90.1.10"   # services box, first interface, primary   -- coturn
IP_WEB="10.90.1.11"    # services box, first interface, secondary -- nginx
IP_PROXY="10.90.1.20"  # services box, second interface           -- inspecting proxy
IP_CLI="10.90.2.10"    # restricted CLI box

INSTANCE_TYPE_SERVICES="${SPIKE_SERVICES_TYPE:-t4g.micro}"
INSTANCE_TYPE_CLI="${SPIKE_CLI_TYPE:-t4g.nano}"
ROOT_VOLUME_GIB="${SPIKE_ROOT_GIB:-12}"
CACHE_VOLUME_GIB="${SPIKE_CACHE_GIB:-16}"
CANONICAL_OWNER=099720109477
UBUNTU_NAME_FILTER='ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*'

# The images each box needs, as <cache file>=<image tag>. ONE list: fixture-up.sh
# ships the tarballs under exactly these file names and hands the same pairs to
# each bring-up script, which loads those files and then inspects those tags. The
# file name and the tag cannot drift apart, and a delivery that missed one stops
# the run at bring-up instead of failing every exchange after it.
CLI_IMAGES=("party.tar=psi-link:spike-party")
SERVICES_IMAGES=("services-hosted.tar=psi-link:spike-hosted"
                 "services-coturn.tar=coturn/coturn:latest"
                 "services-nginx.tar=nginx:alpine")

# The device the cache volume is asked for at attach time, and the fallback the
# remote probe accepts when no serial matches.
CACHE_DEVICE="${SPIKE_CACHE_DEVICE:-/dev/sdf}"

SSH_USER=ubuntu
KEY_NAME="${SPIKE_KEY_NAME:-psilink-spike-key}"
KEY_FILE="$STATE/$KEY_NAME.pem"

mkdir -p "$ART" "$STATE"

log()  { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die()  { printf '[%s] ABORTING: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; exit 1; }
now()  { date -u +%s; }
isots() { date -u +%FT%TZ; }

# sed buffers its output in blocks when it is not writing to a terminal, and one
# artifact is read while it is still being written: exchange.sh greps the party
# log for the data-channel line to time the exchange and to fire the interrupt.
# Which flag this host's sed takes for line buffering is measured here rather
# than assumed. A sed that takes neither still works, in blocks.
SED_UNBUF=""
if printf '' | sed -u '' >/dev/null 2>&1; then SED_UNBUF="-u"
elif printf '' | sed -l '' >/dev/null 2>&1; then SED_UNBUF="-l"; fi

# One definition of where a secret is written, called by the writers AND by the
# literal list below. Two spellings that have to agree is how the minted
# credential went unredacted: the glob looked one directory above the file
# mkpair.sh wrote, so the literal that backstops the credential was never armed.
#
#   cycle_secret_file <cycle dir>   coturn's static-auth-secret, one per cycle
#   party_secret_file <party dir>   the TURN credential minted for one party
cycle_secret_file() { printf '%s/static-auth-secret\n' "${1%/}"; }
party_secret_file() { printf '%s/turn-secret\n' "${1%/}"; }

# Every copy of both that exists right now. The party directories are what is
# globbed; the file inside one is named by party_secret_file, so the name has a
# single spelling in this directory.
secret_files() {
  local c p
  for c in "$STATE"/cycle-*/; do
    [ -d "$c" ] || continue
    cycle_secret_file "$c"
    for p in "$c"work/*/*/; do
      [ -d "$p" ] || continue
      party_secret_file "$p"
    done
  done
  return 0
}

# Every literal secret this run holds, one per line, so a credential is redacted
# whatever alphabet it uses. Read on every call rather than cached: a cycle mints
# its coturn secret long after the first command is logged.
#
# Values shorter than 8 characters are dropped: they would substring-match
# unrelated text, and the key rules below cover them wherever they appear as a
# field value anyway.
_redact_literals() {
  local f
  f="$SPIKE_ROOT/cloudflare/env"
  if [ -f "$f" ]; then
    # Only values whose KEY names a secret. CF_ZONE_NAME is a zone name, and
    # redacting it takes the readable half out of cloudflare.log for nothing.
    sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|CREDENTIAL|KEY|KEY_ID)=[\"']?([^\"']*)[\"']?[[:space:]]*\$/\\3/p" "$f"
  fi
  while IFS= read -r f; do
    if [ -f "$f" ]; then cat "$f"; echo; fi
  done < <(secret_files)
  return 0
}

# One literal, escaped for sed -E with # as the s/// delimiter. Literals are
# escaped rather than filtered by alphabet: the filter this replaced dropped
# every value carrying a character outside [A-Za-z0-9._-], which is every
# standard-base64 credential -- the alphabet a self-hosted coturn credential and
# a Cloudflare one are both minted in.
_regex_escape() {
  printf '%s' "$1" | sed -e 's/[][\\^$.*+?(){}|#]/\\&/g'
}

# Anything matching these is replaced before a command reaches commands.log or
# any other artifact. Secrets live under $SPIKE_ROOT at mode 600 and nowhere else.
#
# Redaction is by KEY, not by the shape of the value: a base64url credential is
# indistinguishable from ordinary text, so what a field is called is the only
# reliable signal. The field names are matched in lower case only, because the
# tag specifications in commands.log carry Key= and Value= and those are not
# secrets and must stay readable. pkey is NOT among them: coturn's pkey is the
# path to a key file, and the PEM-block rules below cover the material itself.
redact() {
  local -a args=(-E)
  local v esc
  if [ -n "$SED_UNBUF" ]; then args+=("$SED_UNBUF"); fi
  args+=(
    -e 's/("(credential|password|secret|token|key)"[[:space:]]*:[[:space:]]*)"[^"]*"/\1"REDACTED"/g'
    -e "s/(^|[^A-Za-z0-9_.-])(credential|password|secret|token|key)([[:space:]]*[:=][[:space:]]*)['\"]?[^'\"[:space:],;}]*['\"]?/\\1\\2\\3REDACTED/g"
    -e 's/(static-auth-secret=)[^[:space:]]+/\1REDACTED/g'
    -e 's/(Bearer )[A-Za-z0-9._~+\/=-]+/\1REDACTED/g'
    -e 's/([A-Z][A-Z_]*(TOKEN|SECRET|PASSWORD|CREDENTIAL|KEY_ID)=)[^ "]+/\1REDACTED/g'
    -e 's#(://)[^/[:space:]@]+:[^/[:space:]@]+@#\1REDACTED:REDACTED@#g'
    -e 's/(-----BEGIN [A-Z ]*PRIVATE KEY-----).+/\1REDACTED/g'
    -e '/-----BEGIN [A-Z ]*PRIVATE KEY-----/,/-----END [A-Z ]*PRIVATE KEY-----/{/-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----/!s/.+/REDACTED/;}'
  )
  while IFS= read -r v; do
    [ "${#v}" -ge 8 ] || continue
    esc="$(_regex_escape "$v")"
    args+=(-e "s#$esc#REDACTED#g")
  done < <(_redact_literals)
  sed "${args[@]}"
}

# The one way anything lands under relay-spike-aws/artifacts, and the reason is the remote
# logs: coturn prints the credential it was offered and a party log prints the
# configuration it was handed, so an artifact copied straight off a host carries
# this run's own secrets. dry-run.sh fails if any script writes an artifact path
# without going through one of these three.
_artifact_path() {
  case "$1" in
    "$AWS_DIR/artifacts"/*) : ;;
    *) die "an artifact_ function was handed $1, which is not under $AWS_DIR/artifacts" ;;
  esac
}
_artifact_dest() { _artifact_path "$1"; mkdir -p "$(dirname "$1")"; }

artifact_write()  { _artifact_dest "$1"; redact >  "$1"; }
artifact_append() { _artifact_dest "$1"; redact >> "$1"; }
artifact_tee()    { _artifact_dest "$1"; redact | tee "$1"; }
# Reading one back needs no redaction -- what is on disk is already redacted --
# but it gives dry-run.sh's check one form to recognise, so an artifact path
# handed to python3 or node to READ is distinguishable from one handed to it to
# write.
artifact_read()   { _artifact_path "$1"; cat "$1"; }

# The account pin. Every entry script calls this before anything else.
guard_account() {
  local expect acct
  expect="$(tr -d '[:space:]' < "$AWS_DIR/ACCOUNT_ID")"
  [ -n "$expect" ] || die "no ACCOUNT_ID beside $AWS_DIR; refusing to guess"
  [ "$REGION" = "us-west-2" ] || die "this spike lives in us-west-2; region is $REGION"
  acct="$(aws --profile "$PROFILE" --region "$REGION" sts get-caller-identity \
    --query Account --output text 2>&1)" \
    || die "credentials do not resolve for profile $PROFILE: $acct"
  [ "$acct" = "$expect" ] || die "WRONG ACCOUNT: credential is in $acct, expected $expect"
  log "account $acct, region $REGION, profile $PROFILE"
}

# A counter that survives command substitution, so every synthetic id in one walk
# is distinct even though each awsm runs in its own subshell.
_synth_counter() {
  local f="$STATE/.synthetic-counter" n=0
  [ -f "$f" ] && n="$(cat "$f" 2>/dev/null || printf 0)"
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  n=$((n + 1))
  printf '%s' "$n" > "$f"
  printf '%s' "$n"
}

# What a mutating call would have returned, shaped like the id its --query asks
# for, so the caller's state transitions and later branches all run. Anything
# unrecognised returns nothing, which is what a call with no --query does.
synthetic_value() {
  local q="" prev="" a n hex
  for a in "$@"; do
    if [ "$prev" = "--query" ]; then q="$a"; fi
    prev="$a"
  done
  n="$(_synth_counter)"
  hex="$(printf '%016x' "$n")"
  case " $* " in
    *" replace-network-acl-association "*) printf 'aclassoc-0%s\n' "$hex"; return 0 ;;
  esac
  case "$q" in
    *NetworkAclAssociationId*) printf 'aclassoc-0%s\n' "$hex" ;;
    *AttachmentId*)            printf 'eni-attach-0%s\n' "$hex" ;;
    *AllocationId*)            printf 'eipalloc-0%s\n' "$hex" ;;
    *AssociationId*)           printf 'eipassoc-0%s\n' "$hex" ;;
    *NetworkAclId*)            printf 'acl-0%s\n' "$hex" ;;
    *NetworkInterfaceId*)      printf 'eni-0%s\n' "$hex" ;;
    *InternetGatewayId*)       printf 'igw-0%s\n' "$hex" ;;
    *RouteTableId*)            printf 'rtb-0%s\n' "$hex" ;;
    *GroupId*)                 printf 'sg-0%s\n' "$hex" ;;
    *InstanceId*)              printf 'i-0%s\n' "$hex" ;;
    *VolumeId*)                printf 'vol-0%s\n' "$hex" ;;
    *VpcId*)                   printf 'vpc-0%s\n' "$hex" ;;
    *SubnetId*)                printf 'subnet-0%s\n' "$hex" ;;
    *ImageId*)                 printf 'ami-0%s\n' "$hex" ;;
    *KeyMaterial*)
      printf -- '-----BEGIN OPENSSH PRIVATE KEY-----\nSPIKE_NO_MUTATE synthetic key, unusable\n-----END OPENSSH PRIVATE KEY-----\n' ;;
    *MacAddress*)              printf '02:00:00:00:%02x:%02x\n' "$(( (n / 256) % 256 ))" "$(( n % 256 ))" ;;
    *PublicIp*)                printf '203.0.113.%s\n' "$(( (n % 200) + 10 ))" ;;
    *Status*)                  printf 'available\n' ;;
    *) : ;;
  esac
  return 0
}

# Read-only call. Not logged: commands.log is for what could bill. Under
# SPIKE_NO_MUTATE a Describe still runs for real -- it is free and it keeps the
# walk honest where the account can answer -- and falls back to a synthetic value
# only when it names a resource the walk invented. Waiters are skipped: there is
# nothing to wait for.
awsr() {
  local out
  if no_mutate; then
    case "${1:-} ${2:-}" in
      "ec2 wait") log "SPIKE_NO_MUTATE, not waiting: $*"; return 0 ;;
    esac
    if out="$(aws --profile "$PROFILE" --region "$REGION" "$@" 2>/dev/null)" \
      && [ -n "$out" ] && [ "$out" != "None" ]; then
      printf '%s\n' "$out"
      return 0
    fi
    synthetic_value "$@"
    return 0
  fi
  aws --profile "$PROFILE" --region "$REGION" "$@"
}

# Mutating call. Logged verbatim first, then run.
awsm() {
  local line
  line="aws --profile $PROFILE --region $REGION $*"
  printf '%s  %s\n' "$(isots)" "$line" | artifact_append "$CMDLOG"
  if no_mutate; then
    log "SPIKE_NO_MUTATE, would run: $line"
    synthetic_value "$@"
    return 0
  fi
  aws --profile "$PROFILE" --region "$REGION" "$@"
}

# A local container that stands a party or an ACME client up. Stubbed on a walk
# for the same reason a remote command is: there is no host on the other end.
dockerx() {
  if no_mutate; then log "SPIKE_NO_MUTATE, would run: docker $*"; return 0; fi
  docker "$@"
}

# --tag-specifications value for one resource type. Every create call uses this.
# psilink-spike=1 is what inventory.sh and nuke.sh key on; psilink-spike-cycle
# tells one provision cycle from the next.
tagspec() {
  local rtype="$1" name="$2" cycle="${3:-${CYCLE_ID:-fixture}}"
  printf 'ResourceType=%s,Tags=[{Key=psilink-spike,Value=1},{Key=psilink-spike-cycle,Value=%s},{Key=Name,Value=%s}]' \
    "$rtype" "$cycle" "$name"
}

state_file() { printf '%s/%s.env' "$STATE" "${1:-fixture}"; }

state_put() {
  local scope="$1" key="$2" value="$3" f
  f="$(state_file "$scope")"
  touch "$f"
  grep -v "^$key=" "$f" > "$f.tmp" 2>/dev/null || true
  printf '%s=%s\n' "$key" "$value" >> "$f.tmp"
  mv "$f.tmp" "$f"
}

state_get() {
  local scope="$1" key="$2" f
  f="$(state_file "$scope")"
  [ -f "$f" ] || return 1
  sed -n "s/^$key=//p" "$f" | tail -1
}

# Forget one id, and only once the resource it names is really gone. A teardown
# that drops an id it did not delete leaves an orphan reachable only by nuke.sh.
state_del() {
  local scope="$1" key="$2" f
  f="$(state_file "$scope")"
  [ -f "$f" ] || return 0
  grep -v "^$key=" "$f" > "$f.tmp" 2>/dev/null || true
  mv "$f.tmp" "$f"
}

state_require() {
  local v
  v="$(state_get "$1" "$2")" || die "no state for $2 in $(state_file "$1"); run the earlier step first"
  [ -n "$v" ] || die "state key $2 is empty in $(state_file "$1")"
  printf '%s' "$v"
}

# Instances carrying one cycle tag, whatever the local state file remembers. A
# partial teardown drops the state key, so the tag is the only thing that still
# names a box a previous run stranded.
# The call is made directly rather than through awsr: an empty answer is the
# answer here, and awsr would invent an id for it on a SPIKE_NO_MUTATE walk.
tagged_instance_ids() {
  aws --profile "$PROFILE" --region "$REGION" ec2 describe-instances \
    --filters "Name=tag:psilink-spike-cycle,Values=$1" \
              Name=instance-state-name,Values=pending,running,stopping,stopped \
    --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null | tr '\t' ' '
}

# How many resources still carry one cycle's tag. Prints an integer, or UNKNOWN
# when a Describe failed -- an unanswered question is not a zero, and every
# caller treats UNKNOWN as "still dirty".
#
# Volumes are filtered by status because a root volume with DeleteOnTermination
# is still listed as `deleting` for a few seconds after the instance is gone, and
# counting that would call every clean teardown dirty.
cycle_tagged_count() {
  local cycle="$1" total=0 n
  local -a queries=(
    "ec2 describe-instances --filters Name=tag:psilink-spike-cycle,Values=$cycle Name=instance-state-name,Values=pending,running,stopping,stopped --query length(Reservations[].Instances[])"
    "ec2 describe-volumes --filters Name=tag:psilink-spike-cycle,Values=$cycle Name=status,Values=creating,available,in-use,error --query length(Volumes)"
    "ec2 describe-addresses --filters Name=tag:psilink-spike-cycle,Values=$cycle --query length(Addresses)"
    "ec2 describe-network-interfaces --filters Name=tag:psilink-spike-cycle,Values=$cycle --query length(NetworkInterfaces)"
    "ec2 describe-security-groups --filters Name=tag:psilink-spike-cycle,Values=$cycle --query length(SecurityGroups)"
  )
  local q
  for q in "${queries[@]}"; do
    # shellcheck disable=SC2086
    n="$(aws --profile "$PROFILE" --region "$REGION" $q --output text 2>/dev/null)"
    case "$n" in
      ''|*[!0-9]*) printf 'UNKNOWN'; return 0 ;;
    esac
    total=$((total + n))
  done
  printf '%s' "$total"
}

# The same count, given a little time: AWS reports a just-deleted interface or
# address for a moment after the delete returns.
wait_cycle_clear() {
  local cycle="$1" seconds="${2:-60}" deadline n
  deadline=$(( $(now) + seconds ))
  while :; do
    n="$(cycle_tagged_count "$cycle")"
    if [ "$n" = "0" ]; then printf '0'; return 0; fi
    if [ "$(now)" -ge "$deadline" ]; then printf '%s' "$n"; return 0; fi
    sleep 5
  done
}

# One row of the provisioning timeline. The report separates what AWS took from
# what image delivery took, so every phase is recorded with its own boundaries.
phase() {
  local cycle="$1" name="$2" start="$3" end="$4"
  printf '%s\t%s\t%s\t%s\t%s\n' "$(isots)" "$name" "$start" "$end" "$((end - start))" \
    | artifact_append "$ART/cycle-$cycle/timing.tsv"
  log "phase $name: $((end - start))s"
}

# Nothing is written to ~/.ssh/known_hosts: the host key of a box that lives for
# ten minutes is not a trust anchor, and the run writes nothing outside
# $SPIKE_ROOT.
ssh_opts=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
          -o LogLevel=ERROR -o ConnectTimeout=10 -o ServerAliveInterval=15)

sshx() {
  local host="$1"; shift
  if no_mutate; then
    log "SPIKE_NO_MUTATE, not run on $host: $*"
    case "$*" in *lsblk*) printf '/dev/nvme1n1\n' ;; esac
    return 0
  fi
  ssh "${ssh_opts[@]}" -i "$KEY_FILE" "$SSH_USER@$host" "$@"
}

scpx() {
  if no_mutate; then log "SPIKE_NO_MUTATE, not copied: scp $*"; return 0; fi
  scp "${ssh_opts[@]}" -i "$KEY_FILE" "$@"
}

wait_ssh() {
  local host="$1" deadline
  if no_mutate; then log "SPIKE_NO_MUTATE, not waiting for SSH on $host"; return 0; fi
  deadline=$(( $(now) + ${2:-300} ))
  while [ "$(now)" -lt "$deadline" ]; do
    if sshx "$host" true 2>/dev/null; then return 0; fi
    sleep 5
  done
  return 1
}

wait_for() {
  local label="$1" seconds="$2"; shift 2
  local deadline
  deadline=$(( $(now) + seconds ))
  while [ "$(now)" -lt "$deadline" ]; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 3
  done
  log "timed out waiting for $label after ${seconds}s"
  return 1
}

# The shell the remote host runs to name the cache volume's block device.
#
# Nitro renames /dev/sdf to an NVMe node, and the size-ordered guess this
# replaced was correct only while the root volume happened to be the smaller of
# the two. NVMe exposes the EBS volume id as the device serial with the dash
# removed (ADVISORY: AWS's documented behaviour, not driven from this host), so
# the volume id is what the probe matches. The device asked for at attach time is
# the fallback, and a host that answers neither fails loudly rather than
# formatting whatever sorted last.
cache_dev_snippet() {
  local vol="$1" want="${2:-$CACHE_DEVICE}"
  cat <<REMOTE
vol=$vol; want=$want
serial=\${vol//-/}
dev=\$(lsblk -ndo NAME,SERIAL | awk -v s="\$serial" -v v="\$vol" '\$2==s || \$2==v {print "/dev/" \$1; exit}')
if [ -z "\$dev" ] && [ -b "\$want" ]; then dev=\$want; fi
if [ -z "\$dev" ]; then
  echo "no block device carries serial \$serial (volume \$vol), and \$want is not a block device" >&2
  lsblk -o NAME,SERIAL,SIZE,TYPE >&2
  exit 1
fi
printf '%s\n' "\$dev"
REMOTE
}

newest_ubuntu_ami() {
  awsr ec2 describe-images --owners "$CANONICAL_OWNER" \
    --filters "Name=name,Values=$UBUNTU_NAME_FILTER" Name=state,Values=available \
    --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text
}

my_public_ip() {
  local ip
  if no_mutate; then printf '203.0.113.7'; return 0; fi
  ip="$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')"
  [ -n "$ip" ] || die "could not read this host's public IP"
  printf '%s' "$ip"
}

# Cloudflare configuration is optional; every caller branches on these.
load_cloudflare_env() {
  CF_ZONE_NAME=""; CF_DNS_API_TOKEN=""; CF_TURN_KEY_ID=""; CF_TURN_API_TOKEN=""
  local f="$SPIKE_ROOT/cloudflare/env"
  if [ -f "$f" ]; then
    # shellcheck disable=SC1090
    . "$f"
  fi
  CF_DNS=false; CF_TURN=false
  if [ -n "${CF_ZONE_NAME:-}" ] && [ -n "${CF_DNS_API_TOKEN:-}" ]; then CF_DNS=true; fi
  if [ -n "${CF_TURN_KEY_ID:-}" ] && [ -n "${CF_TURN_API_TOKEN:-}" ]; then CF_TURN=true; fi
  export CF_ZONE_NAME CF_DNS_API_TOKEN CF_TURN_KEY_ID CF_TURN_API_TOKEN CF_DNS CF_TURN
}

turn_host() { if [ "${CF_DNS:-false}" = true ]; then printf 'spike-turn.%s' "$CF_ZONE_NAME"; else printf '%s' "$1"; fi; }
web_host()  { if [ "${CF_DNS:-false}" = true ]; then printf 'spike-web.%s'  "$CF_ZONE_NAME"; else printf '%s' "$1"; fi; }
