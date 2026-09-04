---
title: "What a FIPS Provider Offers in the Shipped Image"
---

# What a FIPS provider offers in the shipped image

*Status: measurement, plus two decisions taken on it. This note records what an OpenSSL FIPS provider holds and reaches inside the container image psilink ships, and what the CMVP certificates approve, so the container, compliance, and crypto items can cite a measurement instead of a belief. The owner has since set FIPS 140-3 as the target standard and accepted that the Alpine base will likely give way. Which certificate and base pair is now decided -- AWS's certificate 5021, a 140-3 validation, on `amazonlinux:2023`, shipped as a separate variant image -- and whether to pursue a FIPS claim at all remains open. See [docs/notes/README.md](README.md).*

Three unverified facts gated the whole FIPS thread: whether the provider we would ship has X25519 key agreement, whether it has Ed25519 signing, and whether Node's WebCrypto in the shipped image engages a configured FIPS provider at all. All three are now measured by running the real tool in an image built on this repo's `Dockerfile` runtime base. Two of the answers invert the assumption they replace.

Nothing measured here changes any shipped code. The harness is `support/fips-probe/`, driven by `.github/workflows/fips_provider_probe.yaml`; it builds a throwaway image and the runtime stage of `Dockerfile` is untouched.

## What was measured, and on what

| | |
|---|---|
| Base image | `node:26-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66` (the `Dockerfile` runtime stage, derived at run time, not hardcoded) |
| Node | v26.5.0, `process.versions.openssl` 3.5.7, `node_shared_openssl` false, `openssl_is_fips` false |
| Provider build A | OpenSSL 3.0.21, `fips.so` sha256 `2d28258e29d40067c2c6adfa5dc74679b6b31ae97d37beb4384d97e8ab60d52f` |
| Provider build B | OpenSSL 3.5.7, `fips.so` sha256 `74cee9ce943744dc111fccf6d3e43dade3f6a866fa838d679afb232b65b666e1` |

Both providers were built from source from the `openssl/openssl` release tags with `enable-fips`, installed with `make install_sw install_fips`, and configured by the `fipsmodule.cnf` that `openssl fipsinstall` wrote. Two builds rather than one because the choice of provider is itself a variable this spike had to expose: the 3.0 line is where the OpenSSL Project's CMVP certificates sit, and 3.5.7 is what the image's own Node links. Since Node links its own 3.5.7 libcrypto whatever provider is installed, the 3.0.21 leg is also the **cross-load** configuration -- an older module under a current libcrypto -- which is the arrangement an actual FIPS deployment would use.

The certificates cover 3.0.8 and 3.0.9 specifically, not the 3.0 line as a whole, so those two were built and measured afterwards on the same base. Both behave identically to 3.0.21 on every question below.

A note on what "provider build" means for a claim: a CMVP certificate binds to tested operational environments, so a provider built from source here is not itself a validated module even when its source matches a certified version. The measurements below are the algorithm surface and the dispatch behaviour; what the certificates approve is a separate question, answered in its own section.

## Question 1: is X25519 among the provider's key-exchange algorithms?

**Present in 3.0.8, 3.0.9 and 3.0.21. Absent in 3.5.7.** The 3.5 series dropped it.

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

The prior belief recorded on the board was "believed absent -- unverified". That is right for the version Node links and wrong for the certified versions, which is the least convenient combination: the builds disagree exactly where the decision sits.

Two traps around this answer, both of which produce a confident wrong result:

- X25519 does appear in 3.5.7's **KEM** list, inside the hybrid `X25519MLKEM768`. That is a TLS hybrid group, not standalone X25519 key agreement. Any check that greps the combined output for the substring reports X25519 present in 3.5.7. The harness matches whole algorithm names per listing for this reason.
- A provider that fails to load lists nothing, which reads exactly like a provider that holds nothing. The harness reads the provider's `status:` back from `openssl list -providers` first and reports UNSETTLED rather than ABSENT when it is not active.

