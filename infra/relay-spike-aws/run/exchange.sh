#!/bin/bash
# One exchange between the restricted CLI box and the partner on this machine.
#
# usage: exchange.sh <cycle-id> <class: a|b|open> <shape: ephemeral|shared> <relay: self|cloudflare>
#
# The partner runs HERE, over the real internet, which is the path question 1
# could not measure: its two parties were containers on one bridge network.
#
# Two things this script refuses to pretend about. First, it does not wait for
# the CLI to exit before calling the exchange finished: question 1 measured a
# TURN-configured exchange holding the process for eight minutes and nineteen
# seconds after the result was written, five times, so the result file is the
# completion signal and the exit is recorded separately with its own grace
# period. Second, the intersection is checked against the fixture question 1
# pinned, so a run that completes with the wrong answer is a failure, not a row.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

CYCLE_ID="${1:?usage: exchange.sh <cycle-id> <class> <shape> <relay>}"
CLASS="${2:?}"
SHAPE="${3:?}"
RELAY="${4:?}"
export CYCLE_ID
guard_account
load_cloudflare_env

SCOPE="cycle-$CYCLE_ID"
CDIR="$STATE/$SCOPE"
CLI_PUBLIC="$(state_require fixture CLI_PUBLIC)"
EIP_TURN="$(state_require "$SCOPE" EIP_TURN)"
EIP_WEB="$(state_require "$SCOPE" EIP_WEB)"
TURN_HOST="$(state_require "$SCOPE" TURN_HOST)"
WEB_HOST="$(state_require "$SCOPE" WEB_HOST)"

RUN_ID="${SPIKE_RUN_ID:-$CLASS-$SHAPE-$RELAY-$(date -u +%H%M%S)}"
OUT="$ART/cycle-$CYCLE_ID/$RUN_ID"
mkdir -p "$OUT"
W="$CDIR/work/$RUN_ID"
EXIT_GRACE="${SPIKE_EXIT_GRACE:-90}"
RUN_TIMEOUT="${SPIKE_RUN_TIMEOUT:-420}"

# --- the relay, and the credential for it ------------------------------------
EXTRA_CIDRS=""
if [ "$RELAY" = cloudflare ]; then
  CRED_LINE="$("$RUN_DIR/cloudflare.sh" turn-credential "$CYCLE_ID" 600)" || {
    log "the managed relay row is NOT MEASURED: no Cloudflare TURN key configured"
    printf '{"cycle":"%s","class":"%s","shape":"%s","relay":"cloudflare","status":"not-measured","reason":"no CF_TURN_KEY_ID / CF_TURN_API_TOKEN"}\n' \
      "$CYCLE_ID" "$CLASS" "$SHAPE" | artifact_append "$ART/rows.jsonl"
    exit 0
  }
  TURN_USERNAME="$(printf '%s' "$CRED_LINE" | cut -f1)"
  TURN_CREDENTIAL="$(printf '%s' "$CRED_LINE" | cut -f2)"
  CF_URLS="$(printf '%s' "$CRED_LINE" | cut -f3)"
  printf '%s\n' "$CF_URLS" | artifact_write "$OUT/cloudflare-urls.json"
  # TURNS over TCP on 443 first, because that is the transport a restrictive
  # network leaves open; anything else the credential lists is the fallback, and
  # which one carried class B is itself a finding.
  PREFERRED='turns:turn.cloudflare.com:443?transport=tcp'
  if printf '%s' "$CF_URLS" | grep -q 'turn\.cloudflare\.com'; then
    A_TURN_URL="$PREFERRED"
  else
    A_TURN_URL="$(printf '%s' "$CF_URLS" | jq -r '.[]' | grep -m1 '^turns:' || printf '%s' "$CF_URLS" | jq -r '.[0]')"
    log "the credential did not list turns:turn.cloudflare.com:443; falling back to $A_TURN_URL"
  fi
  B_TURN_URL="$A_TURN_URL"
  CF_HOST="$(printf '%s' "$A_TURN_URL" | sed -E 's#^turns?:##; s#[:?].*##')"
  for ip in $(dig +short "$CF_HOST" A 2>/dev/null || true); do
    case "$ip" in *.*.*.*) EXTRA_CIDRS="$EXTRA_CIDRS $ip/32" ;; esac
  done
  printf '%s resolves to:%s\n' "$CF_HOST" "$EXTRA_CIDRS" | artifact_tee "$OUT/relay-addresses.txt"
  [ -n "$EXTRA_CIDRS" ] || log "could not resolve $CF_HOST; the restrictive class will block the managed relay"
