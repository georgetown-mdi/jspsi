#!/bin/bash
# Ask the deployed relay, over the network, whether it is doing its job.
#
# Driven end to end against a real relay from install.sh's own end-of-install
# run on 2026-09-03/04: 6 pass / 0 fail / 0 unclear (infra/relay/README.md,
# Provenance). The exit statuses and message strings the probes below key on
# are what that run measured against a live coturn instance, not documented
# shapes assumed in advance. Fix what a later run gets wrong rather than
# loosening a probe until it passes.
#
# Five probes, in the order a failure matters:
#
#   handshake     a real TLS handshake on 443/tcp, and the certificate the relay
#                 serves for its own realm
#   allocation    a real TURN allocation through that handshake, with a
#                 credential minted for this run
#   internal-peer the same client asking to reach the cloud metadata endpoint and
#                 an RFC1918 address, which the relay must refuse
#   secrets table two keys registered for this run both allocate, a key never
#                 registered is refused, a credential keyed with a registered
#                 key's 32 decoded bytes rather than its 64 hex characters is
#                 refused (docs/spec/PROTOCOL.md, Relay credential derivation),
#                 and a revoked key's new allocation is refused
#   registrar     where the host holds a registrar token: a call without the
#                 token, or with a wrong one, is refused and writes nothing, and
#                 a registration and a revocation with it reach the mapping and
#                 the table. Skipped, and said so, where the host holds none
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

# --- keys for this run --------------------------------------------------------
# Two exchanges registered under fixed ids, so a run that died before its cleanup
# is replaced rather than accumulated by the next one.
VERIFY_A=psilink-verify-a
VERIFY_B=psilink-verify-b
VERIFY_R=psilink-verify-registrar
KEY_A="$(openssl rand -hex 32)"
KEY_B="$(openssl rand -hex 32)"
KEY_R="$(openssl rand -hex 32)"
KEY_UNREGISTERED="$(openssl rand -hex 32)"
# Cleanup revokes each id, which drops its mapping line, then removes each key
# from the table by value: a register can add the row and still fail, leaving a
# key no mapping line holds.
cleanup() {
  local id
  for id in "$VERIFY_A" "$VERIFY_B" "$VERIFY_R"; do
    "$HERE/revoke-exchange.sh" "$id" > /dev/null 2>&1 || true
  done
  (
    # shellcheck source=exchange-keys.sh
    . "$HERE/exchange-keys.sh"
    set -- "$VERIFY_A" "$KEY_A" "$VERIFY_B" "$KEY_B" "$VERIFY_R" "$KEY_R"
    while [ "$#" -gt 0 ]; do
      if [ -n "$2" ]; then
        remove_key_by_value "$2"
        case "$?" in
          1) ;;
          0) printf 'WARNING: the key this run registered for %s is still in the secrets table; run revoke-exchange.sh %s if %s has a line for it, otherwise %s\n' "$1" "$1" "$MAP_FILE" "$(list_table_hint)" >&2 ;;
          *) printf 'WARNING: could not read the secrets table to confirm the key this run registered for %s left it; %s\n' "$1" "$(list_table_hint)" >&2 ;;
        esac
      fi
      shift 2
    done
  ) < /dev/null || printf 'WARNING: could not check the secrets table for the keys this run registered for %s, %s, and %s; see the message above\n' "$VERIFY_A" "$VERIFY_B" "$VERIFY_R" >&2
  return 0
}
trap cleanup EXIT
TABLE_READY=1
register() {
  local out
  if ! out="$("$HERE/register-exchange.sh" "$1" "$2" 2>&1)"; then
    report fail "could not register $1 for this run" "$(printf '%s' "$out" | tr '\n' ' ')"
    TABLE_READY=0
  fi
}
register "$VERIFY_A" "$KEY_A"
register "$VERIFY_B" "$KEY_B"

# The recipe mint-credential.sh uses, over a key given here. With hexkey the key
# is the 32 bytes the hex decodes to, which coturn must refuse.
mint() {
  printf '%s' "$1" | openssl dgst -sha1 -hmac "$2" -binary | openssl base64 | tr -d '\n'
}
mint_over_decoded_bytes() {
  printf '%s' "$1" | openssl dgst -sha1 -mac hmac -macopt "hexkey:$2" -binary | openssl base64 | tr -d '\n'
}
run_user() { printf '%s:%s' "$(( $(date -u +%s) + 600 ))" "$1"; }

