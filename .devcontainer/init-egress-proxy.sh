#!/bin/bash
set -Eeuo pipefail # Exit on error (inherited by functions/subshells), undefined
IFS=$'\n\t'        # vars, and pipeline failures; stricter word splitting.

# Hostname-gated egress lane for the infra dev-container profile, applied on
# start AFTER init-firewall.sh and only in an image built with PSILINK_INFRA=1.
#
# init-firewall.sh matches destination IPs, which cannot express AWS: EC2 in
# us-west-2 alone publishes 169 shared-tenant prefixes, and admitting them
# admits every other tenant's instance. So this script adds a second lane
# without touching the first: a tinyproxy CONNECT proxy bound to loopback,
# default-deny, admitting a destination by HOSTNAME from
# /usr/local/share/psilink-egress-allowlist plus PSILINK_EGRESS_EXTRA_HOSTS,
# and an iptables OUTPUT rule that lets the tinyproxy uid -- and nothing else in
# the container -- reach an address outside the IP allowlist.
#
# Everything init-firewall.sh admitted stays admitted, directly: the infra
# profile's NO_PROXY names those hosts, so the workflow that runs in the default
# profile runs here byte-identically and only a NEW destination takes the proxy.
#
# Fail closed. If the allowlist does not parse, the proxy does not start, or any
# verification below fails, the trap tears the proxy and the uid rule back out
# and the script exits non-zero, leaving egress exactly what init-firewall.sh
# left it -- never wider.

PROXY_PORT=8888
PROXY_URL="http://127.0.0.1:$PROXY_PORT"
PROXY_USER=tinyproxy
CONF_DIR=/etc/psilink-egress-proxy
CONF_FILE="$CONF_DIR/tinyproxy.conf"
FILTER_FILE="$CONF_DIR/filter"
LOG_FILE=/var/log/psilink-egress-proxy.log
PID_FILE=/run/psilink-egress-proxy.pid
ALLOWLIST_FILE=/usr/local/share/psilink-egress-allowlist

# Undo everything this script added. Called by the trap and before a fresh
# start, so re-running the script is idempotent rather than cumulative.
teardown() {
  if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
  fi
  pkill -x tinyproxy 2>/dev/null || true
  # tinyproxy removes its own PID file on a clean shutdown; give it the moment
  # to do so before forcing the issue, so the log does not collect a warning
  # about a file this function deleted underneath it.
  for _ in $(seq 1 20); do
    pgrep -x tinyproxy >/dev/null 2>&1 || break
    sleep 0.1
  done
  rm -f "$PID_FILE"
  # Delete every copy of the uid rule, however many earlier runs left.
  while iptables -C OUTPUT -p tcp -m owner --uid-owner "$PROXY_USER" -j ACCEPT 2>/dev/null; do
    iptables -D OUTPUT -p tcp -m owner --uid-owner "$PROXY_USER" -j ACCEPT
  done
}

trap 'rc=$?; echo "init-egress-proxy: error (rc=$rc) -- removing the proxy and its firewall rule; egress stays exactly what init-firewall.sh left"; teardown; exit $rc' ERR

# The proxy widens nothing on its own: it is only reachable because of the uid
# rule below, which is only safe on top of a built firewall. Refuse to run
# against an unconfigured one rather than adding a rule to a permissive chain.
if [ "$(iptables -S OUTPUT | head -n1)" != "-P OUTPUT DROP" ]; then
  echo "ERROR: OUTPUT policy is not DROP -- run init-firewall.sh first"
  exit 1
fi

teardown

# A pattern is a hostname, optionally with `*` wildcards in its FIRST label
# only. The shapes rejected here are the ones that read as narrow and match
# wide: a bare `*`, a wildcard in a later label (`a.*.com`), a wildcard label
# sitting straight on a TLD (`*.com`), a pattern with no dot, and anything
# carrying a character a hostname cannot hold -- a space, a slash, a comment
# marker that survived stripping.
valid_pattern() {
  local pattern=$1 first rest
  [[ "$pattern" == *.* ]] || return 1
  first=${pattern%%.*}
  rest=${pattern#*.}
  [[ "$rest" != *'*'* ]] || return 1
  [[ "$first" =~ ^[a-z0-9*]([a-z0-9*-]*[a-z0-9*])?$ ]] || return 1
  [[ "$rest" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z][a-z0-9-]*[a-z0-9]$ ]] || return 1
  if [[ "$first" == *'*'* ]]; then
    [[ "$rest" == *.* ]] || return 1
  fi
  return 0
}

