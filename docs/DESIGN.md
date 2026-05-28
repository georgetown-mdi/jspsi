---
title: "PSI-Link"
author: "Vincent Dorie"
date: 2026-05-04
---

# Overview

The goal of this project is to facilitate secure inter-agency data sharing of administrative records. This is accomplished by executing a privacy-preserving record linkage (PPRL) protocol based on private set intersection (PSI). A base implementation of PSI executes a cryptographic protocol between two parties who each have lists of strings and reveals to one or both parties the elements they have in common. This base function can be used repeatedly by two parties to identify which of several statistical linkage keys they share, generating an association map between each party's matched elements. Those parties can then exchange additional data elements for their common members. Alternatively, the parties can run a private set intersection cardinality (PSI-C) protocol to determine the number of members they have in common without revealing their identities, which may provide motivation for high-level program discussions about data sharing. The PPRL using PSI is intended for operational use, while PSI-C is intended only for research. (PSI-C is not yet fully implemented; it is targeted for a release after 1.0 - see [ROADMAP.md](ROADMAP.md).)

Running a PSI linkage protocol and using it operationally can be challenging for organizations with limited technical resources and requires deliberate attention to usability and deployment frictions. Within organizations it is often the case that a program officer would benefit from exchanging data and even has a signed data sharing agreement in hand, yet the exchange stalls while other stakeholders' requirements are satisfied: security teams may require that any new software undergo a formal audit, compliance officers need explicit assurance about what data is disclosed and to whom, and IT departments must vet software against their own technology requirements. In contrast, smaller organizations may have fewer procedural hurdles but they often lack the technical sophistication to perform regular data linking and sharing. In order to useful to these two audiences, the project is designed to first work locally in a browser without requiring additional software to be installed and restricting data to flow through trusted channels. For ease-of-use, browser-based solutions have have modern, user-centered interfaces. Users willing to install software can use a containerized, command line application to perform all the same functionality which is easily hardened and integrates with a variety of infrastructures.

This document covers the project overview, architecture, exchange specification summary, and high-level user journey. It does not cover the PSI protocol details (see [PROTOCOL.md](PROTOCOL.md)), the threat model and authentication design (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md)), network communication and supporting services (see [COMMUNICATION.md](COMMUNICATION.md)), or the CLI command reference (see [CLI.md](CLI.md)). Intended readers are program officers, evaluators, and new contributors.

# Exchange specification

The parameters necessary to execute an exchange are written down into a JSON or YAML documents which are supplied to an application. The components of an exchange specification include: the linkage terms which describes what will be exchanged and how, connection information which describes where the exchange will take place, metadata that describes the fields and their roles, and data cleaning transformations which simply provide convenience for low-tech users. See [EXCHANGE_SPEC.md](EXCHANGE_SPEC.md) for the full reference covering all fields, types, constraints, and examples for each of these four components.

# Architecture

The linkage protocol, exchange agreements, and communication layer described in this document are built into a single library whose functionality is exposed to users through two applications, one delivered in the web browser and one used through the command line.

When adopting the software, program officers are likely to first conduct exchanges with the web application in order to establish the business case for using the software, either by operating on previously established data sharing agreements or running a PSI-C algorithm to measure the size of shared membership. This bootstrapping process allows for setting and exporting exchange parameters, which can be handed off to IT professionals who can automate the procedure. They are likely to use the command line application as it can be more easily integrated with other data processes, such as exporting the data to be shared and ingesting the data received.

## Core library

The core library includes the base PSI function, linkage term verification, input ingestion and cleaning, linkage key generation, and the execution of the linkage algorithms over PSI. Receipt generation and signing are part of the intended design but are not yet implemented; they are targeted for the 1.0 release (see [ROADMAP.md](ROADMAP.md)). The various libraries that are run-time dependent, such as communication channels and cryptography, are abstracted over and need to be supplied by specific applications.

## Command line application

