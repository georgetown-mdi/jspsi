#!/bin/bash
# The whole measurement, unattended and resumable.
#
# usage: all.sh [--from <step>] [--only <step>] [--list]
#
# Steps run in order and record themselves in relay-spike-aws/artifacts/all-progress, so a
# re-run skips what already finished. A step that failed is not recorded, so a
# re-run repeats it.
#
# Two invariants this script is responsible for. It never leaves more than two
# instances running -- services-up.sh refuses to launch a third, and every step
# that stands one up tears it down on its way out, failure or not. And it never
# reaches the end without writing RESULTS.md, because a run whose numbers are
# only in a scrollback has not been measured.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

PROGRESS="$ART/all-progress"
touch "$PROGRESS"

STEPS="fixture c1 c2 c3 c4 c5 c6 shared teardown-shared fixture-down final"
FROM=""; ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --list) printf '%s\n' $STEPS; exit 0 ;;
    *) die "unknown argument $1" ;;
  esac
done

guard_account
load_cloudflare_env

done_already() { grep -qx "$1" "$PROGRESS"; }
mark_done() { printf '%s\n' "$1" | artifact_append "$PROGRESS"; }

should_run() {
  local step="$1" seen=0 s
  if [ -n "$ONLY" ]; then
    if [ "$step" = "$ONLY" ]; then return 0; fi
    return 1
  fi
  if [ -n "$FROM" ]; then
    case " $STEPS " in *" $FROM "*) : ;; *) die "unknown step $FROM" ;; esac
    for s in $STEPS; do
      if [ "$s" = "$FROM" ]; then seen=1; fi
      if [ "$s" = "$step" ]; then
        if [ "$seen" = 1 ]; then return 0; fi
        return 1
      fi
    done
    return 1
  fi
  if done_already "$step"; then return 1; fi
  return 0
}

emergency() {
  local rc=$? active stranded known
  active="$(cat "$STATE/active-cycle" 2>/dev/null || true)"
  if [ -n "$active" ]; then
    log "a services box is still up for cycle $active; tearing it down (exit $rc)"
    "$RUN_DIR/services-down.sh" "$active" || log "teardown failed; run relay-spike-aws/nuke.sh --yes"
  fi
  # The fixture box is meant to survive between steps, so this reports rather
  # than terminates -- but it reports by TAG, because a partial teardown drops
  # the state key and leaves the box running and billing under nothing.
  known="$(state_get fixture CLI_INSTANCE || true)"
  for stranded in $(tagged_instance_ids fixture); do
    if [ "$stranded" != "$known" ]; then
      log "STRANDED: instance $stranded carries psilink-spike-cycle=fixture and no state file names it. It is billing. Terminate it: aws --profile $PROFILE --region $REGION ec2 terminate-instances --instance-ids $stranded"
    fi
  done
  exit "$rc"
}
trap emergency EXIT

# A cycle whose resources outlived its teardown blocks the next one -- the
# elastic-address quota is five per region and a surviving proxy interface stops
# the subnet from ever deleting -- so the run refuses to add to the pile. A state
# file whose cycle is provably clean is stale and is dropped here instead.
require_cycles_clear() {
  local f scope cycle n dirty=0
  for f in "$STATE"/cycle-*.env; do
    [ -e "$f" ] || continue
    scope="$(basename "$f" .env)"
    cycle="${scope#cycle-}"
    n="$(cycle_tagged_count "$cycle")"
    if [ "$n" = "0" ]; then
      log "cycle $cycle left a state file but nothing tagged $cycle survives; dropping $f"
      rm -f "$f"
      if [ "$(cat "$STATE/active-cycle" 2>/dev/null || true)" = "$cycle" ]; then
        rm -f "$STATE/active-cycle"
      fi
      continue
    fi
    log "cycle $cycle still owns $n resource(s) tagged psilink-spike-cycle=$cycle"
    log "  retry its teardown with: $RUN_DIR/services-down.sh $cycle"
    dirty=$((dirty + 1))
  done
  [ "$dirty" -eq 0 ] || die "$dirty earlier cycle(s) have not been torn down; this run will not start another until they are"
}

# A fixture box the state file does not name is one a previous run stranded.
# Found by tag: the state key is exactly what a partial teardown drops.
require_no_stranded_fixture() {
  local known id
  known="$(state_get fixture CLI_INSTANCE || true)"
  for id in $(tagged_instance_ids fixture); do
    [ "$id" = "$known" ] && continue
    die "instance $id carries psilink-spike-cycle=fixture and no state file names it; it is billing. Terminate it (aws --profile $PROFILE --region $REGION ec2 terminate-instances --instance-ids $id) or run $AWS_DIR/nuke.sh --yes, then re-run."
  done
}

require_no_stranded_fixture
require_cycles_clear