## Question 2: is Ed25519 among the provider's signature algorithms?

**Present in every measured build** -- 3.0.8, 3.0.9, 3.0.21 and 3.5.7.

    { 1.3.101.112, ED25519 } @ fips      # 3.0.21 and 3.5.7 alike

3.5.7 additionally has ED448, ED25519ph and ED448ph. This also inverts the recorded belief ("believed absent -- unverified"), and it inverts for both candidate builds rather than splitting between them.

## Question 3: does `crypto.subtle` engage the configured provider for AES-256-GCM?

**Engaged, on every build measured, attributed rather than assumed.**

The acceptance criterion here was to distinguish "the call succeeded" from "the call ran inside the provider". A call that returns proves nothing on its own: with no provider loaded at all, the same AES-256-GCM round trip succeeds through the default provider and looks identical. So the verdict is computed from four legs, and ENGAGED requires all of them:

1. **The module is in the process.** `fips.so` appears in `/proc/self/maps`, checked after the crypto call because provider loading can be lazy.
2. **The call succeeds while FIPS properties are required.** AES-256-GCM encrypt and decrypt at the product's call shape -- a raw-imported 256-bit key and a 12-byte IV, matching the envelope in `packages/core/src/connection/encryptedMessageConnection.ts` -- under a configuration that activates fips and base and, by design, does not activate default.
3. **Operations no FIPS provider serves fail in that same process.** An MD5 digest and an RSA keygen below the FIPS minimum modulus both fail. Had either survived, the default provider would still be reachable and leg 2 would be unattributable.
4. **Breaking the provider stops the call.** With the `module-mac` in `fipsmodule.cnf` corrupted, and again with `fips.so` truncated, the AES call no longer runs.

What happens on leg 4 is stronger than a failed call: Node **aborts during startup**.

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
| P-256 ECDH key agreement (`kex.ts`) | WebCrypto `crypto.subtle` | Yes -- `ECDH` is listed under a fips-only configuration on every measured build, and the P-256 `deriveBits` call is a gating leg of the variant image's engagement probe |
| ECDSA P-256 with SHA-256 keygen/sign/verify (`signingKeys.ts`, `signingIdentity.ts`, `signedReceipt.ts`) | WebCrypto `crypto.subtle` | Yes -- `ECDSA` is listed under a fips-only configuration on every measured build; no leg of the variant image's engagement probe covers it, so nothing here is a measured dispatch |
| PSI masking, P-256 (`psiEngine.ts`) | BoringSSL inside the vendored `@openmined/psi.js` (WASM, or the native addon) | **No, and not reachable in principle** -- an OpenSSL provider cannot cover a different crypto library |
| SFTP transport crypto (`ssh2` via `connection/ssh2SftpAdapter.ts`) | `node:crypto`, not WebCrypto | Yes -- measured dispatched (see below) |

The last row needed its own measurement, because "WebCrypto engages" says nothing about `node:crypto`. It does dispatch through the provider: MD5 fails under a fips-only configuration on both builds, and `generateKeyPairSync('x25519')` fails under 3.5.7 while succeeding under 3.0.21 -- independently reproducing the question-1 answer through a completely different API surface.

That has a deployment consequence for the SFTP profile item: in a fips-only container with a 3.5.x provider, `ssh2` loses X25519 keypair generation, and with it the `curve25519-sha256` SSH key exchange, plus MD5 for key fingerprints. Under a 3.0.x provider X25519 survives. Which SSH algorithms remain available is therefore a function of the provider build, and it is not something the WebCrypto answer would have shown.

The ceiling this table implies is the important part. Every operation psilink performs itself -- the AEAD, the key-schedule primitives, key establishment, and receipt signing -- can sit inside a provider boundary, because each is a `crypto.subtle` call. The PSI masking cannot, and it is the one that no move to WebCrypto fixes: it is BoringSSL inside a vendored module, not OpenSSL.

