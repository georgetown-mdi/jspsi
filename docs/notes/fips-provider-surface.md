---
title: "What a FIPS Provider Offers in the Shipped Image"
---

# What a FIPS provider offers in the shipped image

*Status: measured, not decided. This note records what an OpenSSL FIPS provider carries and reaches inside the container image PSI-Link ships, so the container, compliance, and crypto items can cite a measurement instead of a belief. It chooses nothing: which provider to target, and whether to pursue a FIPS claim at all, remain open. See [docs/notes/README.md](README.md).*

Three unverified facts gated the whole FIPS thread: whether the provider we would ship carries X25519 key agreement, whether it carries Ed25519 signing, and whether Node's WebCrypto in the shipped image engages a configured FIPS provider at all. All three are now measured by running the real tool in an image built on this repo's `Dockerfile` runtime base. Two of the answers invert the assumption they replace.

Nothing measured here changes any shipped code. The harness is `support/fips-probe/`, driven by `.github/workflows/fips_provider_probe.yaml`; it builds a throwaway image and the runtime stage of `Dockerfile` is untouched.

## What was measured, and on what

| | |
|---|---|
| Base image | `node:26-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66` (the `Dockerfile` runtime stage, derived at run time, not hardcoded) |
| Node | v26.5.0, `process.versions.openssl` 3.5.7, `node_shared_openssl` false, `openssl_is_fips` false |
| Provider build A | OpenSSL 3.0.21, `fips.so` sha256 `2d28258e29d40067c2c6adfa5dc74679b6b31ae97d37beb4384d97e8ab60d52f` |
| Provider build B | OpenSSL 3.5.7, `fips.so` sha256 `74cee9ce943744dc111fccf6d3e43dade3f6a866fa838d679afb232b65b666e1` |

Both providers were built from source from the `openssl/openssl` release tags with `enable-fips`, installed with `make install_sw install_fips`, and configured by the `fipsmodule.cnf` that `openssl fipsinstall` wrote. Two builds rather than one because the choice of provider is itself a variable this spike had to expose: 3.0.x is the series carrying CMVP certificates, and 3.5.7 is what the image's own Node links. Since Node links its own 3.5.7 libcrypto whatever provider is installed, the 3.0.21 leg is also the **cross-load** configuration -- a validated-series module under a current libcrypto -- which is the arrangement an actual FIPS deployment would use.

A note on what "provider build" means for a claim: a CMVP certificate binds to tested operational environments, so a provider built from source here is not itself a validated module even when its source is the validated series. What is measured below is the algorithm surface and the dispatch behaviour, not validation status.

## Question 1: is X25519 among the provider's key-exchange algorithms?

**3.0.21: present. 3.5.7: absent.** The 3.5 series dropped it.

    $ openssl list -key-exchange-algorithms      # 3.0.21, fips-only configuration
      { 1.2.840.113549.1.3.1, DH, dhKeyAgreement } @ fips
      { 1.3.101.110, X25519 } @ fips
      { 1.3.101.111, X448 } @ fips
      ECDH @ fips
      TLS1-PRF @ fips
      HKDF @ fips

    $ openssl list -key-exchange-algorithms      # 3.5.7, fips-only configuration
      { 1.2.840.113549.1.3.1, DH, dhKeyAgreement } @ fips
      ECDH @ fips
      TLS1-PRF @ fips
      HKDF @ fips

The prior belief recorded on the board was "believed absent -- unverified". That is right for the version Node links and wrong for the series that carries certificates, which is the least convenient combination: the two builds disagree exactly where the decision sits.

Two traps around this answer, both of which produce a confident wrong result:

- X25519 does appear in 3.5.7's **KEM** list, inside the hybrid `X25519MLKEM768`. That is a TLS hybrid group, not standalone X25519 key agreement. Any check that greps the combined output for the substring reports X25519 present in 3.5.7. The harness matches whole algorithm names per listing for this reason.
- A provider that fails to load lists nothing, which reads exactly like a provider that carries nothing. The harness reads the provider's `status:` back from `openssl list -providers` first and reports UNSETTLED rather than ABSENT when it is not active.

## Question 2: is Ed25519 among the provider's signature algorithms?

