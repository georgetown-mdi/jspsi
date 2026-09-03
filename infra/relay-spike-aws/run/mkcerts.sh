#!/bin/bash
# Mint this cycle's server certificates.
#
# Two paths, chosen by whether a Cloudflare DNS token is configured:
#
#   token present -- ONE Let's Encrypt certificate covering spike-turn.<zone> and
#     spike-web.<zone>, issued by DNS-01 on the first cycle and reused on every
#     later cycle from the copy under state/le. Let's Encrypt's duplicate
#     certificate limit is five per week (ADVISORY: from Let's Encrypt's rate
#     limit documentation, not driven here), so issuing per cycle would fail on
#     the sixth cycle. That the ephemeral shape has to cache a certificate across
#     cycles is a finding about the shape, not an implementation detail.
#
#   no token -- the private CA under certs/, exactly as question 1 ran, with the
#     cycle's addresses as IP SANs.
#
# The inspecting proxy's certificates always come from the private proxy CA:
# an interception certificate is what class B measures, and no public authority
# issues one.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

CYCLE_ID="${1:?usage: mkcerts.sh <cycle-id>}"
load_cloudflare_env

CERTS_SRC="$SPIKE_ROOT/certs"
OUT="$STATE/cycle-$CYCLE_ID/certs"
mkdir -p "$OUT"
chmod 700 "$STATE/cycle-$CYCLE_ID"