if [ ! -r "$ALLOWLIST_FILE" ]; then
  echo "ERROR: $ALLOWLIST_FILE is missing or unreadable"
  exit 1
fi

# Strip comments and surrounding whitespace, drop blank lines. The extra hosts
# arrive comma-separated in one environment variable, so commas are separators
# on both paths.
patterns=$(
  {
    cat "$ALLOWLIST_FILE"
    printf '%s\n' "${PSILINK_EGRESS_EXTRA_HOSTS:-}" | tr ',' '\n'
  } | sed -e 's/#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e '/^$/d' | sort -u
)
if [ -z "$patterns" ]; then
  echo "ERROR: assembled allowlist is empty"
  exit 1
fi

invalid=0
while read -r pattern; do
  if ! valid_pattern "$pattern"; then
    echo "ERROR: rejected allowlist pattern '$pattern' (a hostname, with '*' only inside its first label)"
    invalid=$((invalid + 1))
  fi
done <<<"$patterns"
if [ "$invalid" -ne 0 ]; then
  echo "ERROR: $invalid invalid pattern(s); refusing to start the proxy"
  exit 1
fi

mkdir -p "$CONF_DIR"
chmod 0755 "$CONF_DIR"
printf '%s\n' "$patterns" >"$FILTER_FILE"
chmod 0644 "$FILTER_FILE"

# Created here rather than left to tinyproxy so it is world-readable: the node
# user reads it to see which host a refused request named.
install -o "$PROXY_USER" -g "$PROXY_USER" -m 0644 /dev/null "$LOG_FILE"

# FilterDefaultDeny turns the filter file into a whitelist; FilterType fnmatch
# makes each line an anchored glob rather than an unanchored regular
# expression, which is what keeps `example.com` from admitting
# `notexample.com`. Filtering is on the host (FilterURLs is left at its default
# of No), because every destination here arrives as CONNECT, where the proxy
# sees the host and nothing else. ConnectPort is the only tunnel width offered:
# 443 for HTTPS and 22 for SSH, so a tunnel to an arbitrary service port on an
# admitted host is refused.
cat >"$CONF_FILE" <<EOF
User $PROXY_USER
Group $PROXY_USER
Port $PROXY_PORT
Listen 127.0.0.1
Allow 127.0.0.1
Timeout 600
MaxClients 100
PidFile "$PID_FILE"
LogFile "$LOG_FILE"
DefaultErrorFile "/usr/share/tinyproxy/default.html"
LogLevel Notice
DisableViaHeader Yes
Filter "$FILTER_FILE"
FilterDefaultDeny Yes
FilterType fnmatch
ConnectPort 443
ConnectPort 22
EOF
chmod 0644 "$CONF_FILE"

echo "init-egress-proxy: starting tinyproxy on $PROXY_URL with $(printf '%s\n' "$patterns" | wc -l | tr -d ' ') allowed host patterns"
tinyproxy -c "$CONF_FILE"

# tinyproxy daemonizes, so the port is not necessarily bound when it returns.
# A bare TCP connect is the whole question here, and unlike an HTTP request to
# the proxy's own address it does not make tinyproxy log an error about a
# transparent-proxy request it was never configured for.
listening=0
for _ in $(seq 1 50); do
  if nc -z -w 2 127.0.0.1 "$PROXY_PORT" 2>/dev/null; then
    listening=1
    break
  fi
  sleep 0.2
done
if [ "$listening" -ne 1 ]; then
  echo "ERROR: tinyproxy did not begin listening on $PROXY_URL"
  exit 1
fi

# The one rule that widens egress, and it widens it for one uid. Inserted at the
# head of OUTPUT so it precedes both the ipset match and the catch-all REJECT;
# every other rule init-firewall.sh installed is untouched, so a process that is
# not the proxy still reaches only the IP allowlist.
iptables -I OUTPUT 1 -p tcp -m owner --uid-owner "$PROXY_USER" -j ACCEPT

