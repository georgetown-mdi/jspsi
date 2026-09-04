#!/bin/bash
# Ask the deployed relay, over the network, whether it is doing its job.
#
# UNTESTED LIVE. Nothing in this file has been run against a relay: it was
# authored from coturn's documented interfaces on a branch that stood nothing up,
# and the exit statuses and message strings the probes below key on are the
# documented shapes rather than measured ones. The first real run is what turns
# this from a proposal into a check; until then, a green result here is worth
# what an unrun script is worth. Fix what it gets wrong on that run rather than
# loosening a probe until it passes.
#
# Three probes, in the order a failure matters:
#
#   handshake     a real TLS handshake on 443/tcp, and the certificate the relay
#                 serves for its own realm
#   allocation    a real TURN allocation through that handshake, with a
#                 credential minted for this run
#   internal-peer the same client asking to reach the cloud metadata endpoint and
#                 an RFC1918 address, which the relay must refuse
#
# The third is the one that cannot be inferred from the second: a relay that
# allocates is working, and a relay that allocates toward its own VPC and the
# metadata endpoint is a proxy into the deployment. It passes only on an observed
# refusal. A probe that could not be asked at all reports UNCLEAR and fails the
# script, because an unanswered question is not a pass.
#
# Meant to run at install and on psilink-relay-verify.timer.
set -uo pipefail

ETC=/etc/psilink-relay
ENV_FILE="${PSILINK_RELAY_ENV_FILE:-$ETC/relay.env}"
# mint-credential.sh is a sibling of this script wherever it sits, which is what
# install.sh and the unit files both mean by /opt/psilink-relay.
HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE="${PSILINK_RELAY_IMAGE:-localhost/psilink-relay:installed}"

die() { printf 'ABORTING: %s\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "no $ENV_FILE; this host has not been installed as a relay"
# shellcheck disable=SC1090
. "$ENV_FILE"
REALM="${PSILINK_RELAY_REALM:-}"
[ -n "$REALM" ] || die "PSILINK_RELAY_REALM is unset in $ENV_FILE"

# EC2 does not hairpin an instance's traffic back to its own Elastic IP: a probe
# run ON the relay box against the public name gets connection-refused on every
# TCP probe even while the relay serves correctly to everyone else. Measured
# 2026-09-03: `openssl s_client -connect <private-ip>:443 -servername
# turn.data-bridge.org` from the box completes the handshake and returns the real
# Let's Encrypt certificate, while the same probe via the Elastic IP is refused.
# REALM stays the SNI name and the TURN realm in every probe regardless -- only
# the TCP connect target changes. install.sh's end-of-install run overrides this
# to the instance's private address; the timer-driven run leaves it at the
# default (REALM) because it should fail if the public path -- the one a partner
# actually uses -- is what broke.
CONNECT="${PSILINK_RELAY_VERIFY_CONNECT:-$REALM}"

# The runtime install.sh chose and recorded. A host installed by hand may carry
# no record of it, so fall back to whichever is on PATH rather than assuming one:
# the probes below run the relay's own image, and the wrong binary is a run that
# never happens rather than a question answered.
RUNTIME="${PSILINK_RELAY_RUNTIME:-}"
if [ -z "$RUNTIME" ]; then
  for candidate in podman docker; do
    if command -v "$candidate" >/dev/null 2>&1; then
      RUNTIME="$candidate"
      break
    fi
  done
fi
[ -n "$RUNTIME" ] || die "no container runtime on this host and PSILINK_RELAY_RUNTIME is unset in $ENV_FILE; the allocation probes run the relay's image"
command -v "$RUNTIME" >/dev/null 2>&1 || die "PSILINK_RELAY_RUNTIME names $RUNTIME, which is not on PATH"

# The wait budget the listener retry below spends, validated up front and not
# where it is read: under `set -uo pipefail` (no -e), a non-numeric value
# makes the `[ -ge ]` comparison in that loop error and evaluate false on every
# iteration rather than halting the script, so the loop would retry forever
# instead of reporting a bound failure. Measured 2026-09-03. Mirrors the
# case-statement validation this reference already uses for its other knobs
# (PSILINK_RELAY_RUNTIME in install.sh).
WAIT="${PSILINK_RELAY_VERIFY_WAIT:-30}"
case "$WAIT" in
  ''|*[!0-9]*) die "PSILINK_RELAY_VERIFY_WAIT is '$WAIT'; set it to a non-negative integer of seconds" ;;
