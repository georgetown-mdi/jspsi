# FIPS provider probe

A throwaway measurement harness, not part of the product and not a field guide.
It answers three questions about an OpenSSL FIPS provider running beside the
Node in psilink's shipped container base:

1. Is X25519 among the FIPS provider's key-exchange algorithms?
2. Is Ed25519 among its signature algorithms?
3. Does `crypto.subtle` in that image's Node engage a configured FIPS provider
   for AES-256-GCM?

Every answer is the output of a command run inside the image. Nothing here is
asserted from documentation, and nothing here ships: the root `Dockerfile`, the
packages and the apps are untouched.

`.github/workflows/fips_provider_probe.yaml` runs the whole thing over two
provider builds and commits the transcripts. What follows is the same run by
hand, so a claim made from a transcript can be re-measured without CI.

## Running it

The base image is whatever the root `Dockerfile`'s runtime stage names, and the
provider build is an OpenSSL release tag. Both are arguments, so the probe can
be pointed at any pair:

```sh
base=$(grep -iE '^FROM[[:space:]]' Dockerfile | tail -1 | awk '{print $2}')

# The latest 3.0.x release, resolved rather than remembered.
tag=$(git ls-remote --tags --refs https://github.com/openssl/openssl 'refs/tags/openssl-3.0.*' \
  | awk '{print $2}' | sed 's#refs/tags/##' \
  | grep -E '^openssl-3\.0\.[0-9]+$' | sort -V | tail -1)

docker build \
  --build-arg BASE_IMAGE="$base" \
  --build-arg OPENSSL_TAG="$tag" \
  -t fips-probe:local \
  support/fips-probe

docker run --rm fips-probe:local sh /probe/list-algorithms.sh
docker run --rm fips-probe:local node /probe/webcrypto-probe.mjs
```

The build compiles OpenSSL from source with `enable-fips` and runs
`openssl fipsinstall`, so it takes several minutes and needs network access to
`github.com`.

Two provider builds are worth measuring, and the workflow measures both: the
latest OpenSSL 3.0.x release, the series that carries CMVP certificates, and the
exact release the base image's Node links, which

```sh
docker run --rm "$base" node -p 'process.versions.openssl'
```

reports. A 3.0.x `fips.so` under that Node is the cross-load configuration --
the one an actual FIPS deployment of this image would have to work -- and the
probe labels a run as such from the two versions it reads at runtime.

## What each file does

- `Dockerfile` -- fetches and builds the OpenSSL release named by `OPENSSL_TAG`
  with `enable-fips` on top of `BASE_IMAGE`, installs `fips.so`, and writes a
  `fipsmodule.cnf` with `openssl fipsinstall`. A missing module fails the build
  rather than leaving the scripts to report an absence that is really a broken
  image.
- `list-algorithms.sh` -- questions 1 and 2. Prints the provider build, the CLI
  doing the listing, the module and its digest, `openssl list -providers
  -verbose` so the transcript shows which providers were actually active, and
  the full unfiltered key-exchange, signature and KEM listings, under a
  configuration that activates fips and base and not default. The PRESENT and
  ABSENT lines at the end are derived from those same captured bytes. The same
  listings under the default configuration are printed as a control: an absence
  under fips that is also an absence under default is the listing command's, not
  the provider's.
- `webcrypto-probe.mjs` -- question 3, described below.
- `README.md` -- this file.

## How question 3 is settled

An AES-256-GCM call succeeding proves nothing on its own: it can succeed because
the default provider served it. The probe separates the two mechanically, and
computes its own verdict rather than leaving the reading to a human:

- It first measures what configuration mechanism, if any, makes the bundled
  OpenSSL read a provider configuration at all -- `OPENSSL_CONF`,
  `--openssl-config`, `--openssl-shared-config`, `OPENSSL_MODULES`, and the
  `openssl_conf` versus `nodejs_conf` top-level key -- by handing Node
  configurations that cannot load and recording which ones make it fail.
- **S1** runs the round trip with no configuration: a 256-bit key and a 12-byte
  IV, the parameter shape read from
  `packages/core/src/connection/encryptedMessageConnection.ts`. This is the same
  WebCrypto call shape the product uses, not the product's own module -- a proxy
  for the AEAD path, not an end-to-end run of it.
- **S2** repeats it with fips and base activated, default not activated, and
  `fips=yes` as the default property, recording `crypto.getFips()` and whether
  `fips.so` appears in `/proc/self/maps` after the call.
- **S3** attempts, in that same process, operations a FIPS provider does not
  carry: an X25519 `deriveBits` and an RSA keygen below the FIPS minimum
  modulus. Each is also run at baseline, so a control that cannot succeed even
  unconfigured counts for nothing. If an informative control still succeeds
  under the fips-only configuration, the default provider is still reachable and
  S2's success is unattributable.
- **S4** breaks the provider -- first the `module-mac` in its config, then the
  module truncated -- and re-runs the same call. A break counts only where
  `fips.so` stopped being mapped.

The only ENGAGED verdict is S2 succeeding, every informative S3 control failing,
and every effective S4 break stopping the call. Anything else is UNSETTLED or
NOT ENGAGED, and the probe prints which and why. Both are legitimate results;
neither is a broken harness.

The probe writes its scratch configurations under `/probe/tmp`; set `PROBE_TMP`
to run it outside the image.

## Reading the output

Both scripts print a complete transcript and a machine-readable summary on one
line: `LIST_JSON:` from the listing and `PROBE_JSON:` from the WebCrypto probe.
Both exit 0 whatever they measure, so a non-zero exit is the harness or the
image failing, never a finding.
