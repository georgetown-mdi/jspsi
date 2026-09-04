---
title: "psilink Deployment Model and Shared Responsibility"
review_owner: "psilink maintainers"
last_reviewed: "2026-09-04"
---

# Deployment model and shared responsibility

Agency security questionnaires are written for cloud services: they ask where the vendor hosts the data, who at the vendor can reach it, and what the vendor's backup, retention, and incident-response commitments are. Most of those questions have the same answer here, and it is a structural one -- the deploying agency operates everything, and no agency data reaches the project.

This document states that split. It names what the project operates and what the deploying agency operates, separately for the two deployments, so a reviewer can answer most of a questionnaire from one page.

It is not a certification, an attestation, or a contract. It describes how psilink is built and deployed; the deploying agency remains responsible for its own risk assessment and authorization ([COMPLIANCE.md](COMPLIANCE.md)).

## psilink is not a hosted service

A security questionnaire's vendor rows have no vendor to land on. The deploying agency runs the software and is the sole controller of the data it processes; the project is neither controller, processor, nor business associate for that data, and operates nothing on the agency's behalf. Nothing in either deployment asks an agency to register, checks a license, calls home for updates, or reports usage.

The hosted deployment of the web application is the single exception to "operates nothing", and [Hosted web application](#hosted-web-application) below bounds what it changes.

No personal data is collected, transmitted, or retained by the project on its own behalf. [PRIVACY.md](../PRIVACY.md) is the authority on that answer, and carries the repository check that backstops it against drift; this document takes it as given and states who operates what.

## The two deployments

The split differs by deployment, and a responsibility table written for one is misleading about the other. Read the section for the deployment in question.

One responsibility precedes both and is the same in each: the decision to disclose -- its legal basis, the data sharing agreement behind it, and which columns are designated for disclosure -- together with the risk assessment, the privacy impact assessment, and the authorization that cover it. psilink conducts the exchange the two parties configured and makes no determination about whether a disclosure is lawful ([COMPLIANCE.md](COMPLIANCE.md#authority-to-operate)).

### Container deployment (CLI and local console)

This is the deployment supported for production use.

- **The project operates no part of it.** The container runs on hardware the agency controls, connects only to the SFTP server or shared directory the agency configured for the exchange, and no component of it reports back.
- **No agency data is transmitted to, stored on, or accessible from project-operated infrastructure** -- the exchange touches none. The project receives no data, no metadata, and no record that an exchange took place.
- **Even the registry the image comes from is not project-operated.** It is a public one, and what it can observe is one row of [Third-party supporting services](#third-party-supporting-services).

The local console is part of this deployment rather than a hosted one: it rides in the same container, served over loopback to the operator's own machine and reachable from nowhere else ([DEPLOYMENT.md](DEPLOYMENT.md#server-job-api)).

### Hosted web application

- **Status: evaluation and demonstration.** Real records belong in the container deployment.
- **This is the one deployment where the project operates infrastructure at all**, since the application is served from project-controlled hosting. That is what makes the second table below differ from the first.
- **What that infrastructure receives is delivery and rendezvous metadata:** the web server's request logs, and the connection metadata the bundled peer-coordination server needs to introduce two browsers. [PRIVACY.md](../PRIVACY.md#hosted-web-application) enumerates the fields.
- **What it does not receive is the exchange:** not its content, the input file, the linkage identifiers, the shared secret, the agreed terms, or any record of what was linked. Matching happens in the browser -- a reviewed property of the codebase, not one the browser enforces ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#egress-hardening-and-its-limits)) -- and the coordination server relays opaque setup messages rather than data-channel content ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#channel-security)).

An agency that deploys the web application on its own infrastructure takes every project-side row of the hosted table below.

## Responsibility split: container deployment

| Area | The psilink project | The deploying agency |
|------|---------------------|----------------------|
| Infrastructure and network controls | Publishes the container image and documents how to hold its outbound access to the single endpoint an exchange needs ([DEPLOYMENT.md](DEPLOYMENT.md#restricting-the-containers-outbound-network-access)). Operates no infrastructure the exchange touches. | All of it: the host, the container engine, the network path, egress rules, and the SFTP server or shared folder the two parties rendezvous through. psilink requires no particular SFTP server and provides none ([DEPLOYMENT.md](DEPLOYMENT.md#sftp-server)). |
| Host and OS hardening | Ships the image running unprivileged as uid 1000, with its program files owned by root so the running process cannot rewrite its own code ([DEPLOYMENT.md](DEPLOYMENT.md#the-user-the-image-runs-as)). | The host operating system and its patching, the container engine's configuration, and the ownership and permissions of every mounted directory. |
| Identity and access | The exchange's own authentication: a pre-shared secret and an authenticated key exchange for recurring exchanges ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#authentication)), and SFTP host-key verification whose no-pin default is fail-closed ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#transport-layer-authentication)). No accounts, no login, no directory integration. | Who may log into the host and run the container; the SFTP accounts, their per-exchange directory permissions, and a separate account per party ([DEPLOYMENT.md](DEPLOYMENT.md#rendezvous-directory-checklist)); and carrying the shared secret and the host-key fingerprint to the partner out of band. |
| Encryption in transit | Wraps every recurring file-sync exchange in application-layer AES-256-GCM keyed from the key exchange, so the SFTP or shared-folder operator sees only ciphertext. A zero-setup exchange has no session key and relies on the transport alone ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#channel-security)). | The transport beneath it: the SSH server's configuration and the access controls on a shared folder. Constraining SSH negotiation to approved algorithms is a connection setting the agency applies ([FIPS_SFTP_PROFILE.md](FIPS_SFTP_PROFILE.md)). |
| Encryption at rest | None. psilink applies owner-only access control rather than encryption: the key file, signing identity, exchange records, and result CSV are written unencrypted at owner-only permissions ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#key-file-security)). | At-rest confidentiality in full -- storage or full-disk encryption on the host and on any backup medium ([COMPLIANCE.md](COMPLIANCE.md#nist-sp-800-53), SC-28). |
| Backup and recovery | Documents that a backed-up shared secret must carry the same owner-only restrictions as the original, and that re-invitation is the recovery when no backup exists ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#backup)). Provides no backup mechanism and holds no copy of anything. | Backing up, restoring, and protecting the key file, signing identity, configuration, input, and results, and the media those backups live on. |
| Data retention and disposal | Retains nothing. In the default mode the exchange deletes each file it has consumed as a protocol step; in retain mode it deliberately leaves the whole transcript in the shared directory, and nothing removes it afterwards ([DEPLOYMENT.md](DEPLOYMENT.md#rendezvous-directory-checklist)). | Retention and disposition of the input, the result CSV, the exchange records, and the shared directory's contents, including clearing a retain-mode transcript. The exchange record can carry a self-facing pointer to where the result was filed and under what schedule ([COMPLIANCE.md](COMPLIANCE.md#hipaa-considerations)). |
| Logging and monitoring | Writes operational logs to the container's own output and keeps PII out of them; content is limited to non-sensitive metadata ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#data-handling)). Emits no telemetry and receives no logs. | Collecting, storing, protecting, and monitoring those logs; reviewing output before forwarding it to a third-party logging service; and alerting on a failed or missed exchange. |
| Incident response | Coordinated vulnerability disclosure on the timeline in [SECURITY.md](../SECURITY.md#reporting-a-vulnerability), with advisories and CVE assignment where applicable, and a documented compromise response for a leaked shared secret ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#compromise-response)). | Detection and response in its own environment, executing the compromise response with the partner, any breach notification it owes, and applying patched releases. |
| Patching and supply chain | Signed release tags, Cosign-signed images carrying a SLSA build provenance attestation, a CycloneDX SBOM per release ([COMPLIANCE.md](COMPLIANCE.md#release-integrity)), and security patches for the current and previous major release ([SECURITY.md](../SECURITY.md#supported-versions)). | Verifying those signatures before deploying, tracking releases, and scheduling the upgrade ([RELEASES.md](RELEASES.md#verifying-a-release)). |

**The local console adds one operator-side control.** Its job API carries no authentication by design, because it assumes the single operator at the host. What it is reachable from is decided by the container's publish binding and the host firewall, both the agency's ([DEPLOYMENT.md](DEPLOYMENT.md#server-job-api)); the trust invariant and what violates it are in [SECURITY_DESIGN.md](SECURITY_DESIGN.md#single-party-appliance-trust-boundary).

## Responsibility split: hosted web application

| Area | The psilink project | The deploying agency |
|------|---------------------|----------------------|
| Infrastructure and network controls | Operates the hosting that delivers the application code, the bundled peer-coordination server, and the reverse proxy and TLS terminator in front of them ([DEPLOYMENT.md](DEPLOYMENT.md#hardening-the-signaling-surface)). | The network path from its own endpoints, and any egress or proxy controls it applies to them. |
| Host and OS hardening | The hosting platform and the application it serves. | The endpoint the browser runs on -- operating system and browser patching, disk encryption, screen lock. All data handling happens there. |
| Identity and access | No accounts, no registration, no cookies, and no login of any kind. Exchange authentication is the same authenticated key exchange the container runs. | Who may use the device and the browser profile, and carrying the invitation -- which contains the secret that authenticates the exchange -- over a trusted channel ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#invitation-contents-and-confidentiality)). |
| Encryption in transit | Serves the application over TLS and runs the coordination server that brokers the browser-to-browser connection. The exchange itself is end-to-end encrypted under WebRTC DTLS, which the coordination server never terminates ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#channel-security)). | The network path from its own endpoints to the coordination server and to the partner. The browser client builds its peer connection with a fixed STUN set and no TURN entry, so there is no relay to choose in this deployment; relay configuration is a container-deployment field ([EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#connectionturn)), and a relay forwards encrypted DTLS packets without terminating the session. |
| Encryption at rest | No agency data is stored on project infrastructure, so there is nothing there to encrypt. A managed (recurring) exchange persists its record -- including the rotating shared secret -- in browser storage on the operator's own device, where the at-rest posture is deliberately weaker than the CLI's owner-only key file: the store has no owner-only mode, and any script running in the origin can read it ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges)). | Device-level protection for that storage: full-disk encryption, browser-profile hygiene, and deleting the managed exchange when the partnership ends ([MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md#deleting-a-managed-exchange)). |
| Backup and recovery | Holds no copy of anything to restore. Re-invitation is the documented recovery for a lost or suspect secret. | Everything on the device, and one hazard specific to it: a browser-profile backup, a VM snapshot, or an exported credential file can silently re-arm the secret it captured ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#rollback-at-rest-copies-can-silently-resurrect)). |
| Data retention and disposal | Holds the web server request logs and the coordination server's connection metadata named under [Hosted web application](#hosted-web-application) above. No exchange content, no input data, and no record of what was linked. | The input file, the result file, and any managed-exchange record on the device. Deleting the managed exchange removes its stored record ([MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md#deleting-a-managed-exchange)). |
| Logging and monitoring | Operates and monitors the hosted service itself. Its logs record that a browser loaded the application, not anything about an exchange. | Any monitoring of its own exchanges. The project provides no per-agency audit feed and no exchange history. |
| Incident response | The same disclosure process as above, and an incident affecting the hosted service itself. | Incidents in its own environment, including a lost or compromised device holding a managed exchange's secret; treat a captured export or profile copy as a captured token ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#compromise-response)). |
| Patching and supply chain | Maintains and deploys the hosted application; there is no package for the agency to install or patch. No third-party content delivery, analytics, or tracking scripts are served. | The browser's own patching, and any extension or endpoint agent running in it. The in-browser data-handling property is a reviewed property of the codebase, not one the browser enforces against an injected script ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#egress-hardening-and-its-limits)). |

## Third-party supporting services

An exchange relies on services operated by one of the parties, by the project, or by a third party, depending on the channel and the deployment. Who operates a service is who answers for it. None of them sees the identifiers used for matching: those never leave the party that holds them.

| Supporting service | Typically operated by | What it can observe |
|--------------------|----------------------|---------------------|
| Peer coordination (signaling) | The project, for the hosted web application; the agency, if it deploys the web application itself; or a public third-party service the agency points at | Rendezvous identifiers, connection timing, and client IP addresses. Never data-channel content. |
| STUN | A third party. The hosted web application is configured by default with two public STUN servers | The client IP address that queried it, and nothing further. |
| TURN relay | Whoever the agency configures in the container deployment; commonly a commercial ICE service. The hosted web application configures none | The two endpoints' addresses and the traffic volume between them. It forwards encrypted DTLS packets without terminating the session. |
| Shared SFTP server or file drop | One of the two parties, or a third party both trust | The exchange's files: ciphertext and file timing on a recurring, authenticated exchange; readable content on a zero-setup exchange, which relies on the transport alone. |
| Container registry | A public registry the project does not operate | That an image pull happened. The project receives only whatever aggregate pull counts the registry publishes to image owners. |

The per-service detail is in [PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe), and the channel-by-channel analysis behind it in [SECURITY_DESIGN.md](SECURITY_DESIGN.md#channel-security).

## Recurring questionnaire answers

| A questionnaire asks | The answer, and where it is written down |
|----------------------|------------------------------------------|
| Where is our data hosted? | Where you run it. In the container deployment the project operates nothing and receives nothing. In the hosted web application, data handling stays in the browser and the input file is never uploaded ([Two deployments](#the-two-deployments)). |
| Who at your organization can access our data? | Nobody. The project receives no agency data in either deployment. Between the two partner agencies, what is disclosed is the intersection plus the payload columns each party designated ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#data-handling)). |
| What is your uptime commitment or disaster recovery plan? | The project operates nothing on your behalf in the container deployment, so availability is a property of your own host. The hosted web application is for evaluation and demonstration, not production exchanges of real records. |
| Are you FedRAMP or StateRAMP authorized? Do you have an ATO? | psilink is software, not a service offering, and is not in scope for either on its own ([COMPLIANCE.md](COMPLIANCE.md#fedramp-and-stateramp)). An ATO is granted to a deployment in an authorizing environment, not to open-source software ([COMPLIANCE.md](COMPLIANCE.md#authority-to-operate)). |
| Do you encrypt data at rest? | The software encrypts nothing on disk. It writes its artifacts owner-only, and at-rest confidentiality is the deploying agency's storage or full-disk encryption ([COMPLIANCE.md](COMPLIANCE.md#nist-sp-800-53), SC-28). |
| Do you use FIPS 140-validated cryptography? | A scoped claim, with its conditions and the places an unqualified claim fails, is set out in full ([COMPLIANCE.md](COMPLIANCE.md#fips-140)). Constraining an SFTP exchange's SSH layer to approved algorithms is separate and available today ([FIPS_SFTP_PROFILE.md](FIPS_SFTP_PROFILE.md)). |
| List your subprocessors. | None for the container deployment; the project processes nothing. The supporting services an exchange can rely on, and what each sees, are in [Third-party supporting services](#third-party-supporting-services) above. |
| How do we report a vulnerability, and what is your patch commitment? | Private reporting, the response timeline, and the supported-version policy are in [SECURITY.md](../SECURITY.md). |
| Which NIST 800-53 controls does the software address? | The control mapping, with what each row does and does not claim, is in [COMPLIANCE.md](COMPLIANCE.md#nist-sp-800-53). |

## What this document does not cover

- **Data practices** -- what is collected, transmitted, and retained, and by whom: [PRIVACY.md](../PRIVACY.md) is the authority. Both documents set out the two deployments, because the responsibility split turns on the same facts; each states them in its own terms, and this one links back for the data-practices detail rather than carrying it.
- **Regulatory framings and control mappings** -- NIST SP 800-53, FIPS 140, HIPAA, FERPA, CJIS, IRS 1075, Section 508, export control: [COMPLIANCE.md](COMPLIANCE.md).
- **The threat model and the security controls themselves**: [SECURITY_DESIGN.md](SECURITY_DESIGN.md).
- **How to operate a deployment** -- the container, the console appliance, the SFTP server checklist, and egress restriction: [DEPLOYMENT.md](DEPLOYMENT.md).

## Review and ownership

- **Owner:** the psilink maintainers. This is a maintainer responsibility rather than a named individual's; use the reporting channels in [SECURITY.md](../SECURITY.md) and [SUPPORT.md](../SUPPORT.md) rather than contacting a person.
- **Last reviewed:** the `last_reviewed` date in the front matter at the top of this document.
- **Cadence:** reviewed on any change that moves the line between what the project operates and what the deploying agency operates, and at least annually regardless of whether anything changed. Every revision and its date are recorded in this repository's version history.

## See also

- [PRIVACY.md](../PRIVACY.md) - what the project collects, transmits, and retains, and what supporting services can observe
- [COMPLIANCE.md](COMPLIANCE.md) - regulatory framings, the NIST 800-53 control mapping, and the FIPS 140 position
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md) - threat model, authentication design, channel security, and data handling
- [DEPLOYMENT.md](DEPLOYMENT.md) - operating the container, the console appliance, and the supporting services
- [SECURITY.md](../SECURITY.md) - vulnerability reporting, response timeline, and supported versions