The command line application enables the automation of all exchange operations and can be integrated into data transformations. Recurring exchanges can be executed through external schedulers or orchestrators, making it the preferred interface for IT professionals operationalizing exchanges that program officers established via the web application. The application is distributed as a Docker image with a default working directory of `/work`; users mount their exchange directory there so that configuration, credentials, and data files are all accessible within the container.

## Web application

The web application is a management interface for exchanges. It allows for the inspection and editing of one-off and recurring exchanges, setting their parameters, adjusting their schedules, and viewing their logs. It also includes code to execute exchanges.

Exchange specifications can be downloaded from the web app for use by the command line application, so the web application has user-friendly ways of creating those files. This includes a data explorer and metadata labeler, linkage rule creator, and data cleaning transformation creator.

If the browser window is left open, it runs scheduled exchanges at the appropriate time. Note that this is a sub-optimal user experience, as it is easy to accidentally close the application.

The web application includes a feature to invite parties to conduct exchanges. Users can generate a shared secret for their partner, instantiate an ephemeral peer coordination server using a serverless compute platform, generate an additional secret for use with that coordination server, and transfer the necessary information to the other party using an existing communication channel.

# User journey

A user should be able to *invite* someone to conduct an exchange, *accept* an extended invitation, and *exchange* data for previously arranged details. The bare minimum necessary to conduct an exchange is an *input* file and a *location*, although most exchanges will also use a *shared secret* and want to save the *output*. As indicated above, linkage terms, connection details, metadata, and data cleaning transformations form further exchange parameters.

For the rest of this section we describe use cases as in the command line application. The application provides four explicit subcommands - `init`, `invite`, `accept`, and `exchange` - alongside a zero-setup mode in which both parties run the same command against a shared server without specifying a subcommand. Web application versions implement the same functionality with an appropriate graphical user interface and use browser storage instead of the file system.

> **Not yet implemented:** Today only `exchange` and the zero-setup mode are functional. The `init`, `invite`, and `accept` subcommands and the `--save` flag are stubbed and targeted for the 1.0 release; see [CLI.md](CLI.md) and [ROADMAP.md](ROADMAP.md). The command table and flows below describe the intended behavior.

A typical first exchange of a recurring relationship begins with one party generating an invitation with `psilink invite` and securely transmitting it to their partner out-of-band. The partner accepts with `psilink accept`, which establishes the shared configuration and key on both sides. Both parties then run `psilink exchange` to conduct the data exchange. Subsequent exchanges use `psilink exchange` with the stored configuration and shared secret, requiring no further coordination. After any successful exchange the shared secret is rotated. As a one-step alternative, parties can run `invite` and `accept` with a server URL as an argument, in which case acceptance leads to immediately conducting an exchange.

Two invitation flows are supported: an offline flow where no server is involved and a server-coordinated flow where a server address is used for coordination and is given to both parties. In the server-coordinated flow, setup and exchange happen in one step: the inviter waits for the acceptor to respond, and both parties exchange immediately on acceptance.

| Intent | Invocation |
|---|---|
| Zero-setup exchange (both parties) | `psilink URL input.csv` |
| Generate a config file for editing | `psilink init [input.csv]` |
| Start a recurring exchange relationship (offline) | `psilink invite [input.csv]`, then share the invitation string out-of-band |
| Start a recurring exchange relationship and exchange (server-coordinated) | `psilink invite URL input.csv`, then share the invitation string; the exchange runs on acceptance |
| Accept an offline invitation | `psilink accept INVITATION [input.csv]` |
| Accept a server-coordinated invitation and exchange | `psilink accept URL INVITATION input.csv` |
| Recurring exchange | `psilink exchange input.csv` |
| Zero-setup exchange, establish recurring relationship (both parties) | `psilink --save URL input.csv` |
| Re-establish after lost secret | Delete key file on both sides; re-run `psilink invite` and `psilink accept` |

