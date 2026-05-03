---
title: "PSI-Link"
author: "Georgetown Massive Data Institute"
date: 2026-04-30
---

# Overview

The goal of this project is to facilitate secure inter-agency data sharing of administrative records. This is accomplished by executing a privacy-preserving record linkage (PPRL) protocol based on private set intersection (PSI). A PSI primitive is repeatedly used by two parties to identify which of several statistical linkage keys their data elements have in common, revealing the association map between each party's matched elements. Those parties can then exchange additional data elements for their common members. Alternatively, the parties can run a private set intersection cardinality (PSI-C) protocol to determine the number of members they have in common, which may provide motivation for high-level program discussions about data sharing. The PPRL using PSI is intended for operational use, while PSI-C is intended only for research. Running a PSI linkage protocol and using it operationally can be challenging for organizations with limited techincal resources and requires deliberate attention to usability and deployment frictions.

Within organizations it is often the case that a program officer would benefit from exchanging data and even has a signed data sharing agreement in hand, yet the exchange stalls while other stakeholders' requirements are satisfied: security teams may require that any new software undergo a formal audit, compliance officers need explicit assurance about what data is disclosed and to whom, and IT departments must vet software against their own approval processes. While each concern is individually reasonable, they can collectively block an exchange that is otherwise ready to proceed. Other organizations have fewer procedural hurdles to overcome but lack technical sophistication. As such, the majority of the project is designed to work locally in a browser so as to not require additional software to be installed, and data should only flow through trusted channels. Browser-based solutions should have modern, user-centered interfaces.

# Threat Model

The deployment frictions described above arise in part from the following security properties the system is designed to uphold. This system is designed to limit what can be learned by an honest-but-curious adversary. Its primary goal is to prevent parties from learning anything about each other's data beyond the mapping between shared members. In the case of PSI-C, it should only reveal the size of the set of shared members. It is expected that parties using either protocol will have a legal agreement that permits the use of the tool.

A malicious adversary cannot learn anything beyond what the PSI protocol reveals, but they could attempt a membership attack using specific inputs. For instance, if a statistical linkage key was as simple as just the social security number, it would be easy to brute-force. To protect against this, we recommend that keys combine multiple elements of personally identifiable information (PII). Membership attacks would still be possible, but only if a person's PII is already known.

Separately from adversarial attacks, we note that the PSI primitive we use inherently leaks the size of each partys' sets. This is considered acceptable for the use-case of linking administrative data, as it is individual membership and identifying information that is considered sensitive and not the size of the database. 

When using public services to facilitate scheduled exchanges, some metadata around the exchange is leaked such as who is conducting the exchange and when. Parties are encouraged to stand up their own services when necessary and resources to facilitate this will be made available.

# Exchange Agreement Specification

When two parties meet to exchange data, they must first share and verify an *exchange agreement*, a JSON document that contains all of the particulars on what will be shared and what will be done with it. Exchange agreements can be developed by hand or interactively using an application described below. They can be shared over conventional communication channels or become part of an invitation to exchange data relying on an ephemeral token.

After authentication has taken place at the start of each exchange, both parties swap exchange agreements; if any field is inconsistent with their own copy (with exceptions noted below), the exchange is cancelled. The exchange agreement includes:
* A version number identifying the schema of the exchange agreement document. If schema are incompatible, the exchange may fail.
* Identity strings for both parties, typically containing the name, organization, and contact information for a person at each party.
* A date field, indicating when the exchange agreement was last modified.
* Whether or not both parties will receive the output.
* Optionally, which role either party will play. Asymmetric data exchanges have implied roles by what the PSI protocol reveals. Symmetric exchanges will require less data to be transmitted if the party with the smaller dataset is the "client". If a specific role isn't given, the server/client distinction can be made arbitrarily by the order parties initiate connections, or parties can exchange the sizes of their datasets.
* If the output is the association table or the cardinality. If the output is the association table, parties may also indicate that they intend to send payloads that correspond to their matched elements.
* The multiplicity of the linkage: one-to-one, one-to-many, or many-to-many. For one-to-many, the exchange agreement must specify which party's records are the constrained side. Both parties must supply all data elements needed for all keys regardless of multiplicity.
* The linkage keys themselves. This includes a descriptive name of the key, the semantic type of each combined data element (e.g. first name, SSN, phone number, etc), and any constraints those data elements must fulfill.
  * For example, dates-of-birth fields have specific formats, social security numbers can be subject to validation, and names may have limited character sets and/or have titles and suffixes prohibited.
  * Linkage keys may also indicate that two elements must be transposed, in which case the role of each party implies who produces the transposed and who produces the un-transposed version. For instance, a key might involve matching first name swapped with last name and "clients" transpose their data elements while "servers" do not.
