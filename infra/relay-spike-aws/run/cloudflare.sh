#!/bin/bash
# Cloudflare DNS records and Cloudflare Realtime TURN credentials.
#
# ADVISORY, EVERY ENDPOINT IN THIS FILE. No Cloudflare call has been driven from
# this host: the tokens do not exist yet. The shapes below are the vendor's
# documented ones. Every call records its request and its response, secrets
# redacted, under relay-spike-aws/artifacts, so the first real run REPLACES this advisory
# note with a measurement -- which is the point of recording them.
#
#   dns-up   <cycle> <turn-ip> <web-ip>   A records, DNS-only, never proxied
#   dns-down <cycle>                      remove them
#   turn-credential <cycle> <ttl>         one Cloudflare Realtime TURN credential
#
# Every subcommand is a no-op that reports "not configured" when the matching
# token is absent, so the callers do not branch.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

CF_API=https://api.cloudflare.com/client/v4
CF_RTC=https://rtc.live.cloudflare.com/v1

load_cloudflare_env

record_call() {
  local cycle="$1" label="$2" body="$3"
  { printf '=== %s %s\n' "$(isots)" "$label"; printf '%s\n' "$body"; } \
    | artifact_append "$ART/cycle-$cycle/cloudflare.log"
}

# Cloudflare has no --dry-run, so SPIKE_NO_MUTATE stands in for one the way awsm
# does for AWS: the request that would have been sent is logged and recorded, and
# a synthetic answer is handed back so every branch downstream of it runs. A walk
# with a token configured therefore reaches the end instead of stopping at the
# first request.
zone_id() {
  if no_mutate; then printf 'cfzone000000000000000000000000\n'; return 0; fi
  curl -fsS -H "Authorization: Bearer $CF_DNS_API_TOKEN" \
    "$CF_API/zones?name=$CF_ZONE_NAME" | jq -r '.result[0].id // empty'
}

dns_up() {
  local cycle="$1" turn_ip="$2" web_ip="$3" zid name ip resp
  if [ "$CF_DNS" != true ]; then log "no Cloudflare DNS token: skipping DNS, parties use raw addresses"; return 0; fi
  zid="$(zone_id)"; [ -n "$zid" ] || die "could not resolve the zone id for $CF_ZONE_NAME"
  for pair in "spike-turn:$turn_ip" "spike-web:$web_ip"; do
    name="${pair%%:*}"; ip="${pair#*:}"
    if no_mutate; then
      log "SPIKE_NO_MUTATE, would POST: $CF_API/zones/$zid/dns_records A $name -> $ip"
      resp="{\"success\":true,\"synthetic\":\"SPIKE_NO_MUTATE\",\"result\":{\"id\":\"cfrec-$name\"}}"
    else
      resp="$(curl -fsS -X POST -H "Authorization: Bearer $CF_DNS_API_TOKEN" \
        -H 'Content-Type: application/json' \
        --data "{\"type\":\"A\",\"name\":\"$name\",\"content\":\"$ip\",\"ttl\":60,\"proxied\":false}" \
        "$CF_API/zones/$zid/dns_records")"
    fi
    record_call "$cycle" "POST dns_records $name -> $ip" "$resp"
    state_put "cycle-$cycle" "CF_RECORD_${name//-/_}" "$(printf '%s' "$resp" | jq -r '.result.id // empty')"
  done
  state_put "cycle-$cycle" CF_ZONE_ID "$zid"
  log "DNS A records created for spike-turn.$CF_ZONE_NAME and spike-web.$CF_ZONE_NAME (proxied=false)"
}

dns_down() {
  local cycle="$1" zid rid resp
  if [ "$CF_DNS" != true ]; then return 0; fi
  zid="$(state_get "cycle-$cycle" CF_ZONE_ID || true)"
  [ -n "$zid" ] || zid="$(zone_id)"
  for key in CF_RECORD_spike_turn CF_RECORD_spike_web; do
    rid="$(state_get "cycle-$cycle" "$key" || true)"
    [ -n "$rid" ] || continue
    if no_mutate; then
      log "SPIKE_NO_MUTATE, would DELETE: $CF_API/zones/$zid/dns_records/$rid"
      resp='{"success":true,"synthetic":"SPIKE_NO_MUTATE"}'
    else
      resp="$(curl -fsS -X DELETE -H "Authorization: Bearer $CF_DNS_API_TOKEN" \
        "$CF_API/zones/$zid/dns_records/$rid" || echo '{"deleted":"FAILED"}')"
    fi
    record_call "$cycle" "DELETE dns_records $rid" "$resp"
  done
  log "DNS records for cycle $cycle removed"
}

# The managed-relay row of question 3. The credential goes to stdout as
# "<username>\t<credential>\t<urls-json>"; the caller writes it at mode 600.
turn_credential() {
  local cycle="$1" ttl="${2:-600}" resp
  if [ "$CF_TURN" != true ]; then
    log "no Cloudflare TURN key: the managed relay row is NOT MEASURED"
    return 91
  fi
  if no_mutate; then
    log "SPIKE_NO_MUTATE, would POST: $CF_RTC/turn/keys/<key>/credentials/generate ttl=$ttl"
    # Standard base64, trailing = and all, because that is the alphabet a real
    # one arrives in and the alphabet redact() has to cover.
    resp='{"iceServers":{"username":"spike-no-mutate","credential":"c3Bpa2Utbm8tbXV0YXRlL2NyZWQ+","urls":["turns:turn.cloudflare.com:443?transport=tcp"]}}'
  else
    resp="$(curl -fsS -X POST \
      -H "Authorization: Bearer $CF_TURN_API_TOKEN" -H 'Content-Type: application/json' \
      --data "{\"ttl\":$ttl}" \
      "$CF_RTC/turn/keys/$CF_TURN_KEY_ID/credentials/generate")"
  fi
  record_call "$cycle" "POST turn credentials generate ttl=$ttl" "$resp"
  printf '%s\t%s\t%s\n' \
    "$(printf '%s' "$resp" | jq -r '.iceServers.username')" \
    "$(printf '%s' "$resp" | jq -r '.iceServers.credential')" \
    "$(printf '%s' "$resp" | jq -c '.iceServers.urls')"
}

case "${1:-}" in
  dns-up)          dns_up "$2" "$3" "$4" ;;
  dns-down)        dns_down "$2" ;;
  turn-credential) turn_credential "$2" "${3:-600}" ;;
  *) echo "usage: cloudflare.sh dns-up <cycle> <turn-ip> <web-ip> | dns-down <cycle> | turn-credential <cycle> [ttl]" >&2; exit 2 ;;
esac