esac

PASS=0; FAIL=0; UNCLEAR=0
report() {
  case "$1" in
    pass)    printf '  PASS     %s\n' "$2"; PASS=$((PASS + 1)) ;;
    fail)    printf '  FAIL     %s\n' "$2"; FAIL=$((FAIL + 1)) ;;
    unclear) printf '  UNCLEAR  %s\n' "$2"; UNCLEAR=$((UNCLEAR + 1)) ;;
  esac
  [ -n "${3:-}" ] && printf '           %s\n' "$3"
  return 0
}

printf 'psilink relay verification: %s\n' "$REALM"
[ "$CONNECT" = "$REALM" ] || printf '(connecting via %s)\n' "$CONNECT"
printf '\n'

# --- wait for the listener ----------------------------------------------------
# install.sh restarts the relay's supervised service and calls this script
# within about a second, but the listener takes a few seconds longer to come
# up. Measured 2026-09-03: a probe at t+0.3s after restart got
# connection-refused, and the listener was accepting by t+1.3s. Retry a bare
# TCP connect against the same target/port the probes below use, once per
# second, before running the first probe -- an install-time run should not
# fail a relay that is merely still starting.
waited=0
until timeout 1 bash -c "exec 3<>\"/dev/tcp/$CONNECT/443\"" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -ge "$WAIT" ]; then
    report fail "no TCP listener at $CONNECT:443 after ${WAIT}s" "PSILINK_RELAY_VERIFY_WAIT to allow longer"
    break
  fi
  sleep 1
done

# --- handshake ---------------------------------------------------------------
# Which certificate the relay serves, read out of an s_client transcript that
# carries it.
certificate_report() {
  local transcript="$1"
  local subject issuer
  subject="$(printf '%s' "$transcript" | sed -n 's/^subject=//p' | head -1)"
  issuer="$(printf '%s' "$transcript" | sed -n 's/^issuer=//p' | head -1)"
  if [ -z "$subject" ] || [ -z "$issuer" ]; then
    report unclear "could not read the certificate $REALM:443 serves" \
      "$(printf '%s' "$transcript" | tr '\n' ' ' | cut -c1-160)"
    return 0
  fi
  # A self-signed certificate is what the demo box carried, and werift refuses to
  # gather a relay candidate against a chain it cannot verify
  # (docs/notes/webrtc-relay-deployment.md): every party would silently fail to
  # relay rather than report a certificate problem.
  if [ "$subject" = "$issuer" ]; then
    report fail "the certificate is self-signed" "subject and issuer are both $subject"
  else
    report pass "the certificate is issued by $issuer"
  fi
  if printf '%s' "$transcript" | openssl x509 -noout -checkend 604800 >/dev/null 2>&1; then
    report pass "the certificate is valid for at least another 7 days"
  else
    report fail "the certificate expires within 7 days" "psilink-relay-cert.timer should have renewed it"
  fi
}

if ! HS="$(echo | timeout 20 openssl s_client -connect "$CONNECT:443" -servername "$REALM" \
  -verify_return_error 2>&1)"; then
  # -verify_return_error ends the handshake on an unverifiable chain before
  # s_client prints the certificate, so an untrusted or self-signed one -- the
  # case the diagnostics below exist for -- is exactly the case they would have
  # nothing to read. Ask a second time without it, for the diagnosis only: the
  # handshake that decides this probe is the verifying one above.
  UNVERIFIED="$(echo | timeout 20 openssl s_client -connect "$CONNECT:443" -servername "$REALM" 2>&1)" || true
  certificate_report "$UNVERIFIED"
  report fail "TLS handshake on $REALM:443" "$(printf '%s' "$HS" | tr '\n' ' ' | cut -c1-160)"
