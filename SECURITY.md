---
title: "Security Policy"
review_owner: "psilink maintainers"
last_reviewed: "2026-08-28"
---

# Security Policy

This document describes how to report vulnerabilities in psilink and what reporters and users can expect in response. For the threat model, authentication design, and cryptographic protocol details, see [docs/SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md).

## Supported Versions

psilink maintains security patches for the current major release and the previous major release. Older releases do not receive patches.

| Version        | Supported |
| -------------- | --------- |
| Current major  | Yes       |
| Previous major | Yes       |
| Older releases | No        |

## Reporting a Vulnerability

**Do not report security vulnerabilities through public GitHub issues, pull requests, or discussions.**

Use GitHub's built-in [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability) for this repository. This opens a private thread visible only to you and the maintainers and is the fastest path to a coordinated fix.

If you cannot use the GitHub path -- you have no GitHub account, or private reporting is unavailable when you arrive -- email the maintainer at [vincent.dorie@georgetown.edu](mailto:vincent.dorie@georgetown.edu) with the same details below. Prefer the GitHub path when both are open: the private thread is visible to the maintainer team rather than a single mailbox, and it is where the coordinated fix is tracked.

When reporting, please include:

- A description of the vulnerability and its potential impact on data confidentiality, integrity, or authentication
- The affected component(s), version(s), and transport channel (WebRTC, SFTP, or filedrop)
- Steps to reproduce, or a proof-of-concept if available
- Any mitigations you have identified

## Response Timeline

| Milestone                 | Target                    |
| ------------------------- | ------------------------- |
| Initial acknowledgement   | 5 business days           |
| Confirmed or declined     | 15 business days          |
| Fix or advisory published | 90 days from confirmation |

Critical vulnerabilities affecting data privacy or cryptographic integrity are prioritized. We will keep you informed of progress throughout.

The responder-side procedure behind these targets -- triage and the severity call, which released versions a fix must cover, the hotfix release, advisory publication and CVE assignment, and the message you receive at each milestone -- is documented in [docs/INCIDENT_RESPONSE.md](docs/INCIDENT_RESPONSE.md), along with what happens if the maintainer is unavailable when your report arrives.

## Disclosure Policy

We follow [coordinated vulnerability disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure). Once a fix is ready:

1. A patch release is prepared, tagged, and published (see [RELEASES.md](docs/RELEASES.md)).
2. A GitHub Security Advisory is published with CVE assignment where applicable.
3. The CHANGELOG is updated to note the security fix.

We ask reporters to hold public disclosure until we have published the advisory or until the 90-day window has elapsed, whichever comes first. Reporters will be credited in the advisory unless they request anonymity.

## Scope

The following are in scope for this policy:

- Cryptographic protocol implementation: P-256 ECDH key exchange, key derivation, secret rotation, key confirmation
- Key file handling and credential exposure through configuration parsing
- PSI protocol correctness: a result that leaks more than the agreed intersection
- Authentication bypass or impersonation between exchange partners
- Data confidentiality during transport for any supported channel
- At-rest permissions of the artifacts psilink writes owner-only -- among them the key file, the signing identity, the self-attested exchange record, and the result CSV -- where one is left readable or writable by another account on the same host. The write construction and the artifacts it covers are specified in [docs/spec/CREDENTIAL_STORAGE.md](docs/spec/CREDENTIAL_STORAGE.md).

The following are out of scope:

- Fundamental cryptographic flaws in the PSI primitive itself -- report those to [OpenMined/PSI](https://github.com/OpenMined/PSI) directly, then notify us so we can coordinate an update to the vendored copy. psilink is responsible for updating the vendored copy when security patches are released upstream and will do so as part of normal maintenance.
- Denial-of-service attacks against shared infrastructure (SFTP servers, STUN/TURN relays, peer coordination servers)
- Attacks that require an adversary to have already compromised the host running psilink. A second, unprivileged account on that host reading a file psilink wrote owner-only is the at-rest permissions item above rather than this one.
- The absence of at-rest encryption. psilink encrypts nothing on disk by design: it applies owner-only permissions and leaves at-rest confidentiality to the deploying agency's storage or full-disk encryption (see [docs/COMPLIANCE.md](docs/COMPLIANCE.md#nist-sp-800-53), control SC-28).
- Social engineering

## Cryptographic Dependencies

psilink's security properties depend on several upstream cryptographic components. If you discover a vulnerability in one of these, please report it to the upstream maintainer and also notify us through the private advisory channel above.

| Dependency          | Role                                        | Upstream                                                            |
| ------------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| `@openmined/psi.js` | PSI primitive (vendored WASM)               | [OpenMined/PSI](https://github.com/OpenMined/PSI)                   |
| Web Crypto API      | P-256 ECDH keygen and key agreement, P-256 ECDSA receipt signing, SHA-256, HMAC-SHA-256, HKDF | Platform-provided; report to browser/runtime vendor    |

`@noble/curves` is a declared dependency of `@psilink/core` that no code path
reaches: every cryptographic operation runs through the Web Crypto API.