## What the certificates say

Everything above describes a provider's algorithm surface. A FIPS claim rests on a certificate, and the two are not the same thing: a module can have an algorithm its certificate does not approve. This section was added after the certificates were read from a network-capable host, and it answers what this note originally recorded as unresolved.

The OpenSSL Project holds three active certificates under the module name "OpenSSL FIPS Provider": **4282** and **4811** (FIPS 140-2, module versions 3.0.8 and 3.0.9), and **4985** (FIPS 140-3, module version 3.1.2). The certified surface is therefore not one series. The variant image pairs with a vendor certificate rather than any of them -- AWS's **5021**, FIPS 140-3, module version `3.0.8-d694bfa693b76001` -- whose tables are read in [CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md#what-certificate-5021-attests) and shown in the last column below for comparison.

The two algorithms this spike measured land differently on each certificate, and that difference is the whole answer:

| Algorithm | 4282 / 4811 (140-2) | 4985 (140-3) | 5021 (140-3) |
|---|---|---|---|
| X25519 | Table 7, **Allowed** | Table 8, **Non-Approved, Not Allowed** | In **no table**; module has no X25519 |
| Ed25519 | Table 8, **Non-Approved** | Table 8, **Non-Approved, Not Allowed** | In **no table**; module has no Ed25519 |

Neither appears in the approved-algorithm table of any of the four. The 140-2 policy states the rule rather than leaving it to be inferred from table membership: use of the approved algorithms "and allowed algorithms listed in table 7" places the module in the Approved mode, while use of a Table 8 algorithm "will place the module in the non-Approved mode of operation". The EdDSA placement is deliberate -- the policy revision history records "Updated to move EdDSA to the non-Approved mode" at version 1.2, 26 January 2023.

The last column is an absence rather than a placement, in the policy and in the module alike: neither algorithm is named anywhere in 5021's security policy ([CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md#what-certificate-5021-attests)), and `openssl list` in the variant image reports both primitives absent while the certified provider is active ([fips-variant-image.md](fips-variant-image.md)). So there is no status either algorithm could hold under that certificate, and no primitive to drive if one could.

Three statements therefore have to be kept apart, and collapsing them is how this gets written wrongly:

- **Approved** -- on the certificate's approved list. On the OpenSSL Project certificates, AES-GCM, SHA2, HMAC, ECDSA and KAS-SSC key agreement are.
- **Allowed** -- not approved, but does not take the module out of approved mode. X25519 is, on 4282 and 4811 only.
- **Not allowed** -- using it puts the module in non-approved mode. Ed25519 is, on all three OpenSSL Project certificates; X25519 is, on 4985.

The middle category is where the taxonomy is certificate-specific rather than standard-wide, so it does not travel: certificate 5021 states its non-approved-but-allowed categories empty, which leaves approved and not-approved and nothing between them, and a sentence written from the three-way shape above will not land on that certificate.

The direction of travel tightens. A newer certified provider withdraws X25519's reprieve rather than extending it, so "wait for a newer certificate" is not a strategy that helps here.

The runtime measurements agree with the tables, which is a useful cross-check that the intended module was loaded: under a fips-only configuration on 3.0.8 and 3.0.9, an X25519 `deriveBits` succeeds while the below-minimum RSA keygen and the MD5 digest fail beside it -- exactly the behaviour of an algorithm the module serves without approving. Those are the OpenSSL Project's from-source builds of those versions, and the version number is not what decides it: AWS's certified module is 3.0.8 too, and has no X25519 at all.

### A Table 13 row that does not say what it appears to say