**Present in both builds.**

    { 1.3.101.112, ED25519 } @ fips      # 3.0.21 and 3.5.7 alike

3.5.7 additionally carries ED448, ED25519ph and ED448ph. This also inverts the recorded belief ("believed absent -- unverified"), and it inverts for both candidate builds rather than splitting between them.

## Question 3: does `crypto.subtle` engage the configured provider for AES-256-GCM?

**Engaged, on both builds, attributed rather than assumed.**

The acceptance criterion here was to distinguish "the call succeeded" from "the call ran inside the provider". A call that returns proves nothing on its own: with no provider loaded at all, the same AES-256-GCM round trip succeeds through the default provider and looks identical. So the verdict is computed from four legs, and ENGAGED requires all of them:

1. **The module is in the process.** `fips.so` appears in `/proc/self/maps`, checked after the crypto call because provider loading can be lazy.
2. **The call succeeds while FIPS properties are required.** AES-256-GCM encrypt and decrypt at the product's call shape -- a raw-imported 256-bit key and a 12-byte IV, matching the envelope in `packages/core/src/connection/encryptedMessageConnection.ts` -- under a configuration that activates fips and base and deliberately does not activate default.
3. **Operations no FIPS provider serves fail in that same process.** An MD5 digest and an RSA keygen below the FIPS minimum modulus both fail. Had either survived, the default provider would still be reachable and leg 2 would be unattributable.
4. **Breaking the provider stops the call.** With the `module-mac` in `fipsmodule.cnf` corrupted, and again with `fips.so` truncated, the AES call no longer runs.

Leg 4 is worth reading closely, because what happens is stronger than a failed call: Node **aborts during startup**.

    Assertion failed: ncrypto::CSPRNG(nullptr, 0)

A FIPS module that fails its integrity check does not degrade the process to non-FIPS crypto; it prevents the process from initialising. For the container item that is an operational finding in its own right -- a bad module is a hard-down image, not a silent fallback.

Anything short of all four legs is reported as UNSETTLED or NOT ENGAGED with the reason, and the harness was falsification-tested with the module removed to confirm it reaches NOT ENGAGED and distinguishes a failed module load from a configuration channel that never reached OpenSSL.

### The configuration trap

Node's bundled OpenSSL parses a config file handed to it by `OPENSSL_CONF` -- a malformed one aborts startup -- but it applies the init section named `nodejs_conf`, not `openssl_conf`. A fips-only config written the ordinary way is read, ignored, and the process then behaves exactly as though no configuration existed: `getFips()` 0, no module mapped, every control succeeding. That is indistinguishable by inspection from "Node cannot engage a provider", and it is the single most likely way to answer this question wrongly. The harness probes the configuration channel empirically -- it tries `openssl_conf`, `nodejs_conf`, `--openssl-config`, `--openssl-shared-config` and `OPENSSL_MODULES`, records which ones reach OpenSSL at all, and only then measures engagement.

Related: `crypto.setFips(true)` succeeds and `getFips()` returns 1 **with no FIPS provider present anywhere**. `getFips()` reports the library context's default properties, not a loaded module, and is not evidence of engagement. The harness records it but never concludes from it.

## What a provider would and would not cover

Engagement is necessary but not sufficient: a provider only covers operations that actually dispatch through OpenSSL. Mapped against the call sites in the tree today:

| Operation | Implementation today | Inside an OpenSSL provider boundary? |
|---|---|---|
| AEAD AES-256-GCM, 12-byte IV (`connection/encryptedMessageConnection.ts`) | WebCrypto `crypto.subtle` | Yes -- measured engaged |
| HKDF-SHA-256, HMAC-SHA-256, SHA-256 (`utils/crypto.ts`, `auth.ts`, `kex.ts`, `signedReceipt.ts`) | WebCrypto `crypto.subtle` | Yes -- measured available under a fips-only configuration |
| `getRandomValues` (`utils/crypto.ts`) | WebCrypto | Yes |
| X25519 key agreement (`kex.ts`) | `@noble/curves`, pure JS | **No** -- pure JS is inside no module boundary, whatever the provider carries |
| Ed25519 keygen/sign/verify (`signingIdentity.ts`, `signedReceipt.ts`) | `@noble/curves`, pure JS | **No** -- same |
| PSI masking, P-256 (`psiEngine.ts`) | BoringSSL inside the vendored `@openmined/psi.js` (WASM, or the native addon) | **No, and not reachable in principle** -- an OpenSSL provider cannot cover a different crypto library |
| SFTP transport crypto (`ssh2` via `connection/ssh2SftpAdapter.ts`) | `node:crypto`, not WebCrypto | Yes -- measured dispatched (see below) |

