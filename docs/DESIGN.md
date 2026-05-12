---
title: "PSI-Link"
author: "Georgetown Massive Data Institute"
date: 2026-05-04
---

# Overview

The goal of this project is to facilitate secure inter-agency data sharing of administrative records. This is accomplished by executing a privacy-preserving record linkage (PPRL) protocol based on private set intersection (PSI). A base implementation of PSI executes a cryptographic protocol between two parties who each have lists of strings and reveals to one or both parties the elements they have in common. This base function can be used repeatedly by two parties to identify which of several statistical linkage keys they share, generating an association map between each party's matched elements. Those parties can then exchange additional data elements for their common members. Alternatively, the parties can run a private set intersection cardinality (PSI-C) protocol to determine the number of members they have in common without revealing their identities, which may provide motivation for high-level program discussions about data sharing. The PPRL using PSI is intended for operational use, while PSI-C is intended only for research.

Running a PSI linkage protocol and using it operationally can be challenging for organizations with limited techincal resources and requires deliberate attention to usability and deployment frictions. Within organizations it is often the case that a program officer would benefit from exchanging data and even has a signed data sharing agreement in hand, yet the exchange stalls while other stakeholders' requirements are satisfied: security teams may require that any new software undergo a formal audit, compliance officers need explicit assurance about what data is disclosed and to whom, and IT departments must vet software against their own technology requirements. In contrast, smaller organizations may have fewer procedural hurdles but they often lack the technical sophistication to perform regular data linking and sharing. In order to useful to these two audiences, the project is designed to first work locally in a browser without requiring additional software to be installed and restricting data to flow through trusted channels. For ease-of-use, browser-based solutions have have modern, user-centered interfaces. Users willing to install software can use a containerized, command line application to perform all the same functionality which is easily hardened and integrates with a variety of infrastructures.

# Threat model

The system is designed to be utilized by partner agencies with signed data sharing agreements, and the primary goal of the security design is to prevent parties from learning anything about each other's data beyond the mapping between shared members. With that in mind, an honest-but-curious threat model has been adopted which assumes that partners are not actively tampering with inputs, but that it is still beneficial to minimize what is disclosed.

For each successive use of the base PSI function, information is revealed to each party. For PSI, this includes the key that links individual members. For PSI-C, the cardinality of that key can be learned. This implies that linkage keys could be chosen to reveal sensitive information through a differencing attack in order to reveal membership, so it is crucial that both parties review the linkage keys before agreeing to use them.

A malicious adversary cannot learn anything beyond what the PSI protocol reveals, but they can attempt a membership attack using specific inputs. For instance, if a statistical linkage key included only social security numbers, it would be easy to brute-force. To protect against this, it is recommended that keys combine multiple elements of personally identifiable information (PII). Even with complex linkage keys, membership attacks are still possible but only if a target's PII is already known.

Separately from adversarial attacks, note that the PSI base function used inherently leaks the size of each parties' sets. This is considered acceptable for the use-case of linking administrative data, as it is individual membership and identifying information that is considered sensitive and not the size of the database. 

When using public services to facilitate scheduled exchanges, some metadata around the exchange is leaked such as who is conducting the exchange and when. Parties are encouraged to stand up their own services when necessary and resources to facilitate this are available.

# Privacy preserving record linkage

The PPRL protocol utilizes a base PSI function to repeatedly reveal the size of the sets of shared statistical linkage keys. This reveals to the parties an association map between their shared members and nothing about elements they do not have in common.

## PSI base function