Certificate 4985's Table 13 (Non-Approved Services) has a **Key Derivation** row, "Derive keys (key derivation key passed in by the calling process)", over `X942KDF-CONCAT`, `X963KDF`, `HKDF` and `OneStep KDF`. Read on its own it says that HKDF with a caller-supplied key is a non-approved service -- which would put psilink's whole key schedule, and the collapsed `deriveBits` call that
[key-establishment-fips-boundary.md](key-establishment-fips-boundary.md) lands on an approved `KDA HKDF` row, outside the approved set. It does not say that, and the reading is recorded here because it will otherwise be met cold by whoever reads the certificate next.

**Table 13 is the service view of Table 8, and each row includes Table 8's qualification.** The correspondence was checked entry for entry: every algorithm named across Table 13's eight rows appears in Table 8 (Non-Approved, Not Allowed Algorithms), and Table 8 names none that Table 13 omits. So the Key Derivation row's four algorithms each arrive with the condition Table 8 states for them, and none of those conditions is "when the caller supplies the key":

| Table 8 entry | The stated condition |
|---|---|
| `HKDF` | "Provides < 112 bits of security, Usage of HKDF with key length less than 112 bits" |
| `OneStep KDF` | "Usage of OneStep KDF with PRF SHAKE128, SHAKE256" |
| `X942KDF-CONCAT` | usage with PRF SHA-1, the truncated SHA-2 variants, the SHA-3 family, SHAKE, or KECCAK-KMAC |
| `X963KDF` | the same PRF list |

psilink derives with HKDF-SHA-256 from 256-bit key-derivation keys to 256-bit outputs, so neither end of the derivation approaches the 112-bit threshold that row states and the row does not reach it.

Two corroborations, from the same policy. `KDA HKDF SP800-56Cr2` is in **Table 5 (Approved Algorithms)**, and **Table 12 (Approved Services)** has a "Key derivation (Perform approved security functions)" service whose indicator list includes `[HKDF: HKDF, MAC: HMAC, (SHA1, SHA2-224, SHA2-256, ...)]`. An algorithm cannot be both blanket non-approved and an approved service; the Table 8 qualification is what makes the two tables consistent.

**Why the misreading is easy, stated so it is not made twice.** Table 13's rows are not uniformly self-contained. Its **Keyed Hash** row spells its condition out inline -- "Generate HMAC using key length less than 112 bits" -- and its **Random** row names the specific non-approved DRBG PRFs, while the Key Derivation row states only the caller-supplies-the-key condition and leaves the algorithm-level qualification to Table 8. A reader who takes each Table 13 row as complete in itself gets the HMAC answer right and the HKDF answer wrong.

What this determines is the algorithm's approval status on certificate 4985, and no more. Whether the module accepts a caller-supplied byte string as the shared-secret input to a given derivation service is a separate question, recorded as open in
[key-establishment-fips-boundary.md](key-establishment-fips-boundary.md) and determined by driving the module rather than by reading further policy text.

The reading is 4985's alone, and certificate 5021 reaches the same answer through a differently arranged policy. Its non-approved *services* table is **Table 14**, whose "Key derivation" row contains KBKDF, `KDA OneStep`, `KDA TwoStep`, HKDF, ANS X9.42 KDF and ANS X9.63 KDF at "< 112-bit keys", with further entries conditioning `KDA OneStep`, `KDA TwoStep` and ANS X9.42 KDF on the SHAKE PRFs, ANS X9.63 KDF on those plus SHA-1, and the SSH, TLS 1.2 and TLS 1.3 KDFs each on a named hash list. Two things separate it from 4985's row. Its condition is a parameter condition stated inline rather than 4985's "key derivation key passed in by the calling process" description with the qualification deferred to another table, so the misreading above does not arise on that certificate at all; and its approved-services table has a key-derivation service for HKDF from a shared secret, which is the same corroboration 4985's Table 12 gives. psilink's HKDF-SHA-256 from a 256-bit key-derivation key sits outside every condition either row states.

