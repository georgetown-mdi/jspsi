---
title: "PSI-Link"
author: "Georgetown Massive Data Institute"
date: 2026-04-30
---

The goal of this project is to facilitate secure inter-agency data sharing of administrative records. This is accomplished by executing a privacy-preserving record linkage (PPRL) protocol based on private set intersection (PSI). A PSI primitive is repeatedly used by two parties to identify which of several statistical linkage keys their data elements have in common, resulting in the association map between each party's elements being revealed. Those parties can then exchange additional data elements for their common members. Alternatively, the parties can run a private set intersection cardinality (PSI-C) protocol to determine the number of members they have in common, which may provide motivation for high-level program discussion about data sharing.

Beyond the privacy-preserving nature of the algorithm and the quality of the match, two key project priorities are ease of use and the reduction of security, compliance, and information-technology frictions. Within organizations it is often the case that a program officer would benefit from exchanging data and even has a signed data sharing agreement, but other stakeholders concerns must first be met. As such, the majority of the project is designed to work locally in a browser so as to not require additional software to be installed, and data should only flow through trusted channels. In addition, browser-based solutions should have modern, user-centered-designed interfaces.

# Privacy Preserving Record Linkage

The PPRL protocol involves the following components:

## PSI Primitive

The PSI primitive is a lightly modified version of OpenMined's [PSI](https://github.com/OpenMined/PSI). That package implements private set intersection layering over Google's [Private Join and Compute](https://github.com/Google/private-join-and-compute), with a C++ implementation that is compiled into WebAssembly. The primitive protocol defines "server" and a "client" roles. The client initializes the exchange by encrypts their own data with their own private key using a commutative encryption algorithm and then sends it to the server. The server commutatively encrypts both their own data and the client's data with their own private key and then send both datasets to the client. The client can then remove their own key from their own data, leaving them with client and server datasets encrypted only by the server. A straightforward string comparison allows the client to see which elements they have in common. They can then choose to share the association table back with the server. If the server applies a permutation when sending back to the client the client's data with both sets of encryption keys, the client will no longer be able to determine the mapping between elements but can still learn its size, yielding the PSI-C protocol.

The terminology of "server" and "client" is disfavored throughout the rest of this project as there will be many other instances of servers and mclients, and in this case OpenMined's PSI includes no actual server code. Often we will want to execute the protocol so that both parties learn the result, so that the roles they play are arbitrary.

## Linkage Keys

By repeatedly executing the PSI primitive on statistical linkage keys generated from an input data set, two parties can run a fuzzy PPRL. The most common data elements for linkage keys are social security number, first name, last name, and date of birth. An example of a linkage key is the last four digits of the social security number concatenated with last name and date-of-birth as a character string.

## PSI Contract

When two parties meet to exchange data, they must first agree on the protocol they will execute and thus enter into a contract. This includes:
* Whether or not both parties will receive the output.
* Which role either party will play. If the exchange of the result symmetric, this reduces to which partner will go first.
* If the output is the association table or the cardinality. If the output is the association table, parties may also indicate that they intend to send payloads that correspond to their matched elements.
* The multiplicity of the linkage. If one party wants to connect each of their records to multiple of their partner's, their partner needs to ensure that all data elements are available for use for all keys. If the linkage is one-to-one, those sets can be filtered to just the elements that have not already been matched.
* The linkage keys themselves. This includes a descriptive name of the key, the semantic meaning of each combined data element, and any constraints those data elements must fulfill. For example, dates-of-birth fields have specific formats, social security numbers can be subject to validation, and names may have limited character sets and/or have titles and suffixes prohibited.

## Data Cleaning

In order to meet the linkage key components of the contract, each party must clean their own data. This involves specifying data cleaning pipelines comprised of the composition of cleaning functions. For example, one party might take their first name input field, remove all punctuation, trim whitespace, and cast the result to upper-case. Linkage keys might use this "cleaned" name field wholesale, take substrings, or apply a phonetic algorithm.

## Payloads and Metadata

As indicated, parties can choose to send data to their partner after common members have been identified. This is accomplished by supplying additional data columns with the input file. To manage this feature, users can supply metadata that indicates the semantic meaning of columns to be used in data linkage, whether additional columns should be transferred, and if a column is a unique identifier used by that party. Identifier columns can be used in the association table instead of row indices for ease of ingestion back into data systems.

# Communication

The linkage protocol requires active communication between partners.

## Channels

If the exchange is to be accomplished without additional infrastructure, it should utilize existing communication channels. At present, there are two solutions:

* Peer-to-peer using WebRTC - this is a protocol that is primarily used by browsers to communicate with each other, for example when conducting video calls. Peer-to-peer connections can be difficult to establish when parties are behind corporate firewalls and using Network Address Translation (NAT). To facilitate these connections, a third-party server typically needs to be available to execute to either help establish the connection, or to explicitly route the traffic.
* SFTP - for many exchanges, one partner already runs an SFTP server that is used for secure file transfers. SFTP is less-than-ideal for a communication protocol, as it is a file transfer protocol and not a direct connection.

Other solutions may be added in the future.

## Authentication

Before establishing connections, clients need to ensure that they are communicating with the correct partner. They can either share a secret that will be used to further encrypt their data, or they can "meet in a trusted spot". For an ephemeral, one-off exchange they might choose to arrange it using a web service that generates a one-time, short-lived link that can be shared. For an SFTP connection, user and path management on the server-side can ensure that no one else is able to listen in.

## Synchronization

The protocol requires both parties to execute it at the same time. For a new exchange where one party may "invite" the other, the inviter can listen for the other partner to respond. For scheduled exchanges, which party shows up first is arbitrary and in order to execute the protocol there needs to be a way of resolving who will "speak" first and who will "listen".

As an example for SFTP, both parties first look for "hello" files. If they fail to find one, they create a hello file of their own and wait. If they find one, they consume the "hello", say "hello" back, and an order has been established. If, however, both parties say "hello" at the same time, they must have a way of breaking the tie.

For WebRTC, this is solved by a single-threaded peer-matching service which ensures only one party can be "first".

# Services

As implied above, the project can require a number of micro-services to function fully.

## STUN/TURN

For parties that don't have a public IP and are behind Network Address Translation (NAT), an Internet Connectivity Establishment (ICE) protocol must be used to establish peer-to-peer connections. This typically relies on a server that implements the Session Traversal Utilities for NAT (STUN) protocol. If this fails, a server implementing Traversal Using Relays around NAT (TURN) can be used to tunnel the traffic.

## Web-socket to TCP

Browser runtimes are unable to open raw TCP connections, and instead have to rely on Websockets. A proxy server can translate this traffic and allow direct TCP connections, so that, for example, a web browser can open an ssh connection.

## Peer-coordination

Connecting peer-to-peer without knowing the address typically requires coordination beyond the STUN or TURN server. When two parties request to talk to each other through such a server, the server responds by telling both parties each others' addresses.

## SFTP

Although not entirely necessary for the project, it can be beneficial to have light-weight installations of SFTP servers for illustration purposes.

# Architecture and deployment

## Present State

There are two applications that build off a base library.

### Base library

The base library:
* Wraps OpenMined PSI into a PSI primitive that operates over a generic connection-style object.
* Implements synchronization of participants over SFTP.
* Has hard-coded linkage keys.
* Implements a one-to-one PPRL for a set realized linkage keys and a object that conducts a PSI primitive on it.
* Also contains some SFTP abstractions.

### Web Application

The web application:
* Is a React website using TanStack Router.
* It enables parties to invite each other to perform exchanges over WebRTC by single-use, ephemeral links that are tracked by a backend server.
* Interfaces with the base library to perform a PSI link and generates a result data file.
* It has a built-in PeerJS server to handle coordinating peer-to-peer connections and uses PeerJS's DataConnections to send messages.
* Is deployed to AWS Elastic Beanstalk.

### Command Line Application

The command line application:
* Is a NodeJS script built into a Docker container that can conduct scheduled exchanges over SFTP.
* Uses Docker for its ability to harden containers, limiting file-system access out of the box and having the possibility to restrict network endpoints.
* Interfaces with the base library to perform a PSI link and generates a result data file.
* Does not yet have WebRTC capability, as PeerJS needs to be tricked into running on NodeJS.

## Ideal State

### Web Application

In its current state, the web application only allows parties to conduct one-off exchanges by generating a link. Expanding on the discussion above, the "web application" should be a management interface for exchanges. It should allow for the inspection and editing of one-off and recurring exchanges, setting their parameters, adjusting their schedules, and viewing their logs. It should also execute the exchanges, although that might be best suited as a distinct component. It should be able to be built as an desktop Electron app, or possibly able to be saved as a progressive web app.

The part of the application that allows for generating links may be unnecessary. It is essentially serving a dual purpose of creating a shared secret (the session on the server) and relating between parties the identifiers to use on the peer coordination server. Instead, the one party who wishes to do the inviting can generate a shared secret for their partner, instantiate an ephemeral peer coordination server through a sevice like an AWS Lambda, generate a secret for use with that coordination server, and transfer the necessary information to the other party. This would align well with the ability to instantiate other services on demand, such as a STUN server or Websocket-to-TCP proxy.

### Command Line Application

The command line application is proceeding on the right track. It needs to be augmented with additional connection protocols, have its logging options expanded, and general debugged. It may be advantageous to build it as an executable in addition to distributing as a Docker image. Beyond that, it just needs the full PSI PPRL protocol to be developed.