* Whether or not additional data will be transferred for matched elements, and if so a data dictionary for the elements to be sent and to be received.
  * The data dictionary should consist of a description of each column and any usage notes.
  * Data exchange can be asymmetric, and parties can "discover" the data dictionary after receiving it the first time. 
* An optional reference to the legal agreement enabling the data exchange and its expiration date. If the agreement has expired, the exchange will fail.

As noted, not all fields require strict consistenty. Exchange agreements that do not have the same version number, identity string, dates, or data dictionaries by default cause a warning to be issued instead of raising an error. An agreement with the updated values is output and the user can supply it in the future.

Note that data cleaning is explicitly not part of the exchange agreement. It is up to each party to clean their own data to meet the standards required, and if they fail to do so they will simply degrade the quality of the match.

# Privacy Preserving Record Linkage

With the exchange agreement established, the PPRL protocol can proceed. It is composed of the following components:

## PSI Primitive

The PSI primitive is a lightly modified version of OpenMined's [PSI](https://github.com/OpenMined/PSI). That package implements private set intersection layering over Google's [Private Join and Compute](https://github.com/Google/private-join-and-compute), with a C++ implementation that is compiled into WebAssembly. The primitive protocol defines "server" and a "client" roles. At a high level, the steps of the protocol are:

1. Both client and server generate their own private keys which live only in memory for the duration of the exchange. Keys are random scalars in the P-256 elliptic curve group and are generated using OpenSSL.
2. The client initializes the exchange by encrypting their own data with their own private key using a commutative encryption algorithm and then sends it to the server.
3. The server commutatively encrypts both their own data and the client's data with their own private key and then send both datasets to the client.
4. The client can then remove their own key from their own data, leaving them with client and server datasets encrypted only by the server.
5. A straightforward string comparison allows the client to see which elements they have in common. They can then choose to share the association table back with the server.

The terminology of "server" and "client" is disfavored in this project as there are many other instances of servers and clients, and OpenMined's PSI includes no actual server code. Most often we will want to execute the protocol so that both parties learn the association between their members, making the roles they play are arbitrary.

## Linkage Keys

By repeatedly executing the PSI primitive on statistical linkage keys generated from an input data set, two parties can run a fuzzy PPRL. The most common data elements for linkage keys are social security number, first name, last name, and date of birth. An example of a linkage key is the last four digits of the social security number concatenated with last name and date-of-birth as a character string. Linkage keys must be designed to be precise enough (high positive-predictive value) that any match is definitive, preserving the guarantee that no information is revealed about individuals not in the intersection.

## Data Cleaning

Before the PSI protocol executes, each party must prepare their input data into the form expected by the linkage keys. Data cleaning pipelines can be specified as a separate input to the program as the composition of cleaning functions applied to specific input fields whose outputs are combined to form linkage keys. For example, one party might take their first name input field, remove all punctuation, trim whitespace, and cast the result to upper-case. Linkage keys might use this "cleaned" name field wholesale, take substrings, or apply a phonetic algorithm, which can then be combined with other cleaned and mapped fields to form a distinct linkage key. A library of common cleaning functions will be made available and parties can always pre-clean their data if desired. This functionality is largely a convenience intended for parties who lack technical sophistication, as any desired result can also be achieved by independently modifying the input data.

## Input Metadata

Parties can choose to supply metadata with their input files that indicates the semantic type of each column, including data for linkage, unique identifier columns, and optional payload data that will be sent to their partner after common members have been identified. The metadata also includes a party's data dictionary (see the Exchange Agreement Specification above). If no metadata file is supplied, metadata is inferred from the column names. By default, payload data is not shared but identifiers are.

## Matching Algorithms

### PSI

For one-to-one mappings, linkage keys are applied in sequence forming a cascade of deterministic linkages: keys are ordered from most to least precise, and at each round only records that match uniquely on that key are accepted as pairs and removed from the candidate set. Inputs without a match or without a unique linkage key carry forward to the next round. Removing matched elements from the candidate set and only transmiting unique linkage keys requires transmitting the indices of encrypted elements as additional overhead.

In linkages that involve multiple links - either many-to-one or many-to-many - the multiplicity will be resolved into single entity clusters by applying a transitive closure algorithm. A transitive closure may create a scenario where two members are linked through a third record without a rule linking them directly, so careful consideration of linkage keys and their consequences is required. In a many-to-one exchange, the "many" party filters its candidate set to remove linked elements after each round similar to the deterministic cascade in a one-to-one. Note that a many-to-many exchange only makes sense provided that the association map is revealed to both parties, as the "many" part implies that some meaning is imparted to the data holder through the entity resolution step. 

Crucially, unlike traditional PPRL, blocking is neither necessary nor appropriate here. PSI's computational complexity is O(n log n) in the total number of elements rather than quadratic in their product, so there is no cross-product comparison to reduce. Blocking would also compromise the privacy guarantee by revealing to each party how many of the other's records fall into each partition.

The practical upper limit on the number of records for browser-based execution is determined by available memory rather than computation: each encrypted element occupies roughly 64 bytes, so holding both parties' encrypted sets simultaneously for the comparison step requires on the order of 1–2 GB for datasets in the tens of millions of rows — well within the capacity of a modern workstation. The only part of the algorithm that requires WebAssembly is the application of the commutative encryption algorithm, which can be streamed and parallelized over the data.

### PSI-C

PSI-C is also executed by sequentially executing deterministic linkages. Membership anonymity is granted by the server permuting the client's doubly-encrypted data before returning it to them. The results of multiple linkage keys can be combined so long as the server uses a consistent permutation algorithm for each round. The association map in the permuted space has the same size as one in the original space so that the cardinality can be measured, but it does not reveal which specific members are in common.

# Post-linkage Steps

## Non-repudiation

At the conclusion of a successful exchange but before the association map is shared, both parties sign a receipt recording the timestamp, a hash of the exchange agreement, the identities of both parties, and the size of the result, and exchange these signatures. Each party retains the other's signature as cryptographic evidence that the exchange occurred. Each party can sign the exchange receipt using either a session-derived key — sufficient for the parties' own records but not independently verifiable by outsiders — or a certificate-authority-backed private key, which allows auditors or legal bodies to verify the signatures without any prior knowledge of the exchange.

Catastrophic failure to exchange receipts results in termination of the program and the exchange must be restarted. Dropped connections are retried and undelivered messages are sent again.

Retention, access controls, and log integrity beyond the receipt remain each party's internal compliance obligation.

## Output

The fundamental output is an association table between each party's element. If parties supplied identifier columns with their inputs and flagged them in their metadata, the association table will be between each party's identifiers. Otherwise, the table references the row indices of each dataset.

If parties elected to transmit payload data, the relevant columns for the appropriate rows will be transmitted and appended to the output.

# Architecture

The protocol, exchange agreements, and communication layer described in this document are built into a single library whose functionality is exposed to users through two applications, one delivered in the web browser and one used through the command line.

When adopting the software, program officers are likely to first conduct exchanges with the web application in order to establish the business case for using the software, either by operating on previously established data sharing agreements or running a PSI-C algorithm to measure the size of shared membership. The web application allows for setting and exporting exchange parameters, which can be handed off to IT professionals who can automate the procedure. They are likely to use the command line application as it can be more easily integrated with other data processes, such as exporting the data to be shared and ingesting the data received.

## Base Library

The library includes the PSI primitive, exchange agreement verification, input ingestion, linkage key generation, the execution of the linkage algorithms over PSI, and the generation and signing of the receipt. The various libraries that are run-time dependent, such as communication channels and cryptography, are abstracted over and need to be supplied by specific applications.

## Web Application

The "web application" should be a management interface for exchanges. It should allow for the inspection and editing of one-off and recurring exchanges, setting their parameters, adjusting their schedules, and viewing their logs.

A file containing the information necessary to execute an exchange should be downloadable from the web app for use by the command line application, so it would be of benefit if the web application had user-friendly ways of creating those files including a data-explorer and metadata labeler, linkage rule creator, and data cleaning pipeline creator.

If the browser window is left open, it should run scheduled exchanges at the appropriate time. Note that this is a sub-optimal experience, as it is easy to accidentally close the application.

The web application should enable invite exchanges. A user should be able to generate a shared secret for their partner, instantiate an ephemeral peer coordination server using a serverless compute platform, generate a secret for use with that coordination server, and transfer the necessary information to the other party.

It should be able to be built as a desktop Electron app, or possibly able to be saved as a progressive web app. These options can behave more like system services, but will likely require additional IT review.

## Command Line Application

The command line application should enable the automation of all exchange operations and can be integrated into data pipelines. Recurring exchanges can be executed through external schedulers or orchestrators, making it the preferred interface for IT professionals operationalizing exchanges that program officers established via the web application.

# Communication

The protocol components above define what data parties exchange; this section describes how that exchange is carried over a network. This includes the channels available for transmission, how parties verify each other's identity, and how they coordinate the sequencing of protocol steps.

## Channels

If the exchange is to be accomplished without additional infrastructure, it should utilize existing communication channels. Two communication channels have been identified so far:

* Peer-to-peer using WebRTC - this is a protocol that is primarily used by browsers to communicate with each other, for example when conducting video calls. Peer-to-peer connections can be difficult to establish when parties are behind corporate firewalls and using Network Address Translation (NAT). To facilitate these connections, a third-party server typically needs to be available to execute to either help establish the connection, or to explicitly route the traffic.
* SFTP - for many exchanges, one partner already runs an SFTP server that is used for secure file transfers. SFTP is less-than-ideal for a communication protocol, as it is a file transfer protocol and not a direct connection. That said, with frequent polling and strategies to resolve synchronization, it can be treated as a message passing channel with slight delays for each message. As the number of messages is independent of the size of the datasets, this represents a fixed, tolerable time cost.

Additional channels will be selected based on infrastructure and deployment conversations with potential users.

## Authentication

Before establishing connections, clients need to ensure that they are communicating with the correct partner. They can either share a secret that will be used to further encrypt their data, or they can "meet in a trusted spot".

In order to share secrets, one party generates a random cryptographic token using an available cryptography library and shares it with their partner using a trusted, existing communication channel such as secure email. In order to proceed, both parties must execute a Password Authenticated Key Exchange (PAKE) protocol, such as SPAKE2 with the shared token as the password input.

"Meeting in a trusted spot" really refers to already having a trusted form of communication which both parties want to reuse for the exchange. For an SFTP connection, user and path management on the server-side can ensure that no one else is able to listen in. This offloads trust to the SFTP server's administrator to ensure that the directory is specific to the exchange and cannot be accessed by other users. This method may be preferable if managing an additional encryption key is perceived as too burdensome, even though it is less secure overall.

## Channel Security

WebRTC connections use a DTLS layer and provide an encrypted end-to-end communication channel. Connections made over SFTP will assume an honest-but-curious server administrator and use an Authenticated Encryption with Associated Data (AEAD) ciphers to encrypt messages using HMAC-based Extract-and-Expand Key Derivation Function (HKDF) to derive an encryption key from the PAKE session key. Each message will include a sequence number as the nonce, which also prevents replay. The server admin sees only opaque ciphertext files. If they tamper with a file, the authentication tag fails and the exchange aborts.

## Synchronization

The protocol requires both parties to execute it at the same time. For a new exchange where one party may "invite" the other, the inviter can listen for the other partner to respond. For scheduled exchanges, which party shows up first is arbitrary and in order to execute the protocol there needs to be a way of resolving who will "speak" first and who will "listen".

For WebRTC, this is solved by a single-threaded peer-coordination service which ensures only one party can be "first". For SFTP, an implementation has been written that utilizes the uniqueness of file handles and catching server errors to handle the rare race condition of both parties arriving at the same time.

## Error Handling

In the case of communication channel errors, messages are retried and parties will time-out while waiting to receive messages. Dropped connections will attempt to be opened up to a user-specified limit. As the communication channels in use guarantee message correctness, any message that fails to validate indicates a deviation from the protocol and will result in program termination and user intervention.

## Supporting Services

The communication channels described above each depend on supporting infrastructure. Rather than relying on persistent third-party servers, these services are intended to be ephemeral — instantiated on demand for a given exchange and torn down afterward — to minimize infrastructure burden. It should be possible to deploy these services in multiple ways so that IT departments can support the application using the platform they prefer. Our organization will provide them as a public resource, and users will have the option to rely on them as fallbacks. If they do so, the program will issue a warning indicating that their encrypted data has to flow through a server outside of their direct control.

### STUN/TURN

For parties that don't have a public IP and are behind Network Address Translation (NAT), an Internet Connectivity Establishment (ICE) protocol must be used to establish peer-to-peer connections. This typically relies on a server that implements the Session Traversal Utilities for NAT (STUN) protocol. If this fails, a server implementing Traversal Using Relays around NAT (TURN) can be used to tunnel the traffic.

### Web-socket to TCP

Browser runtimes are unable to open raw TCP connections, and instead have to rely on Websockets. A proxy server can translate this traffic and allow direct TCP connections, so that, for example, a web browser can open an ssh connection.

### Peer-coordination

Connecting peer-to-peer without knowing the address typically requires coordination beyond the STUN or TURN server. When two parties request to talk to each other through such a server, the server responds by telling both parties each others' addresses.

### SFTP

Although not entirely necessary for the project, it can be beneficial to have light-weight installations of SFTP servers for illustration purposes.

# Possible Extensions

## Multiple Potential Matches

The deterministic cascade requires that each linkage key be precise enough to produce only definitive matches. This is a deliberate constraint that preserves the core privacy guarantee of PSI, but it rules out pairing algorithms that score or threshold matches across multiple keys — doing so requires running PSI on keys that may produce non-definitive matches, revealing information about individuals who are not in the final intersection.

Threshold and weighted scoring approaches could be supported without this privacy cost using secure multi-party computation (MPC) to evaluate match scores over encrypted data, never exposing intermediate per-key match results. This would substantially increase protocol complexity and is left as a potential future extension.

## Brute Force Protection

As mentioned in the threat model, brute-force attacks are possible for simple keys. At some point, we may choose to implement controls that prevent the algorithm from running if the input is a relatively large portion of the potential universe of possible values.

## SSH as a Unified Channel

The current design uses two separate communication channels — WebRTC for synchronous exchange and SFTP for asynchronous exchange — each with distinct authentication mechanisms. An SSH server could serve as a single intermediary for both modes. For synchronous exchange, both parties open SSH sessions and the server bridges them via remote port forwarding or direct-tcpip channels, replacing the WebRTC peer-to-peer connection and its supporting STUN/TURN infrastructure. For asynchronous exchange, the same server's SFTP subsystem handles file-based message passing as currently described. Browser clients connect to the SSH server via the WebSocket-to-TCP proxy already described in Supporting Services.

Authentication would use SSH public keys or short-lived certificates rather than the PAKE-based shared token, replacing out-of-band secret sharing with SSH's own PKI. If parties already have SSH infrastructure and a trusted means of exchanging public keys, this is strictly more auditable and familiar to IT departments. The trade-off is that provisioning SSH credentials for a one-off exchange carries more overhead than sharing a random token over secure email.