else
  report pass "TLS handshake on $REALM:443"
  certificate_report "$HS"
fi

# --- a credential for this run ----------------------------------------------
TURN_USER=""; TURN_CRED=""
if CRED_OUT="$("$HERE/mint-credential.sh" verify 600 2>&1)"; then
  TURN_USER="$(printf '%s' "$CRED_OUT" | sed -n 's/^username:  *//p' | head -1)"
  TURN_CRED="$(printf '%s' "$CRED_OUT" | sed -n 's/^credential:  *//p' | head -1)"
else
  report unclear "could not mint a credential to verify with" \
    "$(printf '%s' "$CRED_OUT" | tr '\n' ' ' | cut -c1-160)"
fi

# One TURNS client run through the image, which is where turnutils_uclient lives.
# Host networking so it reaches the relay the way a party does. podman and docker
# take these flags the same way; only install.sh's build line differs between
# them.
uclient() {
  local peer="$1"
  # The trailing argument is the TCP connect target; coturn's own 401 challenge
  # carries the realm it authenticates against (turnserver.conf's REALM), so
  # swapping this address does not change what realm the exchange below
  # authenticates under.
  timeout 60 "$RUNTIME" run --rm --network host --entrypoint turnutils_uclient "$IMAGE" \
    -t -S -p 443 -u "$TURN_USER" -w "$TURN_CRED" -e "$peer" -n 2 -c -v "$CONNECT" 2>&1
}

if [ -n "$TURN_USER" ] && [ -n "$TURN_CRED" ]; then
  # A peer this box can actually reach. Without one the probe covers the
  # allocation and not the data leg, which it says rather than implies.
  PEER="${PSILINK_RELAY_VERIFY_PEER:-}"
  if [ -n "$PEER" ]; then
    OUT="$(uclient "$PEER")"
    if printf '%s' "$OUT" | grep -qi 'success\|total transmit time'; then
      report pass "a TURN allocation carried data to $PEER"
    else
      report fail "no allocation carried data to $PEER" "$(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-200)"
    fi
  else
    OUT="$(uclient 203.0.113.9)"
    # Measured 2026-09-03 against coturn 4.17.2: a successful run through this
    # image's turnutils_uclient emits none of 'allocate success', 'relay
    # address', or 'allocated' -- it ends with "Total transmit time is N" and a
    # clean close (data sent to the black-hole peer, 0 received, as expected).
    if printf '%s' "$OUT" | grep -qi 'allocate.*success\|relay address\|allocated\|total transmit time'; then
      report pass "the relay allocated (no PSILINK_RELAY_VERIFY_PEER set, so no data leg was exercised)"
    else
      report fail "no allocation success or transmit-time close was observed" "$(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-200)"
    fi
  fi

  # The refusal, once per denied class that a leaked credential would reach.
  for internal in 169.254.169.254 10.0.0.1; do
    OUT="$(uclient "$internal")"
    if printf '%s' "$OUT" | grep -qi 'forbidden\|403\|denied\|not allowed'; then
      report pass "an allocation toward $internal was refused"
    elif printf '%s' "$OUT" | grep -qi 'allocate.*success.*permission.*success\|total transmit time'; then
      report fail "an allocation toward $internal was NOT refused" \
        "denied-peer-ip in turnserver.conf is not doing its job"
    else
      report unclear "could not tell whether $internal was refused" \
        "$(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-200)"
    fi
  done
else
  report unclear "no credential, so no allocation and no refusal was probed"
fi

printf '\n%s pass, %s fail, %s unclear\n' "$PASS" "$FAIL" "$UNCLEAR"
if [ "$FAIL" -gt 0 ] || [ "$UNCLEAR" -gt 0 ]; then exit 1; fi
exit 0