The PSI base function is a lightly modified version of OpenMined's [PSI](https://github.com/OpenMined/PSI). That package implements private set intersection layering over the encryption in Google's [Private Join and Compute](https://github.com/Google/private-join-and-compute) (itself using OpenSSL), written in C++ that is compiled into WebAssembly. The base function divides the two participants into "server" and a "client" roles. At a high level, the steps of the protocol are:

1. Both client and server generate their own private keys which live only in memory for the duration of the exchange. Keys are random scalars in the P-256 elliptic curve group and are generated using OpenSSL.
2. The client initializes the exchange by encrypting their own data with their own private key using a commutative encryption algorithm and then sends it to the server.
3. The server commutatively encrypts both their own data and the client's data with their own private key and then sends both datasets to the client.
4. The client can then remove their own key from their own data, leaving them with client and server datasets encrypted only by the server.
5. A straightforward string comparison allows the client to see which elements they have in common. They can then choose to share the association table back with the server.

The terminology of "server" and "client" derives from OpenMined's PSI implementation and is used here to be consistent with their documentation. However, "server" and "client" are disfavored throughout the rest of this project as there are many other instances of servers and clients, and OpenMined's PSI includes no networking coding. Most often we will want to execute the protocol so that both parties learn the outcome. When it is necessary to distinguish between the two roles, we will instead use *receiver* and *sender* respectively. When only one party receives output, that party's role is fixed as the receiver. When both parties receive output, roles are assigned dynamically: the party with the smaller dataset becomes the receiver (minimising data transmitted); ties are broken in favour of the initiator becoming the receiver.

## Linkage keys

Statistical linkage keys are data elements that combine several other inputs into a single value that uniquely represents an individual with an extremely high probability. In this application, the most common data types for linkage keys are social security number, first name, last name, and date of birth. An example linkage key is the last four digits of the social security number concatenated with last name and date-of-birth as a character string.

Linkage keys can be designed to produce links even in the place of data quality errors, for instance by exhaustively generating all transpositions of two digits in a Social Security Number (SSN) or comparing all single-character edits of strings of a fixed length. By repeatedly executing the PSI base function on such keys, two parties execute a fuzzy PPRL. 

In order to preserve the guarantee that no information is revealed about individuals not in the intersection, linkage keys must be designed to be precise enough (high positive-predictive value) that any match is definitive.

## Matching Algorithms

### PSI

The way in which links are decided depends on whether or not both parties will receive output. If so, then they can communicate directly with each other and optimize the procedure. For one-to-one mappings, linkage keys are applied in sequence forming a cascade of deterministic matches: keys are ordered from most to least precise, and at each round only records that match uniquely on that key are accepted as pairs and removed from the candidate set — the pool of records not yet definitively matched. Inputs without a match or without a unique linkage key carry forward to the next round. If only one party receives the output, then that party must send and receive all of both datasets every round in order to avoid leaking information about the number of matched elements. It must also keep track of the association map on its own in order to enforce a one-to-one mapping.

In linkages that involve multiple links - either many-to-one or many-to-many - the multiplicity is resolved into single entity clusters by applying a transitive closure algorithm. Transitive closure may create scenarios where two members are linked through a third record without a rule linking them directly, so careful consideration of linkage keys and their consequences is required. Having an output that includes multiple links per input implies that some meaning is imparted to the data holder through entity resolution; as such, these exchanges require that the "many" parties receive the output. In order to communicate this effectively to users, rather than describe the multiplicity of the exchange they are asked if they want to *deduplicate* their data, as they effectively use their partner's data to group their own.

In a many-to-one exchange where both parties receive the output, the "many" party can filter its candidate set to remove linked elements after each round similar to the deterministic cascade used in a one-to-one linkage. If the "one" party is not allowed to receive the output, the "many" party must ensure the uniqueness constraint.

Crucially, unlike traditional PPRL, blocking when using PSI is neither necessary nor appropriate. The PSI base function's computational complexity is O(n log n) in the total number of elements rather than quadratic in their product, so there is no cross-product comparison to reduce. Blocking would also compromise the privacy guarantee by revealing to each party how many of the other's records fall into each partition.

The practical upper limit on the number of records for browser-based execution is determined by available memory rather than computation: each encrypted element occupies roughly 64 bytes, so holding both parties' encrypted sets simultaneously for the comparison step requires on the order of 1–2 GB for datasets in the tens of millions of rows — well within the capacity of a modern workstation. The only part of the algorithm that requires WebAssembly is the application of the commutative encryption algorithm, which can be streamed and parallelized over the data.

### PSI-C

PSI-C is also executed by sequentially executing deterministic linkages. Membership anonymity is granted by the sender permuting the receiver's doubly-encrypted data before returning it to them. The results of multiple linkage keys can be combined so long as the sender uses a consistent permutation algorithm for each round. The association map in the permuted space has the same size as one in the original space. This allows the cardinality to be measured without revealing which specific members are in common.

# Exchange specification

The parameters necessary to execute an exchange are written down into a JSON or YAML documents which are supplied to an application. The components of an exchange specification include: the linkage terms which describes what will be exchanged and how, connection information which describes where the exchange will take place, metadata the describes the fields and their roles, and data cleaning transformations which simply provide convenience for low-tech users.

## Linkage terms

Every time two parties meet to exchange data and after authentication has taken place, both parties swap a document that describes their terms for the linkage, including what will be revealed and what will be done with it. The exchange follows a three-message protocol: the initiator sends their terms first; the responder replies with their own terms and a proceed/abort decision; the initiator then confirms their final decision. If either party finds the terms incompatible, it sends an abort with its reasons and the exchange is cancelled. Linkage terms include:
* A semantic versioning number identifying the schema of the linkage terms. If no schema migration exists, the exchange will fail.
* An identity string, typically containing the name, organization, and contact information for a person executing the agreement.
* A date field, indicating when the linkage terms were last modified.
* Whether or not the party expects to receive output.
* Whether or not the party expects their partner to receive output.
* If the algorithm is PSI or PSI-C.
* Whether or not this party's records should be deduplicated, i.e. if the linkage is one-to-X or many-to-X.
* Linkage fields and linkage keys. Linkage fields define the standardized form of each PII element that participates in linkage: their semantic type (e.g. first name, SSN, date of birth) and any constraints both parties commit to meeting for that field (e.g. character sets, SSA rules for SSNs, date validation). Linkage keys are built from linkage fields: each key element identifies a linkage field and optionally applies a transformation to its standardized value before concatenation (e.g. the first character of a name, or the first N digits of an SSN).
  * Although format could be part of the linkage field schema, with the addition of data transformations it makes sense to use standardized formats. `YYYYMMDD` and `XXXXXXXXX` (a nine-character string, not a number) are used for dates and SSNs respectively.
  * Linkage keys may also indicate that two elements must be swapped, in which case the role of each party implies who produces the swapped and who produces the un-swapped version. For instance, a key might involve matching first name swapped with last name, and receivers swap their data elements while senders do not.
* Whether or not additional data will be transferred for matched elements, and if so the names of the elements to be sent and to be received.
* An optional reference to the legal agreement enabling the data exchange and its expiration date. If the legal agreement has expired, the exchange will fail.

As noted, not all fields require strict consistency. Linkage terms that do not have the same date by default cause a warning to be issued instead of raising an error. A set of linkage terms with the updated value is output and the user can supply it in the future.

Note that data cleaning is explicitly not part of the linkage terms. It is up to each party to clean their own data to meet the standards required, and if they fail to do so they will simply degrade the quality of the match. Violation of linkage key constraints results in a warning, not an error. 

## Communication

Specific communication options are detailed below. Within the exchange specification, users must indicate the server or servers they intend to use, any required authentication information, and any shared cryptographic tokens shared with their partner.

## Input metadata

Parties can choose to supply metadata with their exchange specification that indicates the semantic type of each column, descriptions and usage notes, and column roles. A column's role (`linkage`, `identifier`, or `payload`) describes its primary purpose in the protocol. Separately, any column — regardless of role — can be marked as payload, meaning it is transmitted to the partner for matched members after the intersection is identified. Linkage and identifier columns can therefore serve dual purposes: a phone number column, for instance, can participate in PSI linkage and also be delivered as payload. Columns that are not used for linkage or identification must be payload columns. The description for payload columns is shared with partners as a data dictionary. If no metadata is supplied, it is inferred from column names. If not specified, payload data is not shared but identifiers are.

## Data cleaning

Before any PSI protocol executes, each party must prepare their input data as required by linkage keys. Data cleaning transformations can be provided as part of an exchange specification in the form of compositions of cleaning functions applied to specific input fields, each producing a named output that corresponds to a linkage field defined in the exchange agreement. Normalizing dates to `YYYYMMDD` and SSNs to `XXXXXXXXX` are canonical examples of cleaning steps that must be completed before linkage key generation. In a more complicated example, one party might take their last name input field, strip honorifics and suffixes, remove punctuation, convert to upper-case, and replace placeholders like `NONE` with a null value, producing the standardized `last_name` linkage field. A cleaning step may additionally produce multiple values from a single input — for example, splitting a hyphenated last name into its component parts. A library of common cleaning functions is available and parties can always pre-clean their data if preferred. See [Datasets](#datasets) for more details on how the standardized data is used in the linkage protocol.

# Datasets

## Raw data

Data is input as a csv or other tabular data format. These files include rough metadata such as column names and storage types, which can be augmented with [metadata](#input-metadata) from the exchange specification. Thus raw data consists of one or more columns, metadata for each column, and a record count.

## Standardized data

A standardized dataset bridges between raw data and the fields expected as inputs to linkage keys. It is an abstraction over the application of [data cleaning](#data-cleaning) transformations. As noted in that section, there can be zero, one, or more than one standardized record for any input, so a standardized data element is essentially a mapping between an index into the raw dataset and a set of strings. These mappings are lazily evaluated and their results are cached. A standardized dataset is a collection of these mappings and the names of the linkage key fields they provide.

## Key input data

As defined in [linkage terms](#linkage-terms), linkage fields are the inputs that are typically transformed to create the character strings that are concatenated to form statistical linkage keys. The linkage algorithm attempts to connect individuals - not just character strings - represented by their indices in the original dataset. Consequently, key inputs are realizations of linkage fields and are, like standardized data elements, maps between indices and sets of character strings of arbitrary size. In order to realize a complete linkage key, the set of all combinations of all key inputs is computed each and each combination is concatenated together into a string.

When that set has zero elements, i.e. one of the elements is `NULL`, it is omitted from the linkage protocol. When that set has more than one element and the algorithm is using the optimization implied by the deterministic cascade detailed in [Matching algorithms](#psi), communication is required in order to determine if the link is unique. For example, if one party has a member named "Mary Shaye-Smith" and another two members named "Mary Thorne" and "Mary Smith", unless the mapping was many-to-one it would be incorrect to accept both matches as valid and remove the individuals from the candidate set.

This extra communication step violates the threat model which guarantees that nothing can be learned about members that are not in common. That said, the existence of a match on a key would be sufficient evidence that two records represent the same person and it is only by revealing contradictory evidence that the link is not made. Users who employ these transformations are warned about their consequences.

# Communication

The protocol components above define what data parties exchange; this section describes how that exchange is carried over a network. This includes the channels available for transmission, how parties verify each other's identity, and how they coordinate the sequencing of protocol steps.

## Channels

If the exchange is to be accomplished without additional infrastructure, it must utilize existing communication channels. Two communication channels have been identified so far:

* Peer-to-peer using WebRTC - this is a protocol that is primarily used by browsers to communicate with each other, for example when conducting video calls. Peer-to-peer connections can be difficult to establish when parties are behind corporate firewalls and using Network Address Translation (NAT). To facilitate these connections, a third-party server typically needs to be available to execute to either help establish the connection, or to explicitly route the traffic.
* SFTP - for many exchanges, one partner already runs an SFTP server that is used for secure file transfers. SFTP is less-than-ideal for a communication protocol, as it is a file transfer protocol and not a direct connection. That said, with frequent polling and strategies to resolve synchronization, it can be treated as a message passing channel with slight delays for each message. As the number of messages is independent of the size of the datasets, this represents a fixed, tolerable time cost.

Additional channels will be selected based on infrastructure and deployment conversations with potential users.

## Authentication

Before establishing connections, parties need to ensure that they are communicating with the correct partner. They can either share a secret that will be used to further encrypt their data, or they can "meet in a trusted spot".

In order to share secrets, one party generates a random cryptographic token using an available cryptography library and shares it with their partner using a trusted, existing communication channel such as secure email. At the start of the exchange, both parties must execute a Password Authenticated Key Exchange (PAKE) protocol, such as SPAKE2 with the shared token as the password input.

The shared secret is automatically rotated after each successful exchange. The replacement secret is generated locally and transmitted to both parties over the established authenticated channel as part of the receipt step, taking effect only after the receipt has been confirmed by both parties. If the exchange fails before receipt confirmation, the existing secret remains valid and the next exchange can proceed normally. If a secret is lost after rotation, a new invitation can be generated from the existing configuration directory to re-establish a shared secret (see [Invitations](#invitations)).

Tokens generated for invitations carry a bounded lifetime. A default expiration window of 1 hour is used if none is provided by the inviting party. Because the invitation token is rotated on first use, it functions as a one-time setup credential: its window of validity is the period between generation and acceptance. Replacement tokens generated by rotation carry no expiration by default, making them suitable for recurring scheduled exchanges without further coordination.

"Meeting in a trusted spot" really refers to already having a trusted form of communication which both parties want to reuse for the exchange. For an SFTP connection, user and path management on the server-side can ensure that no one else is able to listen in. This offloads trust to the SFTP server's administrator to ensure that the directory is specific to the exchange and cannot be accessed by other users. This method may be preferable if managing an additional encryption key is perceived as too burdensome, even though it is less secure overall. After the first successful exchange, clients create a shared secret to use in the future.

## Channel Security

WebRTC connections use a DTLS layer and provide an encrypted end-to-end communication channel. Connections made over SFTP assume an honest-but-curious server administrator and use an Authenticated Encryption with Associated Data (AEAD) ciphers to encrypt messages using HMAC-based Extract-and-Expand Key Derivation Function (HKDF) to derive an encryption key from the PAKE session key. Each message includes a sequence number as the nonce, preventing replay. The server admin sees only opaque ciphertext files. If they tamper with a file, the authentication tag fails and the exchange aborts.

## Synchronization

The protocol requires both parties to execute it at the same time. For a new exchange where one party may "invite" the other, the inviter can listen for the other partner to respond. For scheduled exchanges, which party shows up first is arbitrary and in order to execute the protocol there needs to be a way of resolving who will "speak" first and who will "listen".

For WebRTC, this is solved by a single-threaded peer-coordination service which ensures only one party can be "first". For SFTP, an implementation has been written that utilizes the uniqueness of file handles and catching server errors to handle rare race conditions.

When using a public coordination server, WebRTC additionally requires both parties to know each other's peer IDs before a connection can be established. These IDs are derived from the shared cryptographic token: each party holds a role of either invitor or acceptor, and each independently computes both IDs from the token and their role. This makes peer discovery self-contained and requires no out-of-band address exchange. The invitor and acceptor roles, the PSI protocol's sender and receiver roles, and the initiator and responder roles from the linkage terms handshake (see [Linkage terms](#linkage-terms)) are all independent of one another and each operate in a distinct phase of the exchange. For a private peer coordination server, directory listings can be used.

## Error Handling

In the case of communication channel errors, messages that fail to transmit are retried. Dropped connections are attempted to be reopened up to a user-specified limit. As the communication channels in use guarantee message correctness, any message that fails to validate indicates a deviation from the protocol and results in program termination.

## Supporting services

The communication channels described above each depend on supporting infrastructure. These services can be deployed in two patterns to minimize resource consumption between exchanges:

**Lifecycle provisioning**: the service has a fixed, permanent address but is started on demand before each exchange and stopped afterward. Both parties know the address statically and may independently trigger startup. This is the preferred model for most supporting services and maps well to serverless compute platforms.

**Address-returning provisioning**: a fresh resource is allocated for each exchange and its address is not known in advance. This is inherently asymmetric — the inviting party allocates the resource during the invitation flow, and the resulting address is communicated to the other party as part of the invitation. By the time either party runs the CLI, both have the static address in their configuration.

Some services support **symmetric provisioning**: both parties call the same provisioning endpoint independently at the start of each exchange and receive their own credentials without needing to coordinate the result with each other. ICE credential services operate this way.

Public fallback instances of each supporting service are provided. When a party uses a public instance, the application issues a warning because connection metadata or encrypted data must flow through a server outside their direct control. Parties are encouraged to operate their own instances when possible; deployment guidance and reference configurations are available in [DEPLOYMENT.md](DEPLOYMENT.md).

### STUN/TURN

For parties behind Network Address Translation (NAT) or corporate firewalls, an Internet Connectivity Establishment (ICE) protocol assists in establishing peer-to-peer WebRTC connections. STUN servers help each party discover their public address; TURN servers relay traffic when no direct path can be found.

STUN and TURN servers can be configured statically or their credentials can be obtained on demand from an ICE credential API. Commercial services such as Twilio Network Traversal Service return time-limited credentials at the start of each exchange. Both parties call the same endpoint independently — this is a symmetric provisioning operation requiring no coordination.

### WebSocket-to-TCP proxy

Browser runtimes cannot open raw TCP connections and must use WebSockets instead. A proxy server translates between the two protocols, allowing a browser to reach services such as an SFTP server that speak TCP natively.

This proxy is a property of the client's runtime environment rather than the server: a browser-based party must configure a proxy while a CLI party connects natively. The two parties' connection configurations may therefore differ here even when connecting to the same underlying server.

### Peer coordination

Establishing a WebRTC connection requires a signaling step in which both parties exchange session descriptions and ICE candidates before a direct channel can be opened. The project uses PeerJS for this: each party registers with a PeerJS-compatible server under a token-derived peer ID and then locates their partner using the complementary ID. PeerJS also provides the data channel implementation used for chunked data transfer over the established connection; signaling and data transport are therefore not independently separable in the current design.

The peer coordination server is well-suited to lifecycle provisioning. It is only needed during the brief signaling phase before the WebRTC data channel is established, after which the two peers communicate directly. Hosting it as a serverless WebSocket function — for example on AWS Lambda with API Gateway or Cloudflare Workers — allows it to cold-start on demand and go idle between exchanges with no standing cost.

### SFTP

A lightweight SFTP server may be operated as a drop zone for exchanges between parties who prefer file-based communication to WebRTC. Like the peer coordination server, an SFTP server is suitable for lifecycle provisioning: its address is fixed and it can be stopped between exchanges. Directory-level access controls on a shared SFTP server can alternatively provide per-exchange isolation without requiring dedicated instances.

# Post-linkage Steps

## Non-repudiation

At the conclusion of a successful exchange but before the association map is shared, both parties sign a receipt recording the timestamp, a hash of the exchange agreement, the identities of both parties, and the size of the result if that information was learned by both parties. They then exchange these signatures. Each party retains the other's signature as cryptographic evidence that the exchange occurred. Each party can sign the exchange receipt using either a session-derived key — sufficient for the parties' own records but not independently verifiable by outsiders — or a certificate-authority-backed private key, which allows auditors or legal bodies to verify the signatures without any prior knowledge of the exchange.

Catastrophic failure to exchange receipts results in termination of the program and the exchange must be restarted. As above, dropped connections are retried and undelivered messages are attempted again.

Retention, access controls, and log integrity beyond the receipt remain each party's internal compliance obligation.

## Output

The basic output is an association table between each party's element. As noted above, if parties supplied identifier columns with their inputs and flagged them in their metadata, the association table will be between each party's identifiers. Otherwise, the table references the row indices of each dataset.

If parties elected to transmit payload data, the relevant columns for the appropriate rows will be transmitted in-band over the secure connection and appended to the output in-the-clear.

# Architecture

The linkage protocol, exchange agreements, and communication layer described in this document are built into a single library whose functionality is exposed to users through two applications, one delivered in the web browser and one used through the command line.

When adopting the software, program officers are likely to first conduct exchanges with the web application in order to establish the business case for using the software, either by operating on previously established data sharing agreements or running a PSI-C algorithm to measure the size of shared membership. This bootstrapping process allows for setting and exporting exchange parameters, which can be handed off to IT professionals who can automate the procedure. They are likely to use the command line application as it can be more easily integrated with other data processes, such as exporting the data to be shared and ingesting the data received.

## Core library

The core library includes the base PSI function, linkage term verification, input ingestion and cleaning, linkage key generation, the execution of the linkage algorithms over PSI, and the generation and signing of the receipt. The various libraries that are run-time dependent, such as communication channels and cryptography, are abstracted over and need to be supplied by specific applications.

## Command line application

The command line application enables the automation of all exchange operations and can be integrated into data transformations. Recurring exchanges can be executed through external schedulers or orchestrators, making it the preferred interface for IT professionals operationalizing exchanges that program officers established via the web application. The application is distributed as a Docker image with a default working directory of `/work`; users mount their exchange directory there so that configuration, credentials, and data files are all accessible within the container.

## Web application

The web application is a management interface for exchanges. It allows for the inspection and editing of one-off and recurring exchanges, setting their parameters, adjusting their schedules, and viewing their logs. It also includes code to execute exchanges.

Exchange specifications can be downloaded from the web app for use by the command line application, so the web application has user-friendly ways of creating those files. This includes a data explorer and metadata labeler, linkage rule creator, and data cleaning transformation creator.

If the browser window is left open, it runs scheduled exchanges at the appropriate time. Note that this is a sub-optimal user experience, as it is easy to accidentally close the application.

The web application includes a feature to invite parties to conduct exchanges. Users can generate a shared secret for their partner, instantiate an ephemeral peer coordination server using a serverless compute platform, generate an additional secret for use with that coordination server, and transfer the necessary information to the other party using an existing communication channel.

# User journey

A user should be able to *invite* someone to conduct an exchange, *accept* an extended invitation, and *exchange* data for previously arranged details. The bare minimum necessary to conduct an exchange is an *input* file and a *location*, although most exchanges will also use a *shared secret* and want to save the *output*. As indicated above, linkage terms, connection details, metadata, and data cleaning transformations form further exchange parameters.

For the rest of this section we describe use cases as in the command line application. Web application versions implement the same functionality with an appropriate graphical user interface.

A typical first exchange begins with one party generating an invitation and securely transmitting it to their partner. The partner accepts, which immediately conducts the exchange. Subsequent exchanges between the same parties use the stored configuration and shared secret, requiring no further coordination.

## Configuration

Exchange configuration is stored in a directory designated by `--config-dir`, which defaults to `.psilink` in the current working directory. The directory holds two files: `config.yaml`, which records the exchange parameters, and `secret.key`, which holds the shared secret used for authentication. When this directory is first created, the application prints a notice identifying both files and warning that the secret key should be treated as private.

Command line arguments take precedence over values in `config.yaml`, allowing scripted workflows to override specific parameters without modifying the stored configuration. Any argument value prefixed with `@` is read from the file at the given path rather than taken literally — for example, `--sftp-key=@/run/secrets/id_rsa` reads the private key from disk rather than embedding it in the command or configuration file. This convention applies both on the command line and inside `config.yaml`, and is the recommended approach for any credential to avoid exposing sensitive material in process listings or shell history.

## Invitations

```sh
psilink invite URL INPUT_FILE [OUTPUT_FILE]
```

This generates a shareable invitation string that can be sent to a partner by a secure channel. Default values are used for the linkage terms and connection parameters, while metadata and cleaning transformations are inferred from the input file. The shareable string encodes connection information, linkage terms, and a shared secret as a base64 JSON string, and can be supplied directly to `psilink accept`.

If `--set-config` is given, the user is interactively walked through setting exchange parameters before the invitation string is generated. Once generated, the application connects to the server and waits for the other party to respond; it exits when the token expires, when the connection times out, or when the user cancels. In all three cases the token is invalidated and removed from the configuration directory, preventing a stale invitation from being accepted later.

## Acceptance

```sh
psilink accept INVITATION_STRING INPUT_FILE [OUTPUT_FILE]
```

This decodes the invitation string, connects to the server specified in its parameters, and immediately conducts the exchange. If `--set-config` is specified, the user is interactively walked through modifying the configuration before connecting, with defaults drawn from the invitation and their data file.

## Exchange

The `exchange` subcommand is intended for automated, recurring exchanges:

```sh
psilink exchange --config-dir=CONFIG_DIR INPUT_FILE [OUTPUT_FILE]
```

It requires an existing config directory and issues no interactive prompts; the exchange proceeds entirely from the stored configuration and shared secret. The shared secret is rotated automatically on successful completion.

## Recovery

If `--config-dir` points to a directory that already contains a configuration when running `invite`, the user is prompted whether to reuse the existing exchange parameters with a newly generated secret or to start from defaults. This is the standard path when a shared secret must be re-established after a failed rotation.

If files already exist in the target config directory when running `accept`, the user is prompted before any are overwritten, shown which values differ, and given instructions on how to specify a different directory with `--config-dir`. An interactive merging feature may be added in the future.

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