The last row needed its own measurement, because "WebCrypto engages" says nothing about `node:crypto`. It does dispatch through the provider: MD5 fails under a fips-only configuration on both builds, and `generateKeyPairSync('x25519')` fails under 3.5.7 while succeeding under 3.0.21 -- independently reproducing the question-1 answer through a completely different API surface.

That has a deployment consequence worth carrying to the SFTP profile item: in a fips-only container with a 3.5.x provider, `ssh2` loses X25519 keypair generation, and with it the `curve25519-sha256` SSH key exchange, plus MD5 for key fingerprints. Under a 3.0.x provider X25519 survives. Which SSH algorithms remain available is therefore a function of the provider build, and it is not something the WebCrypto answer would have surfaced.

The ceiling this table implies is the important part. Today the AEAD and the key-schedule primitives could sit inside a provider boundary; key establishment, receipt signing, and the PSI masking itself could not. The PSI masking is the one that cannot be fixed by moving code to WebCrypto, because it is BoringSSL inside a vendored module, not OpenSSL.

## What is settled, and what is not

Settled by measurement, in the image, on the base that ships:

- X25519 is in the 3.0.21 FIPS provider's key-exchange algorithms and is not in 3.5.7's.
- Ed25519 is in both providers' signature algorithms.
- `crypto.subtle` AES-256-GCM, and `node:crypto`, both dispatch into a configured FIPS provider in this image, by the four-leg attribution above.
- A 3.0.x provider cross-loads into the 3.5.7 libcrypto Node links, and serves.
- A module that fails its integrity check stops the process from starting.

Not settled, and not settleable from the dev container:

- **Approved versus present.** A module can carry algorithms its certificate does not list as approved. Nothing measured here distinguishes the two, and CMVP is not reachable from the firewalled container. "X25519 is present in 3.0.21" is therefore not "X25519 key establishment may be claimed inside a validated boundary", and must not be read as it.
- **Whether a validated module is obtainable on this base at all.** A CMVP certificate binds to tested operational environments; the provider measured here was built from source under Alpine/musl. Whether any validated build covers that environment is unverified.

## What this means for the items downstream

- Ship a FIPS-validated provider in the image (board 10, 224129266): the mechanism works -- the module loads, serves, and is attributable. The open part is provider selection, which the two builds above frame as a real tradeoff rather than a detail, plus the operational-environment question.
- Document a FIPS deployment profile for SFTP (board 10, 224129384): the provider build determines the surviving SSH algorithm set. That is now measured, not assumed.
- Rewrite the FIPS and SC-13 claims in `docs/COMPLIANCE.md` (board 10, 224129556): the current text says the modules in use are not FIPS 140-validated, which remains accurate. Nothing here licenses "validated module" anywhere, and the PSI masking ceiling above bounds what any future claim can cover.
- Move Ed25519 receipt signing off pure JS (board 9, 224129736): a provider target exists on both candidate builds, and Node 26's WebCrypto carries Ed25519 natively, so the destination is available. Scope is unblocked.
- Decide the key-establishment FIPS boundary (board 9, 224129878): the answer depends on the provider build, and on the approved-versus-present question that is still open. A 3.5.x provider forecloses X25519; a 3.0.x provider carries it, subject to what its certificate actually approves.

## Reproducing this

`.github/workflows/fips_provider_probe.yaml` builds `support/fips-probe/` on the `Dockerfile` runtime base and runs both scripts against both provider builds; `support/fips-probe/README.md` gives the local `docker` invocation. Both scripts print every command, its raw output, and its exit status, and derive their verdicts from those same captured bytes, so a transcript carries the evidence as well as the conclusion. The measurements in this note came from workflow run 31046265222.
