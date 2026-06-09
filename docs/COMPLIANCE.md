---
title: "PSI-Link Compliance"
---

# PSI-Link compliance

This document collects the regulatory and policy framings most often raised by agency security, compliance, and privacy reviewers. It is not a certification or an attestation of compliance with any specific framework. PSI-Link is open-source software; the deploying agency is responsible for its own risk assessments, authority-to-operate (ATO) determinations, and any required third-party assessments under applicable federal, state, or local regulations.

Where another document in this repository covers a topic in detail, this document links there rather than duplicating it.

## Intended use and data classification

PSI-Link is designed to perform privacy-preserving record linkage between two partner agencies that have a signed data sharing agreement. The base PSI protocol exposes only the membership intersection between the parties; records that are not in the intersection are not disclosed. See [SECURITY_DESIGN.md#data-handling](SECURITY_DESIGN.md#data-handling) for the data-handling guarantees and [PROTOCOL.md](PROTOCOL.md) for the cryptographic details.

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
| IA-3 | Device Identification and Authentication | The explicit, role-asymmetric mutual key confirmation in the X25519 authenticated key exchange authenticates both parties before any data is exchanged. |
| IA-5 | Authenticator Management | The shared secret is a 256-bit cryptographically random credential stored in a key file with owner-only permissions; it rotates automatically after every successful exchange. |
| IA-5(1) | Authenticator Management: Password-Based Authentication | The shared secret is a 256-bit value from `crypto.getRandomValues`, not a human-memorable password; it is mixed into the X25519 key schedule as the Noise NNpsk0 pre-shared key rather than stretched as a password, so its full 256-bit entropy authenticates the exchange. |
| RA-3 | Risk Assessment | Threat model, adversary capabilities, privacy guarantees, and known limitations are documented in [SECURITY_DESIGN.md#threat-model](SECURITY_DESIGN.md#threat-model). |
| SA-22 | Unsupported System Components | The supported-version and end-of-life policy is defined in [SECURITY.md](../SECURITY.md). |
| SC-8 | Transmission Confidentiality and Integrity | Recurring (authenticated) exchanges on the SFTP and filedrop channels are protected in transit by AES-GCM AEAD keyed from the X25519 key-exchange session key; zero-setup exchanges on those channels are not AEAD-wrapped at the application layer and rely on the channel's transport encryption (for SFTP, the SSH session). WebRTC channels use DTLS end-to-end. |
| SC-12 | Cryptographic Key Establishment and Management | Session keys are established via an X25519 authenticated key exchange -- an ephemeral X25519 Diffie-Hellman (RFC 7748) keyed with the pre-shared secret under the Noise NNpsk0 pattern, with explicit key confirmation, following NIST SP 800-56A Rev. 3. Key-file permissions, rotation, backup, and compromise-response procedures are documented in [SECURITY_DESIGN.md#key-file-security](SECURITY_DESIGN.md#key-file-security). |
| SC-13 | Cryptographic Protection | All cryptographic operations use NIST-approved algorithms: X25519 (FIPS 186-5, SP 800-186), Ed25519 (FIPS 186-5) for receipt signing identities, SHA-256, HMAC-SHA-256, HKDF (SP 800-56C), and AES-GCM. |
| SC-28 | Protection of Information at Rest | The shared secret is the only persistent credential. It is stored with mode `0600` on Unix and a restricted ACL on Windows; see [SECURITY_DESIGN.md#key-file-security](SECURITY_DESIGN.md#key-file-security). |
| AU-12 | Audit Record Generation | PSI-Link does not capture PII in log output; see [SECURITY_DESIGN.md#data-handling](SECURITY_DESIGN.md#data-handling). |
| SI-2 | Flaw Remediation | Coordinated vulnerability disclosure with a 90-day fix target; CVE assignment for confirmed vulnerabilities; patch releases follow the process in [RELEASES.md](RELEASES.md). |
| SI-7 | Software, Firmware, and Information Integrity | Release tags are signed with the maintainer's SSH key; container images are signed with Cosign; a CycloneDX SBOM is attached to each GitHub Release. |

### FedRAMP and StateRAMP

PSI-Link is software, not a service offering, and is not in scope for FedRAMP or StateRAMP authorization on its own. An agency that deploys the web application as a hosted service is responsible for any required authorization of that hosting environment.

<!-- TODO: if a reference hosted deployment is offered, document its FedRAMP or StateRAMP posture here. -->

### FIPS 140

The cryptographic primitives PSI-Link uses are NIST-approved algorithms (P-256, SHA-256, HMAC-SHA-256, HKDF, AES-GCM), but **the cryptographic modules in use are not FIPS 140-validated**:

- `@noble/curves` (elliptic-curve scalar multiplication) is not FIPS-validated.
- The Web Crypto API implementations in Node.js and in browsers are generally not FIPS-validated as shipped.
- BoringSSL, embedded in the vendored `@openmined/psi.js` WebAssembly module, is not a FIPS-validated module in this build configuration.

Agencies that are required to use FIPS 140-validated cryptographic modules should treat PSI-Link as unsuitable for those workloads in its current form.

<!-- TODO: investigate whether a FIPS-validated build path exists (for example, swapping in a FIPS-validated provider for the symmetric primitives) and document the result. -->

### Section 508 and accessibility

The CLI has no graphical interface and is not subject to Section 508's web or software accessibility requirements. The web application has not been formally evaluated against WCAG 2.1 Level AA or Section 508. A Voluntary Product Accessibility Template (VPAT) is not yet available; an accessibility assessment is targeted ahead of the 1.0 release (see [ROADMAP.md](ROADMAP.md)).

<!-- TODO: publish a VPAT or an Accessibility Conformance Report once the web application has been assessed. -->

### Export control (EAR)

PSI-Link incorporates cryptographic software. Distribution may be subject to the U.S. Export Administration Regulations (EAR). Most open-source cryptographic software qualifies for License Exception ENC under ECCN 5D002, but the exception requires a one-time notification to the Bureau of Industry and Security (BIS) and the National Security Agency. This notification is pending and will be completed before the 1.0 release.

<!-- TODO: record the BIS/NSA ENC notification reference once filed. -->

## Sector-specific framings

### HIPAA considerations

PSI-Link does not transmit Protected Health Information (PHI) to any third party. During an exchange, the only data that traverses the network is cryptographic protocol output (elliptic-curve points and AEAD ciphertext) between the two partner agencies; the output written to disk is an association table of row indices, not raw PHI. See [SECURITY_DESIGN.md#data-handling](SECURITY_DESIGN.md#data-handling).

For HIPAA-regulated deployments:

- The PSI-Link software itself is not a Business Associate. The two covered entities (or business associates) running the exchange remain responsible for any business associate agreement (BAA) between themselves under their data sharing agreement.
- Any third-party service used to support the exchange (a peer-coordination server, STUN/TURN relay, or shared SFTP server) is operated either by one of the parties or by a third party. If a third party operates such a service, the deploying agency is responsible for assessing whether a BAA is required. Because the PSI protocol does not transmit PHI to those supporting services, most deployments treat them as conduits, but this is a determination the deploying agency must make for itself.
- The Security Rule's technical safeguards (access control, audit controls, integrity, transmission security) are addressed by the cryptographic design documented in [SECURITY_DESIGN.md](SECURITY_DESIGN.md). The administrative and physical safeguards remain the deploying agency's responsibility.
- The self-attested exchange record each party writes after a successful exchange is a local, unsigned log of what it disclosed -- the partner, the governing data sharing agreement and the purpose of the disclosure under it, the algorithm, the categories of data exchanged, and (when both parties learn it) the result size -- and carries no protected values. Where an accounting of disclosures applies (45 CFR 164.528), an agency can retain these records as the per-exchange source for that accounting; the record carries the brief purpose statement 164.528 requires for each disclosure, so it can populate the accounting without reopening the agreement. Whether a given disclosure is accountable, and the retention and production of the accounting, remain the agency's responsibility. See [PROTOCOL.md](PROTOCOL.md#self-attested-record).

<!-- TODO: provide a sample HIPAA-conduit determination memo template that agencies can adapt. -->

### FERPA considerations

PSI-Link can be used to link educational records across agencies under a data sharing agreement consistent with FERPA's "studies" or "audit and evaluation" exceptions (34 CFR Part 99). The same protocol-level guarantees apply: no individual records are disclosed beyond the intersection, and supporting services see only ciphertext or connection metadata.

The decision to disclose education records under FERPA, and to whom, is the educational agency's responsibility. PSI-Link does not enforce FERPA-specific controls beyond the cryptographic protections described in [SECURITY_DESIGN.md](SECURITY_DESIGN.md).

The self-attested exchange record (see the [HIPAA considerations](#hipaa-considerations) above and [PROTOCOL.md](PROTOCOL.md#self-attested-record)) likewise gives the educational agency a per-exchange log -- the partner, the governing agreement and the purpose of the disclosure under it, and the categories of data exchanged, with no protected values -- that it can retain toward FERPA's requirement to record disclosures of education records (34 CFR 99.32, subject to that section's exceptions). FERPA's studies and audit/evaluation exceptions turn on the purpose of the disclosure, which the record now states explicitly. Maintaining the record of disclosures remains the agency's responsibility.

### CJIS considerations

PSI-Link has not been assessed against the FBI CJIS Security Policy. Several CJIS requirements (advanced authentication, audit log retention, personnel security, physical access controls) are environmental controls that the deploying agency would need to satisfy independently. The application's cryptographic design uses NIST-approved primitives but, as noted under [FIPS 140](#fips-140), does not currently use FIPS 140-validated modules; CJIS requires FIPS 140-validated cryptography for CJI in transit.

PSI-Link should not be used for CJI workloads without an independent CJIS assessment.

### IRS Publication 1075 considerations

PSI-Link has not been assessed against IRS Publication 1075. Publication 1075 inherits NIST 800-53 controls with additional FTI-specific requirements (notably FIPS 140-validated cryptography, audit logging, and Safeguards Computer Security Evaluation Matrix conformance). The same FIPS limitation noted above applies.

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

PSI-Link does not hold an ATO of its own; an ATO is granted to a specific deployment within a specific authorizing environment, not to open-source software. The documentation in this repository - in particular the threat model and authentication design in [SECURITY_DESIGN.md](SECURITY_DESIGN.md), the cryptographic protocol in [PROTOCOL.md](PROTOCOL.md), the NIST 800-53 mapping in [SECURITY_DESIGN.md#nist-sp-800-53](SECURITY_DESIGN.md#nist-sp-800-53), and the SBOM described in [RELEASES.md](RELEASES.md) - is intended to support an agency's own ATO process, not to substitute for it.

## Privacy review

A privacy review of PSI-Link should consider:

- **What data flows.** Across the network during an exchange, only cryptographic protocol messages between the two parties (see [PROTOCOL.md](PROTOCOL.md)). To third-party supporting services, only connection metadata or opaque ciphertext (see [SECURITY_DESIGN.md#channel-security](SECURITY_DESIGN.md#channel-security)).
- **What is retained.** The shared secret in `.psilink.key` is the only persistent credential. The exchange output is an association table of row indices, not raw PII. See [SECURITY_DESIGN.md#data-handling](SECURITY_DESIGN.md#data-handling) and [SECURITY_DESIGN.md#key-file-security](SECURITY_DESIGN.md#key-file-security).
- **What is logged.** PSI-Link does not write PII to log output; see [SECURITY_DESIGN.md#data-handling](SECURITY_DESIGN.md#data-handling).
- **What third parties see.** Peer-coordination, STUN/TURN, and SFTP operators see metadata only; data-channel content is encrypted. See [SECURITY_DESIGN.md#channel-security](SECURITY_DESIGN.md#channel-security).
- **Who can attack what.** Documented in [SECURITY_DESIGN.md#threat-model](SECURITY_DESIGN.md#threat-model).

<!-- TODO: publish a standalone Privacy Impact Assessment (PIA) summary in the PIA template format used by most agencies. -->

## Reporting compliance gaps

If a reviewer identifies a compliance-relevant gap that is not addressed here, please:

- Open a [GitHub issue](https://github.com/georgetown-mdi/jspsi/issues) tagged `compliance` if the gap is not security-sensitive.
- Follow the private reporting process in [SECURITY.md](../SECURITY.md) if the gap is security-sensitive.

## See also

- [SECURITY_DESIGN.md](SECURITY_DESIGN.md) - threat model, authentication design, channel security, NIST 800-53 mapping
- [PROTOCOL.md](PROTOCOL.md) - PSI and key-exchange protocol specification
- [RELEASES.md](RELEASES.md) - release artifacts, signing, and SBOM
- [SECURITY.md](../SECURITY.md) - vulnerability reporting and response
- [NOTICE](../NOTICE) - third-party component attributions
