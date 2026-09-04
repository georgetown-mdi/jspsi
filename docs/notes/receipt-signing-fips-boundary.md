---
title: "Receipt Signing and the FIPS 140-3 Boundary"
---

# Receipt signing and the FIPS 140-3 boundary: migrate the algorithm, keep the trust model

*Status: decided. This note records the choice to move both receipt-signing
operations -- the certificate self-signature and the receipt signature -- from
Ed25519 to ECDSA over P-256 through `crypto.subtle`, the two alternatives
weighed against it and rejected, what the migration surrenders and what it does
not, and what a scoped FIPS claim may and may not say about receipt signing as a
result. It extends the signing-identity decision in
[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#receipt-signing-identities) rather
than replacing it: the pinned self-signed trust model is untouched. The
normative constructions are specified in
[PROTOCOL.md](../spec/PROTOCOL.md#signing-identity-and-certificate-pinning) and
[EXCHANGE_RECORD.md](../spec/EXCHANGE_RECORD.md#signed-receipt); the provider
measurements and certificate readings underneath the reasoning are in
[fips-provider-surface.md](fips-provider-surface.md). See
[docs/notes/README.md](README.md).*

With FIPS 140-3 as the target standard, Ed25519 sits outside the boundary on
both certificates in play here. Certificate 4985 places it in Table 8,
Non-Approved and Not Allowed, and includes ECDSA on its approved-algorithm list.
Certificate 5021, the module the FIPS variant image embeds, names Ed25519 in no
table at all and states its non-approved-but-allowed category empty, so there is
no status the algorithm could hold there -- and the certified module does not
include the primitive to begin with
([CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md#what-certificate-5021-attests),
[fips-variant-image.md](fips-variant-image.md)). ECDSA is on that certificate's
approved-algorithm table as well, over P-256 and with SHA2-256 among its hashes,
so both certificates in play approve the algorithm this note migrates to.
Receipt signing ran Ed25519 in `@noble/curves`, outside any module. The
fork is the one key establishment faced -- disclose the boundary, or migrate to
an algorithm a certificate approves -- plus one apparent third option that has
to be cleared away first, because the provider measurements found Ed25519
present in every OpenSSL Project build tried.

## The decision

- **Migrate both signing operations to ECDSA over P-256 through
  `crypto.subtle`**: the certificate self-signature and the receipt signature
  alike, replacing the Ed25519 signing, verification, and key generation that ran
  in `@noble/curves`.
- **Everything above the signature stays.** The canonical encoding, the domain
  separation that keeps a signature and a fingerprint from being confused, the
  per-signer fingerprint-and-role binding, the pinned self-signed trust model,
  and the pin-before-signature check are not in question; the algorithm and where
  it runs are the whole of the change.

**Rejected: keeping the pure-JS implementation and disclosing it.** Its
attraction is real and should not be understated -- it costs *nothing* in module
terms. An algorithm the module never performs cannot take the module out of
approved mode, so the disclosure path leaves the container work's approved-mode
posture exactly where it finds it, at zero engineering cost and zero risk to a
format that already reproduces across two implementations. It was rejected on the
second and third grounds below: the exposure is undefended, and the exception
would be elective.

**Rejected: routing Ed25519 through a validated provider.** This is worse than
either other option, and is eliminated before the real fork is reached. See below
for why the measurement that makes it look available is not a green light.

The migration is implemented. The normative constructions -- the certificate
body, the EC JWK public key, the pinned signature encoding, and the load-time
rejections -- are specified in
[PROTOCOL.md](../spec/PROTOCOL.md#signing-identity-and-certificate-pinning) and
[EXCHANGE_RECORD.md](../spec/EXCHANGE_RECORD.md#signed-receipt); this record
keeps the reasoning and the two design choices the migration was left to decide
(below).

## Why migrate rather than disclose

In the order the reasons matter.

**1. Receipt signing is not a data-protection control, which is exactly why its
non-approved status is undiluted.** The signed-receipt step runs at the
conclusion of a successful exchange, after the payload exchange -- it is evidence
collection over a completed exchange, not a gate
([PROTOCOL.md](../spec/PROTOCOL.md#the-signed-receipt-step)). The data has
already moved before any signature exists. The receipt contains no payload
contents and no key material, and the exchange's authentication anchor is the
pre-shared secret in the handshake, not the signing identity. A reviewer asking
what happens to their data learns nothing from this algorithm choice. That is the
point rather than a reassurance: where key establishment can set a
confidentiality argument against a non-approved algorithm, receipt signing has no
such counterweight to offer.

**2. Its entire compliance surface is the SC-13 algorithm inventory.** Receipt
signing appears in exactly one row of the control mapping in
[COMPLIANCE.md](../COMPLIANCE.md#nist-sp-800-53), the SC-13
cryptographic-protection row; there is no non-repudiation or AU-10 row anywhere
in that document for it to be defended by. Fully visible in the inventory,
defended by nothing -- so an assessor's first pass over the algorithm list is
also the last word on it.

**3. An elective exception reads differently from a forced one.** Contrast the
PSI masking, which runs in BoringSSL inside the vendored `@openmined/psi.js`
WebAssembly module and which [fips-provider-surface.md](fips-provider-surface.md)
records as unreachable by an OpenSSL provider *in principle*. That disclosure
survives an assessor because no alternative exists to have taken. "An approved
alternative is on the certificate we target and we did not take it" is a
different sentence, and it does not.

**4. Pre-release timing.** Nothing is released, no partner has pinned a
production fingerprint, and the signed-receipt content domain is already at its
second version from an earlier pre-release shape change (the label itself is in
[EXCHANGE_RECORD.md](../spec/EXCHANGE_RECORD.md#receipt-signature)). This is a
version bump rather than a migration, and it will not be this cheap again.

## Why provider-backed Ed25519 is worse than neutral

Ed25519 is present in every FIPS provider build measured -- 3.0.8, 3.0.9, 3.0.21
and 3.5.7 alike ([fips-provider-surface.md](fips-provider-surface.md), Question
2). That measurement inverted an unverified assumption that it was absent, and
the correction is easy to over-read in the other direction.

**Presence is not permission.** The measurement establishes that the builds it
was taken on can perform the algorithm. It says nothing about whether performing
it is approved, and under certificate 4985 it is not -- Ed25519 sits in the
Non-Approved and Not Allowed table, so driving the module to perform it takes the
module out of approved mode for that operation. Routing signing into the provider
therefore converts a clean "this operation happens outside the module" into "this
module was driven out of approved mode", against the approved-mode posture the
container work is trying to establish for the AEAD. Leaving the operation outside
the module entirely is strictly better than routing it in, and that holds under
the disclosure option as much as under the migration.

Under certificate 5021 the option is not there to take at all. The certified
Amazon Linux module has no Ed25519 -- `openssl list` reports it absent while
the provider is active, measured in the variant image
([fips-variant-image.md](fips-variant-image.md)) -- so presence is a property of
the OpenSSL Project builds measured here rather than of the module the image
ships.

The same reasoning forecloses an obvious-looking shortcut. Node's WebCrypto in
this runtime does include Ed25519 -- measured deterministic, 64-byte signatures,
and the same RFC 8037 OKP JWK shape the certificate already stores -- so swapping
`@noble/curves` for `crypto.subtle` without changing the scheme is nearly free in
code terms and surrenders none of the properties the next section weighs. It is
rejected anyway, and for this reason alone: it points the operation at whatever
module `crypto.subtle` dispatches to, which on a configured host is the provider
-- measured engaged for AES-GCM, by four-leg attribution rather than a successful
call ([fips-provider-surface.md](fips-provider-surface.md), Question 3). The
shortcut's whole apparent benefit, reaching platform crypto, is what makes it the
harmful move.

## What the migration surrenders, and what it does not

[PROTOCOL.md](../spec/PROTOCOL.md#signing-identity-and-certificate-pinning)
credits Ed25519 with three properties. Each was measured against WebCrypto ECDSA
on the runtime this project targets rather than reasoned from documentation.

**Single canonical encoding is not surrendered.** WebCrypto ECDSA emits a fixed
64-byte raw `r || s` -- the fixed-width concatenation of IEEE Std 1363-2000's
informative Annex E.3.1, specified in
[PROTOCOL.md](../spec/PROTOCOL.md#signing-identity-and-certificate-pinning) --
never a DER structure, the first signature byte not being `0x30`. The encoding
latitude that makes ECDSA signatures a canonicalization hazard elsewhere does
not arise through this call surface. The
signature is also the same 64 bytes as Ed25519, so the receipt format's
base64url field bound is unaffected and the signature field does not change
size. The certificate body does grow: a P-256 public key has both `x` and `y`
where the Ed25519 OKP JWK has `x` alone.

**Determinism is surrendered, and it is the real cost.** Two signatures over
identical input under the same key differ; WebCrypto exposes no RFC 6979
deterministic mode. What depends on determinism is the known-answer vector
design: the checked-in signed-receipt and signing-certificate vectors pin exact
signature bytes from a fixed seed, and the browser suite reproduces them against
the web build of `@psilink/core` in real Chromium. That reproduction *is* this
project's cross-implementation guarantee for the receipt format.

The seed goes with the signature, and this is a second loss rather than a
restatement of the first: `crypto.subtle.generateKey` takes no seed and two
calls yield different keys, so a vector cannot derive its keypair the way the
current fixtures do. Measured: a fixed private-key JWK imported through
`importKey` round-trips exactly, which is what a vector must hold instead. From
such a fixed key the certificate fingerprint, the binder, and the canonical
signed bytes all still reproduce byte for byte; the pinned signature field does
not, and becomes a verify-only vector. Re-shaping those fixtures was the largest
single piece of the migration, driven by the platform's key generation as much as
by the algorithm's randomness; what replaced reproduce-the-signature is decided
below.

**Non-malleability is surrendered, with a measured scope of impact.** A third
party holding a receipt can transform `s` into `-s mod n` and produce a different
64-byte signature that still verifies: measured against WebCrypto's own verify,
which accepts the transformed signature. The scope of impact is narrow because
nothing in this project treats a signature as an identifier -- the receipt
signature is never hashed, committed to, deduped, or used as a key anywhere in
the tree, and the exchange record's commitments do not cover it. The one claim it
backs is [EXCHANGE_RECORD.md](../spec/EXCHANGE_RECORD.md#dual-signed-record-file)'s
statement that both parties write a byte-identical artifact, which such a third
party could break in a copy without invalidating anything the artifact attests.

## What a scoped FIPS claim may and may not say about receipt signing

**May say**, where a validated module is actually present in the environment:
the signature and verification operations of receipt signing are performed by
the module, using ECDSA over P-256 with SHA2-256. Certificate 5021, the module
the FIPS variant image embeds, includes the algorithm at those parameters on its
approved-algorithm table -- `KeyGen`, `KeyVer`, `SigGen` and `SigVer`, all
FIPS 186-5 -- and includes signature generation and signature verification with
ECDSA on its approved-services table. The rows, the full curve and hash lists,
the service's approved indicator, and the CAVP certificate ids are in
[CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md#the-ecdsa-rows-which-no-probe-leg-covers).
Certificate 4985 approves the algorithm too, so the sentence holds on either
module; a claim naming the curve and hash re-reads the table of the certificate
it names for the tested parameter set at the time the claim is made, rather than
inferring either from the algorithm name.

**Table membership is not the whole answer, and the gap is a service rather than
an algorithm.** Certificate 5021 also includes `RSA and ECDSA (pre-hashed
message)` signature generation and verification among its non-approved
algorithms and services, so a module driven that way is performing a
non-approved service with an approved algorithm. Which of the two services a
`crypto.subtle` ECDSA call requests is decided by the indicator the module sets
rather than by the approved-algorithm table, and nothing in this repository
reads that indicator back. The AEAD's externally supplied IV has that shape on
the same certificate, with the difference that decides it
([fips-variant-image.md](fips-variant-image.md)): WebCrypto supplies an external
IV on every AES-GCM call, so the policy's own text determines which service the
AEAD requests, while a `crypto.subtle` ECDSA call passes the message and the
hash algorithm together and nothing in that shape determines which of the two
signature services the module performs. So the security function is available to
name, and the service the call lands on is not established here.

**May not say:**

- That receipt signing is measured to dispatch into the validated module the
  variant image embeds. It runs through `crypto.subtle`, the same path the
  measured operations take, but no leg of the image's entrypoint probe covers
  ECDSA, and the probe's five legs are what a dispatch claim about that image may
  name ([fips-variant-image.md](fips-variant-image.md)).
- That an EdDSA build of receipt signing would be FIPS-approved. It is not on
  any OpenSSL Project certificate; under certificate 4985 Ed25519 is
  Non-Approved and Not Allowed, and certificate 5021 names it in no table at all
  while the module it certifies does not include the primitive. Two of the forty
  active certificates do approve EdDSA, and neither yields a verifiable certified
  module for a freely redistributable image -- see
  [fips-provider-surface.md](fips-provider-surface.md). This is why the algorithm
  moved rather than the disclosure.
- That the receipt, the certificate format, or the signed-receipt protocol is
  validated or approved. A certificate attests algorithms; the canonical
  encoding, the domain separation, the per-signer binding, and the
  pin-before-signature check are an application composition above them that no
  certificate covers.
- That signing is module-backed wherever the code runs. The browser build of
  `@psilink/core` uses the same signing path, and there is no module beneath
  it at all, whatever the algorithm.
- That the shipped image is validated, or that it runs in a validated module's
  operational environment. No certificate covers the default image's base, and
  the variant image runs in none of the six environments certificate 5021 names:
  every one is bare metal, none is a container or a virtual machine, and the
  policy states no vendor affirmation reaching past them
  ([CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md#what-certificate-5021-attests)).
  The flat denial 4985's policy states belongs to that document and is not
  5021's to quote. What the variant image may say instead is in
  [fips-variant-image.md](fips-variant-image.md), and is independent of
  everything decided here.
- That the receipt is non-repudiable in a stronger sense because the algorithm
  changed. What a receipt proves is bounded by its trust model, not its
  primitive, and that boundary is stated in
  [PROTOCOL.md](../spec/PROTOCOL.md#signing-identity-and-certificate-pinning).

## The two questions the migration decided

### Malleability: narrow the claim rather than enforce a canonical `s`

This decision left open whether the implementation should reject a non-canonical
(high-`s`) signature. It does not.

Re-measured on the target runtime: WebCrypto verifies both `s` and `-s mod n`,
and its sign operation gives the caller no control over which it emits. Enforcing
a canonical `s` therefore means a check in application code above
`crypto.subtle`, added to restore a property the algorithm does not have -- one
more composition of exactly the kind this note's claim language is careful to
disclaim, and one that would sit on the receipt-verification path forever.

What it would buy is nothing the tree uses. The measured scope of impact above
holds: no signature is hashed, committed to, deduped, or used as an identifier
anywhere, and the exchange record's commitments do not cover one. The single
claim resting on non-malleability was
[EXCHANGE_RECORD.md](../spec/EXCHANGE_RECORD.md#dual-signed-record-file)'s
statement that both parties write a byte-identical artifact, and that statement
was narrowed instead: the two parties' files agree because each copies the
signature the partner sent rather than re-deriving it, which is a property of how
the parties assemble the file and not of the format, and two records are compared
by verifying them rather than by hashing them. A holder who negates an `s` gets a
differing copy that still verifies and still attests the same facts.

Should a later feature want to identify a receipt by its bytes -- a dedupe index,
a content-addressed store -- the canonical-`s` check becomes worth its cost, and
that feature is where it belongs.

### Cross-implementation guarantee: pin the message, not the signature

Reproduce-the-signature was the project's cross-implementation guarantee for the
receipt format, and randomized signing ends it. Of the candidates weighed --
verify-only vectors, a live browser round-trip, an externally produced signature,
and the surviving deterministic anchors -- the migration takes all four, layered,
because each covers something the others do not:

1. **The deterministic anchors stay known answers.** The certificate fingerprint
   covers the body and never the signature, and the receipt binder is an HKDF
   output, so both remain byte-pinned in the vectors and reproduced by the Node
   and browser suites. These are what a divergence in the canonical encoder, the
   domain labels, or the key derivation breaks, and that is the largest class of
   cross-implementation failure the format can suffer.
2. **The checked-in signatures become verify-only, and are produced by
   `openssl`.** This is the layer that replaces reproduction, and the reasoning
   is that ECDSA verification is over the *message*: an implementation that
   accepts a fixed signature under a fixed key has necessarily reconstructed the
   same signed bytes. Pinning a signature therefore pins the byte layout just as
   a known-answer signature did, without needing the signature to be
   reproducible. Producing it with `openssl` rather than with the module under
   test is what makes it evidence about something outside this codebase; the
   generator assembles the signed bytes from the spec rather than importing them
   from `signedReceipt.ts`, so a drift between the specification and the
   implementation shows up as a vector that stops verifying.
3. **Both directions are covered without a live cross-process round trip.**
   Signing and verification share one construction of the signed bytes within a
   build, and layer 2 establishes that a build's bytes are the ones the fixed
   signature covers; so a signature that build produces is over those same bytes.
   The Node suite and the browser suite each assert both halves against the same
   checked-in file, which is what makes "the CLI signs, the web app verifies"
   hold in both directions. A live browser-to-Node round trip would need test
   plumbing to send bytes across the process boundary and would prove strictly
   less: it would exercise one signature rather than the layout.
4. **Negative twins accompany every positive.** A flipped signature bit, the
   opposite signer role, and mutated content are each asserted to fail, on both
   platforms. Without these a verifier that returned `true` unconditionally would
   pass every check above.

The cost of the `openssl` leg is that regenerating the vectors needs the CLI on
`PATH`; the generators say so in their headers, and the checked-in vectors are
what the suites read.

## Where the evidence comes from

The certificate readings are [fips-provider-surface.md](fips-provider-surface.md)'s,
taken from the security policies themselves; that note is also where the provider
measurements and their falsification tests live. Every property claimed for
WebCrypto ECDSA above -- the fixed 64-byte `r || s`, the two-field EC public JWK,
the non-determinism, the unseedable key generation, and the acceptance of a
negated `s` -- was driven against the runtime this project targets (Node 26.5.1,
OpenSSL 3.5.7) rather than read out of documentation, and
each is a few lines of `crypto.subtle` to re-run against a candidate runtime
before it is relied on again.

## See also

- [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#receipt-signing-identities) -- the
  signing-identity decision this record extends, and the custody model.
- [PROTOCOL.md](../spec/PROTOCOL.md#signing-identity-and-certificate-pinning) --
  the normative constructions: the certificate document, the self-signature, the
  fingerprint, and the signed-receipt step.
- [EXCHANGE_RECORD.md](../spec/EXCHANGE_RECORD.md#signed-receipt) -- the receipt
  byte layout, the signed bytes, and the dual-signed record file.
- [fips-provider-surface.md](fips-provider-surface.md) -- what a FIPS provider
  has and reaches in the shipped image, and what the certificates approve.
- [key-establishment-fips-boundary.md](key-establishment-fips-boundary.md) -- the
  sibling decision, whose composition-disclosure reasoning applies here unchanged.
- [COMPLIANCE.md](../COMPLIANCE.md#fips-140) -- the FIPS claims an agency
  reviewer reads.
