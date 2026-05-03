---
title: "PSI-Link"
author: "Georgetown Massive Data Institute"
date: 2026-04-30
---

The goal of this project is to facilitate secure inter-agency data sharing of administrative records. This is accomplished by executing a privacy-preserving record linkage (PPRL) protocol based on private set intersection (PSI). A PSI primitive is repeatedly used by two parties to identify which of several statistical linkage keys their data elements have in common, resulting in the association map between each party's elements being revealed. Those parties can then exchange additional data elements for their common members. Alternatively, the parties can run a private set intersection cardinality (PSI-C) protocol to determine the number of members they have in common, which may provide motivation for high-level program discussion about data sharing.

Beyond the privacy-preserving nature of the algorithm and the quality of the match, two key project priorities are ease of use and the reduction of security, compliance, and information-technology frictions. Within organizations it is often the case that a program officer would benefit from exchanging data and even has a signed data sharing agreement, but other stakeholders concerns must first be met. As such, the majority of the project is designed to work locally in a browser so as to not require additional software to be installed, and data should only flow through trusted channels. In addition, browser-based solutions should have modern, user-centered-designed interfaces.

# Threat Model

This system is designed to limit what can be learned by an honest-but-curious adversary. Its primary goal is to prevent parties from learning anything about each other's data beyond  the mapping between shared members. In the case of PSI-C, it should only reveal the size of the set of shared members.

A malicious adversary cannot learn anything beyond what the PSI protocol reveals, but they could attempt a membership attack using specific inputs. For instance, if a statistical linkage key was as simple as just the social security number, it would be easy to brute-force. To protect against this, we recommend that keys combine multiple elements of personally identifiable information (PII). Membership attacks would still be possible, but only if a person's PII is already known.

Finally, we note that the PSI primitive we use leaks the size of each party's sets.

# Privacy Preserving Record Linkage

The PPRL protocol involves the following components:

## PSI Primitive

