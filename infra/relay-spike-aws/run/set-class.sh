#!/bin/bash
# Put the restricted subnet into network class A, class B, or open.
#
# usage: set-class.sh a|b|open [cycle-id]
#
# WHAT ACTUALLY DIFFERS BETWEEN A AND B, stated plainly because the network ACL
# does not say it. Both classes deny all UDP explicitly and allow outbound
# TCP/443 to the two service addresses and nothing else. Class B additionally
# puts one route for the services subnet in the restricted subnet's route table, sending it
# addresses to the services box's SECOND interface, where iptables redirects
# them into the TLS-terminating proxy. The packets still carry the service
# addresses, so a network ACL naming the proxy's address would match nothing --
# on AWS the interception is a routing control, not an addressing one. This is
# the same honesty question 1 recorded: "through the proxy" means the proxy is
# the only reachable next hop, not that psilink was configured to use one.
#
# Because prose asserting that cannot be trusted, the switch ENDS in a
# measurement: a TLS probe from the restricted box reads the issuer of the
# certificate it is served, and the script fails if class B is not being
# intercepted or class A is. A second probe confirms UDP is dead on both classes.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

CLASS="${1:?usage: set-class.sh a|b|open [cycle-id]}"
# Extra destinations the restrictive classes must still reach on TCP/443, as
# space-separated CIDRs. Used for a managed relay outside the VPC.
SPIKE_EXTRA_TCP443="${SPIKE_EXTRA_TCP443:-}"
CYCLE="${2:-$(cat "$STATE/active-cycle" 2>/dev/null || true)}"
guard_account

ACL_ID="$(state_require fixture ACL_ID)"
RT_RESTRICTED="$(state_require fixture RT_restricted)"
MYIP="$(state_require fixture MYIP)"

# Every non-default entry goes, then the class's entries are written. Editing in
# place would leave a stale rule at a number the new set does not use.
clear_entries() {
  local egress rn
  for egress in true false; do
    for rn in $(awsr ec2 describe-network-acls --network-acl-ids "$ACL_ID" \
        --query "NetworkAcls[0].Entries[?Egress==\`$egress\` && RuleNumber!=\`32767\`].RuleNumber" \
        --output text); do
      if [ "$egress" = true ]; then
        awsm ec2 delete-network-acl-entry --network-acl-id "$ACL_ID" --rule-number "$rn" --egress >/dev/null
      else
        awsm ec2 delete-network-acl-entry --network-acl-id "$ACL_ID" --rule-number "$rn" --ingress >/dev/null
      fi
    done
  done
}

entry() {
  local rn="$1" dir="$2" action="$3" proto="$4" cidr="$5" from="${6:-}" to="${7:-}"
  local args=(ec2 create-network-acl-entry --network-acl-id "$ACL_ID" --rule-number "$rn"
              --protocol "$proto" --rule-action "$action" --cidr-block "$cidr")
  # The flag pair is --egress | --ingress; there is no --no-egress, which the
  # dry run caught before a run did.
  if [ "$dir" = egress ]; then args+=(--egress); else args+=(--ingress); fi
  if [ -n "$from" ]; then args+=(--port-range "From=$from,To=$to"); fi
  awsm "${args[@]}" >/dev/null
}

restrictive_entries() {
  # Deny sits above the allows so the artifact states the class rather than
  # leaving it to the implicit deny at 32767.
  entry 90  egress  deny  17 0.0.0.0/0 1 65535
  entry 90  ingress deny  17 0.0.0.0/0 1 65535
  entry 100 egress  allow  6 "$IP_TURN/32" 443 443
  entry 110 egress  allow  6 "$IP_WEB/32"  443 443
  entry 120 egress  allow  6 "$MYIP/32" 1024 65535
  entry 100 ingress allow  6 "$IP_TURN/32" 1024 65535
  entry 110 ingress allow  6 "$IP_WEB/32"  1024 65535
  entry 120 ingress allow  6 "$MYIP/32" 22 22
  # A managed relay lives outside this VPC, so its addresses have to be named
  # explicitly rather than left to a wildcard: widening the class to all of
  # TCP/443 would stop measuring the class. exchange.sh resolves the vendor's
  # hostname and passes what it found, and the addresses used are recorded.
  rn=130
  for cidr in ${SPIKE_EXTRA_TCP443:-}; do
    entry "$rn" egress  allow 6 "$cidr" 443 443
    entry "$rn" ingress allow 6 "$cidr" 1024 65535
    rn=$((rn + 10))
  done
}