# --- a credential for this run ----------------------------------------------
# From the static secret where the host holds one, so that path stays driven;
# from the first registered key where it does not.
TURN_USER=""; TURN_CRED=""
SECRET_FILE="${PSILINK_RELAY_SECRET_FILE:-$ETC/static-auth-secret}"
if [ -f "$SECRET_FILE" ]; then
  if CRED_OUT="$("$HERE/mint-credential.sh" verify 600 2>&1)"; then
    TURN_USER="$(printf '%s' "$CRED_OUT" | sed -n 's/^username:  *//p' | head -1)"
    TURN_CRED="$(printf '%s' "$CRED_OUT" | sed -n 's/^credential:  *//p' | head -1)"
  else
    report unclear "could not mint a credential to verify with" \
      "$(printf '%s' "$CRED_OUT" | tr '\n' ' ' | cut -c1-160)"
  fi
elif [ "$TABLE_READY" = 1 ]; then
  TURN_USER="$(run_user verify)"
  TURN_CRED="$(mint "$TURN_USER" "$KEY_A")"
fi

# One TURNS client run through the image, which is where turnutils_uclient lives.
# Host networking so it reaches the relay the way a party does. podman and docker
# take these flags the same way; only install.sh's build line differs between
# them.
uclient() {
  local peer="$1" user="${2:-$TURN_USER}" cred="${3:-$TURN_CRED}"
  # The trailing argument is the TCP connect target; coturn's own 401 challenge
  # carries the realm it authenticates against (turnserver.conf's REALM), so
  # swapping this address does not change what realm the exchange below
  # authenticates under.
  timeout 60 "$RUNTIME" run --rm --network host --entrypoint turnutils_uclient "$IMAGE" \
    -t -S -p 443 -u "$user" -w "$cred" -e "$peer" -n 2 -c -v "$CONNECT" 2>&1
}