The table numbers do not travel with the reading, in either direction. 5021's non-approved *algorithms* table -- where `AES GCM (external IV)` sits -- is **Table 7** against 4985's Table 8, while its non-approved *services* table is Table 14 against 4985's Table 13. Part of that offset is 5021 stating both of its non-approved-but-allowed categories empty in prose ("N/A for this module") instead of carrying a table for each. So a row cited by table number alone names a different table on the other policy, and every citation here names the certificate first. What 5021 states about the module's HKDF beyond these placements is a use-context restriction, recorded in [fips-variant-image.md](fips-variant-image.md).

### No certificate covers the base that ships

All 40 active certificates carrying this module name were read: 15 from their certificate pages, and the other 25 from their security policies, because those pages render no operational-environment section at all. **None names a musl, Alpine, uClibc or BusyBox environment.** Every environment across the 40 is glibc-based, or macOS, FreeBSD, or Windows. The OpenSSL Project's own certificates name five OS families across 12 tested configurations, each with and without PAA: Ubuntu 22.04.1, Debian 11.5, FreeBSD 13.1, Windows 10, and macOS 11.5.2.

The stronger form of that argument does not depend on the search at all. A tested operational environment binds to the hardware and OS it was tested on, not to a libc family: even a certificate whose firmware turned out to be musl would name something like "Linux 5.10 on an HP DesignJet Cortex-A7", and an Alpine container on generic x86-64 would still not be a covered environment. Alpine does not become reachable by finding a musl entry.

Certificate 4985's policy closes the usual documented exception explicitly. Its operational-environment section states: **"No operational environments are vendor affirmed."** So that certificate covers its 12 tested configurations and nothing else, and each of those names hardware as well as an OS -- Ubuntu 22.04.1 Server and Debian 11.5 on a Dell Inspiron with an Intel i7, FreeBSD 13.1 and Windows 10 Pro on the same machine, macOS 11.5.2 on Apple M1 and Intel Mac minis. Matching the distribution is therefore necessary but not sufficient, and there is no affirmation route that extends the certificate to a container on arbitrary hardware.

That points at the other shape of an answer: a distribution vendor's own certificate, where the tested environments are that vendor's OS on machines closer to how a container is actually deployed. Red Hat's covers RHEL 9 on Dell PowerEdge and IBM POWER10; AlmaLinux's covers 9.2 on AWS `a1.metal` and `m5.metal` instances. Which of the vendor certificates are FIPS 140-3 rather than 140-2 is not established here and has to be read per certificate.

