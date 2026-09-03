#!/bin/bash
# Run one psilink party on the restricted box and sample its sockets.
#
# The container uses host networking on purpose: the network class is the
# subnet's network ACL, so the party's traffic must be the instance's traffic.
# Question 1 applied its classes with iptables inside the container because it
# had no subnet to put them on; here the ACL is the real thing and nothing is
# applied inside the container.
#
# usage: party-run.sh <workdir> [extra args to psilink exchange]
set -uo pipefail
W="${1:?usage: party-run.sh <workdir>}"; shift || true
NAME="spike-party-$(basename "$W")"

# The credential arrives by scp with whatever mode the copy applied. It is
# mounted into the container as a secret, so the mode is set here and read back:
# an unverified mode is a claim, not a fact.
if [ -f "$W/turn-secret" ]; then
  chmod 600 "$W/turn-secret"
  MODE="$(stat -c '%a' "$W/turn-secret")"
  if [ "$MODE" != 600 ]; then
    echo "### $W/turn-secret is mode $MODE, not 600"
    exit 1
  fi
  echo "### $W/turn-secret mode $MODE"
fi
CA_ARGS=()
if [ -s "$W/ca.crt" ]; then
  CA_ARGS=(-v "$W/ca.crt:/certs/ca.crt:ro" -e NODE_EXTRA_CA_CERTS=/certs/ca.crt)
fi
HOST_ARGS=()
for h in ${SPIKE_ADD_HOSTS:-}; do HOST_ARGS+=(--add-host "$h"); done

sudo docker rm -f "$NAME" >/dev/null 2>&1 || true

# ss -tnp once a second for the life of the run, the restricted side's own
# witness of which remote peers it actually talked to.
( while :; do printf '%s\n' "$(date -u +%H:%M:%S)"; sudo ss -tnp 2>/dev/null; sleep 1; done ) \
  > "$W/sockets.log" 2>&1 &
WATCH=$!
trap 'kill "$WATCH" 2>/dev/null' EXIT

echo "### psilink exchange starting at $(date -u +%FT%T.%3NZ)"
sudo docker run --rm --name "$NAME" --network host \
  -v "$W:/work" -v "$W/turn-secret:/run/secrets/turn:ro" \
  "${CA_ARGS[@]}" "${HOST_ARGS[@]}" \
  psi-link:spike-party exchange --log-level debug "$@" input.csv out.csv
code=$?
echo "### psilink exchange exit code $code at $(date -u +%FT%T.%3NZ)"
kill "$WATCH" 2>/dev/null
exit "$code"