else
  TTL="${SPIKE_TURN_TTL:-3600}"
  SECRET="$(cat "$(cycle_secret_file "$CDIR")")"
  TURN_USERNAME="$(( $(now) + TTL )):psilink"
  TURN_CREDENTIAL="$(printf '%s' "$TURN_USERNAME" \
    | openssl dgst -sha1 -hmac "$SECRET" -binary | openssl base64 | tr -d '\n')"
  A_TURN_URL="turns:$(if [ "$CF_DNS" = true ]; then printf '%s' "$TURN_HOST"; else printf '%s' "$IP_TURN"; fi):443?transport=tcp"
  B_TURN_URL="turns:$(if [ "$CF_DNS" = true ]; then printf '%s' "$TURN_HOST"; else printf '%s' "$EIP_TURN"; fi):443?transport=tcp"
fi
printf 'username %s (credential redacted)\nurl A %s\nurl B %s\n' \
  "$TURN_USERNAME" "$A_TURN_URL" "$B_TURN_URL" | artifact_write "$OUT/turn-credential.txt"

# --- the network class -------------------------------------------------------
if [ "$CLASS" != skip ]; then
  SPIKE_EXTRA_TCP443="$EXTRA_CIDRS" "$RUN_DIR/set-class.sh" "$CLASS" "$CYCLE_ID"
fi

# --- both parties' configuration --------------------------------------------
if [ "$CF_DNS" = true ]; then
  A_BROKER_HOST="$WEB_HOST"; B_BROKER_HOST="$WEB_HOST"
  ADD_HOSTS="spike-turn.$CF_ZONE_NAME:$IP_TURN spike-web.$CF_ZONE_NAME:$IP_WEB"
else
  A_BROKER_HOST="$IP_WEB"; B_BROKER_HOST="$EIP_WEB"
  ADD_HOSTS=""
fi
W="$W" A_TURN_URL="$A_TURN_URL" A_BROKER_HOST="$A_BROKER_HOST" \
  B_TURN_URL="$B_TURN_URL" B_BROKER_HOST="$B_BROKER_HOST" \
  TURN_USERNAME="$TURN_USERNAME" TURN_CREDENTIAL="$TURN_CREDENTIAL" \
  "$RUN_DIR/mkpair.sh"
for party in a b; do
  artifact_write "$OUT/psilink-$party.yaml" < "$W/$party/psilink.yaml"
done

# Class B needs the interception CA trusted, which is the difference question 1
# measured between an exchange that completes and one that dies at the signaling
# server with nothing naming a certificate.
if [ "$CLASS" = b ]; then cp "$CDIR/certs/ca-with-proxy.crt" "$W/a/ca.crt"
else cp "$CDIR/certs/ca.crt" "$W/a/ca.crt"; fi
cp "$CDIR/certs/ca.crt" "$W/b/ca.crt"

sshx "$CLI_PUBLIC" "sudo rm -rf /opt/spike/work/$RUN_ID; mkdir -p /opt/spike/work"
scpx -r "$W/a" "$SSH_USER@$CLI_PUBLIC:/opt/spike/work/$RUN_ID"
scpx "$RUN_DIR/remote/party-run.sh" "$SSH_USER@$CLI_PUBLIC:/opt/spike/party-run.sh"

# The partner resolves the broker over public DNS, which is the ephemeral shape's
# own exposure: this zone's negative-cache TTL is 1800 s, so a name minted per
# exchange can be shadowed by a stale NXDOMAIN at the partner's resolver. What the
# resolver answers is recorded, and the partner is pinned to the addresses this
# cycle allocated so the relay measurement does not hang on that.
B_HOST_ARGS=""
if [ "$CF_DNS" = true ]; then
  { printf 'dig %s A: %s\n' "$WEB_HOST" "$(dig +short "$WEB_HOST" A 2>/dev/null | tr '\n' ' ')"
    printf 'dig %s A: %s\n' "$TURN_HOST" "$(dig +short "$TURN_HOST" A 2>/dev/null | tr '\n' ' ')"
    printf 'allocated: web %s turn %s\n' "$EIP_WEB" "$EIP_TURN"
    curl -s -o /dev/null --max-time 15 --resolve "$WEB_HOST:443:$EIP_WEB" \
      -w "GET https://$WEB_HOST/api/ pinned to $EIP_WEB -> HTTP %{http_code} in %{time_total}s\n" \
      "https://$WEB_HOST/api/" || echo "GET https://$WEB_HOST/api/ pinned to $EIP_WEB failed (curl exit $?)"
  } 2>&1 | artifact_tee "$OUT/partner-dns.txt"
  B_HOST_ARGS="--add-host $WEB_HOST:$EIP_WEB --add-host $TURN_HOST:$EIP_TURN"
