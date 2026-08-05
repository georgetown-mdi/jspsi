# Throwaway probe image for the FIPS provider spike. It is built only by
# .github/workflows/fips_provider_probe.yaml and ships nowhere: the root
# Dockerfile's runtime stage is untouched by any of this.
#
# BASE_IMAGE is filled by the workflow from the root Dockerfile's runtime stage,
# so the provider is measured beside the same Node and the same musl userland the
# CLI image actually runs. OPENSSL_TAG names the OpenSSL release tag whose FIPS
# provider is built here; the workflow resolves it (latest 3.0.x, or the version
# the base image's Node links) and passes it in.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG OPENSSL_TAG
ENV PROBE_OPENSSL_TAG=${OPENSSL_TAG}
ENV PROBE_PREFIX=/opt/fips-probe/openssl

RUN apk add --no-cache build-base perl linux-headers ca-certificates curl

WORKDIR /src
RUN set -eux; \
  test -n "$PROBE_OPENSSL_TAG"; \
  curl -fsSLo openssl.tar.gz \
  "https://github.com/openssl/openssl/archive/refs/tags/${PROBE_OPENSSL_TAG}.tar.gz"; \
  src_dir="$(tar -tzf openssl.tar.gz | head -1 | cut -d/ -f1)"; \
  tar -xzf openssl.tar.gz; \
  mv "$src_dir" openssl; \
  rm openssl.tar.gz

# --libdir=lib pins the install layout rather than leaving it to the platform's
# multilib default, so the scripts can name $PROBE_PREFIX/lib/ossl-modules
# outright. install_sw installs the libraries, the CLI and the non-FIPS modules;
# install_fips installs fips.so and writes a fipsmodule.cnf beside it.
WORKDIR /src/openssl
RUN set -eux; \
  perl ./Configure enable-fips --prefix="$PROBE_PREFIX" \
  --openssldir="$PROBE_PREFIX/ssl" --libdir=lib; \
  make -j"$(nproc)"; \
  make install_sw; \
  make install_fips

# The self-test transcript of the install belongs in the measurement record, so
# fipsinstall is run again explicitly, over the installed module, writing the
# config the probe scripts consume. A missing fips.so here is an infrastructure
# failure, not a measurement: fail the build with the directory listing rather
# than leaving the scripts to report an absence that is really a broken image.
RUN set -eux; \
  mkdir -p "$PROBE_PREFIX/ssl"; \
  LD_LIBRARY_PATH="$PROBE_PREFIX/lib" "$PROBE_PREFIX/bin/openssl" fipsinstall \
  -module "$PROBE_PREFIX/lib/ossl-modules/fips.so" \
  -out "$PROBE_PREFIX/ssl/fipsmodule.cnf" \
  -provider_name fips; \
  if [ ! -f "$PROBE_PREFIX/lib/ossl-modules/fips.so" ]; then \
  echo "fips.so absent after install_fips" >&2; \
  ls -la "$PROBE_PREFIX/lib/ossl-modules" >&2 || true; \
  ls -la "$PROBE_PREFIX/lib" >&2 || true; \
  exit 1; \
  fi

COPY list-algorithms.sh webcrypto-probe.mjs /probe/
RUN chmod +x /probe/list-algorithms.sh

WORKDIR /probe