# Every file that carries key material, found by reading it rather than by its
# extension and set on every run rather than once by hand: a private key arrives
# in a .pem bundle as readily as in a .key file, and a mode set by hand drifts.
chmod_key_files() {
  local f
  for f in "$1"/*; do
    [ -f "$f" ] || continue
    if grep -qs -- '-----BEGIN [A-Z ]*PRIVATE KEY-----' "$f"; then chmod 600 "$f"; fi
  done
  return 0
}
chmod_key_files "$CERTS_SRC"

EIP_TURN="$(state_require "cycle-$CYCLE_ID" EIP_TURN)"
EIP_WEB="$(state_require "cycle-$CYCLE_ID" EIP_WEB)"
TURN_HOST="$(turn_host "$EIP_TURN")"
WEB_HOST="$(web_host "$EIP_WEB")"

# One leaf signed by a private CA, with every address and name the two parties
# may dial: the restricted box uses the private addresses, the partner on the
# operator's machine uses the elastic addresses.
mint_private_leaf() {
  local ca_crt="$1" ca_key="$2" cn="$3" out="$4" ip_priv="$5" ip_pub="$6" dns_name="$7"
  local ext
  ext="$OUT/.ext-$(basename "$out")"
  {
    printf 'subjectAltName=IP:%s,IP:%s' "$ip_priv" "$ip_pub"
    if [ "$CF_DNS" = true ]; then printf ',DNS:%s' "$dns_name"; fi
    printf '\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n'
    printf 'extendedKeyUsage=serverAuth\n'
  } > "$ext"
  openssl req -newkey rsa:2048 -nodes -keyout "$out.key" -subj "/CN=$cn" -out "$out.csr" 2>/dev/null
  openssl x509 -req -in "$out.csr" -CA "$ca_crt" -CAkey "$ca_key" -CAcreateserial \
    -days 30 -sha256 -extfile "$ext" -out "$out.crt" 2>/dev/null
  rm -f "$out.csr" "$ext"
  chmod 600 "$out.key"
}

if [ "$CF_DNS" = true ]; then
  LE="$STATE/le"
  mkdir -p "$LE"
  LE_CRT="$LE/certificates/spike-turn.$CF_ZONE_NAME.crt"
  LE_KEY="$LE/certificates/spike-turn.$CF_ZONE_NAME.key"
  reissue=true
  if [ -f "$LE_CRT" ] && openssl x509 -in "$LE_CRT" -noout -checkend 2592000 >/dev/null 2>&1; then
    reissue=false
  fi
  if $reissue && no_mutate; then
    # lego runs through dockerx, which does nothing on a walk, so the copy below
    # had no certificate to copy and a walk with cloudflare/env configured died
    # here. Synthesized the way every other walk value is: a real file at the
    # path lego writes, so the rest of this branch runs.
    log "SPIKE_NO_MUTATE: synthesizing the certificate lego would have issued for $TURN_HOST and $WEB_HOST"
    mkdir -p "$(dirname "$LE_CRT")"
    openssl req -x509 -newkey rsa:2048 -nodes -days 90 \
      -subj "/CN=spike-turn.$CF_ZONE_NAME" -keyout "$LE_KEY" -out "$LE_CRT" 2>/dev/null
    chmod 600 "$LE_KEY"
  elif $reissue; then
    log "issuing one Let's Encrypt certificate for $TURN_HOST and $WEB_HOST by DNS-01"
    log "ADVISORY: lego's cloudflare provider and its CLOUDFLARE_DNS_API_TOKEN variable are the vendor's documented interface, not driven from this host before the run"
    dockerx run --rm \
      -e "CLOUDFLARE_DNS_API_TOKEN=$CF_DNS_API_TOKEN" \
      -v "$LE:/data" goacme/lego:latest \
      run --accept-tos --path /data --dns cloudflare \
      --email "${SPIKE_ACME_EMAIL:-spike@$CF_ZONE_NAME}" \
      -d "spike-turn.$CF_ZONE_NAME" -d "spike-web.$CF_ZONE_NAME" \
      || die "Let's Encrypt issuance failed; re-run with the DNS token removed to fall back to the private CA"
  else
    log "reusing the cached Let's Encrypt certificate (duplicate-certificate limit is five per week)"
  fi
  cp "$LE_CRT" "$OUT/turn.crt"; cp "$LE_KEY" "$OUT/turn.key"
  cp "$LE_CRT" "$OUT/web.crt";  cp "$LE_KEY" "$OUT/web.key"
  : > "$OUT/ca.crt"
  echo "letsencrypt" > "$OUT/authority"
else
  mint_private_leaf "$CERTS_SRC/ca.crt" "$CERTS_SRC/ca.key" "$TURN_HOST" "$OUT/turn" \
    "$IP_TURN" "$EIP_TURN" "spike-turn.${CF_ZONE_NAME:-invalid}"
  mint_private_leaf "$CERTS_SRC/ca.crt" "$CERTS_SRC/ca.key" "$WEB_HOST" "$OUT/web" \
    "$IP_WEB" "$EIP_WEB" "spike-web.${CF_ZONE_NAME:-invalid}"
  cp "$CERTS_SRC/ca.crt" "$OUT/ca.crt"
  echo "private-ca" > "$OUT/authority"
fi

mint_private_leaf "$CERTS_SRC/proxy-ca.crt" "$CERTS_SRC/proxy-ca.key" "$TURN_HOST" "$OUT/mitm-turn" \
  "$IP_TURN" "$EIP_TURN" "spike-turn.${CF_ZONE_NAME:-invalid}"
mint_private_leaf "$CERTS_SRC/proxy-ca.crt" "$CERTS_SRC/proxy-ca.key" "$WEB_HOST" "$OUT/mitm-web" \
  "$IP_WEB" "$EIP_WEB" "spike-web.${CF_ZONE_NAME:-invalid}"

# What each party trusts. Class A trusts the server authority alone; class B
# additionally trusts the proxy CA, which question 1 measured as the difference
# between an exchange that completes and one that dies at the signaling server.
cat "$OUT/ca.crt" "$CERTS_SRC/proxy-ca.crt" > "$OUT/ca-with-proxy.crt"
if [ ! -s "$OUT/ca.crt" ]; then
  log "the server certificate is publicly trusted; class A needs no extra CA on the party host"
fi
chmod_key_files "$OUT"
log "certificates for cycle $CYCLE_ID in $OUT (authority: $(cat "$OUT/authority"))"