That route was taken, and it moves the environment question rather than closing it. Certificate 5021's six tested environments are Amazon Linux 2023 on three bare-metal platforms, none of them a container or a virtual machine, and its policy states no vendor affirmation in either direction -- so 4985's flat denial above is not a sentence to quote against it, and the container is outside the tested set on that certificate as much as on this one ([CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md#what-certificate-5021-attests)). What that supports a claim of is reasoned about in [fips-variant-image.md](fips-variant-image.md).

### Two of the forty approve EdDSA, and none approves X25519

Reading all 40 policies for algorithm placement -- not only the three above -- gives an answer the OpenSSL Project's certificates alone would get wrong. **Two certificates have EdDSA in their approved-algorithm tables**, both FIPS 140-3:

- **5116** (Ctrl IQ, Rocky Linux 9, module version `Rocky9.20250210`) -- `EDDSA KeyGen`, `SigGen` and `SigVer` against CAVP certificate A6328, FIPS 186-5, with Ed25519 and Ed448 named in the SSP tables and an EdDSA SigGen known-answer test at power-on.
- **5373** (TuxCare, module `3.2.2-f9f9d133a30b6eb5`) -- the same three services against CAVP certificate A7098, PreHash and Pure both approved.

Three further certificates match on the string and are not counterexamples: 4282 and 4811 have it only in a revision-history line recording EdDSA's move *to* the non-approved mode, and 4506 lists it under non-approved services. **X25519 has no such exception.** Across all 40 it sits in an Allowed table under 140-2 or a Not Allowed one under 140-3, never an approved one, and the two certificates that approve EdDSA do not mention it at all.

Table membership is read from the caption that *follows* each table body, which is where these policies place it. Attributing a row to the caption above it names the previous table and inverts the answer -- it reports X25519 as approved on the 140-2 certificates, which it is not.

Neither EdDSA exception is reachable for a redistributed image, and the reason is obtainability rather than approval. 5116's certified package sits behind an authenticated portal, and its module version string is a date shared by three distinct public binaries with no digest published in the policy, so no public material binds a specific binary to that certificate. 5373's public build reports `3.2.2-d3feeb3848008cbe` against a certified `3.2.2-f9f9d133a30b6eb5` -- a near miss, and therefore a negative result. Both were tested on x86_64, and neither names an arm64 environment, which the published image needs.

## What is settled

What remains open is recorded in [fips-variant-image.md](fips-variant-image.md),
"What is not settled".

Settled by measurement, in the image, on the base that ships:

- X25519 is in the key-exchange algorithms of the OpenSSL Project builds of 3.0.8, 3.0.9 and 3.0.21, and is not in 3.5.7's.
- Ed25519 is in every measured provider's signature algorithms. Every one of them is a from-source OpenSSL Project build; the vendor module the variant image includes has neither primitive.
- `crypto.subtle` AES-256-GCM, and `node:crypto`, both dispatch into a configured FIPS provider in this image, by the four-leg attribution above.
- A 3.0.x provider cross-loads into the 3.5.7 libcrypto Node links, and serves.
- A module that fails its integrity check stops the process from starting.

Settled by reading the certificates:

- Neither X25519 nor Ed25519 is an approved algorithm on any OpenSSL Project certificate. X25519 is allowed inside approved mode under 140-2 only; Ed25519 is not allowed under either standard.
- Across all 40 active certificates, EdDSA is approved on exactly two -- 5116 and 5373 -- and X25519 on none. Neither EdDSA exception yields a verifiable certified module for a freely redistributable image.
- No active certificate for this module covers a musl or Alpine operational environment, and the environment binds to tested hardware and OS regardless.

Decided since, by the owner, and recorded here because it changes how the rows above should be read:

- **FIPS 140-3 is the target standard**, on the grounds that 140-2 is being retired. That forecloses X25519 inside the module twice over: under 4985 it is Non-Approved and Not Allowed, and the certificate the variant image pairs with, 5021, neither names it nor certifies a module that has it. Its "allowed" status under 140-2 is not something to build on.
- **The Alpine base is expected to give way**, dropping musl, since no certificate reaches it.

Which certificate pairs with which base, and which standard revision that
certificate states, are answered in
[fips-variant-image.md](fips-variant-image.md), the normative home for the
shipped variant.

## What this means for the items downstream

- The FIPS deployment profile for SFTP rests on the surviving SSH algorithm set being a function of the provider build, which is measured here rather than assumed. The profile itself is [FIPS_SFTP_PROFILE.md](../FIPS_SFTP_PROFILE.md).

## Reproducing this

`.github/workflows/fips_provider_probe.yaml` builds `support/fips-probe/` on the `Dockerfile` runtime base and runs both scripts against a provider build named by an OpenSSL release tag; `support/fips-probe/README.md` gives the local `docker` invocation, which is how 3.0.8 and 3.0.9 were measured. Both scripts print every command, its raw output, and its exit status, and derive their verdicts from those same captured bytes, so a transcript holds the evidence as well as the conclusion. The 3.0.21 and 3.5.7 measurements came from workflow run 31046265222.

The certificate findings come from the CMVP validated-modules search and the security policies it links, read from a network-capable host because the dev container cannot reach CMVP. Each certificate's security policy is the authority for its tables; the rendered certificate pages omit those sections for most certificates, and an extraction that finds nothing there is an unread page rather than a negative result.
