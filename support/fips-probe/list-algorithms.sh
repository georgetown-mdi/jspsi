#!/bin/sh
# Questions 1 and 2 of the FIPS provider spike: is X25519 among the FIPS
# provider's key-exchange algorithms, and is Ed25519 among its signature
# algorithms.
#
# Every answer here is the output of a command run in this image; nothing is
# asserted from documentation. The full unfiltered listings are printed because
# the design record needs the raw lists, and the PRESENT/ABSENT lines below are
# derived from those same captured bytes so the transcript carries both the
# evidence and the verdict.
#
# A failing openssl invocation is a measurement, not a broken harness: every
# command prints its output and its exit status and the script continues, and
# the script itself exits 0 so a CI leg never turns red on what the provider
# does or does not carry.

set -u

PREFIX="${PROBE_PREFIX:?PROBE_PREFIX is not set}"
TAG="${PROBE_OPENSSL_TAG:-unknown}"
OPENSSL="$PREFIX/bin/openssl"
MODULES_DIR="$PREFIX/lib/ossl-modules"
FIPS_MODULE="$MODULES_DIR/fips.so"
FIPS_MODULE_CNF="$PREFIX/ssl/fipsmodule.cnf"
TMP="${PROBE_TMP:-/probe/tmp/list}"
CONF="$TMP/fips-only.cnf"

export LD_LIBRARY_PATH="$PREFIX/lib"

mkdir -p "$TMP"

# The provider section name fipsinstall wrote, read back from the file rather
# than assumed, so the config below references the section that actually exists.
FIPS_SECTION="$(grep -m1 -o '^\[[^]]*\]' "$FIPS_MODULE_CNF" 2>/dev/null | tr -d '[]')"
if [ -z "$FIPS_SECTION" ]; then
  FIPS_SECTION=fips_sect
  echo "NOTE: no section header found in $FIPS_MODULE_CNF; falling back to [$FIPS_SECTION]"
fi

# fips and base activated, default deliberately NOT activated, and fips=yes as
# the default property, so anything that lists or runs under this config is
# coming from the FIPS provider.
cat >"$CONF" <<EOF
config_diagnostics = 1
openssl_conf = probe_init

.include $FIPS_MODULE_CNF

[probe_init]
providers = probe_providers
alg_section = probe_algorithms

[probe_algorithms]
default_properties = fips=yes

[probe_providers]
fips = $FIPS_SECTION
base = probe_base

[probe_base]
activate = 1
EOF

# Run a command with its label, echoing the command line, its combined output
# and its exit status, and keeping a copy of the output for the derivations
# below. Never propagates a failure.
run_capture() {
  out="$1"
  shift
  label="$1"
  shift
  echo "### $label"
  echo "\$ $*"
  "$@" >"$out" 2>&1
  status=$?
  cat "$out"
  echo "[exit status $status]"
  echo
}

run() {
  run_capture "$TMP/scratch.out" "$@"
}

# PRESENT/ABSENT for one algorithm name, derived from a captured listing. The
# name must sit on a token boundary, so ED25519 does not match ED25519ph and
# X25519 does not match X448 or a longer name that contains it.
#
# A provider that failed to load lists nothing, which reads exactly like a
# provider that carries nothing -- so a non-empty blocker makes the answer
# UNSETTLED rather than letting an absence stand for both. The verdict is left in
# VERDICT for the caller.
name_verdict() {
  name="$1"
  file="$2"
  label="$3"
  blocker="${4:-}"
  pattern="(^|[^A-Za-z0-9_])$name([^A-Za-z0-9_]|\$)"
  hits=""
  if [ -f "$file" ]; then
    hits="$(grep -inE "$pattern" "$file" 2>/dev/null || true)"
  fi
  if [ -n "$blocker" ]; then
    VERDICT=UNSETTLED
  elif [ -n "$hits" ]; then
    VERDICT=PRESENT
  else
    VERDICT=ABSENT
  fi
  echo "RESULT: $label: $VERDICT"
  if [ -n "$blocker" ]; then
    echo "  unsettled because: $blocker"
  fi
  echo "  derived from: $file"
  echo "  matching lines:"
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits" | sed 's/^/    /'
  else
    echo "    (none)"
  fi
  fips_hits="$(printf '%s\n' "$hits" | grep -i '@ *fips' || true)"
  echo "  of those, annotated with the fips provider:"
  if [ -n "$fips_hits" ]; then
    printf '%s\n' "$fips_hits" | sed 's/^/    /'
  else
    echo "    (none)"
  fi
  echo
}

json_safe() {
  printf '%s' "$1" | tr -d '"\\' | tr '\n' ' '
}

echo "=============================================================="
echo "FIPS provider algorithm listing"
echo "=============================================================="
echo "provider build (OpenSSL release tag): $TAG"
echo "install prefix:                       $PREFIX"
echo "fips module:                          $FIPS_MODULE"
echo "fips module config:                   $FIPS_MODULE_CNF"
echo "provider config used for the listings below:"
sed 's/^/    /' "$CONF"
echo

run "openssl version -a (the CLI doing the listing)" "$OPENSSL" version -a
run "openssl version -m (module directory compiled into this CLI)" "$OPENSSL" version -m
run "node --version (the image's own Node)" node --version
run "node openssl version (what Node links, for the cross-load comparison)" \
  node -p "process.versions.openssl"
run "fips.so on disk" ls -l "$FIPS_MODULE"
run "fips.so digest" sha256sum "$FIPS_MODULE"
run "fipsmodule.cnf written by fipsinstall" cat "$FIPS_MODULE_CNF"

