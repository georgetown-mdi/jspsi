#!/bin/sh
# The FIPS variant image's entrypoint preamble. It reports two runtime facts and
# then hands off to the dispatch script the default image runs, unchanged, so
# both images serve the CLI and `serve` roles identically.
#
# What it reports, and why each is read rather than baked in at build time:
#
#   the activated provider -- read back from the loader through `openssl list`,
#     so the line names the module this container actually loaded rather than
#     the one its build intended. The image build asserts the same string; this
#     is what an operator or an auditor can see without rebuilding.
#   the host kernel's FIPS mode -- /proc/sys/crypto/fips_enabled, which is the
#     host kernel's file seen through the container's /proc. The image cannot
#     set it: fips-mode-setup does not work inside a container, which AWS and
#     Red Hat both document, so this is the operator's to provide.
#
# It warns and does not refuse when the host is not in FIPS mode. Refusing would
# strand every developer machine -- Docker Desktop's kernel does not carry the
# sysctl at all -- and the operator is the one who decides what their deployment
# has to satisfy. What the arrangement does and does not support a claim of, at
# each of the three host tiers, is in docs/notes/fips-variant-image.md.
set -e

provider=$(openssl list -providers 2>/dev/null |
  awk '/^[[:space:]]*fips$/ { seen = 1; next }
       seen && $1 == "version:" { print $2; exit }') || provider=""

if [ -n "$provider" ]; then
  echo "[psilink] FIPS provider active: Amazon Linux 2023 OpenSSL FIPS provider, module $provider" >&2
else
  echo "[psilink] WARNING: no active FIPS provider was reported by 'openssl list -providers'. This image's cryptography is not running in the module it was built around." >&2
fi

if [ -r /proc/sys/crypto/fips_enabled ]; then
  fips_enabled=$(cat /proc/sys/crypto/fips_enabled)
else
  fips_enabled="unreadable"
fi

case "$fips_enabled" in
1)
  echo "[psilink] host kernel FIPS mode: enabled" >&2
  ;;
0)
  echo "[psilink] WARNING: the host kernel is not in FIPS mode (/proc/sys/crypto/fips_enabled is 0). The validated module is loaded and serving, but the deployment does not meet the module's own operating conditions. Enable FIPS mode on the host, or treat this run as carrying no FIPS claim." >&2
  ;;
*)
  echo "[psilink] WARNING: the host kernel's FIPS mode could not be read (/proc/sys/crypto/fips_enabled is absent or unreadable), so this container cannot tell whether the host is in FIPS mode. A kernel built without CONFIG_CRYPTO_FIPS has no such file. Treat this run as carrying no FIPS claim unless you know otherwise." >&2
  ;;
esac

exec /app/docker-entrypoint.sh "$@"
