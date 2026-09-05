---
title: "Privacy Statement"
review_owner: "psilink maintainers"
last_reviewed: "2026-09-05"
---

# Privacy statement

psilink is open-source software that lets two partner agencies find the records they have in common without revealing the records they do not share. This statement describes what the project itself collects, transmits, and retains, and what the supporting services an exchange relies on can observe. It is written for the agency security, compliance, and privacy reviewers who ask for a privacy policy by name.

**Owner:** the psilink maintainers. See [Review and ownership](#review-and-ownership).

This is not a privacy notice for your agency's own data subjects, and it is not a Privacy Impact Assessment (PIA). A PIA is completed per deployment and turns on facts only the deploying agency holds -- the system owner, the authority for collection, the populations involved, and the retention schedule. This statement and [docs/COMPLIANCE.md](docs/COMPLIANCE.md) are the source material an agency uses to complete one.

## The project's role

- **psilink is software you run, not a service run on your behalf.** The one exception is the hosted deployment of the web application, covered below.
- **The deploying agency is the sole controller of the data it processes.** The project is not a controller, processor, or business associate for that data. It never receives it.
- **The project collects, transmits, and retains no personal data on its own behalf**, in either deployment. There are no accounts, no registration, no license check, no update ping, no usage analytics, and no telemetry.
- **What the two parties disclose to each other is governed by their data sharing agreement**, not by this project. psilink enforces the protocol; the agreement decides what may be exchanged under it.

The statements in this document about what psilink connects to have a mechanical backstop: a repository check (`npm run check:egress-claims`) fails the build when the shipped source trees gain a URL literal naming a host under one of the schemes it reads -- `http`, `https`, and the STUN and TURN schemes -- outside a reviewed allowlist. A content delivery network, analytics snippet, or update ping added in that form is caught before it can falsify this document. The check is a backstop rather than a proof of no egress, and it is narrower than the claims it guards: a literal under another scheme (a `wss://` beacon), one added to build configuration outside the scanned trees, a host assembled at runtime, a URL an author spelled around the check by splitting or encoding it, and a connection made inside a dependency are all outside its reach. Its limits are in [docs/SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md#egress-hardening-and-its-limits).

## Two deployments

The answers below differ by deployment. Read the section matching what you are deploying. The operational counterpart to this section -- who operates each part of a deployment, area by area -- is in [docs/SHARED_RESPONSIBILITY.md](docs/SHARED_RESPONSIBILITY.md).

### Container deployment (CLI and local console)

This is the deployment supported for production use.

- **What the project operates: nothing.** The container runs on your machine or in your infrastructure. No component of it reports to the project.
- **What it connects to:** only the SFTP server or shared directory you configure for the exchange. The container makes no other network connection.
- **The local console** is served by that same container to your own machine over loopback and is not reachable beyond that host. It is a local interface to the CLI, not a hosted service. Its browser interface can also run a browser-to-browser exchange rather than an SFTP or shared-directory one; that path contacts the supporting services named below, exactly as the web application does.
- **What the project can observe about your exchanges: nothing.** It receives no data, no metadata, and no record that an exchange occurred.
- **Distribution is the one third-party touch.** Pulling the container image from a public registry tells that registry's operator that the pull happened, as with any container image. The project does not operate the registry and receives only whatever aggregate pull counts the registry publishes to image owners.

### Hosted web application

- **Status: evaluation and demonstration.** The hosted deployment is not recommended for production exchanges of real records. Use the container deployment for those.
- **Where data is handled: entirely in your browser.** The server delivers the application code. Your input file is read, matched, and written locally and is never uploaded. This is a reviewed property of the codebase rather than a browser-enforced one; the limits of that claim against an injected script are stated in [docs/SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md#egress-hardening-and-its-limits).
- **What the project operates,** because this deployment runs on project-controlled infrastructure, and what it can therefore observe:
  - **Web server request logs** for serving the application: client IP address, timestamp, requested path, and user agent. These record that a browser loaded the application, not anything about an exchange.
  - **The bundled peer-coordination server**, which brokers the browser-to-browser connection: the derived rendezvous identifiers, connection timing, and client IP address. It relays opaque setup messages only and never sees data-channel content (see [docs/SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md#channel-security)).
- **What it does not do:** no accounts, no cookies, no analytics or third-party tracking scripts, and no third-party content delivery. The application makes no request to any host other than the supporting services named below.
- **What it stores stays on your device.** A managed (recurring) exchange keeps its record -- the partnership label, the agreed column shape, the rendezvous locator, the schedule, the run outcomes, and the rotating shared secret -- in browser storage. None of it is sent to a server. Deleting the managed exchange removes it (see [docs/MANAGED_EXCHANGE.md](docs/MANAGED_EXCHANGE.md#deleting-a-managed-exchange)). The at-rest threat model for that stored secret is in [docs/SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges).

## What supporting services can observe

An exchange relies on services that are operated by one of the parties, by the project, or by a third party, depending on the channel and the deployment. None of them sees the identifiers used for matching: those never leave the party that holds them. The full channel analysis is in [docs/SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md#channel-security).

| Service | Typically operated by | What it can observe |
|---------|----------------------|---------------------|
| Peer coordination (signaling) | The project, for the hosted web application; you, if you deploy the web application yourself; or a public third-party service if you point at one | Rendezvous identifiers, connection timing, and client IP addresses. Never data-channel content: the two browsers run an authenticated key exchange directly and the server relays only opaque setup messages. |
| STUN | A third party. The hosted web application is configured by default with two public STUN servers, `stun.l.google.com:19302` (Google-operated) and `44.247.30.68:443` | The client IP address that queried it, and nothing further. STUN is used to discover a public address before the connection is established. |
| TURN relay | Whoever you configure; commonly a commercial ICE service | The two endpoints' addresses and the traffic volume between them. It forwards encrypted DTLS packets without terminating the session, so it cannot read content. |
| Shared SFTP server or file drop | One of the two parties, or a third party both trust | The exchange's files. What those files reveal depends on the exchange -- see below. |

The SFTP and file-drop case is the one that turns on how the exchange is set up:

- **A recurring, authenticated exchange** wraps the exchange in application-layer encryption keyed from the two parties' shared secret, so the server operator sees ciphertext and file timing rather than the exchange's contents. The rendezvous files, the key-exchange handshake frames that establish the key the wrap uses, and the abort marker a failing party leaves for its partner sit outside that wrap and are its stated exceptions; none of them holds exchange data or the identifiers used for matching (see [docs/COMPLIANCE.md's SC-8 row](docs/COMPLIANCE.md#nist-sp-800-53)).
- **A zero-setup exchange** carries no such key and relies on the transport alone -- SSH in transit, and the server's own access controls at rest. The server operator can read the files that pass through it, which include the payload values disclosed for matched rows. Where the server is outside both parties' control, prefer an authenticated exchange.

## What psilink retains on your systems

- **The shared secret** in the key file is the only persistent credential; it is stored owner-only and rotates after every successful exchange (see [docs/SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md#key-file-security)).
- **The output file** pairs your own row identifiers with the matched partner records and the columns the partner disclosed. The identifiers used for matching are not part of it. Its retention and disposition are yours to govern.
- **The exchange record** each party writes is a local, self-attested log of what it disclosed and carries no protected values (see [docs/spec/EXCHANGE_RECORD.md](docs/spec/EXCHANGE_RECORD.md)).
- **Logs contain no PII.** Operational logging is limited to non-sensitive metadata.

The complete data-handling account is in [docs/SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md#data-handling).

## Requests from data subjects

The project holds no personal data and cannot respond to access, correction, or deletion requests. Direct them to the agency that operates the deployment, which is the controller of the data it processed.

## Reporting a privacy concern

- If the concern is not security-sensitive, open a [GitHub issue](https://github.com/georgetown-mdi/jspsi/issues) tagged `compliance`.
- If it is security-sensitive -- anything that could expose data -- follow the private reporting process in [SECURITY.md](SECURITY.md) instead. Do not open a public issue.

## Review and ownership

- **Owner:** the psilink maintainers. Privacy review is a maintainer responsibility rather than a named individual's; use the reporting channels above rather than contacting a person.
- **Last reviewed:** the `last_reviewed` date in the front matter at the top of this document.
- **Cadence:** this statement is reviewed on any change that affects what psilink collects, transmits, or retains, and at least annually regardless of whether anything changed. Every revision and its date are recorded in this repository's version history.

## See also

- [docs/COMPLIANCE.md](docs/COMPLIANCE.md) - regulatory framings, data classification, and the considerations a privacy review should cover
- [docs/SHARED_RESPONSIBILITY.md](docs/SHARED_RESPONSIBILITY.md) - the deployment model and what the project operates versus what the deploying agency operates
- [docs/SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md) - threat model, data handling, channel security, and the at-rest model for managed exchanges
- [SECURITY.md](SECURITY.md) - vulnerability reporting and supported versions
- [SUPPORT.md](SUPPORT.md) - where to direct other questions
