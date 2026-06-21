#!/bin/bash
set -Eeuo pipefail # Exit on error (inherited by functions/subshells), undefined
IFS=$'\n\t'        # vars, and pipeline failures; stricter word splitting.

# Egress firewall for the psilink dev container. Default-deny outbound, with an
# allowlist holding only what the workflow needs:
#
#   - registry.npmjs.org, nodejs.org -- the only two hosts a real `npm ci` trace
#     in this image (cold cache) contacted that are not GitHub; node-gyp fetches
#     Node headers from nodejs.org to build the ssh2 optional dep cpu-features.
#   - GitHub's published IP ranges -- the trace's other two hosts (github.com and
#     release-assets.githubusercontent.com, which resolves into 185.199.108.0/22)
#     both fall in these, and they also cover gh, the API, and raw.
#   - api.anthropic.com -- the Claude model API.
#   - claude.ai / console.anthropic.com -- interactive Claude login (API-key auth
#     via ANTHROPIC_API_KEY needs neither; these are best-effort).
#   - the VS Code extension CDN -- only used when opened through the VS Code UI.
#
# Telemetry and error-reporting hosts are deliberately absent: the container sets
# CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC and DISABLE_AUTOUPDATER, so Claude makes
# no telemetry/Sentry/updater calls. Applied on container start via passwordless
# sudo. The SFTP backends and the web dev server bind loopback, covered by the lo
# allow below; they need no outbound rule.

# Fail closed: if anything below errors before the full ruleset is in place, slam
# the OUTPUT/FORWARD policy to DROP so a half-built firewall never leaves egress
# open. On the normal path the explicit DROP later makes this a no-op.
trap 'rc=$?; echo "init-firewall: error (rc=$rc) -- forcing INPUT/OUTPUT/FORWARD DROP (fail closed)"; iptables -P INPUT DROP 2>/dev/null || true; iptables -P OUTPUT DROP 2>/dev/null || true; iptables -P FORWARD DROP 2>/dev/null || true; exit $rc' ERR

# 1. Extract Docker DNS info BEFORE any flushing.
DOCKER_DNS_RULES=$(iptables-save -t nat | grep "127\.0\.0\.11" || true)

# Flush existing rules and delete existing ipsets.
iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
iptables -t mangle -F
iptables -t mangle -X
ipset destroy allowed-domains 2>/dev/null || true

# 2. Selectively restore ONLY internal Docker DNS resolution.
if [ -n "$DOCKER_DNS_RULES" ]; then
  echo "Restoring Docker DNS rules..."
  iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
  iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
  echo "$DOCKER_DNS_RULES" | xargs -L 1 iptables -t nat
else
  echo "No Docker DNS rules to restore"
fi

# Allow DNS and localhost before any restrictions.
# Outbound DNS (UDP, plus TCP for responses that exceed 512 bytes).
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
# Inbound DNS responses, restricted to established lookups rather than any packet
# that merely claims source port 53.
iptables -A INPUT -p udp --sport 53 -m state --state ESTABLISHED -j ACCEPT
iptables -A INPUT -p tcp --sport 53 -m state --state ESTABLISHED -j ACCEPT
# Localhost (the SFTP test backends and the web dev server bind here).
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# Create ipset with CIDR support.
ipset create allowed-domains hash:net

