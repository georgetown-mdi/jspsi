---
title: "psilink Compliance"
review_owner: "psilink maintainers"
last_reviewed: "2026-09-05"
---

# psilink compliance

This document collects the regulatory and policy framings most often raised by agency security, compliance, and privacy reviewers. It is not a certification or an attestation of compliance with any specific framework. psilink is open-source software; the deploying agency is responsible for its own risk assessments, authority-to-operate (ATO) determinations, and any required third-party assessments under applicable federal, state, or local regulations.

Where another document in this repository covers a topic in detail, this document links there rather than duplicating it.

## Start here

This is the plain-language layer: where the plain-language account of the software is kept, what your agency still owns, and where a reviewer's usual questions are answered. Everything below it is the evidence a technical assessor drills into -- the control mapping, the standards citations, and the FIPS 140 position -- and none of it is a prerequisite for reading this section.

### What psilink does, and what it protects

Both are stated once, in plain language, in [SECURITY_DESIGN.md](SECURITY_DESIGN.md#start-here): what two agencies get out of an exchange, who each party's records are protected from, and the three limits that protection does not cover. Two of its rows have a control-mapping reading here -- what the wrap over a recurring exchange covers, and what it does not, is the [SC-8](#nist-sp-800-53) row; "psilink encrypts nothing on disk" is [SC-28](#nist-sp-800-53).

### What your agency remains responsible for

psilink is software an agency runs, not a service the project operates, so everything around the exchange stays with the deploying agency: the decision to disclose, at-rest confidentiality, the environment, the credentials, retention and disposition, and the assessment itself -- your risk assessment, your privacy impact assessment, and your ATO determination. Nothing in this document is a certification or an attestation.

The split is stated area by area, separately for the container deployment and the hosted web application in the form a security questionnaire asks for, in [SHARED_RESPONSIBILITY.md](SHARED_RESPONSIBILITY.md).

### Where a reviewer's usual questions are answered

| A reviewer asks | The short answer | Where it is set out |
|-----------------|------------------|---------------------|
| Is psilink suitable for our data class? | Designed for PII. PHI under HIPAA and education records under FERPA are conditional and rest on your own determination. CJI under CJIS and FTI under IRS Publication 1075 have not been assessed. Classified information is out of scope. | [Intended use and data classification](#intended-use-and-data-classification) |
| Is our data encrypted at rest? | No -- the software encrypts nothing on disk. It writes its files owner-only, and at-rest confidentiality is your storage or full-disk encryption. | [SC-28](#nist-sp-800-53), [Where an unqualified claim fails](#where-an-unqualified-claim-fails), and [SECURITY_DESIGN.md](SECURITY_DESIGN.md#key-file-security) |
| Is our data encrypted in transit? | On a recurring exchange, yes: the exchange is wrapped in AES-256-GCM on top of the channel's own encryption. A zero-setup exchange relies on the channel alone. | [SC-8](#nist-sp-800-53) and [SECURITY_DESIGN.md](SECURITY_DESIGN.md#channel-security) |
| What is our agency still responsible for? | Everything around the exchange: the decision to disclose, at-rest confidentiality, the environment, the credentials, retention, and the assessment. | [What your agency remains responsible for](#what-your-agency-remains-responsible-for) above, and [SHARED_RESPONSIBILITY.md](SHARED_RESPONSIBILITY.md) |
| Which NIST SP 800-53 controls does it address? | The control mapping, with what each row does and does not claim. | [NIST SP 800-53](#nist-sp-800-53) |
| What happens if the shared secret leaks? | Treat it as invalid immediately, notify the partner, delete both key files, and re-invite over an uncompromised channel. | [SECURITY_DESIGN.md](SECURITY_DESIGN.md#compromise-response) |
| Do you use FIPS 140-validated cryptography? | A scoped claim, and the scope is the whole of the answer: the default container image and the browser application embed no validated cryptographic module, and a separate `-fips` image embeds one, which is not the same as being one. Read the section before relying on it either way. | [FIPS 140](#fips-140) |
| Do you hold an ATO, or a FedRAMP authorization? | Neither, and neither is available to software as such: an ATO is granted to a deployment in an authorizing environment. | [Authority to Operate](#authority-to-operate) and [FedRAMP and StateRAMP](#fedramp-and-stateramp) |
| Where do we report a gap this document does not address? | A public issue for a compliance gap, the private process for a security-sensitive one. | [Reporting compliance gaps](#reporting-compliance-gaps) |

### How the rest of this document is arranged

- [Intended use and data classification](#intended-use-and-data-classification) -- the data classes the software is and is not designed for, and where the responsibility split is stated in full.
- [Federal frameworks](#federal-frameworks) -- the technical layer: the NIST SP 800-53 control mapping, the FIPS 140 position with its scope and conditions, FedRAMP and StateRAMP, accessibility, and export control.
- [Sector-specific framings](#sector-specific-framings) -- HIPAA, FERPA, CJIS, and IRS Publication 1075, each with what the software does and does not decide for that sector.
- [State and local laws](#state-and-local-laws) and [Supply chain](#supply-chain) -- jurisdictional applicability, and release signing, provenance, and the SBOM.
- [Authority to Operate](#authority-to-operate) and [Privacy review](#privacy-review) -- what an agency's own authorization and privacy processes draw from this repository, and what they cannot draw from it.

## Intended use and data classification

psilink is designed to perform privacy-preserving record linkage between two partner agencies that have a signed data sharing agreement. The base PSI protocol exposes only the membership intersection between the parties; records that are not in the intersection are not disclosed. See [SECURITY_DESIGN.md#data-handling](SECURITY_DESIGN.md#data-handling) for the data-handling guarantees and [PROTOCOL.md](spec/PROTOCOL.md) for the cryptographic details.

What the project operates and what the deploying agency operates -- stated separately for the container deployment and the hosted web application, with the responsibility split a security questionnaire asks for -- is in [SHARED_RESPONSIBILITY.md](SHARED_RESPONSIBILITY.md).

The following table summarizes the data classifications psilink is and is not designed for. "Suitable" does not relieve the deploying agency of its own compliance obligations.

| Data type | Suitable? | Notes |
|-----------|-----------|-------|
| Personally Identifiable Information (PII) | Yes | The tool was designed for this use case. |
| Protected Health Information (PHI) under HIPAA | Conditionally | See [HIPAA considerations](#hipaa-considerations) below. |
| Educational records under FERPA | Conditionally | See [FERPA considerations](#ferpa-considerations) below. |
| Criminal Justice Information (CJI) under CJIS | Not validated | psilink has not been assessed against the FBI CJIS Security Policy. Do not use for CJI workloads without an independent assessment. |
| Federal Tax Information (FTI) under IRS Pub 1075 | Not validated | psilink has not been assessed against IRS Publication 1075. Do not use for FTI workloads without an independent assessment. |
| Classified information | No | The tool is not designed or evaluated for classified workloads. |

No CJIS or IRS 1075 assessment has been performed on any deployment.

## Federal frameworks

These are the framework-level positions an assessor works through control by control: what each control family maps to in the design, what the FIPS 140 claim is scoped to and where an unqualified version of it fails, and the authorization, accessibility, and export-control postures. The policy-level answers they support are in [Start here](#start-here) above.

### NIST SP 800-53

The table below maps psilink's design to relevant control families of [NIST SP 800-53 Rev. 5](https://doi.org/10.6028/NIST.SP.800-53r5), whose control identifiers and titles the rows reproduce. It is provided to assist security reviewers and is not a certification of compliance; deploying agencies remain responsible for their own authority-to-operate (ATO) assessments.

| Control | Title | psilink implementation |
|---------|-------|------------------------|
| IA-3 | Device Identification and Authentication | The explicit, role-asymmetric mutual key confirmation in the P-256 authenticated key exchange authenticates both parties before any data is exchanged. |
| IA-5 | Authenticator Management | The shared secret is a 256-bit cryptographically random credential stored in a key file with owner-only permissions; it rotates automatically after every successful exchange. |
| IA-5(1) | Authenticator Management: Password-Based Authentication | The shared secret is a 256-bit cryptographically-random value from `crypto.getRandomValues`, not a human-memorable password, so its full entropy -- not a stretched low-entropy passphrase -- authenticates the exchange and password-stretching controls do not apply. It is consumed by the P-256 authenticated key exchange (see [PROTOCOL.md](spec/PROTOCOL.md#p-256-authenticated-key-exchange)), not by a password-hashing path. |
| IR-4 | Incident Handling | psilink is software an agency runs rather than a service the project operates, so the incident this project handles is a vulnerability reported against the software itself. [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md) sequences that handling -- intake and acknowledgement, triage and the severity call, the affected-version determination, a fix developed out of public view and shipped as a hotfix release, advisory publication with CVE assignment, and close-out -- together with the message the reporter receives at each milestone and a co-owner path for a report arriving while the maintainer is unavailable. An incident inside an agency's own deployment is the agency's to detect and respond to; the operator-side procedure for a leaked shared secret is [SECURITY_DESIGN.md#compromise-response](SECURITY_DESIGN.md#compromise-response), and the split is stated per deployment in [SHARED_RESPONSIBILITY.md](SHARED_RESPONSIBILITY.md). |
| IR-8 | Incident Response Plan | The plan is [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md), published in this repository with a named review owner and a last-reviewed date: the two roles it assigns, the preconditions it confirms annually, its numbered steps, the maintainer-unavailable path, and the reporter-facing timelines that [SECURITY.md](../SECURITY.md#response-timeline) is the authority on. It is walked once a year against a simulated report, and again after any change to the release or disclosure process that would alter the sequence; each walk is dated in the [exercise record](INCIDENT_RESPONSE.md#exercise-record) with the scenario it used, the findings it produced, and whether each was fixed in the runbook or referred to the maintainer. |
| RA-3 | Risk Assessment | Threat model, adversary capabilities, privacy guarantees, and known limitations are documented in [SECURITY_DESIGN.md#threat-model](SECURITY_DESIGN.md#threat-model). |
| SA-22 | Unsupported System Components | The supported-version and end-of-life policy is defined in [SECURITY.md](../SECURITY.md). |
| SC-8 | Transmission Confidentiality and Integrity | On a recurring (authenticated) exchange over SFTP or filedrop, everything that crosses the network after the key exchange -- protocol messages and exchange data alike -- is wrapped in AES-256-GCM AEAD keyed from the P-256 key-exchange session key. Three kinds of file reach the rendezvous directory outside that wrap. The rendezvous hello and joining files precede the key exchange and hold the two bilateral mode flags. The key-exchange handshake frames precede the wrap and hold the ephemeral public keys and confirmation MACs; the handshake is authenticated, so tampering with a frame fails the exchange. The abort marker a failing party leaves for its partner holds a version marker and one HKDF token derived from the session key, which an administrator without that key cannot produce. None of the three holds exchange data or the identifiers used for matching, and the remaining rendezvous artifacts -- the lock file and the acknowledgment markers -- hold no payload at all. See [FIPS 140](#fips-140) for what the wrap does and does not cover. Zero-setup exchanges on those channels have no application-layer AEAD at all and rely on the channel's transport encryption (for SFTP, the SSH session; for filedrop, whatever protects the synced folder). WebRTC channels use DTLS end-to-end. |
| SC-12 | Cryptographic Key Establishment and Management | Session keys are established via a P-256 authenticated key exchange -- an ephemeral P-256 ECDH through `crypto.subtle` (the shared-secret computation of [NIST SP 800-56A Rev. 3](https://doi.org/10.6028/NIST.SP.800-56Ar3) section 5.7.1.2, over the curve [SP 800-186](https://doi.org/10.6028/NIST.SP.800-186) section 3.2.1.3 publishes), keyed with the pre-shared secret under the Noise NNpsk0 pattern, with an explicit key-confirmation round whose construction is modelled on the bilateral key confirmation of SP 800-56A Rev. 3 section 5.9.2, though not conformant to it: that section specifies the feature for key-agreement schemes whose parties each hold a static key-establishment key pair, this handshake holds none, and section 6.1.2.3 declines to incorporate key confirmation into that publication's ephemeral-only schemes at all. What is cited is the shared-secret computation rather than a scheme: the publication's ephemeral-only scheme (section 6.1.2.2) also prescribes a key-derivation step this handshake does not perform, so no conformance to an SP 800-56A scheme is claimed. The key schedule that turns that exchange into a session key is composed in application JavaScript above primitive calls and sits outside any validated cryptographic module boundary, so key establishment claims no validation of the composition (see [FIPS 140](#fips-140)); every cryptographic operation it makes is a `crypto.subtle` call, so where a validated module is configured, the module performs all of them. Key-file permissions, rotation, backup, and compromise-response procedures are documented in [SECURITY_DESIGN.md#key-file-security](SECURITY_DESIGN.md#key-file-security). |
| SC-13 | Cryptographic Protection | Approval at the algorithm-standard level and approval on a module certificate are different things, and this row keeps them apart, because collapsing them is how it gets written wrongly. **Algorithm standard**: the operations that protect an exchange in transit use algorithms NIST publications specify -- P-256 ECDH for key establishment ([SP 800-56A Rev. 3](https://doi.org/10.6028/NIST.SP.800-56Ar3) section 5.7.1.2, over the curve [SP 800-186](https://doi.org/10.6028/NIST.SP.800-186) section 3.2.1.3 publishes; FIPS 186-5 contains no curve parameters and refers them there), ECDSA over P-256 with SHA-256 ([FIPS 186-5](https://doi.org/10.6028/NIST.FIPS.186-5)) for receipt signing identities, SHA-256, HMAC-SHA-256, HKDF ([RFC 5869](https://www.rfc-editor.org/rfc/rfc5869) -- [SP 800-56C Rev. 2](https://doi.org/10.6028/NIST.SP.800-56Cr2) is the NIST key-derivation recommendation, but it cites RFC 5869 rather than specifying HKDF itself, and its own methods are scoped to a shared secret produced by an SP 800-56A or SP 800-56B scheme), and AES-GCM ([SP 800-38D](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf), November 2007 -- the AEAD's 96-bit IV is that publication's section 8.2.1 deterministic construction, read against the section's own requirements in [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md#iv-construction-and-sp-800-38d-conformance)). Each is a `crypto.subtle` call rather than a third-party library one, so a validated module configured beneath the platform is what performs it. **Module certificate**: that is not the same as a module certificate approving the operation, and neither is a claim that any module psilink publishes is validated for the environment it runs in. What the project does and does not claim, and on what condition, is in [FIPS 140](#fips-140); what a scoped claim may and may not say per area is in [key-establishment-fips-boundary.md](notes/key-establishment-fips-boundary.md) and [receipt-signing-fips-boundary.md](notes/receipt-signing-fips-boundary.md). The private set intersection sits outside both approvals: its masking is an elliptic-curve construction over P-256 that no NIST publication specifies and no module certificate approves as a scheme, and it runs in BoringSSL inside a vendored WebAssembly module an OpenSSL provider cannot reach in principle ([fips-provider-surface.md](notes/fips-provider-surface.md)). No validated module changes that, because what is unapproved there is the scheme rather than its implementation. |
| SC-28 | Protection of Information at Rest | The shared secret is the only persistent credential. It is stored with mode `0600` on Unix and a restricted ACL on Windows; see [SECURITY_DESIGN.md#key-file-security](SECURITY_DESIGN.md#key-file-security). psilink applies access control at rest rather than encryption: the key file, the signing identity, the exchange records and the result CSV are written unencrypted at those same owner-only permissions, so at-rest confidentiality is the deploying agency's storage or full-disk encryption. |
| AU-12 | Audit Record Generation | psilink does not capture PII in log output; see [SECURITY_DESIGN.md#data-handling](SECURITY_DESIGN.md#data-handling). |
| SI-2 | Flaw Remediation | Coordinated vulnerability disclosure with a 90-day fix target; CVE assignment for confirmed vulnerabilities; patch releases follow the process in [RELEASES.md](RELEASES.md). |
| SI-7 | Software, Firmware, and Information Integrity | Release tags are signed with the maintainer's SSH key; container images are signed with Cosign and include a SLSA build provenance attestation over the same digest; a CycloneDX SBOM is attached to each GitHub Release. See [Release integrity](#release-integrity). |

### FedRAMP and StateRAMP

psilink is software, not a service offering, and is not in scope for FedRAMP or StateRAMP authorization on its own. An agency that deploys the web application as a hosted service is responsible for any required authorization of that hosting environment.

No reference hosted deployment is offered, so no FedRAMP or StateRAMP posture is documented.

### FIPS 140

The position in plain terms, ahead of the distinctions an assessor works through:

- **No image psilink publishes is FIPS 140-validated, and none is claimed to be.** What the project does claim is narrower, and the scope is the whole of the answer.
- **What it claims.** A separate `-fips` container image embeds and uses a validated cryptographic module -- one CMVP validated for another vendor -- so on a host in FIPS mode that module is what performs the cryptographic operations protecting a recurring SFTP or filedrop exchange in transit. Embedding a validated module is not being one. The claim is that the module's code performs the operation -- measured at every container start for the five operations behind the wrap and its key -- and not that the operation runs in the module's approved mode, which for three of them it does not.
- **What it claims for the default image and the browser application.** Nothing. Neither embeds such a module, and no statement here about a validated module is about either of them.
- **What no image reaches.** psilink encrypts nothing on disk; the private set intersection uses a scheme no NIST publication specifies and no certificate approves; and the protocol composed above the primitive calls is attested by no certificate.
- **Whether that satisfies your agency is your agency's call.** A policy requiring a validated module running in an operational environment its certificate covers does not find one here: the certificate names six bare-metal environments and no container among them. What the project asks an authorizing official to accept instead is set out in [What an authorizing official is being asked to accept](#what-an-authorizing-official-is-being-asked-to-accept) rather than left to be inferred.

The rest of this section is the evidence behind those five statements, and it opens on a distinction, because a FIPS 140 question about psilink is answered wrongly in both directions when three different statements are collapsed into one:

- an algorithm is **specified and approved by a NIST publication** -- [FIPS 186-5](https://doi.org/10.6028/NIST.FIPS.186-5), [FIPS 197](https://doi.org/10.6028/NIST.FIPS.197-upd1), [SP 800-38D](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf), [SP 800-56A Rev. 3](https://doi.org/10.6028/NIST.SP.800-56Ar3), [SP 800-56C Rev. 2](https://doi.org/10.6028/NIST.SP.800-56Cr2), and [SP 800-186](https://doi.org/10.6028/NIST.SP.800-186) for the curve the elliptic-curve algorithms run over -- section 10 of FIPS 140-3 is what gives "approved" that meaning, admitting a security function specified in a FIPS, adopted in one, or listed in NIST SP 800-140C, with SP 800-140D playing that role for sensitive security parameter establishment methods;
- a **module certificate** approves that algorithm, so a module performing it stays in its approved mode;
- the **operational environment** the module runs in is one that certificate covers, which is the host plus the runtime plus the image together rather than the image alone.

psilink's answer differs across the three, so this section states the scoped claim the project is prepared to defend, the condition that claim rests on, the places an unqualified claim fails, and the argument an authorizing official is being asked to accept. The target standard is [FIPS 140-3](https://doi.org/10.6028/NIST.FIPS.140-3), which is a short adopting document rather than a body of requirements: its sections 2 and 3 take ISO/IEC 19790:2012(E) as the technical requirements and ISO/IEC 24759:2017(E) as the test requirements, with the SP 800-140 series modifying those documents' annexes and test sections. Neither ISO standard is published free of charge, so the security requirements a reader would want to check this section against are not open documents; what is cited from FIPS 140-3 itself above is its section 10.

#### The scoped claim

Every bound below is critical. Drop one and the result is a claim this project will not stand behind.

- **Which exchanges.** Recurring (authenticated) exchanges, on either file-sync channel. File-sync callers request application-layer encryption unconditionally, so SFTP and filedrop are alike here and neither needs a disclaimer the other does not.
- **Which bytes.** The protocol messages and exchange data that cross the network after the key exchange. An AES-256-GCM AEAD keyed from the key-exchange session key wraps every one of them.
- **Which algorithms.** P-256 ECDH for the shared-secret computation, HKDF-SHA-256 for the key schedule, AES-256-GCM for the AEAD, HMAC-SHA-256 and SHA-256 beneath both, and ECDSA over P-256 with SHA-256 for receipt signing. Each is on the approved-algorithm list of the FIPS 140-3 certificate the variant image embeds (CMVP 5021, named in full below), and each is a `crypto.subtle` call rather than a third-party library one, so a validated module configured beneath the platform is what performs it. The constructions themselves are specified in [PROTOCOL.md](spec/PROTOCOL.md), [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md) and [EXCHANGE_RECORD.md](spec/EXCHANGE_RECORD.md).

**Performed by the validated module is not the same as performed as an approved service.** The certificate this project targets states a condition on each of the three algorithms behind the AEAD and its key, in each case somewhere other than its approved-algorithm table, and psilink's use meets none of the three:

- **AES-256-GCM.** An externally supplied IV makes the module's AES-GCM a non-approved service (security policy section 2.7.1 and Table 7), and every `crypto.subtle` AES-GCM call supplies the IV by construction -- psilink's is a deterministic value that includes the sender's sequence number, conformant to SP 800-38D section 8.2.1 ([CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md#iv-construction-and-sp-800-38d-conformance)). That conformance answers a different question and does not make the service an approved one: what the certificate conditions is where the IV comes from, not which of the publication's two constructions produced it. The application AEAD is therefore not an approved service on that certificate's own terms.
- **P-256 ECDH.** The SP 800-56A Rev. 3 section 5.6.2 assurances are conditioned on using the module together with an application that implements the TLS protocol. psilink is not one.
- **HKDF-SHA-256.** The module's HKDF is scoped to the context of an SP 800-56A Rev. 3 key-agreement scheme, which reaches the shared-secret computation at the head of the key schedule and not the schedule composed above it.

What this document claims for all three is the dispatch -- the validated module's code performs the operation, at a parameter shape the certificate's approved-algorithm table lists -- and never that the operation runs as an approved service. No approved-service indicator is read back from the module anywhere in this project, and no claim here rests on one. The three conditions are quoted whole in [fips-variant-image.md](notes/fips-variant-image.md), and key establishment's claim language is in [key-establishment-fips-boundary.md](notes/key-establishment-fips-boundary.md).

**Not every byte.** The key-exchange handshake frames -- the ephemeral public keys and the confirmation MACs -- precede the AEAD and are not covered by it. On filedrop they are ordinary plaintext files written into the synced folder, readable by anyone who can read that folder; on SFTP the SSH session is what protects them. They contain no linkage identifiers and no exchange data, and the handshake is authenticated, so tampering fails the exchange rather than passing unnoticed. A claim that every byte of an exchange is AEAD-protected is nonetheless not one this document makes.

#### The condition the claim rests on

The default container image (`vdorie/psi-link:X.Y.Z`) and the browser application embed no validated cryptographic module, and this document claims none for them.

The FIPS variant image (`vdorie/psi-link:X.Y.Z-fips`) does. It builds on Amazon Linux 2023 and embeds the CMVP-validated OpenSSL FIPS provider AWS publishes for that distribution, and its engagement is measured rather than assumed: a probe runs at every container start, and CI runs it against the built image on every change that can affect it. The probe makes psilink's own five call shapes -- P-256 ECDH, AES-256-GCM, HKDF-SHA-256, HMAC-SHA-256 and SHA-256, at the parameter shapes the product passes -- and requires, in the same process, that the validated module be loaded and that two operations no FIPS provider serves both fail, so a call served by an uncertified provider cannot read as a dispatch into this one. Receipt signing's ECDSA is not among those five: what stands behind it is the certificate's approved-algorithm list and the `crypto.subtle` call path, not a measurement.

**Which module, exactly.** The claim names one certificate and one build, because a package name proves nothing: ten builds share the provider package name upstream and only one of them is the certified one, so the image asserts both facts at build time and fails the build on either mismatch.

The certificate is CMVP 5021, "Amazon Linux 2023 OpenSSL FIPS Provider" (vendor Amazon Web Services, Inc.; FIPS 140-3, Overall Security Level 1; active, validated 5/26/2025 by atsec information security corporation, sunset 5/25/2030). The module version and the certified package NVRs the image installs -- the two values the build asserts and fails on -- are pinned once in [CONTAINER_IMAGES.md](spec/CONTAINER_IMAGES.md#what-certificate-5021-attests), which this page cites rather than copies, so a certificate or package rotation is edited in one place.

The certificate's own Caveat, verbatim: "When operated in approved mode. No assurance of minimum security of SSPs (e.g., keys, bit strings) that are externally loaded, or of SSPs established with externally loaded SSPs." (An SSP is a sensitive security parameter; the Caveat's provenance is in [CONTAINER_IMAGES.md](spec/CONTAINER_IMAGES.md#the-caveat).) psilink's key schedule mixes a pre-shared secret that the module did not generate, so that sentence speaks directly to this composition: the module makes no assurance about the pre-shared secret's strength, and neither does this document. What stands behind that secret is how it was generated and exchanged, which is [SECURITY_DESIGN.md](SECURITY_DESIGN.md#bootstrapping-a-shared-secret)'s subject rather than the certificate's.

**Which operational environment the certificate covers.** Six tested environments, all of them Amazon Linux 2023 on bare metal: EC2 `c7g.metal` (AWS Graviton3), EC2 `c6i.metal` (Intel Xeon Platinum 8375C), and AWS Snowball (AMD EPYC 7702), each tested with the processor's cryptographic acceleration on and off. The rows and their provenance are in [CONTAINER_IMAGES.md](spec/CONTAINER_IMAGES.md#what-certificate-5021-attests). Three consequences an assessor should have in front of them:

- **None of the six is a container, and none is a virtual machine.** Every row states `Hypervisor or Host OS: N/A`. A container running this module is therefore not running in a tested operational environment on any host, and this policy states no vendor-affirmed environments to fall back on.
- **The image does not put the host in FIPS mode and cannot.** Supplying that host is the operator's. The variant reports what it finds -- whether its own crypto is being served by the module, and what `/proc/sys/crypto/fips_enabled` says -- at every container start, and warns rather than refusing, because the operator is the one who knows what their deployment has to satisfy.
- **What each host tier supports** is set out in [fips-variant-image.md](notes/fips-variant-image.md): an Amazon Linux 2023 host in FIPS mode is the arrangement AWS itself documents; another Linux host in FIPS mode runs an unmodified, self-testing validated module in an environment no certificate names; a host not in FIPS mode supports no claim at all.

**What stays outside the module.** Publishing the variant moves nothing in [Where an unqualified claim fails](#where-an-unqualified-claim-fails) below, which is the enumeration: the PSI masking permanently, everything written to disk, the browser application, and the protocol composed in JavaScript above the primitive calls. One item is specific to what the variant measures rather than to what it embeds -- **receipt signing's ECDSA**, which is on certificate 5021's approved-algorithm list and runs through the same `crypto.subtle` path as the five, but which no probe leg covers, so what stands behind it is a table placement rather than an observation.

**Embedding a validated module is not being one.** A product that embeds another vendor's validated module may say it uses one; it may not call itself validated. That is entry P-17 of the [CMVP FAQ](https://csrc.nist.gov/Projects/cryptographic-module-validation-program/faqs) (retrieved 2026-08-10; the FAQ is a web page, with no PDF edition), quoted whole in [fips-variant-image.md](notes/fips-variant-image.md), which records the wording rules review holds this document to -- among them that no sentence here calls either image validated. Entry P-18 additionally permits such a product to call itself FIPS 140-3 "compliant" -- a word that entry defines as the vendor's own belief that its implementation meets the requirements, with no CMVP validation behind it. This project declines it: it invites exactly the reading the rest of this section is written to prevent.

So the present tense is: the algorithms the scoped claim names are on certificate 5021's approved-algorithm list, three of them under conditions this use does not meet; the dispatch of five of them into that validated module is measured, at every container start and in CI; the module is the one the certificate names, asserted at build time rather than assumed; and the environment it runs in is one no certificate covers unless and until CMVP tests or the vendor affirms a container. Every statement above about a validated module performing an operation is about the `-fips` image, deployed on a host in FIPS mode, and about nothing else psilink publishes.

#### Where an unqualified claim fails

- **Zero-setup exchanges.** With no pre-shared secret there is no session key, so there is no application AEAD at all and the scoped claim does not reach them. What protects them is the channel's own transport encryption.
- **Data at rest.** psilink encrypts nothing on disk. The key file, the signing identity, the exchange records and the result CSV are written unencrypted at owner-only permissions (`0600` on Unix, a restricted ACL on Windows), so at-rest confidentiality is the deploying agency's storage or full-disk encryption rather than a control this software provides. See [SC-28](#nist-sp-800-53) and [SECURITY_DESIGN.md#key-file-security](SECURITY_DESIGN.md#key-file-security).
- **The web application.** Its key exchange and receipt signing run on the browser's own Web Crypto implementation and its PSI in WebAssembly. A browser offers no configurable cryptographic module, so every statement here about a validated module is about the `-fips` container image alone.
- **The PSI scheme itself.** The masking is an elliptic-curve construction over P-256 that no NIST publication specifies and no module certificate approves as a scheme, and it runs in BoringSSL inside a vendored WebAssembly module that an OpenSSL provider cannot reach in principle. The second half is a deployment fact; the first is permanent. What is unapproved is the scheme rather than its implementation, so no validated module and no future image makes the PSI layer approved.
- **Protocol composition in JavaScript.** The key schedule, the AEAD envelope and its sequence discipline, the canonical encoding, and the receipt's domain separation and per-signer binding are composed in application JavaScript above primitive calls. CMVP validates modules, not protocols: however each primitive call is served, the result is validated primitives and never a validated protocol. Recorded per area in [key-establishment-fips-boundary.md](notes/key-establishment-fips-boundary.md) and [receipt-signing-fips-boundary.md](notes/receipt-signing-fips-boundary.md).

#### What an authorizing official is being asked to accept

An agency required to use FIPS 140-validated cryptography for the data it links is being asked to accept one argument, and it is set out here rather than left to be inferred.

**Against every party but the partner, the AEAD is the control.** A transport administrator, an SFTP server operator, a file-sync provider, anyone who can read the synced folder -- none of them is an authorized recipient, and what keeps the exchange confidential from them is the AES-256-GCM wrap. That is squarely a FIPS-scoped question: the algorithm, the module beneath it, and the environment that module runs in are exactly what the rest of this section is about, and the scoped claim and its condition are the whole of the answer.

**Against the partner, it is not a FIPS-scoped question.** The partner is an authorized recipient under the data sharing agreement, already entitled to receive the records the exchange concerns. The PSI layer reduces that disclosure below what the agreement already permits: the partner learns the intersection instead of the file. Its unapproved status therefore does not weaken a control the agency was relying on, because a FIPS-validated module was never what stood between the partner and those records. The scheme is a privacy control layered on an authorized disclosure, not a confidentiality control against an unauthorized one.

**This is an argument, not a determination, and it has a known counter.** A policy requiring validated modules may be written as a property of the software rather than of the threat it addresses, in which case an argument about what the scheme protects does not reach it. An agency whose policy reads that way finds an embedded validated module in the `-fips` image and a tested operational environment nowhere, since certificate 5021 names no container among its six. Whether the scoped claim plus this carve-out satisfies a given authorization is the authorizing official's call, and this document does not make it.

#### Constraining the SSH layer is a separate, achievable control

Restricting what an SFTP exchange's SSH transport will negotiate to approved algorithms is independent of everything above and is available today, whatever image is deployed. The settings, what each excludes, what happens when the partner's server offers nothing approved, and the host-key gap no client-side setting can close are in [FIPS_SFTP_PROFILE.md](FIPS_SFTP_PROFILE.md), which states the offer as measured. Constraining negotiation is not a validated-module claim and that page makes none.

What the client puts on the wire is captured evidence rather than a reading of the configuration: the algorithms it offers at the start of the SSH handshake have been taken off the wire from the variant image on an Amazon Linux 2023 host in FIPS mode, with no algorithm settings applied. Three things follow for a reviewer assessing an SFTP deployment.

- **A FIPS-configured runtime narrows the offer by itself.** The key exchange and the ciphers offered in that configuration are approved algorithms, with nothing set to make them so. The profile's key-exchange list is narrower again.
- **It does not narrow message authentication, so the settings stay critical.** That same default offer includes a SHA-1 HMAC. Restricting the category to HMAC-SHA-2 is the profile's doing, so a host in FIPS mode is not a substitute for applying the settings -- and on a host not in FIPS mode, the settings are the whole of the control.
- **The host-key type is beyond the reach of either.** `ssh-rsa`, which signs with SHA-1, stays in the offer on a FIPS-mode host as anywhere else, and no client-side setting removes it. Excluding it is the partner server's to do, agreed out of band as part of deploying the profile.

### Section 508 and accessibility

The CLI has no graphical interface and is not subject to Section 508's web or software accessibility requirements. The web application has not been formally evaluated against WCAG 2.1 Level AA or Section 508. A Voluntary Product Accessibility Template (VPAT) is not yet available; an accessibility assessment is targeted ahead of the 1.0 release (see [ROADMAP.md](ROADMAP.md)).

### Export control (EAR)

psilink incorporates cryptographic software. Distribution may be subject to the U.S. Export Administration Regulations (EAR). Most open-source cryptographic software qualifies for License Exception ENC under ECCN 5D002, but the exception requires a one-time notification to the Bureau of Industry and Security (BIS) and the National Security Agency. This notification is pending and will be completed before the 1.0 release.

## Sector-specific framings

### HIPAA considerations

psilink does not transmit Protected Health Information (PHI) to any third party: the peer-coordination server, STUN/TURN relay, and any shared SFTP server see only connection metadata or opaque ciphertext, never data-channel content. Between the two partner agencies, the identifiers used for linkage (names, dates of birth, Social Security numbers, and the like) serve only to compute the intersection and are never sent to the partner. After matching, each party transmits only the payload columns it has designated for disclosure and consented to -- by default the non-identifying data columns being shared, not the identifiers used for matching -- and the output each party writes to disk pairs its own arbitrary row identifier with the matched partner records and those disclosed columns. Whether a designated payload column itself contains PHI, and the handling of the written output, are the deploying agency's determination. See [SECURITY_DESIGN.md#data-handling](SECURITY_DESIGN.md#data-handling).

For HIPAA-regulated deployments:

- The psilink software itself is not a Business Associate. The two covered entities (or business associates) running the exchange remain responsible for any business associate agreement (BAA) between themselves under their data sharing agreement.
- Any third-party service used to support the exchange (a peer-coordination server, STUN/TURN relay, or shared SFTP server) is operated either by one of the parties or by a third party. If a third party operates such a service, the deploying agency is responsible for assessing whether a BAA is required. Because the PSI protocol does not transmit PHI to those supporting services, most deployments treat them as conduits, but this is a determination the deploying agency must make for itself.
- The Security Rule's technical safeguards (access control, audit controls, integrity, transmission security) are addressed by the cryptographic design documented in [SECURITY_DESIGN.md](SECURITY_DESIGN.md). The administrative and physical safeguards remain the deploying agency's responsibility.
- The self-attested exchange record each party writes once an exchange has disclosed -- whether or not that run went on to finish, and stating which of the two it was -- is a local, unsigned log of what it disclosed -- the partner, the governing data sharing agreement and the purpose of the disclosure under it, the algorithm, the categories of data exchanged, the number of records this party contributed (`recordsExposed`), (when both parties learn it) the result size, and -- when configured -- a self-facing pointer to where this party filed the result and its retention/disposition schedule -- and contains no protected values. See [EXCHANGE_RECORD.md](spec/EXCHANGE_RECORD.md). Where an accounting of disclosures applies (45 CFR 164.528):
  - The record is a per-exchange source an agency can retain for that accounting, and it includes the brief purpose statement 164.528 requires for each disclosure, so it can populate the accounting without reopening the agreement.
  - The recipient is the one element it may not supply. A party's name in the linkage terms is optional, so a record for a partner that supplied none contains no `partnerIdentity`, and the recipient must come from the agency's own record of who the exchange was with; the terms hash, purpose, timestamps, and counts are unaffected. An agency filing these records toward an accounting should agree terms with a named partner -- the command line warns at terms agreement on a run that will write a record and finds the partner unnamed.
  - Retaining the per-run source is the operator's own step on the command line and for one-off browser exchanges. For a recurring exchange run from the web application the browser keeps it instead: each completed run files its record in the exchange's own accounting of disclosures, exportable as a table and deleted with the exchange (see [MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md#the-accounting-of-disclosures)).
  - The retention/disposition pointer is not itself a 164.528 accounting element; it is a local convenience recording where the result was filed and under what schedule, so an operator can locate and evidence the disposition during an audit without a separate lookup.
  - Whether a given disclosure is accountable, and the retention and production of the accounting, remain the agency's responsibility.

No sample HIPAA conduit-exception determination memo is available yet; a deploying agency should have its own counsel prepare that determination.

### FERPA considerations

psilink can be used to link educational records across agencies under a data sharing agreement consistent with FERPA's "studies" or "audit and evaluation" exceptions (34 CFR Part 99). The same protocol-level guarantees apply: no individual records are disclosed beyond the intersection, and supporting services see only ciphertext or connection metadata.

The decision to disclose education records under FERPA, and to whom, is the educational agency's responsibility. psilink does not enforce FERPA-specific controls beyond the cryptographic protections described in [SECURITY_DESIGN.md](SECURITY_DESIGN.md).

The same self-attested exchange record (see the [HIPAA considerations](#hipaa-considerations) above and [EXCHANGE_RECORD.md](spec/EXCHANGE_RECORD.md)) gives the educational agency a per-exchange log, containing no protected values, that it can retain toward FERPA's requirement to record disclosures of education records (34 CFR 99.32, subject to that section's exceptions). FERPA's studies and audit/evaluation exceptions turn on the purpose of the disclosure, which the record states explicitly. Maintaining the record of disclosures remains the agency's responsibility.

### CJIS considerations

psilink has not been assessed against the FBI CJIS Security Policy. Several CJIS requirements (advanced authentication, audit log retention, personnel security, physical access controls) are environmental controls that the deploying agency would need to satisfy independently. CJIS requires FIPS 140-validated cryptography for CJI in transit, and the position under [FIPS 140](#fips-140) does not meet that: the `-fips` image embeds a validated module rather than being one, no operational environment on its certificate is a container, the default image embeds no module at all, and the PSI layer is unapproved as a scheme whatever module is beneath it.

psilink should not be used for CJI workloads without an independent CJIS assessment.

### IRS Publication 1075 considerations

psilink has not been assessed against IRS Publication 1075. Publication 1075 inherits NIST 800-53 controls with additional FTI-specific requirements (FIPS 140-validated cryptography, audit logging, and Safeguards Computer Security Evaluation Matrix conformance). The same FIPS position applies on the same terms as for CJIS above: an embedded validated module rather than a validated product, in an environment no certificate covers, and not reaching the PSI layer at all.

psilink should not be used for FTI workloads without an independent assessment.

## State and local laws

State and local privacy laws (for example, California CCPA/CPRA, New York SHIELD Act, Texas DIR rules, Illinois BIPA where biometric identifiers are involved, and analogous statutes in other jurisdictions) impose requirements that vary by jurisdiction. psilink does not enforce jurisdiction-specific controls; the deploying agency is responsible for assessing applicability and for any required notices, opt-outs, retention limits, or data-subject rights workflows.

No collected set of state-law guidance documents is available yet; a deploying agency should consult its own counsel on applicable state and local requirements.

## Supply chain

### Section 889

psilink does not use covered telecommunications equipment or services as defined in Section 889 of the John S. McCain National Defense Authorization Act for Fiscal Year 2019. The project's runtime and build dependencies are listed in the CycloneDX Software Bill of Materials (SBOM) attached to each release; see [RELEASES.md#software-bill-of-materials-sbom](RELEASES.md#software-bill-of-materials-sbom). The SBOM allows downstream users to verify the absence of any specific covered vendor.

### Dependency origins and licenses

The redistributed third-party components and their upstreams are documented in the top-level [NOTICE](../NOTICE) file. Per-dependency licenses are listed in the CycloneDX SBOM attached to each release (see [RELEASES.md#software-bill-of-materials-sbom](RELEASES.md#software-bill-of-materials-sbom)); the dependency license-compatibility policy is in [CONTRIBUTING.md#dependency-policy](../CONTRIBUTING.md#dependency-policy).

### Software Bill of Materials

A CycloneDX SBOM is generated as part of the release checklist and attached to every GitHub Release. See [RELEASES.md#software-bill-of-materials-sbom](RELEASES.md#software-bill-of-materials-sbom).

### Release integrity

Container images are signed with Cosign keylessly through Sigstore -- against the release workflow's OIDC identity rather than a project-held signing key, with every signature recorded in Rekor's public transparency log -- and release tags are signed with the maintainer's SSH key. Verification procedures are documented in [RELEASES.md#verifying-a-release](RELEASES.md#verifying-a-release).

Each released image also has a SLSA build provenance attestation. The release workflow generates it over the published manifest-list digest -- the same digest Cosign signs -- and it is signed through Sigstore against that same workflow identity. What it attests to is the build: the source repository and commit the image was built from, and the workflow that produced it. The signature and the attestation therefore answer different questions -- that the release workflow published this exact manifest, and what the build consumed -- and they are held in different places, the signature in the registry alongside the image and the attestation by GitHub. A reviewer working through supply-chain integrity checks both. The verification command is in [RELEASES.md#build-provenance](RELEASES.md#build-provenance).

Two limits matter for an assessment. The build, the signature, and the attestation are all produced by a workflow in the same repository as the source, not by an isolated trusted builder, so both statements are trustworthy to the extent that repository's Actions configuration is. And psilink makes no claim to a specific SLSA build level; the attestation is evidence a reviewer can evaluate, not a level assertion.

## Authority to Operate

psilink does not hold an ATO of its own; an ATO is granted to a specific deployment within a specific authorizing environment, not to open-source software. The documentation in this repository - in particular the threat model and authentication design in [SECURITY_DESIGN.md](SECURITY_DESIGN.md), the cryptographic protocol in [PROTOCOL.md](spec/PROTOCOL.md), the [NIST 800-53 control mapping](#nist-sp-800-53) above, and the SBOM described in [RELEASES.md](RELEASES.md) - is intended to support an agency's own ATO process, not to substitute for it.

## Privacy review

The project's privacy posture is published as a standalone statement at [PRIVACY.md](../PRIVACY.md): what the project collects and retains on its own behalf, how the container deployment and the hosted web application differ in what the project operates and can observe, and what each supporting service sees. A privacy review should start there.

The operational counterpart is [SHARED_RESPONSIBILITY.md](SHARED_RESPONSIBILITY.md): the privacy statement is the authority on data practices, that document on who operates what. Both set out the two deployments, each in its own terms, and the responsibility document links back to the privacy statement for the data-practices detail.

The statement points into the design documents for the underlying detail, and a reviewer working through it will want the same four: what data flows and what is retained ([SECURITY_DESIGN.md#data-handling](SECURITY_DESIGN.md#data-handling)), how the persistent credential is protected ([SECURITY_DESIGN.md#key-file-security](SECURITY_DESIGN.md#key-file-security)), what third-party supporting services can observe ([SECURITY_DESIGN.md#channel-security](SECURITY_DESIGN.md#channel-security)), and who can attack what ([SECURITY_DESIGN.md#threat-model](SECURITY_DESIGN.md#threat-model)).

### Privacy Impact Assessment

The project does not publish a PIA of its own, and a privacy statement is not a substitute for one. A PIA assesses a deployment, and the facts that determine its conclusions -- the system owner, the authority for collection, the populations whose records are linked, and the retention schedule applied to the output -- belong to the deploying agency, not to the software. An agency completing a PIA draws the project-side inputs from [PRIVACY.md](../PRIVACY.md) (data flows, retention, and third-party visibility) and from this document (the control mappings and sector-specific framings above). If an agency needs those inputs restated in a particular PIA template, ask through the channels in [SUPPORT.md](../SUPPORT.md).

## Reporting compliance gaps

If a reviewer identifies a compliance-relevant gap that is not addressed here, please:

- Open a [GitHub issue](https://github.com/georgetown-mdi/jspsi/issues) tagged `compliance` if the gap is not security-sensitive.
- Follow the private reporting process in [SECURITY.md](../SECURITY.md) if the gap is security-sensitive.

## See also

- [SECURITY_DESIGN.md](SECURITY_DESIGN.md) - threat model, authentication design, channel security, NIST 800-53 mapping
- [SHARED_RESPONSIBILITY.md](SHARED_RESPONSIBILITY.md) - the deployment model and the project/agency responsibility split, per deployment
- [PROTOCOL.md](spec/PROTOCOL.md) - PSI and key-exchange protocol specification
- [FIPS_SFTP_PROFILE.md](FIPS_SFTP_PROFILE.md) - constraining an SFTP exchange's SSH layer to approved algorithms
- [RELEASES.md](RELEASES.md) - release artifacts, signing, and SBOM
- [SECURITY.md](../SECURITY.md) - vulnerability reporting and response
- [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md) - the responder-side runbook behind that policy, and the dated tabletop exercise record
- [PRIVACY.md](../PRIVACY.md) - the project's privacy posture, by deployment, and what supporting services can observe
- [NOTICE](../NOTICE) - third-party component attributions
