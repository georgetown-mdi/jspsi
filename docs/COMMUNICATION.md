---
title: "PSI-Link Communication"
---

# PSI-Link communication

This document covers the communication channels available for PSI-Link exchanges, how parties synchronize protocol steps, how errors are handled, and what supporting services are required. Authentication and channel security are not covered here - see [SECURITY_DESIGN.md](SECURITY_DESIGN.md) for those topics. It does not cover the PSI protocol itself (see [PROTOCOL.md](spec/PROTOCOL.md)) or CLI configuration (see [CLI.md](CLI.md)). The implementation-level rationale for the terminal `ConnectionErrorKind` taxonomy is specified in the [transport-contract spec](spec/COMMUNICATION.md). Intended readers are IT staff and developers.

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

When using a public coordination server, WebRTC additionally requires both parties to know each other's peer IDs before a connection can be established. These IDs are derived from the shared cryptographic token: each party holds a role of either inviter or acceptor, and each independently computes both IDs from the token and their role. This makes peer discovery self-contained and requires no out-of-band address exchange. The inviter and acceptor roles, the PSI protocol's sender and receiver roles, and the initiator and responder roles from the linkage terms handshake (see [Linkage terms](EXCHANGE_REFERENCE.md#linkage-terms)) are all independent of one another and each operate in a distinct phase of the exchange. For a private peer coordination server, directory listings can be used.

## Web acceptance and consent

On the web, the acceptor opens the invitation deep link, which decodes the invitation and enforces its expiry before any rendezvous or connect (failing closed on an expired or invalid token, with no consent action offered). It then renders the inviter's full proposed linkage terms: for each key, its ordered elements and, per element, the source field and any value transform -- with a plain-language description of what that transform does to matching alongside its name and parameters -- fuzzy-comparison expansion, or swap; and for each field, its constraints, the matching method, the result-sharing directions, and the deduplicate setting, flagging any non-default rule. When a swap's two key elements both carry transforms, the screen also depicts the transformed-value interchange the receiver performs: each element's transforms apply to the other element's field value, because the field references swap while the transforms stay with their element. Where a function coerces a declared parameter before applying it -- for instance a null `replace_regex` replacement, which runs as the empty string -- the screen shows the value that actually executes alongside the declared one, so a displayed parameter cannot misstate the match. The exchange UI that dials the rendezvous mounts only after the acceptor gives affirmative consent (a checkbox plus their name), so no rendezvous, key-exchange handshake, or PSI frame is sent before consent commits. The exchange then runs the inviter's terms verbatim (with the acceptor's own identity substituted), while the acceptor's own CSV still drives its metadata, standardization, and payloads -- so what the acceptor consented to on screen is exactly what the exchange links on. The deduplicate and fuzzy-comparison settings are shown as proposed but flagged not-yet-applied, since the run is currently one-to-one and fuzzy expansion is unimplemented. All partner-controlled text in the terms is escaped at display (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md), "Channel security"). The rendezvous peer-id derivation that places the two parties on the connection is specified in [PROTOCOL.md](spec/PROTOCOL.md).

## Message delivery and teardown

Each channel passes messages through a common transport contract whose one subtlety is worth stating explicitly, because it is easy to misread when auditing the code: a send completing does not mean the peer has received the message. There is no end-to-end delivery acknowledgement at this layer. What a completed send does guarantee differs by channel, and that difference is the whole contract. Every channel must guarantee that the final frame of an exchange survives a clean connection close, and it may do so in one of two ways.

The first way is a durable send with a draining close: the send writes the message durably before resolving, and the close waits for the peer to consume the last written message before sweeping it. The file-based channels - SFTP and file-drop - work this way. A send writes the message as a file in the shared directory and does not resolve until that write (and its atomic rename into place) is durable, so the frame is committed to disk before the caller proceeds. Because the sender's close also deletes the files it is responsible for, durability-on-disk alone is not sufficient: the close must drain the last sent file - wait for the peer to consume it - before cleanup runs. This gives the precise guarantee: the terminal frame is durability-until-consumed. Without the drain, the sender's cleanup could delete the file before the peer polls, and the peer would hang until its peer timeout.

The second way is a flushing close: the send only buffers locally, so a message can still be in flight when the sender finishes, and the close is what protects it. WebRTC works this way. A send hands the message to the data channel and returns before it is on the wire, so the final frame is guaranteed not by the send but by the close: a clean (non-error) close must flush the buffered frames before tearing the connection down, and the underlying reliable, ordered data channel delivers them ahead of the close signal the peer acts on. A close caused by an error does the opposite - it discards buffered outbound writes, because an errored link is already unusable.

The WebRTC case is the one that looks like a race when reviewed in isolation: the last operation a party performs is a non-blocking send immediately followed by a close, which appears to drop the frame. It does not, provided the close flushes - so a clean WebRTC close must not be shortcut into an abrupt connection teardown that bypasses the flush. The file-based channels have a different hazard: because the sender is responsible for deleting its own files, a send-then-immediately-close can delete the terminal file before the receiver polls. The drain in close() is what closes that gap.

Any new channel added to the project must satisfy one of these two conditions - a durable send with a draining close, or a flushing clean close. A transport that does neither will silently drop the final frame of an exchange. The same rule is recorded for implementors in the `Connection` and `TransportHooks` interface documentation in the core library.

The rules above govern outbound frames. Inbound delivery has a complementary guarantee that is easy to conflate with the outbound discard-on-error just described: a frame that has already arrived and been buffered is handed to a waiting `receive()` before any terminal error surfaces, whether the connection ended in a clean half-close or an abnormal drop. The two buffers are distinct - an errored close discards pending outbound writes, but never a received frame already sitting in the inbound queue. This is uniform behavior of the shared message queue, which sits above every channel, rather than a per-channel obligation; it is recorded for implementors in the `TransportControls` interface documentation alongside the rule above.

That inbound drain being uniform leaves only a small per-transport choice behind: each transport still wires which terminal control it calls on its own underlying events. Only one channel is close-capable today - WebRTC, in `apps/web/src/psi/peerMessageConnection.ts` - and it maps the data channel's `close` event to `finish()` (the clean half-close) and its `error` event to `fail()` (the abnormal drop); the file-based channels surface only `fail()`. This residue must not be removed by introducing a shared `Connection.close` *event*. A broadcast close event would be delivered only to whatever listener happened to be attached, reintroducing the no-listener drop window that the pull-based queue was built to eliminate - the same window that makes a completed receive, not an event callback, the unit of delivery. Teardown therefore stays driven through the queue's `finish()`/`fail()` controls rather than an event.

## Error handling

In the case of communication channel errors, messages that fail to transmit are retried. The initial connection is retried on a transient failure up to a user-specified limit (`max_reconnect_attempts`); a connection attempt that times out is terminal and is not retried, since a retry cannot recover an unresponsive server or mount, and there is no reconnection after a connection drops mid-exchange. As the communication channels in use guarantee message correctness, any message that fails to validate indicates a deviation from the protocol and results in program termination.

Terminal failures are tagged with a `ConnectionErrorKind` (the kinds and their meanings are documented on that type in the core library) so a consumer can branch on the cause. A deliberate local close surfaces as `"closed"` (nothing went wrong on this side), while a clean remote close, a dropped link, and a peer timeout all surface as `"transport"` (the link ended; a retry is reasonable). The deferred-decision rationale for that taxonomy -- why a clean remote close is not given its own kind, why a non-attributable local crypto/runtime fault is tagged `"transport"` rather than `"security"` or a dedicated `"system"` kind, and the condition that would reopen each -- is in the [transport-contract spec](spec/COMMUNICATION.md#connectionerrorkind-classification).

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
- [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md) - `connection` block reference for configuring the channels described here
- [DEPLOYMENT.md](DEPLOYMENT.md) - operating the supporting services described here
- [CLI.md](CLI.md) - CLI commands for configuring and running exchanges over these channels