echo "=============================================================="
echo "Which providers are actually active"
echo "=============================================================="
run "openssl list -providers -verbose, default configuration" \
  env -u OPENSSL_CONF -u OPENSSL_MODULES "$OPENSSL" list -providers -verbose
run_capture "$TMP/providers-fips.out" \
  "openssl list -providers -verbose, fips-only configuration" \
  env OPENSSL_CONF="$CONF" OPENSSL_MODULES="$MODULES_DIR" \
  "$OPENSSL" list -providers -verbose

# The status the fips provider reports in the listing above, read back so the
# derivations below can refuse to call an empty list an absence.
FIPS_STATUS="$(awk '/^[[:space:]]*fips[[:space:]]*$/ { found = 1 } found && /status:/ { print $2; exit }' "$TMP/providers-fips.out" 2>/dev/null || true)"
if [ "$FIPS_STATUS" = "active" ]; then
  FIPS_BLOCKER=""
else
  FIPS_BLOCKER="the fips provider was not active in this configuration (status: ${FIPS_STATUS:-not listed}), so an empty listing is a load failure rather than an absent algorithm"
fi
echo "fips provider status under the fips-only configuration: ${FIPS_STATUS:-not listed}"
echo

echo "=============================================================="
echo "Algorithm listings"
echo "=============================================================="

# The derivation source: under the fips-only configuration only fips and base
# are activated, so every algorithm listed here is one of those two providers'.
run_capture "$TMP/kex-fips-config.out" \
  "key-exchange algorithms, fips-only configuration" \
  env OPENSSL_CONF="$CONF" OPENSSL_MODULES="$MODULES_DIR" \
  "$OPENSSL" list -key-exchange-algorithms
run_capture "$TMP/sig-fips-config.out" \
  "signature algorithms, fips-only configuration" \
  env OPENSSL_CONF="$CONF" OPENSSL_MODULES="$MODULES_DIR" \
  "$OPENSSL" list -signature-algorithms
run_capture "$TMP/kem-fips-config.out" \
  "KEM algorithms, fips-only configuration" \
  env OPENSSL_CONF="$CONF" OPENSSL_MODULES="$MODULES_DIR" \
  "$OPENSSL" list -kem-algorithms

# The issue's starting-point commands, run as given.
run_capture "$TMP/kex-provider-flag.out" \
  "openssl list -key-exchange-algorithms -provider fips" \
  env OPENSSL_CONF="$CONF" OPENSSL_MODULES="$MODULES_DIR" \
  "$OPENSSL" list -key-exchange-algorithms -provider fips
run_capture "$TMP/sig-provider-flag.out" \
  "openssl list -signature-algorithms -provider fips" \
  env OPENSSL_CONF="$CONF" OPENSSL_MODULES="$MODULES_DIR" \
  "$OPENSSL" list -signature-algorithms -provider fips
run_capture "$TMP/kem-provider-flag.out" \
  "openssl list -kem-algorithms -provider fips" \
  env OPENSSL_CONF="$CONF" OPENSSL_MODULES="$MODULES_DIR" \
  "$OPENSSL" list -kem-algorithms -provider fips

# Control: the same listings with no provider configuration at all. If the two
# names below are absent from the fips listings but present here, the absence is
# the provider's and not the listing command's.
run_capture "$TMP/kex-default.out" \
  "control: key-exchange algorithms, default configuration" \
  env -u OPENSSL_CONF -u OPENSSL_MODULES "$OPENSSL" list -key-exchange-algorithms
run_capture "$TMP/sig-default.out" \
  "control: signature algorithms, default configuration" \
  env -u OPENSSL_CONF -u OPENSSL_MODULES "$OPENSSL" list -signature-algorithms

echo "=============================================================="
echo "Derived answers"
echo "=============================================================="
name_verdict X25519 "$TMP/kex-fips-config.out" \
  "X25519 among the fips provider's key-exchange algorithms" "$FIPS_BLOCKER"
x25519_fips="$VERDICT"
name_verdict ED25519 "$TMP/sig-fips-config.out" \
  "Ed25519 among the fips provider's signature algorithms" "$FIPS_BLOCKER"
ed25519_fips="$VERDICT"
name_verdict X25519 "$TMP/kex-default.out" \
  "control -- X25519 among the default configuration's key-exchange algorithms"
x25519_default="$VERDICT"
name_verdict ED25519 "$TMP/sig-default.out" \
  "control -- Ed25519 among the default configuration's signature algorithms"
ed25519_default="$VERDICT"

cli_version="$(json_safe "$("$OPENSSL" version 2>&1 | head -1)")"
node_version="$(json_safe "$(node --version 2>&1 | head -1)")"
node_openssl="$(json_safe "$(node -p "process.versions.openssl" 2>&1 | head -1)")"
module_digest="$(json_safe "$(sha256sum "$FIPS_MODULE" 2>&1 | head -1)")"

printf 'LIST_JSON: {'
printf '"provider_build_tag":"%s",' "$(json_safe "$TAG")"
printf '"openssl_cli_version":"%s",' "$cli_version"
printf '"node_version":"%s",' "$node_version"
printf '"node_openssl_version":"%s",' "$node_openssl"
printf '"fips_module":"%s",' "$(json_safe "$FIPS_MODULE")"
printf '"fips_module_sha256":"%s",' "$module_digest"
printf '"fips_provider_status":"%s",' "$(json_safe "${FIPS_STATUS:-not listed}")"
printf '"x25519_key_exchange_under_fips":"%s",' "$x25519_fips"
printf '"ed25519_signature_under_fips":"%s",' "$ed25519_fips"
printf '"x25519_key_exchange_default_control":"%s",' "$x25519_default"
printf '"ed25519_signature_default_control":"%s"' "$ed25519_default"
printf '}\n'

exit 0