# Fetch GitHub meta information and aggregate + add their IP ranges. This single
# set covers git over HTTPS, the gh CLI, the API, raw.githubusercontent.com, and
# codeload.github.com -- everything reachable under github.com.
echo "Fetching GitHub IP ranges..."
gh_ranges=$(curl -s --connect-timeout 5 --max-time 20 https://api.github.com/meta)
if [ -z "$gh_ranges" ]; then
  echo "ERROR: Failed to fetch GitHub IP ranges"
  exit 1
fi

if ! echo "$gh_ranges" | jq -e '.web and .api and .git' >/dev/null; then
  echo "ERROR: GitHub API response missing required fields"
  exit 1
fi

echo "Processing GitHub IPs..."
# Materialize the IPv4 CIDR list in a command substitution rather than a process
# substitution: a failure anywhere in the jq | grep | aggregate pipeline then
# propagates under `set -o pipefail` and trips the fail-closed trap, instead of
# being swallowed by `< <(...)` (whose exit status is not checked) and leaving the
# loop to build an empty or partial allowlist. The meta feed's IPv6 CIDRs are
# filtered out here because the ipset is IPv4 (hash:net), `aggregate` is IPv4-only,
# and IPv6 egress is dropped wholesale below.
# grep is wrapped so its zero-match exit (1) is not fatal -- otherwise, under
# pipefail, an IPv4-less feed would trip the trap with a generic message before
# the explicit, clearer check below runs. A jq or aggregate failure still
# propagates and fails closed.
gh_cidrs=$(echo "$gh_ranges" | jq -r '(.web + .api + .git)[]' | { grep -E '^[0-9]+\.' || true; } | aggregate -q)
if [ -z "$gh_cidrs" ]; then
  echo "ERROR: GitHub meta feed yielded no IPv4 ranges"
  exit 1
fi
while read -r cidr; do
  if [[ ! "$cidr" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/[0-9]{1,2}$ ]]; then
    echo "ERROR: Invalid CIDR range from GitHub meta: $cidr"
    exit 1
  fi
  echo "Adding GitHub range $cidr"
  ipset add -exist allowed-domains "$cidr"
done <<<"$gh_cidrs"

# Resolve a domain's A records and add them. `-exist` keeps the add idempotent --
# several of these hosts share an IP (api.anthropic.com, claude.ai, and
# console.anthropic.com currently all resolve to the same address), which would
# otherwise make the second add fail under `set -e`.
add_domain() { # $1 = domain, $2 = "required" | "optional"
  echo "Resolving $1..."
  local ips
  ips=$(dig +short A "$1" | grep -E '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || true)
  if [ -z "$ips" ]; then
    if [ "$2" = required ]; then
      echo "ERROR: failed to resolve required domain $1"
      return 1
    fi
    echo "WARN: skipping optional domain $1 (no A record)"
    return 0
  fi
  while read -r ip; do
    echo "Adding $ip for $1"
    ipset add -exist allowed-domains "$ip"
  done < <(echo "$ips")
}

# Required hosts: a resolution failure here is fatal (the ERR trap then leaves
# egress closed). Best-effort hosts must never take the whole firewall down.
for domain in "registry.npmjs.org" "nodejs.org" "api.anthropic.com"; do
  add_domain "$domain" required
done
for domain in \
  "claude.ai" \
  "console.anthropic.com" \
  "marketplace.visualstudio.com" \
  "vscode.blob.core.windows.net" \
  "update.code.visualstudio.com" \
  "registry.npmjs.org"; do
  add_domain "$domain" optional || true
done

# Allow the container to reach the host gateway so host-forwarded ports work.
# Restricted to the gateway address itself rather than the whole bridge /24, so
# the container cannot reach other containers on the same Docker network.
HOST_IP=$(ip -4 route show default | awk '{print $3; exit}')
if [ -z "$HOST_IP" ]; then
  echo "ERROR: Failed to detect host IP"
  exit 1
fi
echo "Host gateway detected as: $HOST_IP"
iptables -A INPUT -s "$HOST_IP" -j ACCEPT
iptables -A OUTPUT -d "$HOST_IP" -j ACCEPT

# Add the accept rules (established connections, then the allowlist) BEFORE
# flipping the default policy to DROP, so the change is closing a gap rather than
# briefly orphaning an in-flight connection.
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT

# Default policies to DROP.
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP

# Explicitly REJECT other outbound traffic (appended last, so it is the catch-all
# after the allowlist accept) for immediate feedback instead of a silent drop.
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

# Block IPv6 entirely: the allowlist above is IPv4-only, so without this an agent
# could bypass it over IPv6 wherever the container has IPv6 connectivity. Loopback
# stays open. The flush is best-effort, but the policy DROPs are applied without
# masking -- a genuine failure must trip the fail-closed trap rather than print a
# false "blocked". A host whose ip6tables is unusable (no IPv6 stack) has nothing
# to block and is skipped.
if command -v ip6tables >/dev/null 2>&1 && ip6tables -L >/dev/null 2>&1; then
  ip6tables -F || true
  ip6tables -X || true
  ip6tables -P INPUT DROP
  ip6tables -P FORWARD DROP
  ip6tables -P OUTPUT DROP
  ip6tables -A INPUT -i lo -j ACCEPT
  ip6tables -A OUTPUT -o lo -j ACCEPT
  echo "IPv6 egress blocked (loopback allowed)"
else
  echo "ip6tables unusable or no IPv6 stack; nothing to block"
fi

# The full ruleset is in place; drop the fail-closed trap so a benign error in the
# verification below does not get reported as a firewall build failure.
trap - ERR

echo "Firewall configuration complete"
echo "Verifying firewall rules..."
if curl --connect-timeout 5 -s https://example.com >/dev/null 2>&1; then
  echo "ERROR: Firewall verification failed - was able to reach https://example.com"
  exit 1
else
  echo "Firewall verification passed - unable to reach https://example.com as expected"
fi

# Verify the allowlist actually permits GitHub and the npm registry.
if ! curl --connect-timeout 5 -s https://api.github.com/zen >/dev/null 2>&1; then
  echo "ERROR: Firewall verification failed - unable to reach https://api.github.com"
  exit 1
else
  echo "Firewall verification passed - able to reach https://api.github.com as expected"
fi

if ! curl --connect-timeout 5 -sSf https://registry.npmjs.org/ >/dev/null 2>&1; then
  echo "ERROR: Firewall verification failed - unable to reach https://registry.npmjs.org"
  exit 1
else
  echo "Firewall verification passed - able to reach https://registry.npmjs.org as expected"
fi