# Measured 2026-09-03 against coturn 4.17.2: a successful run through this
# image's turnutils_uclient emits none of 'allocate success', 'relay address',
# or 'allocated' -- it ends with "Total transmit time is N" and a clean close.
allocated() {
  printf '%s' "$1" | grep -qi 'allocate.*success\|relay address\|allocated\|total transmit time'
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
    if allocated "$OUT"; then
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

# --- the secrets table ---------------------------------------------------------
# Measured 2026-09-23 against coturn 4.18.0: a credential under no registered
# secret is answered 401 on every retry, and over TURNS turnutils_uclient gives
# up after about 0.6 s (30 retries) with "Cannot complete Allocation" and exit
# status 255.
expect_allocates() {
  local label="$1" out
  out="$(uclient 203.0.113.9 "$2" "$3")"
  if allocated "$out"; then
    report pass "$label allocated"
  else
    report fail "$label did not allocate" "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)"
  fi
}
expect_refused() {
  local label="$1" out
  out="$(uclient 203.0.113.9 "$2" "$3")"
  if allocated "$out"; then
    report fail "$label was NOT refused"
  elif printf '%s' "$out" | grep -q 'Cannot complete Allocation'; then
    report pass "$label was refused"
  else
    report unclear "could not tell whether $label was refused" "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)"
  fi
}

if [ "$TABLE_READY" = 1 ]; then
  U="$(run_user verify-a)"
  expect_allocates "a credential under registered key A" "$U" "$(mint "$U" "$KEY_A")"
  U="$(run_user verify-unregistered)"
  expect_refused "a credential under a key never registered" "$U" "$(mint "$U" "$KEY_UNREGISTERED")"
  U="$(run_user verify-b)"
  expect_refused "a credential keyed with key B's 32 decoded bytes" "$U" "$(mint_over_decoded_bytes "$U" "$KEY_B")"
  expect_allocates "the same username's credential keyed with key B's 64 hex characters" "$U" "$(mint "$U" "$KEY_B")"
  if REV_OUT="$("$HERE/revoke-exchange.sh" "$VERIFY_A" 2>&1)"; then
    # Measured: a new allocation is refused within about 200 ms of the delete.
    sleep 1
    U="$(run_user verify-a-revoked)"
    expect_refused "a new allocation under revoked key A" "$U" "$(mint "$U" "$KEY_A")"
  else
    report fail "could not revoke key A" "$(printf '%s' "$REV_OUT" | tr '\n' ' ' | cut -c1-160)"
  fi
else
  report unclear "no key was registered, so the secrets table was not probed"
fi

# --- the registrar ---------------------------------------------------------------
# Configured when the host holds the relay-owner token. Every request goes over
# HTTPS to the realm's name, and the token and key reach curl on stdin, never
# its command line. Judged by the status code and by reading the mapping and the
# table back, never by the response text.
REGISTRAR_TOKEN_FILE="${PSILINK_RELAY_REGISTRAR_TOKEN_FILE:-$ETC/registrar-token}"
REGISTRAR_PORT="${PSILINK_RELAY_REGISTRAR_PORT:-8443}"
registrar_status() {
  local method="$1" token="$2" body="$3"
  {
    printf 'url = "https://%s:%s/exchanges/%s"\n' "$REALM" "$REGISTRAR_PORT" "$VERIFY_R"
    printf 'request = "%s"\n' "$method"
    [ -z "$token" ] || printf 'header = "Authorization: Bearer %s"\n' "$token"
    if [ -n "$body" ]; then
      printf 'header = "Content-Type: application/json"\n'
      printf 'data = "%s"\n' "${body//\"/\\\"}"
    fi
  } | timeout 150 curl -sS -K - --connect-to "$REALM:$REGISTRAR_PORT:$CONNECT:$REGISTRAR_PORT" \
    -o /dev/null -w '%{http_code}' 2>/dev/null
}
# 0 when the mapping points the id at this run's key and the table lists it, 3
# when neither holds it, and anything else when the two disagree or the table
# cannot be read.
registrar_read_back() {
  (
    # shellcheck source=exchange-keys.sh
    . "$HERE/exchange-keys.sh"
    mapped="$(key_of "$VERIFY_R")"
    listed=0
    table_lists_key "$KEY_R" || listed=$?
    if [ "$mapped" = "$KEY_R" ] && [ "$listed" -eq 0 ]; then exit 0; fi
    if [ "$mapped" != "$KEY_R" ] && [ "$listed" -eq 1 ]; then exit 3; fi
    exit 2
  ) < /dev/null
}
expect_status() {
  local label="$1" want="$2" got="$3"
  if [ "$got" = "$want" ]; then
    report pass "$label was answered $want"
  elif [ -z "$got" ] || [ "$got" = 000 ]; then
    report unclear "$label got no answer from $CONNECT:$REGISTRAR_PORT" "is psilink-relay-registrar.service running? journalctl -u psilink-relay-registrar.service"
  else
    report fail "$label was answered $got, not $want"
  fi
}

if [ ! -f "$REGISTRAR_TOKEN_FILE" ]; then
  printf '  SKIP     the registrar is not configured on this host (no %s)\n' "$REGISTRAR_TOKEN_FILE"
else
  REGISTRAR_TOKEN="$(tr -d '[:space:]' < "$REGISTRAR_TOKEN_FILE")"
  REGISTER_BODY="{\"key\": \"$KEY_R\", \"maxAgeDays\": 1}"
  expect_status "a registration with no token" 401 "$(registrar_status PUT "" "$REGISTER_BODY")"
  expect_status "a registration with a wrong token" 401 "$(registrar_status PUT "$(openssl rand -hex 32)" "$REGISTER_BODY")"
  expect_status "a revocation with no token" 401 "$(registrar_status DELETE "" "")"
  READ_BACK=0; registrar_read_back || READ_BACK=$?
  if [ "$READ_BACK" -eq 3 ]; then
    report pass "the refused registration left no row"
  else
    report fail "a refused registration left the mapping or the table holding its key"
  fi
  STATUS="$(registrar_status PUT "$REGISTRAR_TOKEN" "$REGISTER_BODY")"
  expect_status "a registration with the token" 200 "$STATUS"
  if [ "$STATUS" = 200 ]; then
    READ_BACK=0; registrar_read_back || READ_BACK=$?
    if [ "$READ_BACK" -eq 0 ]; then
      report pass "the registration is in the mapping and the secrets table"
    else
      report fail "the registrar answered 200, but the mapping and the secrets table do not both hold the key"
    fi
    STATUS="$(registrar_status DELETE "$REGISTRAR_TOKEN" "")"
    expect_status "a revocation with the token" 200 "$STATUS"
    READ_BACK=0; registrar_read_back || READ_BACK=$?
    if [ "$READ_BACK" -eq 3 ]; then
      report pass "the revocation removed the key from the mapping and the secrets table"
    else
      report fail "after the revocation the mapping or the secrets table still holds the key"
    fi
  fi
fi

printf '\n%s pass, %s fail, %s unclear\n' "$PASS" "$FAIL" "$UNCLEAR"
if [ "$FAIL" -gt 0 ] || [ "$UNCLEAR" -gt 0 ]; then exit 1; fi
exit 0
