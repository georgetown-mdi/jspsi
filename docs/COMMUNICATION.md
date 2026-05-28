---
title: "PSI-Link Communication"
---

# PSI-Link communication

This document covers the communication channels available for PSI-Link exchanges, how parties synchronize protocol steps, how errors are handled, and what supporting services are required. Authentication and channel security are not covered here - see [SECURITY_DESIGN.md](SECURITY_DESIGN.md) for those topics. It does not cover the PSI protocol itself (see [PROTOCOL.md](PROTOCOL.md)) or CLI configuration (see [CLI.md](CLI.md)). Intended readers are IT staff and developers.

# Communication

The protocol components above define what data parties exchange; this section describes how that exchange is carried over a network. This includes the channels available for transmission, how parties verify each other's identity, and how they coordinate the sequencing of protocol steps. Authentication and channel security are covered in [SECURITY_DESIGN.md](SECURITY_DESIGN.md).

## Channels

If the exchange is to be accomplished without additional infrastructure, it must utilize existing communication channels. Three communication channels are currently supported:

* Peer-to-peer using WebRTC - this is a protocol that is primarily used by browsers to communicate with each other, for example when conducting video calls. Peer-to-peer connections can be difficult to establish when parties are behind corporate firewalls and using Network Address Translation (NAT). To facilitate these connections, a third-party server typically needs to be available to execute to either help establish the connection, or to explicitly route the traffic.
* SFTP - for many exchanges, one partner already runs an SFTP server that is used for secure file transfers. SFTP is less-than-ideal for a communication protocol, as it is a file transfer protocol and not a direct connection. That said, with frequent polling and strategies to resolve synchronization, it can be treated as a message passing channel with slight delays for each message. As the number of messages is independent of the size of the datasets, this represents a fixed, tolerable time cost.
* File-drop - transfers can be made through directories that both parties can access, for example an NFS or SMB network share provisioned by IT, or a folder backed by an SFTP server and mounted locally. The same file-based polling and synchronization protocol used for SFTP is applied directly to the mounted path. This is the simplest deployment option when shared storage already exists. No additional supporting services are required beyond read/write access to the shared directory. It is possible to conduct an exchange where one party utilizes a file-drop that is synchronized to a directory that is served by an SFTP server to which the other party connects.

## Synchronization

The protocol requires both parties to execute it at the same time. For a new exchange where one party may "invite" the other, the inviter can listen for the other partner to respond. For scheduled exchanges, which party shows up first is arbitrary and in order to execute the protocol there needs to be a way of resolving who will "speak" first and who will "listen".

For WebRTC, this is solved by a single-threaded peer-coordination service which ensures only one party can be "first". For SFTP, an implementation has been written that utilizes the uniqueness of file handles and catching server errors to handle rare race conditions.

When using a public coordination server, WebRTC additionally requires both parties to know each other's peer IDs before a connection can be established. These IDs are derived from the shared cryptographic token: each party holds a role of either inviter or acceptor, and each independently computes both IDs from the token and their role. This makes peer discovery self-contained and requires no out-of-band address exchange. The inviter and acceptor roles, the PSI protocol's sender and receiver roles, and the initiator and responder roles from the linkage terms handshake (see [Linkage terms](EXCHANGE_SPEC.md#linkage-terms)) are all independent of one another and each operate in a distinct phase of the exchange. For a private peer coordination server, directory listings can be used.

## Error handling

In the case of communication channel errors, messages that fail to transmit are retried. Dropped connections are attempted to be reopened up to a user-specified limit. As the communication channels in use guarantee message correctness, any message that fails to validate indicates a deviation from the protocol and results in program termination.

## Supporting services

The communication channels described above each depend on supporting infrastructure. These services can be deployed in two patterns to minimize resource consumption between exchanges:

**Lifecycle provisioning**: the service has a fixed, permanent address but is started on demand before each exchange and stopped afterward. Both parties know the address statically and may independently trigger startup. This is the preferred model for most supporting services and maps well to serverless compute platforms.

**Address-returning provisioning**: a fresh resource is allocated for each exchange and its address is not known in advance. This is inherently asymmetric - the inviting party allocates the resource during the invitation flow, and the resulting address is communicated to the other party as part of the invitation. By the time either party runs the CLI, both have the static address in their configuration.

Some services support **symmetric provisioning**: both parties call the same provisioning endpoint independently at the start of each exchange and receive their own credentials without needing to coordinate the result with each other. ICE credential services operate this way.

Public fallback instances of each supporting service are provided. When a party uses a public instance, the application issues a warning because connection metadata or encrypted data must flow through a server outside their direct control. Parties are encouraged to operate their own instances when possible; deployment guidance and reference configurations are available in [DEPLOYMENT.md](DEPLOYMENT.md).

### STUN/TURN

For parties behind Network Address Translation (NAT) or corporate firewalls, an Internet Connectivity Establishment (ICE) protocol assists in establishing peer-to-peer WebRTC connections. STUN servers help each party discover their public address; TURN servers relay traffic when no direct path can be found.

STUN and TURN servers can be configured statically or their credentials can be obtained on demand from an ICE credential API. Commercial services such as Twilio Network Traversal Service return time-limited credentials at the start of each exchange. Both parties call the same endpoint independently - this is a symmetric provisioning operation requiring no coordination.

### WebSocket-to-TCP proxy

Browser runtimes cannot open raw TCP connections and must use WebSockets instead. A proxy server translates between the two protocols, allowing a browser to reach services such as an SFTP server that speak TCP natively.

This proxy is a property of the client's runtime environment rather than the server: a browser-based party must configure a proxy while a CLI party connects natively. The two parties' connection configurations may therefore differ here even when connecting to the same underlying server.

### Peer coordination

Establishing a WebRTC connection requires a signaling step in which both parties exchange session descriptions and ICE candidates before a direct channel can be opened. The project uses PeerJS for this: each party registers with a PeerJS-compatible server under a token-derived peer ID and then locates their partner using the complementary ID. PeerJS also provides the data channel implementation used for chunked data transfer over the established connection; signaling and data transport are therefore not independently separable in the current design.

The peer coordination server is well-suited to lifecycle provisioning. It is only needed during the brief signaling phase before the WebRTC data channel is established, after which the two peers communicate directly. Hosting it as a serverless WebSocket function - for example on AWS Lambda with API Gateway or Cloudflare Workers - allows it to cold-start on demand and go idle between exchanges with no standing cost.

### SFTP

A lightweight SFTP server may be operated as a drop zone for exchanges between parties who prefer file-based communication to WebRTC. Like the peer coordination server, an SFTP server is suitable for lifecycle provisioning: its address is fixed and it can be stopped between exchanges. Directory-level access controls on a shared SFTP server can alternatively provide per-exchange isolation without requiring dedicated instances.

## See also

- [SECURITY_DESIGN.md](SECURITY_DESIGN.md) - threat model and security properties of the channels described here
- [EXCHANGE_SPEC.md](EXCHANGE_SPEC.md) - `connection` block reference for configuring the channels described here
- [DEPLOYMENT.md](DEPLOYMENT.md) - operating the supporting services described here
- [CLI.md](CLI.md) - CLI commands for configuring and running exchanges over these channels
