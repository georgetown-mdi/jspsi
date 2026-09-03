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

printf 'psilink relay verification: %s\n\n' "$REALM"

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

if ! HS="$(echo | timeout 20 openssl s_client -connect "$REALM:443" -servername "$REALM" \
  -verify_return_error 2>&1)"; then
  # -verify_return_error ends the handshake on an unverifiable chain before
  # s_client prints the certificate, so an untrusted or self-signed one -- the
  # case the diagnostics below exist for -- is exactly the case they would have
  # nothing to read. Ask a second time without it, for the diagnosis only: the
  # handshake that decides this probe is the verifying one above.
  UNVERIFIED="$(echo | timeout 20 openssl s_client -connect "$REALM:443" -servername "$REALM" 2>&1)" || true
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
# Host networking so it reaches the relay the way a party does.
uclient() {
  local peer="$1"
  timeout 60 podman run --rm --network host --entrypoint turnutils_uclient "$IMAGE" \
    -t -S -p 443 -u "$TURN_USER" -w "$TURN_CRED" -e "$peer" -n 2 -c -v "$REALM" 2>&1
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
    if printf '%s' "$OUT" | grep -qi 'allocate.*success\|relay address\|allocated'; then
      report pass "the relay allocated (no PSILINK_RELAY_VERIFY_PEER set, so no data leg was exercised)"
    else
      report fail "the relay did not allocate" "$(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-200)"
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
