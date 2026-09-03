#!/bin/bash
# Render turnserver.conf.tmpl into the rendered configuration coturn reads.
#
# Run at install and again on every start, because the external address is not a
# property of the installation: a stopped and started cloud instance comes back
# on a different public address unless one is held for it, and a config rendered
# last week would advertise a candidate nobody can reach.
#
# The cloud seam is one variable. PSILINK_RELAY_EXTERNAL_IP_HELPER names an
# executable printing "<public>/<private>" on one line; aws/external-ip.sh is the
# AWS implementation and nothing else here knows about a metadata endpoint.
#
# The rendered file carries the static authentication secret, so it is created at
# mode 600 before any content reaches it and is never written anywhere else.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ETC=/etc/psilink-relay
ENV_FILE="${PSILINK_RELAY_ENV_FILE:-$ETC/relay.env}"
TMPL="${PSILINK_RELAY_TEMPLATE:-$HERE/turnserver.conf.tmpl}"

die() { printf 'ABORTING: %s\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "no $ENV_FILE; copy relay.env.example, fill it in, and run install.sh"
# shellcheck disable=SC1090
. "$ENV_FILE"

REALM="${PSILINK_RELAY_REALM:-}"
[ -n "$REALM" ] || die "PSILINK_RELAY_REALM is unset in $ENV_FILE; refusing to guess a realm"

SECRET_FILE="${PSILINK_RELAY_SECRET_FILE:-$ETC/static-auth-secret}"
[ -f "$SECRET_FILE" ] || die "no secret at $SECRET_FILE; install.sh mints one"

MIN_PORT="${PSILINK_RELAY_MIN_PORT:-49152}"
MAX_PORT="${PSILINK_RELAY_MAX_PORT:-49200}"
USER_QUOTA="${PSILINK_RELAY_USER_QUOTA:-6}"
TOTAL_QUOTA="${PSILINK_RELAY_TOTAL_QUOTA:-40}"
MAX_BPS="${PSILINK_RELAY_MAX_BPS:-2000000}"
HELPER="${PSILINK_RELAY_EXTERNAL_IP_HELPER:-$HERE/aws/external-ip.sh}"
OUT="${PSILINK_RELAY_CONF:-$ETC/turnserver.conf}"

[ -x "$HELPER" ] || die "external-ip helper $HELPER is not executable"
ADDRS="$("$HELPER")" || die "external-ip helper $HELPER failed"
case "$ADDRS" in
  */*) : ;;
  *) die "external-ip helper printed '$ADDRS'; expected <public>/<private>" ;;
esac
PUBLIC_IP="${ADDRS%%/*}"
PRIVATE_IP="${ADDRS##*/}"
[ -n "$PUBLIC_IP" ] && [ -n "$PRIVATE_IP" ] || die "external-ip helper printed an incomplete pair: $ADDRS"

# The secret is read into the render and nowhere else. It is not exported, not
# passed as an argument, and not echoed, so it never reaches a process listing,
# a unit file, or the journal.
SECRET="$(cat "$SECRET_FILE")"
[ -n "$SECRET" ] || die "$SECRET_FILE is empty"
# The substitution below is a sed expression, so a secret carrying a metacharacter
# would be rewritten on its way into the file and coturn would authenticate
# against something other than what mint-credential.sh signs with. install.sh
# mints hex; an operator-supplied secret is held to an alphabet that survives.
case "$SECRET" in
  *[!A-Za-z0-9_-]*) die "$SECRET_FILE holds characters outside [A-Za-z0-9_-]; regenerate it with: openssl rand -hex 32" ;;
esac

# The substitution below is textual and does not know a comment from a setting,
# so a comment naming a placeholder is rewritten in place -- and a comment naming
# the secret's placeholder puts the secret in a comment of the rendered file.
COMMENTED="$(grep '^[[:space:]]*#' "$TMPL" | grep -o '__[A-Z_]*__' | sort -u || true)"
if [ -n "$COMMENTED" ]; then
  printf '%s\n' "$COMMENTED" >&2
  die "$TMPL names a placeholder in a comment; name each one where it is used instead"
fi

TMP="$(mktemp "$OUT.XXXXXX")"
chmod 600 "$TMP"
trap 'rm -f "$TMP"' EXIT

sed -e "s#__LISTENING_IP__#$PRIVATE_IP#g" \
    -e "s#__EXTERNAL_IP__#$PUBLIC_IP/$PRIVATE_IP#g" \
    -e "s#__REALM__#$REALM#g" \
    -e "s#__MIN_PORT__#$MIN_PORT#g" \
    -e "s#__MAX_PORT__#$MAX_PORT#g" \
    -e "s#__USER_QUOTA__#$USER_QUOTA#g" \
    -e "s#__TOTAL_QUOTA__#$TOTAL_QUOTA#g" \
    -e "s#__MAX_BPS__#$MAX_BPS#g" \
    -e "s#__STATIC_AUTH_SECRET__#$SECRET#g" \
    "$TMPL" > "$TMP"

# A placeholder left in a setting is one this script has not been taught about,
# and coturn would read the literal token as the value. Comment lines are exempt
# because a comment is not a setting; the check above is what keeps one from
# carrying a placeholder in the first place.
LEFTOVER="$(grep -v '^[[:space:]]*#' "$TMP" | grep -o '__[A-Z_]*__' | sort -u || true)"
if [ -n "$LEFTOVER" ]; then
  printf '%s\n' "$LEFTOVER" >&2
  die "unsubstituted placeholders remain in the rendered configuration"
fi

# The container reads this file as a bind mount, so it has to be readable by the
# account inside the image. install.sh records that account's numeric uid.
mv "$TMP" "$OUT"
trap - EXIT
chmod 600 "$OUT"
if [ -n "${PSILINK_RELAY_IMAGE_UID:-}" ]; then
  chown "$PSILINK_RELAY_IMAGE_UID" "$OUT"
fi

printf 'rendered %s (realm %s, external %s/%s, relay ports %s-%s)\n' \
  "$OUT" "$REALM" "$PUBLIC_IP" "$PRIVATE_IP" "$MIN_PORT" "$MAX_PORT"
