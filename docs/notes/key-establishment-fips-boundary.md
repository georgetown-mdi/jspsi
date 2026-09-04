---
title: "Key Establishment and the FIPS 140-3 Boundary"
---

# Key establishment and the FIPS 140-3 boundary: migrate the curve, keep the schedule

*Status: decided and implemented. This note records the choice to move the key
exchange's shared-secret computation to P-256 ECDH through `crypto.subtle` while
retaining the Noise NNpsk0 key schedule and the explicit key-confirmation round,
the alternative weighed against it and rejected, and what a scoped FIPS claim may
and may not say about key establishment as a result. It extends the
key-agreement decision in
[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#key-agreement-design) rather than
replacing it. The normative construction is specified in
[PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange); the
provider measurements and certificate readings underneath the reasoning are in
[fips-provider-surface.md](fips-provider-surface.md). See
[docs/notes/README.md](README.md).*

With FIPS 140-3 as the target standard, no provider choice puts an X25519 key
exchange inside a module's approved mode. Certificate 5021, the module the FIPS
variant image embeds, names X25519 in no table at all, approved or
non-approved, and states its non-approved-but-allowed category empty, so there
is no status the curve could hold there -- and the certified module does not
include the primitive to begin with
([CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md#what-certificate-5021-attests),
[fips-variant-image.md](fips-variant-image.md)). Certificate 4985, the OpenSSL
Project module read beside it, places X25519 in its Non-Approved, Not Allowed
table. That leaves a fork. Disclose the boundary -- cheap and accurate, and
costing nothing in module terms, because an algorithm the module never performs
cannot take the module out of approved mode -- or migrate to a curve a
certificate approves, which is the only thing that buys key establishment a
place *inside* the boundary.

The decision is to migrate. Most of the reasoning below is about how far the
migration should go, because the curve was never the interesting question.

## The decision

- **Migrate the shared-secret computation to P-256 ECDH through
  `crypto.subtle`**, replacing the X25519 Diffie-Hellman and ephemeral key
  generation that ran in `@noble/curves`.
- **Retain the Noise NNpsk0 key schedule and the explicit, role-asymmetric
  key-confirmation round** exactly as specified today. The mixing order, the
  domain-separation labels, the transcript binding, and the two confirmation
  tags are unchanged.
- **Collapse the Noise chaining HKDF into a single `crypto.subtle` HKDF
  `deriveBits` call**, so the extract-then-expand step is one operation the
  platform -- and any module beneath it -- serves as a unit, rather than a chain
  of HMAC calls assembled in JavaScript.

**Rejected: restructuring the schedule into a NIST-shaped derivation.** The
alternative was to additionally recast the handshake as an SP 800-56A Rev 3
shared-secret computation followed by an SP 800-56C Rev 2 two-step
extract-then-expand derivation, using the pre-shared secret as the auxiliary
shared secret `T` of a hybrid shared secret `Z || T`, with the handshake
transcript as FixedInfo. Its appeal was narrative: the derivation would read as
a named NIST key-derivation method rather than as a Noise schedule.

This record is the decision and the reasoning behind it; the construction it
produced is specified in
[PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange).

## What this extends, and what it supersedes

The key-agreement decision record is
[SECURITY_DESIGN.md, Key-agreement design](../SECURITY_DESIGN.md#key-agreement-design),
which recorded adopting an ephemeral key exchange keyed with the pre-shared
secret and retiring the customized SPAKE2. Everything critical in it
survives:

- The reason for retiring SPAKE2. The shared secret is a 256-bit token, not a
  human password, so a PAKE's one distinctive property is unused, while forward
  secrecy and mutual authentication are preserved by an ephemeral exchange plus
  a secret-keyed confirmation.
- The construction: Noise NNpsk0 with an added explicit, role-asymmetric key
  confirmation, with the full Noise framework not implemented, by design.
- The library-selection rule -- a well-respected, ideally audited, dual-platform
  primitive with only minimal hand-written glue. Moving the Diffie-Hellman to
  `crypto.subtle` satisfies that rule more strongly than a third-party library
  does, and removes a dependency from the key-establishment path rather than
  adding one.
- The pre-shared secret as the baseline authentication anchor, and the version
  discriminant that keeps an authority-backed mode open.
- The limit: a leaked secret permits active impersonation until it is rotated
  out, and forward secrecy buys only that a recorded transcript stays
  confidential if the secret later leaks.

Two things in that record are superseded:

- **The curve and the provenance of the Diffie-Hellman.** X25519 in
  `@noble/curves` becomes P-256 in `crypto.subtle`.
- **The compliance reading of the switch.** That record's closing sentence
  treats Ed25519's and the curves' standard approval (FIPS 186-5, SP 800-186) as
  material for a FIPS-validated build. The standard approval is real; the
  implication that it buys anything on a module certificate is not. Neither
  X25519 nor Ed25519 appears on the approved-algorithm list of any OpenSSL
  Project certificate -- under certificate 4985 both are Non-Approved and Not
  Allowed -- and neither string occurs anywhere in the security policy of
  certificate 5021, the module the variant image embeds.

Nothing here is normative. The wire format, the mixing order, the labels, and
the protocol-version tag are specified in
[PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange), which is
the authority for every value this note describes in prose.

## Why the schedule stays

In the order the reasons matter.

**1. WebCrypto exposes no SP 800-56C two-step KDA service.** `crypto.subtle`
offers ECDH, HKDF (RFC 5869), HMAC, SHA-2, and AES-GCM. There is no API by
which psilink could invoke a module's `KDA TwoStep` service, so the rejected
option's two-step derivation would be hand-composed in JavaScript from HMAC
calls regardless -- while naming a module service that never runs. This is the
decisive point: the rejected option's central advantage does not survive
contact with the platform's call surface.

**2. The certified `KDA TwoStep` service is feedback mode only.** Its
properties on certificate 4985 read `KDF Mode - feedback`, while RFC 5869 HKDF
-- and WebCrypto, and every derivation in this tree -- is counter mode. Building
a two-step derivation faithful to the certified service therefore means
authoring a novel feedback-mode KDF with no anchor anywhere in the repository.
That is strictly more hand-rolled crypto than the status quo, not less.

On certificate 5021 -- the module the variant image actually embeds -- that
mode tag reaches one row further, and the tension is recorded rather than
resolved. Its own Table 8, which on that certificate is the Security Function
Implementations table (p. 20), gives the *HKDF* security function
`Mode: Feedback`, where 4985's corresponding row has no mode qualifier at
all. Three things cut against reading it as a property of the HKDF the module
performs: 5021's Table 5 row for `KDA HKDF Sp800-56Cr1` has no `KDF Mode`
property; the construction that row names is RFC 5869's extract-and-expand,
which is fixed rather than mode-parameterised (SP 800-56C Rev. 2 never uses the
name HKDF -- it cites RFC 5869 among its references, and the mode selection
sits in the two-step method's SP 800-108 expansion step, which is what
`KDA TwoStep` covers); and the cell sits beside KBKDF and `KDA TwoStep` rows
that are genuinely feedback-mode. None of those three is a reading of what the
module does, which is the only thing that would determine it -- by driving the
module, as with the open questions below. The reasoning above does not move
either way on it, turning as it does on `KDA TwoStep` and on the platform's call
surface. What the discrepancy does bound is claim text: a sentence naming 5021's
HKDF row should not also assert counter mode until the module has been driven.

**3. A certificate attests components, not compositions.** Both certificates are
silent on hybrid or concatenated shared secrets, and both were read for that
silence. "concatenat" and "pre-shared" occur nowhere in either security policy,
and every occurrence of "hybrid" is the FIPS 140-3 module-type sense (software,
firmware, hybrid). On certificate 5021 the search additionally covered
"composite", "combin", "augment", `Z'` and every occurrence of "shared secret",
and no statement anywhere composes the shared secret with other secret material;
the three sections that come nearest -- 2.7.4 (SP 800-56Ar3 assurances), 2.10
(Key Establishment) and 2.11 (Industry Protocols) -- describe public-key
validation and per-protocol use contexts and nothing else. The conclusion does
not turn on that silence either way: what 5021 does state about the schedule's
surroundings restricts rather than attests -- its HKDF "shall only be used to
generate secret keys in the context of an SP 800-56Ar3 key agreement scheme",
which reaches the head of the chain and leaves the rest of the composition
exactly as unattested
([fips-variant-image.md](fips-variant-image.md)). So the schedule assembled
above the shared secret is an operator-built composition under either option.
The rejected option would have exchanged one unattested composition for
another while presenting it under a NIST label -- the same conflation of
algorithm-standard approval with module-certificate approval that
[fips-provider-surface.md](fips-provider-surface.md) already catches in the
SC-13 row.

**4. Collapsing the chaining HKDF captures most of the rejected option's appeal
at near-zero risk.** The Noise chaining HKDF is already exactly RFC 5869
HKDF-Extract with the chaining key as salt followed by Expand with an empty
info string -- the spec says so, and the test suite already anchors it against
RFC 5869 test case 3. One `deriveBits` call reproduces it bit for bit, checkable
against the existing known-answer vectors, and it lands the extract-then-expand
on an approved HKDF key-derivation row instead of on a chain of individually
approved HMAC calls -- `KDA HKDF Sp800-56Cr1` (CAVP certificate A4603) on
certificate 5021, the module the variant image embeds, and
`KDA HKDF SP800-56Cr2` on 4985.

**5. The web application runs the same code and has no FIPS provider at all.**
Its key exchange runs in the browser, outside any module boundary, whatever the
curve. The construction therefore has to be expressible in plain WebCrypto on
both platforms. P-256 ECDH is; a module-specific KDA service is not.

**6. The scope of impact argues for containment.** The session key keys the
application AEAD, the rotated shared secret persisted to the key file, the
signed-receipt binder, and the per-direction receipt MACs. Retaining the
schedule touches the Diffie-Hellman call sites and the protocol-version tag;
the rejected option rewrites the schedule, redefines transcript binding, and
abandons a pattern with published analysis for a bespoke equivalent with none.

## What a scoped FIPS claim may and may not say about key establishment

**May say**, where a validated module is actually present in the environment:
every cryptographic operation in key establishment is performed by the module,
using algorithms on the approved list of certificate 5021, the module the FIPS
variant image embeds -- the shared-secret computation as
`KAS-ECC-SSC Sp800-56Ar3` over P-256, and the extract-then-expand as
`KDA HKDF Sp800-56Cr1` (CAVP certificate A4603). The rows and their tested
parameter ranges are in
[CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md#what-certificate-5021-attests).

**May not say:**

- That either operation meets the conditions certificate 5021 states outside
  its approved-algorithm table. That certificate conditions the SP 800-56Ar3
  section 5.6.2 assurances on using the module "together with an application
  that implements the TLS protocol", which this handshake is not, and scopes the
  module's HKDF to "the context of an SP 800-56Ar3 key agreement scheme", which
  reaches the head of the chain and says nothing about the rest of the schedule.
  The security functions themselves have neither condition, which is why the
  may-say sentence names them and stops. Both are quoted whole in
  [fips-variant-image.md](fips-variant-image.md).
- That key establishment used a FIPS-approved algorithm while it ran on X25519.
  It did not, on any certificate; that is what the migration was for.
- That the key exchange, the key schedule, or the protocol is validated or
  approved as a scheme.
- That the certificate attests the composition. The schedule above the shared
  secret is an application composition of approved operations, and that
  distinction must not be collapsed.
- That the key-confirmation round conforms to SP 800-56A Rev 3. Its
  construction is modelled on that document's bilateral key confirmation, but
  section 5.9.2 offers the feature for "any key-agreement scheme in which each
  party is required to own a static key-establishment key pair", and this
  handshake has no static keys -- its authentication anchor is the pre-shared
  secret. Read directly from the publication; the citation this project used
  before pointed additionally at section 6.2.1.5, which is key confirmation for
  a C(1e, 2s) scheme and further still from this handshake's shape.

**The composition disclosure is required on either path**, and it outlives the
migration: a protocol composed in JavaScript above primitive calls yields
validated primitives, never a validated protocol. CMVP validates modules, not
protocols; there is no certificate under which psilink's handshake is the
validated artifact. Migrating the curve is what lets each operation sit inside a
boundary; it does not put the composition inside one, and no wording makes it do
so.

**No sentence may call the shipped image validated, or place it in a validated
module's operational environment.** No certificate covers the default image's
base, and the variant image, which embeds certificate 5021's module, runs in
none of the six environments that certificate names: every one is bare metal,
none is a container or a virtual machine, and the policy states no vendor
affirmation reaching past them
([CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md#what-certificate-5021-attests)).
The flat denial 4985's policy states is that document's sentence and not
5021's, so it is not available to quote here. What the variant image may say
instead, and how that turns on the host it runs on, is reasoned about in
[fips-variant-image.md](fips-variant-image.md); the environment question is
independent of everything decided here.

## What the primary sources actually say

Read from the documents themselves: NIST SP 800-56C Rev 2, the OpenSSL FIPS
Provider FIPS 140-3 non-proprietary security policy for certificate 4985, and
the Amazon Linux 2023 OpenSSL FIPS Provider policy for certificate 5021, the
module the variant image embeds. Two modules, so every row below names the
certificate it was read from; 5021's rows are recorded in full in
[CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md#what-certificate-5021-attests).

**SP 800-56C Rev 2, Section 2 (Scope and Purpose, normative)** permits a hybrid
shared secret of the form `Z || T`, described as "a concatenation consisting of
a standard shared secret Z that was generated during the execution of a
key-establishment scheme (as currently specified in [SP 800-56A] or [SP
800-56B]) followed by an auxiliary shared secret T that has been generated using
some other method." The only stated condition on `T` is that "the content,
format, length, and method used to generate T must be known and agreed upon by
all parties that will rely upon the derived keying material". No restriction on
how `T` is generated, and no minimum length or entropy. The revision history in
Appendix A.3 (informative) confirms the permission reaches the two-step method:
extraction of a key-derivation key from a shared secret of the form `Z || T` is
"a bona fide extension of the previously specified technique".

**Certificate 4985, Table 5 (Approved Algorithms)** lists `KAS-ECC-SSC
Sp800-56Ar3` with P-256 among its domain parameters, `Scheme -
ephemeralUnified`, `KAS Role - initiator, responder`; and, on the derivation
side, `KDA HKDF SP800-56Cr2`, `KDA OneStep SP800-56Cr2`, and `KDA TwoStep
SP800-56Cr2` (`KDF Mode - feedback`, `Shared Secret Length: 224-8192 Increment
8`).

**Certificate 5021 differs on the derivation row, which is why the citations
above name Cr1.** The module the variant image embeds names its row
`KDA HKDF Sp800-56Cr1` at CAVP certificate `A4603`, with `Shared Secret Length:
224-2048 Increment 8` -- a narrower window than 4985's 224-8192, and one this
handshake's 256-bit shared secret and 256-bit derived output sit well inside.
Section 2.10 of that policy (p. 24) states the split in prose: HKDF is
"compliant with SP 800-56Cr1", while `KDA OneStep` and `KDA TwoStep` are Cr2.
Its `KAS-ECC-SSC Sp800-56Ar3` row is the same shape as 4985's. The full rows are
in
[CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md#what-certificate-5021-attests).

**Certificate 4985's Table 8 (Non-Approved, Not Allowed Algorithms)** contains
X25519 and X448 as its only key-agreement entries -- the counterpart table on
5021 is its Table 7, which names neither string -- corroborating what
[fips-provider-surface.md](fips-provider-surface.md) already records. `KDA HKDF`
and `KDA OneStep` are dual-listed there, non-approved only for key lengths below
112 bits and for SHAKE PRFs respectively; `KDA TwoStep` appears in no
non-approved table.

So the rejected option was *permitted* by the documents. It was rejected because
the platform cannot reach the service, the certified mode does not match, and
the certificate attests no composition -- not because the standard forbids it.
Any later account of this decision that says "we could not have done it" is
false.

## The risk this decision accepts

Every panelist across both panels raised the same one, and it is the actual cost
of the choice: if an assessor requires the derivation to read as SP 800-56C *by
construction*, or requires the validated KDA service to be invoked by name with
its tested parameter set, the retained schedule does not deliver that narrative.
Meeting such an assessor means writing the 56A/56C mapping out in prose after
the fact rather than pointing at a service invocation. That cost was accepted
against the reasons above, of which the first is the one that would have to
change for the balance to shift.

## Open questions

Two questions the documents could not decide. Both are recorded as open rather
than glossed, because a confident answer to either would be a guess:

- **Whether the module accepts a caller-supplied byte string as the
  shared-secret input to its approved `KDA TwoStep` service.** The approved
  services table shows the key-derivation service with write access to the
  key-agreement shared secret, which implies import; the SSP table shows that
  same shared secret with an empty input cell and its related SSPs marked
  "Established using" the module's own key agreement, which implies it is only
  ever established internally. A positive answer is the one finding that would
  reopen the rejected option, and it is determined by driving the real module
  (`support/fips-probe/` and its four-leg attribution), never by reading more
  policy text.
- **How CMVP treats an operator-built composition of separately-approved
  components** under the FIPS 140-3 implementation guidance. The security policy
  does not address it, and the claim language above is written to be true
  whichever way it falls.

## How this was decided

The direction was decided by two independent expert panels, three panelists
each, one wave per panel, neutral framing, on a clean checkout. The first ran
with the SP 800-56C and certificate assumptions unverified and returned 3-0
for the retained schedule -- with every panelist conditioning that answer on
the assumptions being unread. The primary documents were then read directly
and the reading was re-verified by an independent agent working from the
same PDFs. The second panel ran with the verified findings supplied and
returned 3-0 for the same answer, on stronger grounds. Every quotation and
table row in *What the primary sources actually say* was produced by two
independent extractions from the source documents, and re-checked a third
time when this record was written.

The `deriveBits` collapse came out of the panels rather than the original
framing, and is part of the decision rather than an aside: it is where most of
the rejected option's value turned out to be reachable.

## See also

- [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#key-agreement-design) -- the
  key-agreement decision this record extends.
- [PROTOCOL.md](../spec/PROTOCOL.md#p-256-authenticated-key-exchange) -- the
  normative construction: wire format, mixing order, labels, and the
  protocol-version tag.
- [fips-provider-surface.md](fips-provider-surface.md) -- what a FIPS provider
  holds and reaches in the shipped image, and what the certificates approve.
- [COMPLIANCE.md](../COMPLIANCE.md#fips-140) -- the FIPS claims an agency
  reviewer reads.
