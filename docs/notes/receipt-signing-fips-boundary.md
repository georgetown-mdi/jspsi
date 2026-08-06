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

With FIPS 140-3 as the target standard, certificate 4985 carries ECDSA on its
approved-algorithm list and places Ed25519 in Table 8, Non-Approved and Not
Allowed. Receipt signing runs Ed25519 in `@noble/curves`, outside any module. The
fork is the one key establishment faced -- disclose the boundary, or migrate to
an algorithm the certificate approves -- plus one apparent third option that has
to be cleared away first, because the provider measurements found Ed25519 present
in every build tried.

## The decision

- **Migrate both signing operations to ECDSA over P-256 through
  `crypto.subtle`**: the certificate self-signature and the receipt signature
  alike, replacing the Ed25519 signing, verification, and key generation that run
  in `@noble/curves` today.
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

This record is the decision. The migration is separate work, and until it lands
receipt signing runs Ed25519 in `@noble/curves`, outside any module boundary.

## Why migrate rather than disclose

In the order the reasons matter.

**1. Receipt signing is not a data-protection control, which is exactly why its
non-approved status is undiluted.** The signed-receipt step runs at the
conclusion of a successful exchange, after the payload exchange -- it is evidence
collection over a completed exchange, not a gate
([PROTOCOL.md](../spec/PROTOCOL.md#the-signed-receipt-step)). The data has
already moved before any signature exists. The receipt carries no payload
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
the inversion is worth naming because the correction is easy to over-read in the
other direction.

**Presence is not permission.** The measurement establishes that the provider can
perform the algorithm. It says nothing about whether performing it is approved,
and under certificate 4985 it is not -- Ed25519 sits in the Non-Approved and Not
Allowed table, so driving the module to perform it takes the module out of
approved mode for that operation. Routing signing into the provider therefore
converts a clean "this operation happens outside the module" into "this module
was driven out of approved mode", against the approved-mode posture the container
work is trying to establish for the AEAD. Leaving the operation outside the
module entirely is strictly better than routing it in, and that holds under the
disclosure option as much as under the migration.

The same reasoning forecloses an obvious-looking shortcut. Node's WebCrypto in
this runtime does carry Ed25519 -- measured deterministic, 64-byte signatures,
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
64-byte raw `r || s` (IEEE P1363), never a DER structure -- the first signature
byte is not `0x30`. The encoding latitude that makes ECDSA signatures a
canonicalization hazard elsewhere does not arise through this call surface. The
signature is also the same 64 bytes as Ed25519, so the receipt format's
base64url field bound is unaffected and the signature field does not change
size. The certificate body does grow: a P-256 public key carries both `x` and
`y` where the Ed25519 OKP JWK carries `x` alone.

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
`importKey` round-trips exactly, which is what a vector must carry instead. From
such a fixed key the certificate fingerprint, the binder, and the canonical
signed bytes all still reproduce byte for byte; the pinned signature field does
not, and becomes a verify-only vector. Re-shaping those fixtures is the largest
single piece of the migration work, and it is driven by the platform's key
generation as much as by the algorithm's randomness.

**Non-malleability is surrendered, with a measured blast radius.** A third party
holding a receipt can transform `s` into `-s mod n` and produce a different
64-byte signature that still verifies: measured against WebCrypto's own verify,
which accepts the transformed signature. The blast radius is narrow because
nothing in this project treats a signature as an identifier -- the receipt
signature is never hashed, committed to, deduped, or used as a key anywhere in
the tree, and the exchange record's commitments do not cover it. The one claim it
backs is [EXCHANGE_RECORD.md](../spec/EXCHANGE_RECORD.md#dual-signed-record-file)'s
statement that both parties write a byte-identical artifact, which such a third
party could break in a copy without invalidating anything the artifact attests.

## What a scoped FIPS claim may and may not say about receipt signing

**May say**, once the migration has landed *and* a validated module is actually
present in the environment: the signature and verification operations of receipt
signing are performed by the module, using ECDSA, which is on certificate 4985's
approved-algorithm list. A claim that additionally names the curve and hash is
written by reading the certificate's approved-algorithm table for its tested
parameter set at the time the claim is made, not by inferring them from the
algorithm name.

**May not say:**

- That receipt signing uses a FIPS-approved algorithm while it runs on Ed25519.
  It does not, on any certificate, and under certificate 4985 Ed25519 is
  Non-Approved and Not Allowed. This is a present-tense claim about shipped code,
  and it stays false until the migration lands.
- That the receipt, the certificate format, or the signed-receipt protocol is
  validated or approved. A certificate attests algorithms; the canonical
  encoding, the domain separation, the per-signer binding, and the
  pin-before-signature check are an application composition above them that no
  certificate covers.
- That signing is module-backed wherever the code runs. The browser build of
  `@psilink/core` carries the same signing path, and there is no module beneath
  it at all, whatever the algorithm.
- That the shipped image runs a validated module. No certificate covers the base
  image today, and certificate 4985 vendor-affirms no operational environments.
  That question is tracked in
  [fips-provider-surface.md](fips-provider-surface.md) and is independent of
  everything decided here.
- That the receipt is non-repudiable in a stronger sense because the algorithm
  changed. What a receipt proves is bounded by its trust model, not its
  primitive, and that boundary is stated in
  [PROTOCOL.md](../spec/PROTOCOL.md#signing-identity-and-certificate-pinning).

## Open question

One question this decision deliberately leaves to the migration, because
answering it here would be settling a design choice with runtime consequence
without the code in front of anyone:

- **Whether the implementation should reject a non-canonical (high-`s`)
  signature.** Measured: WebCrypto verifies both `s` and `-s mod n`, and its sign
  operation gives the caller no control over which it emits, so enforcing a
  canonical `s` means a check in application code above `crypto.subtle` -- one
  more composition of the kind this note's claim language is careful about, added
  to restore a property the algorithm does not have. The alternative is to narrow
  [EXCHANGE_RECORD.md](../spec/EXCHANGE_RECORD.md#dual-signed-record-file)'s
  byte-identical-artifact statement to what remains true. Nothing in the tree
  depends on the answer today, which is why it can wait for the migration rather
  than gating this decision.

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
  carries and reaches in the shipped image, and what the certificates approve.
- [key-establishment-fips-boundary.md](key-establishment-fips-boundary.md) -- the
  sibling decision, whose composition-disclosure reasoning applies here unchanged.
- [COMPLIANCE.md](../COMPLIANCE.md#fips-140) -- the FIPS claims an agency
  reviewer reads.