# --- fixture -----------------------------------------------------------------
if should_run fixture; then
  log "=== fixture"
  "$RUN_DIR/fixture-up.sh"
  mark_done fixture
fi

# --- six ephemeral cycles, alternating class, the fourth interrupted ----------
i=1
for spec in "c1:a:" "c2:b:" "c3:a:" "c4:b:--interrupt" "c5:a:" "c6:b:"; do
  step="$(printf '%s' "$spec" | cut -d: -f1)"
  class="$(printf '%s' "$spec" | cut -d: -f2)"
  extra="$(printf '%s' "$spec" | cut -d: -f3)"
  if should_run "$step"; then
    require_cycles_clear
    log "=== ephemeral cycle $step, class $class $extra"
    # shellcheck disable=SC2086
    "$RUN_DIR/cycle.sh" "${step#c}" --class "$class" $extra
    mark_done "$step"
  fi
  i=$((i + 1))
done

# --- the shared shape --------------------------------------------------------
# One services box, five exchanges, a freshly minted credential each, one
# interrupted. The CLI-to-web attempt and the managed-relay rows ride on the same
# box rather than provisioning their own: they need a broker, not a new shape,
# and a spare provision cycle is spend with nothing to show for it.
if should_run shared; then
  require_cycles_clear
  log "=== shared shape"
  "$RUN_DIR/services-up.sh" shared
  n=1
  for spec in "1:a:" "2:b:" "3:a:" "4:b:--interrupt" "5:a:"; do
    class="$(printf '%s' "$spec" | cut -d: -f2)"
    extra="$(printf '%s' "$spec" | cut -d: -f3)"
    log "--- shared exchange $n, class $class $extra"
    if [ "$extra" = "--interrupt" ]; then
      SPIKE_RUN_ID="shared-$n-$class-interrupted" SPIKE_INTERRUPT=1 \
        "$RUN_DIR/exchange.sh" shared "$class" shared self \
        || log "the interrupted exchange returned non-zero, which is expected"
    else
      SPIKE_RUN_ID="shared-$n-$class" "$RUN_DIR/exchange.sh" shared "$class" shared self \
        || log "shared exchange $n failed; recorded and continuing"
    fi
    n=$((n + 1))
  done

  log "--- the CLI-to-web attempt on class A"
  "$RUN_DIR/cli-to-web.sh" shared || log "the CLI-to-web attempt failed, which question 1 predicts; recorded"

  if [ "$CF_TURN" = true ]; then
    for class in a b; do
      log "--- managed relay, class $class"
      SPIKE_RUN_ID="cloudflare-$class" "$RUN_DIR/exchange.sh" shared "$class" shared cloudflare \
        || log "the managed-relay class $class row failed; recorded"
    done
  else
    log "--- managed relay NOT MEASURED: no Cloudflare TURN key in $SPIKE_ROOT/cloudflare/env"
    printf '{"cycle":"shared","run":"cloudflare","class":"a and b","shape":"managed-relay","relay":"cloudflare","result":"not-measured","reason":"no CF_TURN_KEY_ID / CF_TURN_API_TOKEN"}\n' \
      | artifact_append "$ART/rows.jsonl"
  fi
  mark_done shared
fi

if should_run teardown-shared; then
  if [ -n "$(cat "$STATE/active-cycle" 2>/dev/null || true)" ]; then
    "$RUN_DIR/services-down.sh" shared
  fi
  mark_done teardown-shared
fi

# --- back to nothing ---------------------------------------------------------
if should_run fixture-down; then
  log "=== fixture-down"
  "$RUN_DIR/fixture-down.sh"
  mark_done fixture-down
fi

if should_run final; then
  log "=== the full sweep and the day's cost"
  "$AWS_DIR/inventory.sh" 2>&1 | artifact_tee "$ART/inventory-final.txt"
  START="$(date -u +%Y-%m-%d)"
  if command -v gdate >/dev/null 2>&1; then END="$(gdate -u -d tomorrow +%Y-%m-%d)"
  elif date -u -v+1d +%Y-%m-%d >/dev/null 2>&1; then END="$(date -u -v+1d +%Y-%m-%d)"
  else END="$(date -u -d tomorrow +%Y-%m-%d)"; fi
  aws --profile "$PROFILE" --region us-east-1 ce get-cost-and-usage \
    --time-period "Start=$START,End=$END" --granularity DAILY --metrics UnblendedCost \
    --group-by Type=DIMENSION,Key=SERVICE --output json \
    2>&1 | artifact_write "$ART/cost-today.json" || log "Cost Explorer failed; the day's spend is UNKNOWN, not zero"
  node "$RUN_DIR/render-results.mjs" | artifact_write "$ART/RESULTS.md"
  log "wrote $ART/RESULTS.md"
  mark_done final
fi

log "all.sh complete. Read $ART/RESULTS.md, then $ART/commands.log for every command that could bill."