fi

# --- run ---------------------------------------------------------------------
SINCE="$(isots)"
T0=$(now)
B_CA_ARGS=""
if [ -s "$W/b/ca.crt" ]; then
  B_CA_ARGS="-v $W/b/ca.crt:/certs/ca.crt:ro -e NODE_EXTRA_CA_CERTS=/certs/ca.crt"
fi

# Each party's own exit status, not the redaction's, is what is recorded: the
# artifact function is the tail of the pipe, so the party's code comes from
# PIPESTATUS. set +e keeps a non-zero party -- what an interrupted run is -- from
# taking the subshell out before its code is written.
( set +e
  sshx "$CLI_PUBLIC" "SPIKE_ADD_HOSTS='$ADD_HOSTS' bash /opt/spike/party-run.sh /opt/spike/work/$RUN_ID" 2>&1 \
    | artifact_write "$OUT/a.log"
  rc=${PIPESTATUS[0]}
  printf '%s' "$rc" | artifact_write "$OUT/a.code" ) &
# shellcheck disable=SC2086
( set +e
  dockerx run --rm --name "spike-partner-$RUN_ID" \
    -v "$W/b:/work" -v "$(party_secret_file "$W/b"):/run/secrets/turn:ro" $B_CA_ARGS $B_HOST_ARGS \
    psi-link:spike-party exchange --log-level debug input.csv out.csv 2>&1 \
    | artifact_write "$OUT/b.log"
  rc=${PIPESTATUS[0]}
  printf '%s' "$rc" | artifact_write "$OUT/b.code" ) &

OPEN_AT=""
RESULT_AT=""
INTERRUPTED=no
DEADLINE=$(( T0 + RUN_TIMEOUT ))
while [ "$(now)" -lt "$DEADLINE" ]; do
  if [ -z "$OPEN_AT" ] && grep -q "waiting for my partner's first message" "$OUT/a.log" 2>/dev/null; then
    OPEN_AT=$(now)
    log "data channel open after $((OPEN_AT - T0))s"
    if [ "${SPIKE_INTERRUPT:-0}" = 1 ]; then
      log "interrupting: SIGKILL to the restricted party while the data channel is open"
      sshx "$CLI_PUBLIC" "sudo docker kill -s KILL spike-party-$RUN_ID" >/dev/null 2>&1 || true
      INTERRUPTED=yes
    fi
  fi
  if [ -z "$RESULT_AT" ] && grep -q 'closing connection' "$OUT/a.log" 2>/dev/null; then
    RESULT_AT=$(now)
    log "result written after $((RESULT_AT - T0))s; allowing ${EXIT_GRACE}s for the process to exit"
  fi
  if [ -f "$OUT/a.code" ] && [ -f "$OUT/b.code" ]; then break; fi
  if [ -n "$RESULT_AT" ] && [ "$(now)" -gt $(( RESULT_AT + EXIT_GRACE )) ]; then
    log "the result was written but the process has not exited; recording it and stopping"
    break
  fi
  if [ "$INTERRUPTED" = yes ] && [ -f "$OUT/a.code" ]; then break; fi
  sleep 2
done
T_END=$(now)

sshx "$CLI_PUBLIC" "sudo docker rm -f spike-party-$RUN_ID" >/dev/null 2>&1 || true
dockerx rm -f "spike-partner-$RUN_ID" >/dev/null 2>&1 || true
wait 2>/dev/null || true
A_CODE="$(cat "$OUT/a.code" 2>/dev/null || echo stopped-waiting)"
B_CODE="$(cat "$OUT/b.code" 2>/dev/null || echo stopped-waiting)"

# --- evidence ----------------------------------------------------------------
sshx "$CLI_PUBLIC" "sudo cat /opt/spike/work/$RUN_ID/out.csv" 2>/dev/null \
  | artifact_write "$OUT/a-out.csv" || true