# --- Verification -----------------------------------------------------------
#
# Each probe below asserts one half of the claim this script makes, and a
# failure trips the ERR trap, which removes the proxy and the uid rule. The
# claim is not "the proxy runs" but "the proxy admits the allowlist, refuses
# everything else, and is the only route to a non-allowlisted address".

# Echoes `reached <status>` when the request got an HTTP response from the
# origin server, `filtered` when the proxy itself answered 403 (the CONNECT was
# denied), or `error <detail>` for anything else -- a proxy 5xx, a TLS failure,
# a timeout. Keeping those three apart is the point: a tinyproxy 403 must never
# be read as "reached AWS".
#
# The `filtered` test is "the transfer failed AND 403 appears in what curl
# said", rather than a match on curl's sentence, which differs between versions
# ("Received HTTP code 403 from proxy after CONNECT" against "CONNECT tunnel
# failed, response 403"). A 403 from the ORIGIN cannot be confused with it: that
# is a completed transfer, which the first branch has already taken.
via_proxy() {
  local url=$1 out rc=0
  out=$(curl --proxy "$PROXY_URL" --connect-timeout 10 --max-time 30 \
    -sS -o /dev/null -w '%{http_code}' "$url" 2>&1) || rc=$?
  if [ "$rc" -eq 0 ]; then
    printf 'reached %s' "$out"
  elif [[ "$out" == *403* ]]; then
    printf 'filtered'
  else
    printf 'error rc=%s %s' "$rc" "${out//$'\n'/ }"
  fi
}

# Echoes `reached <status>` or `refused <detail>` for a request that bypasses
# the proxy entirely, so the firewall is what answers.
direct() {
  local url=$1 out rc=0
  out=$(curl --noproxy '*' --connect-timeout 10 --max-time 20 \
    -sS -o /dev/null -w '%{http_code}' "$url" 2>&1) || rc=$?
  if [ "$rc" -eq 0 ]; then
    printf 'reached %s' "$out"
  else
    printf 'refused rc=%s %s' "$rc" "${out//$'\n'/ }"
  fi
}

expect() { # $1 = label, $2 = observed, $3 = required prefix
  if [[ "$2" == "$3"* ]]; then
    echo "Proxy verification passed - $1: $2"
  else
    echo "ERROR: Proxy verification failed - $1: expected '$3...', got '$2'"
    return 1
  fi
}

expect "an allowlisted AWS endpoint is reachable through the proxy" \
  "$(via_proxy https://sts.us-west-2.amazonaws.com/)" reached
expect "an unlisted host is refused by the proxy" \
  "$(via_proxy https://example.com/)" filtered
expect "the same AWS endpoint is refused when the proxy is bypassed" \
  "$(direct https://sts.us-west-2.amazonaws.com/)" refused
expect "the AWS customer-instance namespace is refused by the proxy" \
  "$(via_proxy https://ec2-1-2-3-4.us-west-2.compute.amazonaws.com/)" filtered

# Every host the owner added through PSILINK_EGRESS_EXTRA_HOSTS must actually be
# admitted by the assembled filter, or the variable is silently doing nothing.
# The assertion is "the proxy did not filter it" rather than "the origin
# answered": an added host is often an instance address with no HTTPS listener,
# and a proxy 5xx from an unreachable origin is a pass here. A pattern carrying
# a wildcard names no host to probe and is skipped.
if [ -n "${PSILINK_EGRESS_EXTRA_HOSTS:-}" ]; then
  while read -r extra; do
    [ -n "$extra" ] || continue
    [[ "$extra" != *'*'* ]] || continue
    result=$(via_proxy "https://$extra/")
    if [ "$result" = filtered ]; then
      echo "ERROR: Proxy verification failed - PSILINK_EGRESS_EXTRA_HOSTS host $extra is filtered"
      exit 1
    fi
    echo "Proxy verification passed - added host $extra is admitted by the filter: $result"
  done < <(printf '%s\n' "${PSILINK_EGRESS_EXTRA_HOSTS}" | tr ',' '\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
fi

trap - ERR
echo "init-egress-proxy: complete -- hostname-gated egress on $PROXY_URL, refusals logged to $LOG_FILE"
