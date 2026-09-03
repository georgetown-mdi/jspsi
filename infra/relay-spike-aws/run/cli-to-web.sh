#!/bin/bash
# The one CLI-to-web attempt: a browser party on this machine invites, the
# restricted CLI box accepts on network class A.
#
# usage: cli-to-web.sh <cycle-id>
#
# Question 1 measured this failing, and the cause was the browser: the web client
# builds its peer connection with a fixed STUN pair, no TURN entry, and offers
# only an mDNS-obscured host candidate and a public reflexive address, neither
# reachable from a party whose network blocks UDP outright. This run repeats it
# over the real internet against a real relay to confirm the same outcome on the
# AWS shape, and records it either way.
#
# The class-A network ACL is widened for this run to reach the services box by
# its ELASTIC addresses as well as its private ones, because the endpoint the
# browser mints names the public host and there is no name to remap when DNS is
# not configured. UDP stays blocked outright, which is the property class A
# measures; the widening is TCP/443 to the same two services.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

CYCLE_ID="${1:?usage: cli-to-web.sh <cycle-id>}"
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

RUN_ID="cli-to-web-$(date -u +%H%M%S)"
OUT="$ART/cycle-$CYCLE_ID/$RUN_ID"
W="$CDIR/work/$RUN_ID"
mkdir -p "$OUT" "$W"

SPIKE_EXTRA_TCP443="$EIP_TURN/32 $EIP_WEB/32" "$RUN_DIR/set-class.sh" a "$CYCLE_ID"

TTL="${SPIKE_TURN_TTL:-3600}"
SECRET="$(cat "$(cycle_secret_file "$CDIR")")"
TURN_USERNAME="$(( $(now) + TTL )):psilink"
TURN_CREDENTIAL="$(printf '%s' "$TURN_USERNAME" \
  | openssl dgst -sha1 -hmac "$SECRET" -binary | openssl base64 | tr -d '\n')"

BROWSER_PID=""
# The browser party writes six files of its own, so it writes them into the work
# directory and they are published from there through artifact_write. Nothing a
# browser or a remote host produced reaches relay-spike-aws/artifacts unredacted.
BROWSER_OUT="$W/browser"
rm -rf "$W/cli" "$BROWSER_OUT"; mkdir -p "$W/cli" "$BROWSER_OUT"
cp "$SPIKE_ROOT/cli/input-a.csv" "$W/cli/input.csv"