sshx "$CLI_PUBLIC" "sudo cat /opt/spike/work/$RUN_ID/sockets.log" 2>/dev/null \
  | artifact_write "$OUT/a-sockets.log" || true
if [ -f "$W/b/out.csv" ]; then artifact_write "$OUT/b-out.csv" < "$W/b/out.csv"; fi
sshx "$EIP_TURN" "sudo docker logs --since '$SINCE' spike-turn" 2>&1 \
  | artifact_write "$OUT/coturn.log" || true
sshx "$EIP_TURN" "sudo docker logs --since '$SINCE' spike-proxy" 2>&1 \
  | artifact_write "$OUT/proxy.log" || true

RESULT=fail
if no_mutate; then
  RESULT=not-measured-no-mutate
elif [ "$INTERRUPTED" = yes ]; then
  RESULT=interrupted
elif diff -q "$RUN_DIR/expected/a-out.csv" "$OUT/a-out.csv" >/dev/null 2>&1 \
  && diff -q "$RUN_DIR/expected/b-out.csv" "$OUT/b-out.csv" >/dev/null 2>&1; then
  RESULT=ok
elif [ -s "$OUT/a-out.csv" ] || [ -s "$OUT/b-out.csv" ]; then
  RESULT=wrong-intersection
fi

# The two log timestamps that bracket the rendezvous are the only first-party
# signal the CLI emits: it calls getStats() nowhere, so there is no candidate
# pair to read from it (question 1's third config-shape finding).
OPEN_SECONDS="$(artifact_read "$OUT/a.log" | python3 -c '
import re, sys, datetime
start = end = None
for raw in sys.stdin.buffer:
    line = raw.decode("utf-8", "replace")
    m = re.match(r"\[([0-9T:.Z-]+)\]", line)
    if not m:
        continue
    ts = datetime.datetime.fromisoformat(m.group(1).replace("Z", "+00:00"))
    if "rendezvousing through the signaling server" in line and start is None:
        start = ts
    if "waiting for my partner'"'"'s first message" in line and end is None:
        end = ts
print(f"{(end - start).total_seconds():.3f}" if start and end else "")
')"

# coturn announces its realm at boot, with zero clients connected, so a realm in
# the log is not evidence of anything. The per-session ALLOCATE success line
# appears only after a credential authenticates and a relay endpoint is handed
# out, and the session's closing peer-usage line carries the bytes that crossed
# the relay -- the byte count the decision record cites -- so that count is
# preferred whenever the session closed inside the captured window.
RELAYED=unknown
if grep -q 'incoming packet ALLOCATE processed, success' "$OUT/coturn.log" 2>/dev/null; then
  RELAYED=yes-coturn-allocated
fi
RELAYED_BYTES="$(sed -n 's/.*peer usage:.*[[:space:]]rb=\([0-9][0-9]*\),.*[[:space:]]sb=\([0-9][0-9]*\).*/\1 \2/p' \
  "$OUT/coturn.log" 2>/dev/null | awk '{ total += $1 + $2 } END { print total + 0 }' || true)"
if [ "${RELAYED_BYTES:-0}" -gt 0 ]; then RELAYED="yes-coturn-relayed-${RELAYED_BYTES}b"; fi
if [ "$CLASS" = b ] && grep -q 'client TLS established' "$OUT/proxy.log" 2>/dev/null; then
  RELAYED="$RELAYED,through-the-proxy"
fi

python3 - <<PY | artifact_append "$ART/rows.jsonl"
import json
print(json.dumps({
  "cycle": "$CYCLE_ID", "run": "$RUN_ID", "class": "$CLASS", "shape": "$SHAPE",
  "relay": "$RELAY", "result": "$RESULT", "interrupted": "$INTERRUPTED",
  "a_exit": "$A_CODE", "b_exit": "$B_CODE",
  "wall_seconds": $((T_END - T0)),
  "open_seconds": "$OPEN_SECONDS",
  "result_seconds": "$( [ -n "$RESULT_AT" ] && echo $((RESULT_AT - T0)) || echo "" )",
  "turn_url_restricted": "$A_TURN_URL", "turn_url_partner": "$B_TURN_URL",
  "relay_evidence": "$RELAYED",
  "artifacts": "$OUT",
}))
PY

log "exchange $RUN_ID: $RESULT (a=$A_CODE b=$B_CODE, open ${OPEN_SECONDS:-n/a}s, wall $((T_END - T0))s)"
if [ "$RESULT" = fail ]; then exit 1; fi
exit 0