If only one party uses `--save` during a zero-setup exchange, no shared secret is established; see [Bootstrapping a shared secret](SECURITY_DESIGN.md#bootstrapping-a-shared-secret) for the full set of outcomes.

For full documentation of each subcommand, configuration files, invitation strings, and recovery procedures, see [CLI.md](CLI.md).

# Possible extensions

## Multiple potential matches

The deterministic cascade requires that each linkage key be precise enough to produce only definitive matches. This is a deliberate constraint that preserves the core privacy guarantee of PSI, but it rules out pairing algorithms that score or threshold matches across multiple keys. Doing so requires running PSI on keys that may produce non-definitive matches, revealing information about individuals who are not in the final intersection.

Threshold and weighted scoring approaches could be supported without this privacy cost using secure multi-party computation (MPC) to evaluate match scores over encrypted data, never exposing intermediate per-key match results. This would substantially increase protocol complexity and is left as a potential future extension.

## Brute force protection

As mentioned in the threat model, brute-force attacks are possible for simple keys. At some point, controls may be implemented that prevent the algorithm from running if the input is a relatively large portion of the potential universe of possible values.

## SSH as a replacement for SFTP

Communication over SFTP requires polling for messages, which introduces significant latency. If both parties are able to access a shared SSH server, SSH channels - bidirectional byte streams that require no polling - can be used instead to eliminate this restriction.

SSH offers no built-in solution for synchronizing two parties who arrive at the same time. However, SSH servers often expose an SFTP subsystem so that the strategy used there can also be applied. Once order has been established, both parties can close their SFTP subsystems and switch to SSH channels for message passing. If the SSH server does not expose an SFTP subsystem but does permit remote command execution, shell-level primitives such as `mkdir` can provide the same atomicity guarantee that SFTP synchronization requires.

## WebSocket relay

WebRTC connections can fail due to aggressive firewalling in some corporate environments even if a TURN server is available on port 443. A WebSocket relay addresses this by giving both parties a channel that is genuine HTTPS traffic from the network's perspective: each party opens a WebSocket connection to the relay server on port 443, and the relay forwards messages between them.

The relay operates at the application layer, which has meaningful trust implications that distinguish it from a TURN server. A TURN server forwards encrypted packets without terminating the end-to-end encryption between peers; it cannot read the payload and its role is closer to that of a network router than an application service. A WebSocket relay terminates the TLS session and reads the WebSocket frames before forwarding them. Application-level AEAD encryption ensures the relay operator sees only ciphertext, but they are structurally in a position of access that a TURN server operator is not. This is similar to running an exchange on an SFTP server, and agencies would likewise be encouraged to deploy their own relay.

## Other applications

It may be beneficial to be able to build the web application as a desktop Electron app, or possibly have it be able to be saved as a progressive web app. These options can behave more like system services, but will likely require additional IT review.

## See also

- [PROTOCOL.md](PROTOCOL.md) - PSI and PSI-C algorithm details and post-linkage steps
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md) - threat model, authentication design, and channel security
- [COMMUNICATION.md](COMMUNICATION.md) - communication channels and supporting services
- [CLI.md](CLI.md) - full CLI command reference and configuration guide
- [EXCHANGE_SPEC.md](EXCHANGE_SPEC.md) - complete exchange specification reference
- [COMPLIANCE.md](COMPLIANCE.md) - regulatory framings, data classification, and compliance considerations

# License and disclaimer

PSI-Link is free, open-source software released under the [Apache License, Version 2.0](../LICENSE.md) and will remain available at no cost. It is provided "as-is," without warranty of any kind, express or implied, including without limitation any warranties of merchantability, fitness for a particular purpose, or non-infringement. The full warranty disclaimer and limitation of liability appear in sections 7 and 8 of the Apache License.

Agencies evaluating PSI-Link for operational use are responsible for their own risk assessments, authority-to-operate (ATO) determinations, and compliance reviews under applicable federal, state, or local regulations. The project documentation — including this document, [SECURITY_DESIGN.md](SECURITY_DESIGN.md), [PROTOCOL.md](PROTOCOL.md), and [COMPLIANCE.md](COMPLIANCE.md) — is intended to support those reviews, not to substitute for them.
