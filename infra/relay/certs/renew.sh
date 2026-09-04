#!/bin/bash
# Obtain or renew the relay's certificate by ACME DNS-01, then run the deploy
# hook. Idempotent: an ACME client that finds a certificate with life left in it
# does nothing, and the hook then re-owns what is already there.
#
# DNS-01 rather than HTTP-01 because the relay listens on 443 and terminates TLS
# for TURNS there. An HTTP-01 challenge would need a second service on 80 on the
# same name, which is a listener that exists only to answer a challenge.
#
# Provider-pluggable: the client and the DNS provider are two variables, and the
# provider's own credential comes from env beside this file. env.example carries
# the Cloudflare shape; another provider is that provider's variables in the same
# file and its name in PSILINK_RELAY_DNS_PROVIDER.
#
# UNTESTED LIVE: no certificate has been issued through this script.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ETC=/etc/psilink-relay
ENV_FILE="${PSILINK_RELAY_ENV_FILE:-$ETC/relay.env}"
ACME_ENV="${PSILINK_RELAY_ACME_ENV:-$ETC/acme.env}"
ACME_HOME="${PSILINK_RELAY_ACME_HOME:-$ETC/acme}"

die() { printf 'ABORTING: %s\n' "$*" >&2; exit 1; }
log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

[ -f "$ENV_FILE" ] || die "no $ENV_FILE; this host has not been installed as a relay"
# shellcheck disable=SC1090
. "$ENV_FILE"
[ -f "$ACME_ENV" ] || die "no $ACME_ENV; copy certs/env.example there, chmod 600, and fill in the provider credential"
# Plain (non-exporting) source for this script's own reads below (EMAIL,
# PROVIDER, CLIENT): a `set +a` after an export-all source does not un-export
# variables already exported, so the DNS provider credential would otherwise
# stay in the environment of everything that runs after this point, including
# deploy-hook.sh, which needs no credential. Measured 2026-09-03: a subshell
# opened after `set -a; . "$ACME_ENV"; set +a` still sees the credential. The
# export-all sourcing below is scoped to a subshell around only the ACME
# client invocation instead, so the credential never outlives that command.
# shellcheck disable=SC1090
. "$ACME_ENV"

REALM="${PSILINK_RELAY_REALM:-}"
[ -n "$REALM" ] || die "PSILINK_RELAY_REALM is unset in $ENV_FILE"
EMAIL="${PSILINK_RELAY_ACME_EMAIL:-}"
[ -n "$EMAIL" ] || die "PSILINK_RELAY_ACME_EMAIL is unset in $ACME_ENV; the authority requires a contact"
PROVIDER="${PSILINK_RELAY_DNS_PROVIDER:-cloudflare}"
CLIENT="${PSILINK_RELAY_ACME_CLIENT:-lego}"

install -d -m 700 "$ACME_HOME"

case "$CLIENT" in
  lego)
    command -v lego >/dev/null 2>&1 || die "lego is not installed; see Certificates in infra/relay/README.md"
    # lego v5's `run` covers both the first issuance and every later renewal:
    # it reads the stored certificate and renews only when due (--renew-days),
    # so the timer needs no branch and no state of its own. Measured against
    # lego v5.4.1: the v4 top-level flags moved under `run`, and the v4
    # `renew` command is gone.
    if [ -f "$ACME_HOME/certificates/$REALM.crt" ]; then
      log "renewing the certificate for $REALM through $PROVIDER (no-op outside the window)"
    else
      log "issuing a first certificate for $REALM through $PROVIDER"
    fi
    # The provider credential must reach lego's process environment: a plain
    # `.` sets shell variables the client never sees, so export-all around a
    # second sourcing -- scoped to this subshell, which is the client
    # invocation and nothing else, so the export does not outlive it.
    # Measured 2026-09-03 (lego saw no token without it).
    (
      set -a
      # shellcheck disable=SC1090
      . "$ACME_ENV"
      set +a
      lego run --accept-tos --email "$EMAIL" --dns "$PROVIDER" --domains "$REALM" \
        --path "$ACME_HOME" --renew-days 30
    )
    SRC_CRT="$ACME_HOME/certificates/$REALM.crt"
    SRC_KEY="$ACME_HOME/certificates/$REALM.key"
    ;;
  acme.sh)
    command -v acme.sh >/dev/null 2>&1 || die "acme.sh is not installed; see Certificates in infra/relay/README.md"
    (
      set -a
      # shellcheck disable=SC1090
      . "$ACME_ENV"
      set +a
      acme.sh --home "$ACME_HOME" --issue --dns "dns_$PROVIDER" -d "$REALM" \
        --accountemail "$EMAIL"
    ) || [ $? -eq 2 ] # 2 is acme.sh for "not due for renewal"
    SRC_CRT="$ACME_HOME/$REALM/fullchain.cer"
    SRC_KEY="$ACME_HOME/$REALM/$REALM.key"
    ;;
  *)
    die "PSILINK_RELAY_ACME_CLIENT is '$CLIENT'; this script drives lego or acme.sh"
    ;;
esac

[ -s "$SRC_CRT" ] && [ -s "$SRC_KEY" ] || die "$CLIENT reported success but left no certificate at $SRC_CRT"

PSILINK_RELAY_CERT_SOURCE="$SRC_CRT" PSILINK_RELAY_KEY_SOURCE="$SRC_KEY" "$HERE/deploy-hook.sh"
