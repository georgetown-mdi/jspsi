#!/bin/sh
# The FIPS variant image's entrypoint preamble. It reports two runtime facts and
# then hands off to the dispatch script the default image runs, unchanged, so
# both images accept the same CLI and `serve` invocations.
#
# What it reports, and how each is established:
#
#   whether this container's crypto is served by the validated module -- decided
#     by running the engagement probe the image ships and reading its exit
#     status, and by nothing else. The probe is a Node process under the image's
#     own configuration, so it exercises the same libcrypto the `node` that runs
#     psilink does, at the parameter shapes psilink itself passes; it requires
#     fips.so mapped into that process and an MD5 digest and a below-minimum RSA
#     keygen failing beside the successful calls, so a success served by the
#     default provider cannot read as engagement. The Amazon Linux `openssl` CLI
#     answers for a different libcrypto and a different consumer, which is why
#     nothing here consults it. WHICH module is serving is not read back at all:
#     FIPS_MODULE_VERSION is baked into the image by a build that asserted the
#     installed module reports exactly that string, so at run time it is a fact
#     rather than a parse. An empty value is therefore a fact about the
#     environment rather than about the image, and the report declines to name a
#     module instead of naming an empty one.
#   the host kernel's FIPS mode -- /proc/sys/crypto/fips_enabled, which is the
#     host kernel's file seen through the container's /proc. The image cannot
#     set it: fips-mode-setup does not work inside a container, which AWS and
#     Red Hat both document, so this is the operator's to provide.
#
# It warns and does not refuse, on either report. Refusing would strand every
# developer machine -- Docker Desktop's kernel does not carry the sysctl at all
# -- and the operator is the one who decides what their deployment has to
# satisfy. What the arrangement does and does not support a claim of, at each of
# the three host tiers, is in docs/notes/fips-variant-image.md.
set -e

# How the two reports below refer to the module. The image bakes the version in
# from a build that compared it against the module the loader activates, so an
# empty value can only mean it was cleared or overridden when the container was
# started -- in which case the run has nothing to name, and says so rather than
# writing an assurance line with an empty module in it.
if [ -n "${FIPS_MODULE_VERSION:-}" ]; then
  module_clause="module ${FIPS_MODULE_VERSION}"
else
  module_clause="a module this run cannot name, FIPS_MODULE_VERSION being empty in this container's environment -- the image bakes in the version its build compared against the loaded module, so an empty value means it was cleared or overridden when this container was started"
fi

# The probe's own stdout carries the JSON transcript and the per-leg reasons,
# which are worth showing on the failure path and noise on the success one, so
# it is captured whole and replayed rather than read.
if engagement_report=$(node /app/fips-probe/image-engagement.mjs 2>&1); then
  echo "[psilink] FIPS provider active: this container's crypto is served by the Amazon Linux 2023 OpenSSL FIPS provider, ${module_clause} (probed in this container at startup)" >&2
else
  echo "[psilink] WARNING: the startup probe did not find this container's crypto being served by the FIPS provider this image was built around (${module_clause}). This image's cryptography is not running in the module it was built around. The probe reported:" >&2
  printf '%s\n' "$engagement_report" >&2
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
  echo "[psilink] WARNING: the host kernel is not in FIPS mode (/proc/sys/crypto/fips_enabled is 0). Whatever the provider report above says, a deployment outside host FIPS mode does not meet the module's own operating conditions. Enable FIPS mode on the host, or treat this run as carrying no FIPS claim." >&2
  ;;
*)
  echo "[psilink] WARNING: the host kernel's FIPS mode could not be read (/proc/sys/crypto/fips_enabled is absent or unreadable), so this container cannot tell whether the host is in FIPS mode. A kernel built without CONFIG_CRYPTO_FIPS has no such file. Treat this run as carrying no FIPS claim unless you know otherwise." >&2
  ;;
esac

exec /app/docker-entrypoint.sh "$@"