set_routes() {
  local want="$1" eni cidr
  eni="$(state_get "cycle-$CYCLE" PROXY_ENI 2>/dev/null || true)"
  # A route more specific than the VPC's local route must equal a subnet's whole
  # CIDR: /32 destinations are refused with "Route destination doesn't match any
  # subnet CIDR blocks" (driven 2026-09-03), and the services subnet's /24 to an
  # interface inside that subnet is accepted (driven the same way).
  cidr="$SERVICES_CIDR"
  awsm ec2 delete-route --route-table-id "$RT_RESTRICTED" --destination-cidr-block "$cidr" \
    >/dev/null 2>&1 || true
  [ "$want" = present ] || return 0
  [ -n "$eni" ] || die "class b needs a services box: no PROXY_ENI in $(state_file "cycle-$CYCLE")"
  awsm ec2 create-route --route-table-id "$RT_RESTRICTED" --destination-cidr-block "$cidr" \
    --network-interface-id "$eni" >/dev/null
  log "restricted subnet routes $cidr (the services subnet) to the proxy interface $eni"
}

case "$CLASS" in
  open)
    clear_entries
    entry 100 egress  allow -1 0.0.0.0/0
    entry 100 ingress allow -1 0.0.0.0/0
    set_routes absent
    ;;
  a)
    clear_entries; restrictive_entries; set_routes absent ;;
  b)
    clear_entries; restrictive_entries; set_routes present ;;
  *) die "class must be a, b or open" ;;
esac
log "network class $CLASS applied to the restricted subnet"

mkdir -p "$ART/cycle-${CYCLE:-fixture}"
awsr ec2 describe-network-acls --network-acl-ids "$ACL_ID" --output json \
  | artifact_write "$ART/cycle-${CYCLE:-fixture}/nacl-class-$CLASS.json"
awsr ec2 describe-route-tables --route-table-ids "$RT_RESTRICTED" --output json \
  | artifact_write "$ART/cycle-${CYCLE:-fixture}/routes-class-$CLASS.json"

CLI_PUBLIC="$(state_get fixture CLI_PUBLIC || true)"
[ -n "$CLI_PUBLIC" ] || { log "no CLI box yet; skipping the confirming probes"; exit 0; }

# UDP must be dead on both restrictive classes and alive when open. A DNS query
# to a public resolver is the cheapest probe that needs no package installed.
UDP_PROBE='python3 - <<PY
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(4)
q = bytes.fromhex("abcd0100000100000000000003777777076578616d706c6503636f6d0000010001")
try:
    s.sendto(q, ("1.1.1.1", 53)); s.recvfrom(512); print("UDP-REACHED")
except Exception: print("UDP-BLOCKED")
PY'
if no_mutate; then
  log "SPIKE_NO_MUTATE: the UDP probe and the certificate-issuer probe are NOT MEASURED; both need the restricted box"
  exit 0
fi
UDP="$(sshx "$CLI_PUBLIC" "$UDP_PROBE" 2>/dev/null || echo UDP-BLOCKED)"
log "udp probe from the restricted box: $UDP"
case "$CLASS:$UDP" in
  a:UDP-REACHED|b:UDP-REACHED) die "class $CLASS is meant to block UDP outright and did not" ;;
esac

if [ -z "$CYCLE" ] || [ -z "$(state_get "cycle-$CYCLE" SERVICES_INSTANCE 2>/dev/null || true)" ]; then
  log "no services box; skipping the certificate-issuer probe"
  exit 0
fi
ISSUER="$(sshx "$CLI_PUBLIC" \
  "echo | timeout 15 openssl s_client -connect $IP_TURN:443 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null" \
  || true)"
log "certificate issuer seen by the restricted box on $IP_TURN:443 -- ${ISSUER:-none}"
printf '%s\n' "$ISSUER" | artifact_write "$ART/cycle-$CYCLE/issuer-class-$CLASS.txt"
case "$CLASS" in
  b) printf '%s' "$ISSUER" | grep -q 'psilink-spike-inspecting-proxy' \
       || die "class b did not intercept: the restricted box was served ${ISSUER:-nothing}" ;;
  a) printf '%s' "$ISSUER" | grep -q 'psilink-spike-inspecting-proxy' \
       && die "class a was intercepted, which it must not be: ${ISSUER}" ;;
esac
log "class $CLASS confirmed by measurement"