The PSI primitive is a lightly modified version of OpenMined's [PSI](https://github.com/OpenMined/PSI). That package implements private set intersection layering over Google's [Private Join and Compute](https://github.com/Google/private-join-and-compute), with a C++ implementation that is compiled into WebAssembly. The primitive protocol defines "server" and a "client" roles. At a high level, the steps of the protocol are:

1. Both client and server generate their own private keys which live only in memory for the duration of the exchange. Keys are random scalars in the P-256 elliptic curve group and are generated using OpenSSL.
2. The client initializes the exchange by encrypting their own data with their own private key using a commutative encryption algorithm and then sends it to the server.
3. The server commutatively encrypts both their own data and the client's data with their own private key and then send both datasets to the client.
4. The client can then remove their own key from their own data, leaving them with client and server datasets encrypted only by the server.
5. A straightforward string comparison allows the client to see which elements they have in common. They can then choose to share the association table back with the server.

If the server applies a permutation when sending back to the client the client's data with both sets of encryption keys, the client will no longer be able to determine the mapping between elements but can still learn its size, yielding the PSI-C protocol.

The terminology of "server" and "client" is disfavored throughout the rest of this project as there will be many other instances of servers and clients, and in this case OpenMined's PSI includes no actual server code. Often we will want to execute the protocol so that both parties learn the result, so that the roles they play are arbitrary.

## Linkage Keys

By repeatedly executing the PSI primitive on statistical linkage keys generated from an input data set, two parties can run a fuzzy PPRL. The most common data elements for linkage keys are social security number, first name, last name, and date of birth. An example of a linkage key is the last four digits of the social security number concatenated with last name and date-of-birth as a character string.

## Match Algorithm - PSI

For one-to-one mappings, linkage keys are applied in sequence using a cascade of deterministic linkages: keys are ordered from most to least precise, and at each round only records that match uniquely on that key are accepted as pairs and removed from the candidate set. Ambiguous matches carry forward to the next round. Keys must be designed to be precise enough that any match is definitive, preserving the guarantee that no information is revealed about individuals not in the intersection.

In linkages that involve multiple links, either many-to-one or many-to-many, the links can be resolved into single entity clusters by applying transitive closure to the resulting match graph. In a many-to-one exchange, the "many" party filters its candidate set to remove linked elements after each round similar to the deterministic cascade. Note that a many-to-many exchange only makes sense provided that the association map is revealed to both parties, as the "many" part implies that some meaning is imparted to the data holder through the entity resolution step. 

Unlike traditional PPRL, blocking is neither necessary nor appropriate here. PSI's computational complexity is O(n log n) in the total number of elements rather than quadratic in their product, so there is no cross-product comparison to reduce. Blocking would also compromise the privacy guarantee by revealing to each party how many of the other's records fall into each partition.

The practical upper limit on the number of records for browser-based execution is determined by available memory rather than computation: each encrypted element occupies roughly 64 bytes, so holding both parties' encrypted sets simultaneously for the comparison step requires on the order of 1–2 GB for datasets in the tens of millions of rows — well within the capacity of a modern workstation.

## Match Algorithm - PSI-C

PSI-C with a one-to-one mapping requires that the server apply a consistent permutation when returning the client's doubly-encrypted data. The algorithm is unable to fully exploit the efficiencies of the deterministic cascade algorithm introduced by filtering the data with each successive linkage key: the cascade requires knowing which elements to remove from the candidate set after each round. The client observes complete match information in the permuted space, which allows to them to perform a one-to-one linkage whose set size is the same as a true linkage but whose association map reveals no sensitive data.

## PSI Contract

When two parties meet to exchange data, they must first agree on the protocol they will execute and thus enter into a contract. At the start of each exchange, the initiating party transmits their copy of the contract; if any field differs from the receiving party's copy, the exchange is cancelled. The contract includes:
* A version number identifying the schema of the contract document.
* Whether or not both parties will receive the output.
* Which role either party will play. If the exchange of the result is symmetric, this reduces to which partner will go first.
* If the output is the association table or the cardinality. If the output is the association table, parties may also indicate that they intend to send payloads that correspond to their matched elements.
* The multiplicity of the linkage: one-to-one, one-to-many, or many-to-many. For one-to-many, the contract must specify which party's records are the constrained side. Both parties must supply all data elements needed for all keys regardless of multiplicity.
* The linkage keys themselves. This includes a descriptive name of the key, the semantic meaning of each combined data element, and any constraints those data elements must fulfill. For example, dates-of-birth fields have specific formats, social security numbers can be subject to validation, and names may have limited character sets and/or have titles and suffixes prohibited.
* Whether or not additional data will be transferred for matched elements, and if so a data dictionary for the elements to be sent and to be received. Data exchange can be asymmetric, and parties can "discover" data after receiving it the first time.
* An optional reference to the legal agreement enabling the data exchange and its expiration date. If the agreement has expired, the exchange will fail.

## Data Cleaning

In order to meet the linkage key components of the contract, each party must clean their own data. This involves specifying data cleaning pipelines comprised of the composition of cleaning functions. For example, one party might take their first name input field, remove all punctuation, trim whitespace, and cast the result to upper-case. Linkage keys might use this "cleaned" name field wholesale, take substrings, or apply a phonetic algorithm. A library of common cleaning functions will be made available and parties can always pre-clear their data if desired.

Data cleaning is each party's responsibility and data that does not meet the contract will link poorly or not at all.

## Payloads and Metadata

As indicated, parties can choose to send data to their partner after common members have been identified. This is accomplished by supplying additional data columns with the input file. To manage this feature, users can supply metadata that indicates the semantic meaning of columns to be used in data linkage, whether additional columns should be transferred, and if a column is a unique identifier used by that party. Identifier columns can be used in the association table instead of row indices for ease of ingestion back into data systems.

# Communication

The protocol components above define what data parties exchange; this section describes how that exchange is carried over a network. This includes the channels available for transmission, how parties verify each other's identity, and how they coordinate the sequencing of protocol steps.

## Channels

If the exchange is to be accomplished without additional infrastructure, it should utilize existing communication channels. Two communication channels have been identified so far:

* Peer-to-peer using WebRTC - this is a protocol that is primarily used by browsers to communicate with each other, for example when conducting video calls. Peer-to-peer connections can be difficult to establish when parties are behind corporate firewalls and using Network Address Translation (NAT). To facilitate these connections, a third-party server typically needs to be available to execute to either help establish the connection, or to explicitly route the traffic.
* SFTP - for many exchanges, one partner already runs an SFTP server that is used for secure file transfers. SFTP is less-than-ideal for a communication protocol, as it is a file transfer protocol and not a direct connection.

Additional channels will be selected based on infrastructure and deployment conversations with potential users.

## Error Handling

In the case of communication channel errors, messages are retried and parties will time-out while waiting to receive messages. Dropped connections will attempt to be opened up to a user-specified limit. As the communication channels in use guarantee message correctness, any message that fails to validate indicates a deviation from the protocol and will result in program termination and user intervention.

## Authentication

Before establishing connections, clients need to ensure that they are communicating with the correct partner. They can either share a secret that will be used to further encrypt their data, or they can "meet in a trusted spot".

In order to share secrets, one party generates a random cryptographic token using an available cryptography library and shares it with their partner using a trusted, existing communication channel such as secure email. In order to be connected for a peer-to-peer exchange, both parties must first execute a Password Authenticated Key Exchange (PAKE) protocol. When connecting over SFTP, both parties use the shared token to derive a symmetric encryption key, which is then used to encrypt all protocol messages before they are written to the SFTP server. This ensures that the server operator cannot derive meaning from the messages.

"Meeting in a trusted spot" really refers to already having a trusted form of communication which both parties want to reuse for the exchange. For an SFTP connection, user and path management on the server-side can ensure that no one else is able to listen in. This offloads trust to the SFTP server's administrator to ensure that the directory is specific to the exchange and cannot be accessed by other users. This method may be preferable if managing an additional encryption key is perceived as too burdensome, even though it is less secure overall.

## Synchronization

The protocol requires both parties to execute it at the same time. For a new exchange where one party may "invite" the other, the inviter can listen for the other partner to respond. For scheduled exchanges, which party shows up first is arbitrary and in order to execute the protocol there needs to be a way of resolving who will "speak" first and who will "listen".

For WebRTC, this is solved by a single-threaded peer-coordination service which ensures only one party can be "first". For SFTP, an implementation has been written that utilizes the uniqueness of file handles and catching server errors to handle the rare race condition of both parties arriving at the same time.

## Non-repudiation

At the conclusion of a successful exchange, both parties sign a receipt recording the timestamp, a hash of the contract, the identities of both parties, and the size of the result, and exchange these signatures before closing the connection. Each party retains the other's signature as cryptographic evidence that the exchange occurred. Each party can sign the exchange receipt using either a session-derived key — sufficient for the parties' own records but not independently verifiable by outsiders — or a certificate-authority-backed private key, which allows auditors or legal bodies to verify the signatures without any prior knowledge of the exchange.

Catastrophic failure to exchange receipts results in termination of the program and the exchange must be restarted.

Retention, access controls, and log integrity beyond the receipt remain each party's internal compliance obligation.

# Services

The communication channels described above each depend on supporting infrastructure. Rather than relying on persistent third-party servers, these services are intended to be ephemeral — instantiated on demand for a given exchange and torn down afterward — to minimize infrastructure burden. It should be possible to deploy these services in multiple ways so that IT departments can support the application using the platform they prefer. Our organization will provide them as a public resource, but agencies will be warned whenever their (encrypted) data has to flow through an unexpected source.

## STUN/TURN

For parties that don't have a public IP and are behind Network Address Translation (NAT), an Internet Connectivity Establishment (ICE) protocol must be used to establish peer-to-peer connections. This typically relies on a server that implements the Session Traversal Utilities for NAT (STUN) protocol. If this fails, a server implementing Traversal Using Relays around NAT (TURN) can be used to tunnel the traffic.

## Web-socket to TCP

Browser runtimes are unable to open raw TCP connections, and instead have to rely on Websockets. A proxy server can translate this traffic and allow direct TCP connections, so that, for example, a web browser can open an ssh connection.

## Peer-coordination

Connecting peer-to-peer without knowing the address typically requires coordination beyond the STUN or TURN server. When two parties request to talk to each other through such a server, the server responds by telling both parties each others' addresses.

## SFTP

Although not entirely necessary for the project, it can be beneficial to have light-weight installations of SFTP servers for illustration purposes.

# Architecture

The protocol, communication mechanisms, and supporting services described above are built into a single library whose functionality is exposed to users through two applications, one delivered in the web browser and one used through the command line.

When adopting the software, program officers are likely to first conduct exchanges with the web application in order to establish the business case for using the software, either by operating on previously established data sharing agreements or running a PSI-C algorithm to measure the size of shared membership. The web application allows for setting and exporting exchange parameters, which can be handed off to IT professionals who can automate the procedure. They are likely to use the command line application as it can be more easily integrated with other data processes, such as exporting the data to be shared and ingesting the data received.

## Web Application

The "web application" should be a management interface for exchanges. It should allow for the inspection and editing of one-off and recurring exchanges, setting their parameters, adjusting their schedules, and viewing their logs.

A file containing the information necessary to execute an exchange should be downloadable from the web app for use by the command line application, so it would be of benefit if the web application had user-friendly ways of creating those files including a data-explorer and metadata labeler, linkage rule creator, and data cleaning pipeline creator.

If the browser window is left open, it should run scheduled exchanges at the appropriate time. Note that this is a sub-optimal experience, as it is easy to acidentially close the application.

The web application should enable invite exchanges. A user should be able to generate a shared secret for their partner, instantiate an ephemeral peer coordination server using a serverless compute platform, generate a secret for use with that coordination server, and transfer the necessary information to the other party.

It should be able to be built as an desktop Electron app, or possibly able to be saved as a progressive web app. These options can behave more like system services, but will likely require additional IT review.

## Command Line Application

The command line application should enable the automation of all features of the web application through the use of a scheduler.

# Possible Extensions

## Multiple Potential Matches

The deterministic cascade requires that each linkage key be precise enough to produce only definitive matches. This is a deliberate constraint that preserves the core privacy guarantee of PSI, but it rules out pairing algorithms that score or threshold matches across multiple keys — doing so requires running PSI on keys that may produce non-definitive matches, revealing information about individuals who are not in the final intersection.

Threshold and weighted scoring approaches could be supported without this privacy cost using secure multi-party computation (MPC) to evaluate match scores over encrypted data, never exposing intermediate per-key match results. This would substantially increase protocol complexity and is left as a potential future extension.

## Brute Force Protection

As mentioned in the threat model, brute-force attacks are possible for simple keys. At some point, we may choose to implement controls that prevent the algorithm from running if the input is a relatively large portion of the potential universe of possible values.