publish_browser_output() {
  local f
  for f in "$BROWSER_OUT"/*; do
    [ -f "$f" ] || continue
    artifact_write "$OUT/$(basename "$f")" < "$f"
  done
  return 0
}

# The browser is killed and its output published however this script leaves, so
# a run that dies at the invitation still lands the log that says why.
cli_to_web_exit() {
  local rc=$?
  [ -z "$BROWSER_PID" ] || kill "$BROWSER_PID" 2>/dev/null || true
  publish_browser_output
  exit "$rc"
}
trap cli_to_web_exit EXIT

if no_mutate; then
  log "SPIKE_NO_MUTATE: no browser and no acceptance; a placeholder config is written instead"
  printf 'SPIKE-NO-MUTATE-INVITATION\n' > "$BROWSER_OUT/invitation.txt"
  cat > "$W/cli/psilink.yaml" <<'YAML'
version: 1
connection:
  channel: file
  directory: ./drop
outbound_payload_consent:
  status: pending
YAML
else
  log "starting the browser party against https://$WEB_HOST"
  WEB_URL="https://$WEB_HOST" OUT_DIR="$BROWSER_OUT" WEB_CSV="$SPIKE_ROOT/cli/input-b.csv" \
    WAIT_MS=240000 node "$RUN_DIR/web-invite.mjs" > "$BROWSER_OUT/browser.log" 2>&1 &
  BROWSER_PID=$!

  for _ in $(seq 1 120); do
    if [ -s "$BROWSER_OUT/invitation.txt" ]; then break; fi
    sleep 2
  done
  [ -s "$BROWSER_OUT/invitation.txt" ] || die "the browser never minted an invitation; see $OUT/browser.log"
  INVITATION="$(cat "$BROWSER_OUT/invitation.txt")"

  set +e
  docker run --rm -v "$W/cli:/work" psi-link:spike accept \
    --identity "Agency A, a@agency-a.example" --consent-to-terms --log-level info \
    "$INVITATION" > "$W/cli-accept.out" 2> "$W/cli-accept.err"
  ACCEPT_CODE=$?
  set -e
  artifact_write "$OUT/cli-accept.out" < "$W/cli-accept.out"
  artifact_write "$OUT/cli-accept.err" < "$W/cli-accept.err"
  [ "$ACCEPT_CODE" -eq 0 ] || { tail -5 "$W/cli-accept.err"; die "psilink accept failed"; }
fi

# The relay entry and the payload-consent confirmation the documented path needs
# when an acceptance carries no input file, exactly as question 1 wrote them.
A_TURN_URL="turns:$(if [ "$CF_DNS" = true ]; then printf '%s' "$TURN_HOST"; else printf '%s' "$IP_TURN"; fi):443?transport=tcp"
python3 - "$W/cli/psilink.yaml" "$TURN_USERNAME" "$A_TURN_URL" <<'PY'
import re, sys
cfg, user, turn = sys.argv[1:4]
t = open(cfg).read()
t = re.sub(r'(?m)^(  turn:\n(?:    .*\n)*)', '', t)
block = f"""  turn:
    - url: "{turn}"
      username: "{user}"
      credential: "@/run/secrets/turn"
      credential_type: hmac-sha1
"""
t = re.sub(r"(?m)^(connection:\n(?:  .*\n)*)", lambda m: m.group(1) + block, t, count=1)
t = re.sub(r"(?m)^outbound_payload_consent:\n(?:  .*\n)*",
           "outbound_payload_consent:\n  status: confirmed\n  columns: []\n", t, count=1)
open(cfg, "w").write(t)
PY
CLI_SECRET="$(party_secret_file "$W/cli")"
printf '%s' "$TURN_CREDENTIAL" > "$CLI_SECRET"; chmod 600 "$CLI_SECRET"
cp "$CDIR/certs/ca.crt" "$W/cli/ca.crt"
artifact_write "$OUT/psilink-cli.yaml" < "$W/cli/psilink.yaml"

sshx "$CLI_PUBLIC" "sudo rm -rf /opt/spike/work/$RUN_ID; mkdir -p /opt/spike/work"
scpx -r "$W/cli" "$SSH_USER@$CLI_PUBLIC:/opt/spike/work/$RUN_ID"
scpx "$RUN_DIR/remote/party-run.sh" "$SSH_USER@$CLI_PUBLIC:/opt/spike/party-run.sh"

ADD_HOSTS=""
if [ "$CF_DNS" = true ]; then ADD_HOSTS="spike-turn.$CF_ZONE_NAME:$IP_TURN spike-web.$CF_ZONE_NAME:$IP_WEB"; fi
SINCE="$(isots)"
T0=$(now)
set +e
sshx "$CLI_PUBLIC" "SPIKE_ADD_HOSTS='$ADD_HOSTS' bash /opt/spike/party-run.sh /opt/spike/work/$RUN_ID" 2>&1 \
  | artifact_write "$OUT/cli.log"
CODE=${PIPESTATUS[0]}
set -e
T_END=$(now)

sshx "$CLI_PUBLIC" "sudo cat /opt/spike/work/$RUN_ID/sockets.log" 2>/dev/null \
  | artifact_write "$OUT/cli-sockets.log" || true
sshx "$EIP_TURN" "sudo docker logs --since '$SINCE' spike-turn" 2>&1 \
  | artifact_write "$OUT/coturn.log" || true
[ -n "$BROWSER_PID" ] && wait "$BROWSER_PID" 2>/dev/null; true

RESULT=fail
if no_mutate; then RESULT=not-measured-no-mutate
elif grep -qE 'wrote self-attested exchange record' "$OUT/cli.log" 2>/dev/null; then RESULT=ok; fi
python3 - <<PY | artifact_append "$ART/rows.jsonl"
import json
print(json.dumps({"cycle": "$CYCLE_ID", "run": "$RUN_ID", "class": "a", "shape": "cli-to-web",
                  "relay": "self", "result": "$RESULT", "a_exit": "$CODE", "b_exit": "browser",
                  "wall_seconds": $((T_END - T0)), "artifacts": "$OUT"}))
PY
log "cli-to-web attempt: $RESULT, CLI exit $CODE after $((T_END - T0))s (artifacts in $OUT)"
