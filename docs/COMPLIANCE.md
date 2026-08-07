---
title: "PSI-Link Compliance"
review_owner: "PSI-Link maintainers"
last_reviewed: "2026-08-07"
---

# PSI-Link compliance

This document collects the regulatory and policy framings most often raised by agency security, compliance, and privacy reviewers. It is not a certification or an attestation of compliance with any specific framework. PSI-Link is open-source software; the deploying agency is responsible for its own risk assessments, authority-to-operate (ATO) determinations, and any required third-party assessments under applicable federal, state, or local regulations.

Where another document in this repository covers a topic in detail, this document links there rather than duplicating it.

## Intended use and data classification

PSI-Link is designed to perform privacy-preserving record linkage between two partner agencies that have a signed data sharing agreement. The base PSI protocol exposes only the membership intersection between the parties; records that are not in the intersection are not disclosed. See [SECURITY_DESIGN.md#data-handling](SECURITY_DESIGN.md#data-handling) for the data-handling guarantees and [PROTOCOL.md](spec/PROTOCOL.md) for the cryptographic details.

The following table summarizes the data classifications PSI-Link is and is not designed for. "Suitable" does not relieve the deploying agency of its own compliance obligations.

| Data type | Suitable? | Notes |
|-----------|-----------|-------|
| Personally Identifiable Information (PII) | Yes | The tool was designed for this use case. |
| Protected Health Information (PHI) under HIPAA | Conditionally | See [HIPAA considerations](#hipaa-considerations) below. |
| Educational records under FERPA | Conditionally | See [FERPA considerations](#ferpa-considerations) below. |
| Criminal Justice Information (CJI) under CJIS | Not validated | PSI-Link has not been assessed against the FBI CJIS Security Policy. Do not use for CJI workloads without an independent assessment. |
| Federal Tax Information (FTI) under IRS Pub 1075 | Not validated | PSI-Link has not been assessed against IRS Publication 1075. Do not use for FTI workloads without an independent assessment. |
| Classified information | No | The tool is not designed or evaluated for classified workloads. |

<!-- TODO: confirm whether any deployments have completed a CJIS or IRS 1075 assessment and document the result. -->

## Federal frameworks

### NIST SP 800-53

The table below maps PSI-Link's design to relevant NIST SP 800-53 Rev 5 control families. It is provided to assist security reviewers and is not a certification of compliance; deploying agencies remain responsible for their own authority-to-operate (ATO) assessments.

| Control | Title | PSI-Link implementation |
|---------|-------|------------------------|
| IA-3 | Device Identification and Authentication | The explicit, role-asymmetric mutual key confirmation in the P-256 authenticated key exchange authenticates both parties before any data is exchanged. |
| IA-5 | Authenticator Management | The shared secret is a 256-bit cryptographically random credential stored in a key file with owner-only permissions; it rotates automatically after every successful exchange. |
| IA-5(1) | Authenticator Management: Password-Based Authentication | The shared secret is a 256-bit cryptographically-random value from `crypto.getRandomValues`, not a human-memorable password, so its full entropy -- not a stretched low-entropy passphrase -- authenticates the exchange and password-stretching controls do not apply. It is consumed by the P-256 authenticated key exchange (see [PROTOCOL.md](spec/PROTOCOL.md#p-256-authenticated-key-exchange)), not by a password-hashing path. |
| RA-3 | Risk Assessment | Threat model, adversary capabilities, privacy guarantees, and known limitations are documented in [SECURITY_DESIGN.md#threat-model](SECURITY_DESIGN.md#threat-model). |
| SA-22 | Unsupported System Components | The supported-version and end-of-life policy is defined in [SECURITY.md](../SECURITY.md). |
| SC-8 | Transmission Confidentiality and Integrity | On a recurring (authenticated) exchange over SFTP or filedrop, everything that crosses the network after the key exchange -- protocol messages and exchange data alike -- is wrapped in AES-256-GCM AEAD keyed from the P-256 key-exchange session key. The key-exchange handshake frames precede that wrap and are not covered by it; see [FIPS 140](#fips-140) for what the wrap does and does not cover. Zero-setup exchanges on those channels carry no application-layer AEAD at all and rely on the channel's transport encryption (for SFTP, the SSH session; for filedrop, whatever protects the synced folder). WebRTC channels use DTLS end-to-end. |
| SC-12 | Cryptographic Key Establishment and Management | Session keys are established via a P-256 authenticated key exchange -- an ephemeral P-256 ECDH (SP 800-56A Rev. 3 ephemeralUnified, curve per FIPS 186-5 / SP 800-186) through `crypto.subtle`, keyed with the pre-shared secret under the Noise NNpsk0 pattern, with an explicit key-confirmation round whose construction is modelled on the bilateral key confirmation of NIST SP 800-56A Rev. 3 section 5.9.2, though not conformant to it: that section specifies the feature for key-agreement schemes whose parties each hold a static key-establishment key pair, and this handshake holds none. The key schedule that turns that exchange into a session key is composed in application JavaScript above primitive calls and sits outside any validated cryptographic module boundary, so key establishment claims no validation of the composition (see [FIPS 140](#fips-140)); every cryptographic operation it makes is a `crypto.subtle` call, so where a validated module is configured, the module performs all of them. Key-file permissions, rotation, backup, and compromise-response procedures are documented in [SECURITY_DESIGN.md#key-file-security](SECURITY_DESIGN.md#key-file-security). |
| SC-13 | Cryptographic Protection | Approval at the algorithm-standard level and approval on a module certificate are different things, and this row keeps them apart, because collapsing them is how it gets written wrongly. **Algorithm standard**: the operations that protect an exchange in transit use algorithms NIST publications specify -- P-256 ECDH for key establishment (SP 800-56A Rev. 3, curve per FIPS 186-5 / SP 800-186), ECDSA over P-256 with SHA-256 (FIPS 186-5) for receipt signing identities, SHA-256, HMAC-SHA-256, HKDF (SP 800-56C), and AES-GCM (SP 800-38D). Each is a `crypto.subtle` call rather than a third-party library one, so a validated module configured beneath the platform is what performs it. **Module certificate**: that is not the same as a module certificate approving the operation, and neither is a claim that any module PSI-Link publishes is validated for the environment it runs in. What the project does and does not claim, and on what condition, is in [FIPS 140](#fips-140); what a scoped claim may and may not say per area is in [key-establishment-fips-boundary.md](notes/key-establishment-fips-boundary.md) and [receipt-signing-fips-boundary.md](notes/receipt-signing-fips-boundary.md). The private set intersection sits outside both approvals: its masking is an elliptic-curve construction over P-256 that no NIST publication specifies and no module certificate approves as a scheme, and it runs in BoringSSL inside a vendored WebAssembly module an OpenSSL provider cannot reach in principle ([fips-provider-surface.md](notes/fips-provider-surface.md)). No validated module changes that, because what is unapproved there is the scheme rather than its implementation. |
| SC-28 | Protection of Information at Rest | The shared secret is the only persistent credential. It is stored with mode `0600` on Unix and a restricted ACL on Windows; see [SECURITY_DESIGN.md#key-file-security](SECURITY_DESIGN.md#key-file-security). PSI-Link applies access control at rest rather than encryption: the key file, the signing identity, the exchange records and the result CSV are written unencrypted at those same owner-only permissions, so at-rest confidentiality is the deploying agency's storage or full-disk encryption. |
| AU-12 | Audit Record Generation | PSI-Link does not capture PII in log output; see [SECURITY_DESIGN.md#data-handling](SECURITY_DESIGN.md#data-handling). |
| SI-2 | Flaw Remediation | Coordinated vulnerability disclosure with a 90-day fix target; CVE assignment for confirmed vulnerabilities; patch releases follow the process in [RELEASES.md](RELEASES.md). |
| SI-7 | Software, Firmware, and Information Integrity | Release tags are signed with the maintainer's SSH key; container images are signed with Cosign; a CycloneDX SBOM is attached to each GitHub Release. |

### FedRAMP and StateRAMP

PSI-Link is software, not a service offering, and is not in scope for FedRAMP or StateRAMP authorization on its own. An agency that deploys the web application as a hosted service is responsible for any required authorization of that hosting environment.

<!-- TODO: if a reference hosted deployment is offered, document its FedRAMP or StateRAMP posture here. -->

### FIPS 140

A FIPS 140 question about PSI-Link is answered wrongly in both directions when three different statements are collapsed into one:

- an algorithm is **specified and approved by a NIST publication** -- FIPS 186-5, FIPS 197, SP 800-38D, SP 800-56A Rev. 3, SP 800-56C Rev. 2;
- a **module certificate** approves that algorithm, so a module performing it stays in its approved mode;
- the **operational environment** the module runs in is one that certificate covers, which is the host plus the runtime plus the image together rather than the image alone.

PSI-Link's answer differs across the three, so this section states the scoped claim the project is prepared to defend, the condition that claim rests on, the places an unqualified claim fails, and the argument an authorizing official is being asked to accept. The target standard is FIPS 140-3.

#### The scoped claim

Every bound below is load-bearing. Drop one and the result is a claim this project will not stand behind.

- **Which exchanges.** Recurring (authenticated) exchanges, on either file-sync channel. File-sync callers request application-layer encryption unconditionally, so SFTP and filedrop are alike here and neither needs a disclaimer the other does not.
- **Which bytes.** The protocol messages and exchange data that cross the network after the key exchange. An AES-256-GCM AEAD keyed from the key-exchange session key wraps every one of them.
- **Which algorithms.** P-256 ECDH for the shared-secret computation, HKDF-SHA-256 for the key schedule, AES-256-GCM for the AEAD, HMAC-SHA-256 and SHA-256 beneath both, and ECDSA over P-256 with SHA-256 for receipt signing. Each is on the approved-algorithm list of the FIPS 140-3 certificate this project targets, and each is a `crypto.subtle` call rather than a third-party library one, so a validated module configured beneath the platform is what performs it. The constructions themselves are specified in [PROTOCOL.md](spec/PROTOCOL.md), [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md) and [EXCHANGE_RECORD.md](spec/EXCHANGE_RECORD.md).

**Not every byte, and the exception is worth stating rather than glossing.** The key-exchange handshake frames -- the ephemeral public keys and the confirmation MACs -- precede the AEAD and are not covered by it. On filedrop they are ordinary plaintext files written into the synced folder, readable by anyone who can read that folder; on SFTP the SSH session is what protects them. They carry no linkage identifiers and no exchange data, and the handshake is authenticated, so tampering fails the exchange rather than passing unnoticed. A claim that every byte of an exchange is AEAD-protected is nonetheless not one this document makes.

#### The condition the claim rests on

The published container image and the browser application embed no validated cryptographic module, and this document claims none for them.

A second container image does. It builds on Amazon Linux 2023 and embeds the CMVP-validated OpenSSL FIPS provider AWS publishes for that distribution, and its engagement is measured rather than assumed: a probe runs at every container start, and CI runs it against the built image on every change that can affect it. The probe makes PSI-Link's own five call shapes -- P-256 ECDH, AES-256-GCM, HKDF-SHA-256, HMAC-SHA-256 and SHA-256, at the parameter shapes the product passes -- and requires, in the same process, that the validated module be loaded and that two operations no FIPS provider serves both fail, so a call served by an uncertified provider cannot read as a dispatch into this one. Receipt signing's ECDSA is not among those five: what stands behind it is the certificate's approved-algorithm list and the `crypto.subtle` call path, not a measurement. **That image is not published.**

Two conditions sit above it even once it is:

- **The environment is the operator's to supply.** The image does not enable FIPS mode and cannot; a claim needs a host in FIPS mode, and the certificate covers tested operational environments rather than a distribution. What the arrangement supports at each host tier, and what stops working inside the image, are in [fips-variant-image.md](notes/fips-variant-image.md).
- **Embedding a validated module is not being one.** A product that embeds another vendor's validated module may say it uses one; it may not call itself validated. CMVP additionally permits such a product to call itself FIPS 140-3 "compliant". This project declines that word: it is not a term NIST or CMVP defines, and it invites a reading the rest of this section is written to prevent.

So the present tense is: the algorithms the scoped claim names are approved ones, the dispatch of five of them into a validated module is measured, and nothing PSI-Link publishes today runs a validated module in an environment a certificate covers. Every statement above about a validated module performing an operation is conditional on deploying the variant image on a host that meets those conditions.

#### Where an unqualified claim fails

- **Zero-setup exchanges.** With no pre-shared secret there is no session key, so there is no application AEAD at all and the scoped claim does not reach them. What protects them is the channel's own transport encryption.
- **Data at rest.** PSI-Link encrypts nothing on disk. The key file, the signing identity, the exchange records and the result CSV are written unencrypted at owner-only permissions (`0600` on Unix, a restricted ACL on Windows), so at-rest confidentiality is the deploying agency's storage or full-disk encryption rather than a control this software provides. See [SC-28](#nist-sp-800-53) and [SECURITY_DESIGN.md#key-file-security](SECURITY_DESIGN.md#key-file-security).
- **The web application.** Its key exchange and receipt signing run on the browser's own Web Crypto implementation and its PSI in WebAssembly. A browser offers no configurable cryptographic module, so every statement here about a validated module is about the container image alone.
- **The PSI scheme itself.** The masking is an elliptic-curve construction over P-256 that no NIST publication specifies and no module certificate approves as a scheme, and it runs in BoringSSL inside a vendored WebAssembly module that an OpenSSL provider cannot reach in principle. The second half is a deployment fact; the first is permanent. What is unapproved is the scheme rather than its implementation, so no validated module and no future image makes the PSI layer approved.
- **Protocol composition in JavaScript.** The key schedule, the AEAD envelope and its sequence discipline, the canonical encoding, and the receipt's domain separation and per-signer binding are composed in application JavaScript above primitive calls. CMVP validates modules, not protocols: however each primitive call is served, the result is validated primitives and never a validated protocol. Recorded per area in [key-establishment-fips-boundary.md](notes/key-establishment-fips-boundary.md) and [receipt-signing-fips-boundary.md](notes/receipt-signing-fips-boundary.md).

#### What an authorizing official is being asked to accept

An agency required to use FIPS 140-validated cryptography for the data it links is being asked to accept one argument, and it is set out here rather than left to be inferred.

**Against every party but the partner, the AEAD is the control.** A transport administrator, an SFTP server operator, a file-sync provider, anyone who can read the synced folder -- none of them is an authorized recipient, and what keeps the exchange confidential from them is the AES-256-GCM wrap. That is squarely a FIPS-scoped question: the algorithm, the module beneath it, and the environment that module runs in are exactly what the rest of this section is about, and the scoped claim and its condition are the whole of the answer.

**Against the partner, it is not a FIPS-scoped question.** The partner is an authorized recipient under the data sharing agreement, already entitled to receive the records the exchange concerns. The PSI layer reduces that disclosure below what the agreement already permits: the partner learns the intersection instead of the file. Its unapproved status therefore does not weaken a control the agency was relying on, because a FIPS-validated module was never what stood between the partner and those records. The scheme is a privacy control layered on an authorized disclosure, not a confidentiality control against an unauthorized one.

**This is an argument, not a determination, and it has a known counter.** A policy requiring validated modules may be written as a property of the software rather than of the threat it addresses, in which case an argument about what the scheme protects does not reach it. An agency whose policy reads that way will not find a validated module in anything PSI-Link publishes today. Whether the scoped claim plus this carve-out satisfies a given authorization is the authorizing official's call, and this document does not make it.

#### Constraining the SSH layer is a separate, achievable control

Restricting what an SFTP exchange's SSH transport will negotiate to approved algorithms is independent of everything above and is available today, whatever image is deployed. The settings, what each excludes, what happens when the partner's server offers nothing approved, and the host-key gap no client-side setting can close are in [FIPS_SFTP_PROFILE.md](FIPS_SFTP_PROFILE.md). Constraining negotiation is not a validated-module claim and that page makes none.

### Section 508 and accessibility

The CLI has no graphical interface and is not subject to Section 508's web or software accessibility requirements. The web application has not been formally evaluated against WCAG 2.1 Level AA or Section 508. A Voluntary Product Accessibility Template (VPAT) is not yet available; an accessibility assessment is targeted ahead of the 1.0 release (see [ROADMAP.md](ROADMAP.md)).

<!-- TODO: publish a VPAT or an Accessibility Conformance Report once the web application has been assessed. -->

### Export control (EAR)

PSI-Link incorporates cryptographic software. Distribution may be subject to the U.S. Export Administration Regulations (EAR). Most open-source cryptographic software qualifies for License Exception ENC under ECCN 5D002, but the exception requires a one-time notification to the Bureau of Industry and Security (BIS) and the National Security Agency. This notification is pending and will be completed before the 1.0 release.

<!-- TODO: record the BIS/NSA ENC notification reference once filed. -->

## Sector-specific framings

### HIPAA considerations

PSI-Link does not transmit Protected Health Information (PHI) to any third party: the peer-coordination server, STUN/TURN relay, and any shared SFTP server see only connection metadata or opaque ciphertext, never data-channel content. Between the two partner agencies, the identifiers used for linkage (names, dates of birth, Social Security numbers, and the like) serve only to compute the intersection and are never sent to the partner. After matching, each party transmits only the payload columns it has designated for disclosure and consented to -- by default the non-identifying data columns being shared, not the identifiers used for matching -- and the output each party writes to disk pairs its own arbitrary row identifier with the matched partner records and those disclosed columns. Whether a designated payload column itself carries PHI, and the handling of the written output, are the deploying agency's determination. See [SECURITY_DESIGN.md#data-handling](SECURITY_DESIGN.md#data-handling).

For HIPAA-regulated deployments:

- The PSI-Link software itself is not a Business Associate. The two covered entities (or business associates) running the exchange remain responsible for any business associate agreement (BAA) between themselves under their data sharing agreement.
- Any third-party service used to support the exchange (a peer-coordination server, STUN/TURN relay, or shared SFTP server) is operated either by one of the parties or by a third party. If a third party operates such a service, the deploying agency is responsible for assessing whether a BAA is required. Because the PSI protocol does not transmit PHI to those supporting services, most deployments treat them as conduits, but this is a determination the deploying agency must make for itself.
- The Security Rule's technical safeguards (access control, audit controls, integrity, transmission security) are addressed by the cryptographic design documented in [SECURITY_DESIGN.md](SECURITY_DESIGN.md). The administrative and physical safeguards remain the deploying agency's responsibility.
- The self-attested exchange record each party writes after a successful exchange is a local, unsigned log of what it disclosed -- the partner, the governing data sharing agreement and the purpose of the disclosure under it, the algorithm, the categories of data exchanged, the number of records this party contributed (`recordsExposed`), (when both parties learn it) the result size, and -- when configured -- a self-facing pointer to where this party filed the result and its retention/disposition schedule -- and carries no protected values. Where an accounting of disclosures applies (45 CFR 164.528), an agency can retain these records as the per-exchange source for that accounting; the record carries the brief purpose statement 164.528 requires for each disclosure, so it can populate the accounting without reopening the agreement. The retention/disposition pointer is not itself a 164.528 accounting element; it is a local convenience recording where the result was filed and under what schedule, so an operator can locate and evidence the disposition during an audit without a separate lookup. Whether a given disclosure is accountable, and the retention and production of the accounting, remain the agency's responsibility. See [EXCHANGE_RECORD.md](spec/EXCHANGE_RECORD.md).

<!-- TODO: provide a sample HIPAA-conduit determination memo template that agencies can adapt. -->

### FERPA considerations

PSI-Link can be used to link educational records across agencies under a data sharing agreement consistent with FERPA's "studies" or "audit and evaluation" exceptions (34 CFR Part 99). The same protocol-level guarantees apply: no individual records are disclosed beyond the intersection, and supporting services see only ciphertext or connection metadata.

The decision to disclose education records under FERPA, and to whom, is the educational agency's responsibility. PSI-Link does not enforce FERPA-specific controls beyond the cryptographic protections described in [SECURITY_DESIGN.md](SECURITY_DESIGN.md).

The same self-attested exchange record (see the [HIPAA considerations](#hipaa-considerations) above and [EXCHANGE_RECORD.md](spec/EXCHANGE_RECORD.md)) gives the educational agency a per-exchange log, carrying no protected values, that it can retain toward FERPA's requirement to record disclosures of education records (34 CFR 99.32, subject to that section's exceptions). FERPA's studies and audit/evaluation exceptions turn on the purpose of the disclosure, which the record states explicitly. Maintaining the record of disclosures remains the agency's responsibility.

### CJIS considerations

PSI-Link has not been assessed against the FBI CJIS Security Policy. Several CJIS requirements (advanced authentication, audit log retention, personnel security, physical access controls) are environmental controls that the deploying agency would need to satisfy independently. CJIS requires FIPS 140-validated cryptography for CJI in transit, and the position under [FIPS 140](#fips-140) does not meet that as PSI-Link publishes today: no published artifact embeds a validated module, the scoped claim is conditional on an image that is built but not published and on a host the operator supplies, and the PSI layer is unapproved as a scheme whatever module is beneath it.

PSI-Link should not be used for CJI workloads without an independent CJIS assessment.

### IRS Publication 1075 considerations

PSI-Link has not been assessed against IRS Publication 1075. Publication 1075 inherits NIST 800-53 controls with additional FTI-specific requirements (notably FIPS 140-validated cryptography, audit logging, and Safeguards Computer Security Evaluation Matrix conformance). The same FIPS position applies on the same terms as for CJIS above: conditional on a deployment that is not published, and not reaching the PSI layer at all.

PSI-Link should not be used for FTI workloads without an independent assessment.

## State and local laws

State and local privacy laws (for example, California CCPA/CPRA, New York SHIELD Act, Texas DIR rules, Illinois BIPA where biometric identifiers are involved, and analogous statutes in other jurisdictions) impose requirements that vary by jurisdiction. PSI-Link does not enforce jurisdiction-specific controls; the deploying agency is responsible for assessing applicability and for any required notices, opt-outs, retention limits, or data-subject rights workflows.

<!-- TODO: collect and link the most common state-law guidance documents that agencies have asked about. -->

## Supply chain

### Section 889

PSI-Link does not use covered telecommunications equipment or services as defined in Section 889 of the John S. McCain National Defense Authorization Act for Fiscal Year 2019. The project's runtime and build dependencies are listed in the CycloneDX Software Bill of Materials (SBOM) attached to each release; see [RELEASES.md#software-bill-of-materials-sbom](RELEASES.md#software-bill-of-materials-sbom). The SBOM allows downstream users to verify the absence of any specific covered vendor.

### Dependency origins and licenses

The redistributed third-party components and their upstreams are documented in the top-level [NOTICE](../NOTICE) file. Per-dependency licenses are listed in the CycloneDX SBOM attached to each release (see [RELEASES.md#software-bill-of-materials-sbom](RELEASES.md#software-bill-of-materials-sbom)); the dependency license-compatibility policy is in [CONTRIBUTING.md#dependency-policy](../CONTRIBUTING.md#dependency-policy).

### Software Bill of Materials

A CycloneDX SBOM is generated as part of the release checklist and attached to every GitHub Release. See [RELEASES.md#software-bill-of-materials-sbom](RELEASES.md#software-bill-of-materials-sbom).

### Release integrity

Container images are signed with Cosign and release tags are signed with the maintainer's SSH key. Verification procedures are documented in [RELEASES.md#verifying-a-release](RELEASES.md#verifying-a-release).

<!-- TODO: add SLSA provenance attestation to the release workflow and document verification here. -->

## Authority to Operate

PSI-Link does not hold an ATO of its own; an ATO is granted to a specific deployment within a specific authorizing environment, not to open-source software. The documentation in this repository - in particular the threat model and authentication design in [SECURITY_DESIGN.md](SECURITY_DESIGN.md), the cryptographic protocol in [PROTOCOL.md](spec/PROTOCOL.md), the [NIST 800-53 control mapping](#nist-sp-800-53) above, and the SBOM described in [RELEASES.md](RELEASES.md) - is intended to support an agency's own ATO process, not to substitute for it.

## Privacy review

The project's privacy posture is published as a standalone statement at [PRIVACY.md](../PRIVACY.md): what the project collects and retains on its own behalf, how the container deployment and the hosted web application differ in what the project operates and can observe, and what each supporting service sees. A privacy review should start there.

The statement points into the design documents for the underlying detail, and a reviewer working through it will want the same four: what data flows and what is retained ([SECURITY_DESIGN.md#data-handling](SECURITY_DESIGN.md#data-handling)), how the persistent credential is protected ([SECURITY_DESIGN.md#key-file-security](SECURITY_DESIGN.md#key-file-security)), what third-party supporting services can observe ([SECURITY_DESIGN.md#channel-security](SECURITY_DESIGN.md#channel-security)), and who can attack what ([SECURITY_DESIGN.md#threat-model](SECURITY_DESIGN.md#threat-model)).

### Privacy Impact Assessment

The project does not publish a PIA of its own, and a privacy statement is not a substitute for one. A PIA assesses a deployment, and the facts that determine its conclusions -- the system owner, the authority for collection, the populations whose records are linked, and the retention schedule applied to the output -- belong to the deploying agency, not to the software. An agency completing a PIA draws the project-side inputs from [PRIVACY.md](../PRIVACY.md) (data flows, retention, and third-party visibility) and from this document (the control mappings and sector-specific framings above). If an agency needs those inputs restated in a particular PIA template, ask through the channels in [SUPPORT.md](../SUPPORT.md).

## Reporting compliance gaps

If a reviewer identifies a compliance-relevant gap that is not addressed here, please:

- Open a [GitHub issue](https://github.com/georgetown-mdi/jspsi/issues) tagged `compliance` if the gap is not security-sensitive.
- Follow the private reporting process in [SECURITY.md](../SECURITY.md) if the gap is security-sensitive.

## See also

- [SECURITY_DESIGN.md](SECURITY_DESIGN.md) - threat model, authentication design, channel security, NIST 800-53 mapping
- [PROTOCOL.md](spec/PROTOCOL.md) - PSI and key-exchange protocol specification
- [FIPS_SFTP_PROFILE.md](FIPS_SFTP_PROFILE.md) - constraining an SFTP exchange's SSH layer to approved algorithms
- [RELEASES.md](RELEASES.md) - release artifacts, signing, and SBOM
- [SECURITY.md](../SECURITY.md) - vulnerability reporting and response
- [PRIVACY.md](../PRIVACY.md) - the project's privacy posture, by deployment, and what supporting services can observe
- [NOTICE](../NOTICE) - third-party component attributions
