---
title: "Security Policy"
---

# Security Policy

This document describes how to report vulnerabilities in PSI-Link and what reporters and users can expect in response. For the threat model, authentication design, and cryptographic protocol details, see [docs/SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md).

## Supported Versions

PSI-Link maintains security patches for the current major release and the previous major release. Older releases do not receive patches.

| Version        | Supported |
| -------------- | --------- |
| Current major  | Yes       |
| Previous major | Yes       |
| Older releases | No        |

## Reporting a Vulnerability

**Do not report security vulnerabilities through public GitHub issues, pull requests, or discussions.**

Use GitHub's built-in [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability) for this repository. This opens a private thread visible only to you and the maintainers and is the fastest path to a coordinated fix.

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

## Disclosure Policy

We follow [coordinated vulnerability disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure). Once a fix is ready:

1. A patch release is prepared, tagged, and published (see [RELEASES.md](docs/RELEASES.md)).
2. A GitHub Security Advisory is published with CVE assignment where applicable.
3. The CHANGELOG is updated to note the security fix.

We ask reporters to hold public disclosure until we have published the advisory or until the 90-day window has elapsed, whichever comes first. Reporters will be credited in the advisory unless they request anonymity.

## Scope

The following are in scope for this policy:

- Cryptographic protocol implementation: X25519 key exchange, key derivation, secret rotation, key confirmation
- Key file handling and credential exposure through configuration parsing
- PSI protocol correctness: a result that leaks more than the agreed intersection
- Authentication bypass or impersonation between exchange partners
- Data confidentiality during transport for any supported channel

The following are out of scope:

- Fundamental cryptographic flaws in the PSI primitive itself — report those to [OpenMined/PSI](https://github.com/OpenMined/PSI) directly, then notify us so we can coordinate an update to the vendored copy. Note that `@openmined/psi.js` is vendored in this repository; PSI-Link is responsible for updating it when security patches are released upstream and will do so as part of normal maintenance.
- Denial-of-service attacks against shared infrastructure (SFTP servers, STUN/TURN relays, peer coordination servers)
- Attacks that require an adversary to have already compromised the host running PSI-Link
- Social engineering

## Cryptographic Dependencies

PSI-Link's security properties depend on several upstream cryptographic components. If you discover a vulnerability in one of these, please report it to the upstream maintainer and also notify us through the private advisory channel above.

| Dependency          | Role                              | Upstream                                                            |
| ------------------- | --------------------------------- | ------------------------------------------------------------------- |
| `@openmined/psi.js` | PSI primitive (vendored WASM)     | [OpenMined/PSI](https://github.com/OpenMined/PSI)                   |
| `@noble/curves`     | Elliptic-curve operations (P-256) | [paulmillr/noble-curves](https://github.com/paulmillr/noble-curves) |
| Web Crypto API      | SHA-256, HMAC-SHA-256, HKDF       | Platform-provided; report to browser/runtime vendor                 |
