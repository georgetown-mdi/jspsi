#!/bin/bash
# Mint one exchange pair: party A invites offline, party B accepts offline, then
# both connection blocks are rewritten to the relay shape.
#
# This is question 1's runs/setup-pair.sh with one change: the two parties now
# see the services box at different addresses -- the restricted box reaches it on
# the private addresses inside the VPC, the partner on this machine reaches it on
# the elastic ones over the real internet -- so each party's connection block is
# written from its own view. Everything else, including the single unreachable
# stun: entry that suppresses server-reflexive gathering, is copied rather than
# re-derived.
#
# Inputs arrive as environment variables:
#   W                work directory to create
#   A_TURN_URL A_BROKER_HOST   the restricted party's view
#   B_TURN_URL B_BROKER_HOST   the partner's view
#   TURN_USERNAME TURN_CREDENTIAL
#   A_ROLE B_ROLE    rendezvous roles, default inviter/acceptor
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

: "${W:?W (work directory) is required}"
: "${A_TURN_URL:?}" "${A_BROKER_HOST:?}" "${B_TURN_URL:?}" "${B_BROKER_HOST:?}"
: "${TURN_USERNAME:?}" "${TURN_CREDENTIAL:?}"
A_ROLE="${A_ROLE:-inviter}"
B_ROLE="${B_ROLE:-acceptor}"
IMAGE="${SPIKE_CLI_IMAGE:-psi-link:spike}"

rm -rf "$W"; mkdir -p "$W/a" "$W/b"
cp "$SPIKE_ROOT/cli/input-a.csv" "$W/a/input.csv"
cp "$SPIKE_ROOT/cli/input-b.csv" "$W/b/input.csv"

if no_mutate; then
  # No party container on a walk, so the two configuration files the rewrite
  # below edits are written here in the shape invite and accept leave them.
  for party in a b; do
    cat > "$W/$party/psilink.yaml" <<'YAML'
version: 1
connection:
  channel: file
  directory: ./drop
YAML
  done
  log "SPIKE_NO_MUTATE: no invitation minted; a placeholder pair is written instead"
else
  docker run --rm -v "$W/a:/work" "$IMAGE" invite \
    --identity "Agency A, a@agency-a.example" --log-level info input.csv \
    > "$W/invite.out" 2> "$W/invite.err"
  INVITATION="$(grep -ohE '^[A-Za-z0-9_-]{200,}$' "$W/invite.out" "$W/invite.err" | head -1)"
  [ -n "$INVITATION" ] || { echo "no invitation minted"; tail -5 "$W/invite.err"; exit 1; }

  docker run --rm -v "$W/b:/work" "$IMAGE" accept \
    --identity "Agency B, b@agency-b.example" --consent-to-terms \
    --log-level info "$INVITATION" input.csv \
    > "$W/accept.out" 2> "$W/accept.err"
fi

for party in a b; do
  if [ "$party" = a ]; then role="$A_ROLE"; turn="$A_TURN_URL"; broker="$A_BROKER_HOST"
  else role="$B_ROLE"; turn="$B_TURN_URL"; broker="$B_BROKER_HOST"; fi
  python3 - "$W/$party/psilink.yaml" "$role" "$TURN_USERNAME" "$turn" "$broker" <<'PY'
import re, sys
cfg, role, user, turn, broker = sys.argv[1:6]
text = open(cfg).read()
block = f"""connection:
  channel: webrtc
  server:
    host: {broker}
    path: /api
  role: {role}
  stun:
    - "stun:127.0.0.1:3478"
  turn:
    - url: "{turn}"
      username: "{user}"
      credential: "@/run/secrets/turn"
      credential_type: hmac-sha1
"""
out, replaced = re.subn(r"(?ms)^connection:.*?(?=^\S|\Z)", block, text, count=1)
if not replaced:
    out = text + "\n" + block
open(cfg, "w").write(out)
PY
  secret="$(party_secret_file "$W/$party")"
  printf '%s' "$TURN_CREDENTIAL" > "$secret"
  chmod 600 "$secret"
done
echo "pair ready in $W (A=$A_ROLE via $A_TURN_URL, B=$B_ROLE via $B_TURN_URL)"
