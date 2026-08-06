---
title: "Key Establishment and the FIPS 140-3 Boundary"
---

# Key establishment and the FIPS 140-3 boundary: migrate the curve, keep the schedule

*Status: decided. This note records the choice to move the key exchange's
shared-secret computation to P-256 ECDH through `crypto.subtle` while retaining
the Noise NNpsk0 key schedule and the explicit key-confirmation round, the
alternative weighed against it and rejected, and what a scoped FIPS claim may
and may not say about key establishment as a result. It extends the
key-agreement decision in
[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#key-agreement-design) rather than
replacing it. The normative construction is specified in
[PROTOCOL.md](../spec/PROTOCOL.md#x25519-authenticated-key-exchange); the
provider measurements and certificate readings underneath the reasoning are in
[fips-provider-surface.md](fips-provider-surface.md). See
[docs/notes/README.md](README.md).*

With FIPS 140-3 as the target standard, certificate 4985 places X25519 in its
Non-Approved, Not Allowed table, so no provider choice puts the current key
exchange inside a module's approved mode. That leaves a fork. Disclose the
boundary -- cheap and honest, and costing nothing in module terms, because an
algorithm the module never performs cannot take the module out of approved mode
-- or migrate to a curve the certificate approves, which is the only thing that
buys key establishment a place *inside* the boundary.

The decision is to migrate. Most of the reasoning below is about how far the
migration should go, because the curve was never the interesting question.

## The decision

- **Migrate the shared-secret computation to P-256 ECDH through
  `crypto.subtle`**, replacing the X25519 Diffie-Hellman and ephemeral key
  generation that run in `@noble/curves` today.
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
extract-then-expand derivation, carrying the pre-shared secret as the auxiliary
shared secret `T` of a hybrid shared secret `Z || T`, with the handshake
transcript as FixedInfo. Its appeal was narrative: the derivation would read as
a named NIST key-derivation method rather than as a Noise schedule.

This record is the decision. The migration is separate work, and until it lands
key establishment runs X25519 in `@noble/curves`, outside any module boundary.

## What this extends, and what it supersedes

The key-agreement decision record is
[SECURITY_DESIGN.md, Key-agreement design](../SECURITY_DESIGN.md#key-agreement-design),
which recorded adopting an ephemeral key exchange keyed with the pre-shared
secret and retiring the customized SPAKE2. Everything load-bearing in it
survives:

- The reason for retiring SPAKE2. The shared secret is a 256-bit token, not a
  human password, so a PAKE's one distinctive property is unused, while forward
  secrecy and mutual authentication are preserved by an ephemeral exchange plus
  a secret-keyed confirmation.
- The construction: Noise NNpsk0 with an added explicit, role-asymmetric key
  confirmation, with the full Noise framework deliberately not implemented.
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
  Project certificate, and under certificate 4985 both are Non-Approved and Not
  Allowed.

Nothing here is normative. The wire format, the mixing order, the labels, and
the protocol-version tag are specified in
[PROTOCOL.md](../spec/PROTOCOL.md#x25519-authenticated-key-exchange), which is
the authority for every value this note describes in prose.

## Why the schedule stays

In the order the reasons matter.

**1. WebCrypto exposes no SP 800-56C two-step KDA service.** `crypto.subtle`
offers ECDH, HKDF (RFC 5869), HMAC, SHA-2, and AES-GCM. There is no API by
which PSI-Link could invoke a module's `KDA TwoStep` service, so the rejected
option's two-step derivation would be hand-composed in JavaScript from HMAC
calls regardless -- while naming a module service that never runs. This is the
decisive point: the rejected option's central advantage does not survive
contact with the platform's call surface.

**2. The certificate's `KDA TwoStep` entry is feedback mode only.** Its
properties on certificate 4985 read `KDF Mode - feedback`, while RFC 5869 HKDF
-- and WebCrypto, and every derivation in this tree -- is counter mode. Building
a two-step derivation faithful to the certified service therefore means
authoring a novel feedback-mode KDF with no anchor anywhere in the repository.
That is strictly more hand-rolled crypto than the status quo, not less.

**3. The certificate attests components, not compositions.** It is silent on
hybrid or concatenated shared secrets: "concatenat" and "pre-shared" do not
occur anywhere in the security policy, and every occurrence of "hybrid" is the
FIPS 140-3 module-type sense (software, firmware, hybrid). So the schedule
assembled above the shared secret is an operator-built composition under either
option. The rejected option would have exchanged one unattested composition for
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
on certificate 4985's approved `KDA HKDF SP800-56Cr2` row instead of on a chain
of individually approved HMAC calls.

**5. The web application runs the same code and has no FIPS provider at all.**
Its key exchange runs in the browser, outside any module boundary, whatever the
curve. The construction therefore has to be expressible in plain WebCrypto on
both platforms. P-256 ECDH is; a module-specific KDA service is not.

**6. The blast radius argues for containment.** The session key keys the
application AEAD, the rotated shared secret persisted to the key file, the
signed-receipt binder, and the per-direction receipt MACs. Retaining the
schedule touches the Diffie-Hellman call sites and the protocol-version tag;
the rejected option rewrites the schedule, redefines transcript binding, and
abandons a pattern with published analysis for a bespoke equivalent with none.

## What a scoped FIPS claim may and may not say about key establishment

**May say**, once the migration has landed *and* a validated module is actually
present in the environment: every cryptographic operation in key establishment
is performed by the module, using algorithms on certificate 4985's approved
list -- the shared-secret computation as `KAS-ECC-SSC` per SP 800-56A Rev 3 over
P-256, and the extract-then-expand as `KDA HKDF SP800-56Cr2`.

**May not say:**

- That key establishment uses a FIPS-approved algorithm while it runs on
  X25519. It does not, on any certificate.
- That the key exchange, the key schedule, or the protocol is validated or
  approved as a scheme.
- That the certificate attests the composition. The schedule above the shared
  secret is an application composition of approved operations, and that
  distinction must not be collapsed.

**The composition disclosure is required on either path**, and it outlives the
migration: a protocol composed in JavaScript above primitive calls yields
validated primitives, never a validated protocol. CMVP validates modules, not
protocols; there is no certificate under which PSI-Link's handshake is the
validated artifact. Migrating the curve is what lets each operation sit inside a
boundary; it does not put the composition inside one, and no wording makes it do
so.

**No sentence may describe the shipped image as running a validated module.** No
certificate covers the base image today, and certificate 4985 vendor-affirms no
operational environments at all -- it covers its twelve tested configurations,
each naming hardware as well as an OS. The environment question is tracked in
[fips-provider-surface.md](fips-provider-surface.md) and is independent of
everything decided here.

## What the primary sources actually say

Read from the documents themselves: NIST SP 800-56C Rev 2, and the OpenSSL FIPS
Provider FIPS 140-3 non-proprietary security policy for certificate 4985.

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

**Table 8 (Non-Approved, Not Allowed Algorithms)** contains X25519 and X448 as
its only key-agreement entries, corroborating what
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

Every panelist across both panels raised the same one, and it is the honest cost
of the choice: if an assessor requires the derivation to read as SP 800-56C *by
construction*, or requires the validated KDA service to be invoked by name with
its tested parameter set, the retained schedule does not deliver that narrative.
Meeting such an assessor means writing the 56A/56C mapping out in prose after
the fact rather than pointing at a service invocation. That cost was accepted
against the reasons above, of which the first is the one that would have to
change for the balance to shift.

## Open questions

Two questions the documents could not settle. Both are recorded as open rather
than glossed, because a confident answer to either would be a guess:

- **Whether the module accepts a caller-supplied byte string as the
  shared-secret input to its approved `KDA TwoStep` service.** The approved
  services table shows the key-derivation service with write access to the
  key-agreement shared secret, which implies import; the SSP table shows that
  same shared secret with an empty input cell and its related SSPs marked
  "Established using" the module's own key agreement, which implies it is only
  ever established internally. A positive answer is the one finding that would
  reopen the rejected option, and it is settled by driving the real module
  (`support/fips-probe/` and its four-leg attribution), never by reading more
  policy text.
- **How CMVP treats an operator-built composition of separately-approved
  components** under the FIPS 140-3 implementation guidance. The security policy
  does not address it, and the claim language above is written to be true
  whichever way it falls.

## How this was decided

The direction was settled by two independent expert panels, three panelists
each, one wave per panel, neutral framing, on a clean checkout. The first ran
with the SP 800-56C and certificate premises unverified and returned 3-0 for the
retained schedule -- with every panelist conditioning that answer on the
premises being unread. The primary documents were then read directly and the
reading was re-verified by an independent agent working from the same PDFs. The
second panel ran with the verified findings supplied and returned 3-0 for the
same answer, on stronger grounds. Every quotation and table row in *What the
primary sources actually say* was produced by two independent extractions from
the source documents, and re-checked a third time when this record was written.

The `deriveBits` collapse came out of the panels rather than the original
framing, and is part of the decision rather than an aside: it is where most of
the rejected option's value turned out to be reachable.

## See also

- [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#key-agreement-design) -- the
  key-agreement decision this record extends.
- [PROTOCOL.md](../spec/PROTOCOL.md#x25519-authenticated-key-exchange) -- the
  normative construction: wire format, mixing order, labels, and the
  protocol-version tag.
- [fips-provider-surface.md](fips-provider-surface.md) -- what a FIPS provider
  carries and reaches in the shipped image, and what the certificates approve.
- [COMPLIANCE.md](../COMPLIANCE.md#fips-140) -- the FIPS claims an agency
  reviewer reads.
