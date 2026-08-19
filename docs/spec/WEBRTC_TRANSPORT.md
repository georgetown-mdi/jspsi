---
title: "WebRTC Transport"
---

# WebRTC transport

The `webrtc` channel's wire: how the two parties find each other through the
PeerJS broker, the signaling envelopes they exchange, the framing on the data
channel, and what a clean close has to do before it tears the channel down.

Two implementations speak this wire and must agree on every line of it: the web
app, which runs the PeerJS client in the browser (`apps/web/src/psi/`), and the
CLI, which drives werift's `RTCPeerConnection` directly and hand-writes both the
broker client and the framing (`apps/cli/src/connection/webrtc/`). None of it is
psilink's own protocol to define -- it is PeerJS 1.5.5's, measured on the wire
and recorded here because a second implementation has to match it exactly. The
library choice and the alternatives weighed are in
[cli-webrtc-stack.md](../notes/cli-webrtc-stack.md); the internal premises that
pin the libraries are in [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md).

It does not cover the rendezvous peer-id derivation (see
[PROTOCOL.md](PROTOCOL.md#webrtc-rendezvous-peer-id-derivation), which is
normative for it), the inbound reassembly bound and the AEAD envelope (see
[CHANNEL_SECURITY.md](CHANNEL_SECURITY.md)), the delivery contract every channel
owes (see [COMMUNICATION.md](../COMMUNICATION.md#message-delivery-and-teardown)),
or the operator-facing configuration (see
[EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#connectionserver) and
[CLI.md](../CLI.md#webrtc-exchanges)).

## Roles

The two parties take fixed, asymmetric roles, named by `connection.role`:

| `role` | Rendezvous | Handshake role |
| ------ | ---------- | -------------- |
| `acceptor` | Dials: creates the data channel, sends the `OFFER`, and re-offers until answered | `initiator` |
| `inviter` | Listens: waits for an `OFFER`, answers it, and takes the channel the remote created | `responder` |

Each party registers with the broker under the id its own role derives and
addresses the id the other's derives, so neither has to be told the other's
address. Both parties must therefore hold different roles; two parties holding
the same one collide at the broker (below).

The handshake role is fixed by the rendezvous role rather than negotiated
separately: the parties already had to disagree about which end they are in
order to meet at all.

## Broker socket

The client opens

```
<ws|wss>://<host>:<port><path>/peerjs?key=<key>&id=<id>&token=<token>&version=1.5.5
```

`version` is the PeerJS client version the broker validates against (1.5.5).
`token` is a fresh per-registration random value; it is what distinguishes a
genuine id collision (two parties, two tokens, answered with `ID-TAKEN`) from a
reconnect of the same client (same id and token, which the broker adopts
silently and answers with no `OPEN`).

The CLI resolves the omitted parts of `connection.server` to the same defaults a
PeerJS client applies, except `secure`, which a browser client takes from the
page it was served over and the CLI has no page for:

| Field | Default |
| ----- | ------- |
| `port` | 443 when `secure`, 80 otherwise |
| `path` | `/` |
| `key` | `peerjs` |
| `secure` | `true` |

The address is built through the URL API, with `path` assigned as a pathname
rather than concatenated, so the scheme's default port is left implicit in it.
`host` and `path` are refused for shape before anything is dialed, because both
are partner-supplied when the connection came from an invitation endpoint and
each can otherwise carry the delimiters that move a URL's authority:

| Field | Refused |
| ----- | ------- |
| `host` | any of `@ / ? # \` or whitespace, and any value that does not parse as a bare authority (one contributing userinfo, a port, or a path of its own) |
| `path` | a value not beginning with `/`, or carrying any of `@ ? # \` or whitespace |

`key` takes no equivalent rule: an invitation endpoint is a strict
`host`/`port`/`path` allowlist and carries none, and the value is encoded as a
query parameter rather than interpolated. The finished address is checked
against the configured host once more before the socket is constructed, so an
address naming another authority opens nothing.

The server stamps `src` itself from the connecting client's id, so an outbound
frame carries only `type`, `payload`, and `dst`. Heartbeats (`HEARTBEAT`, no
payload) go up every 5 s. The broker neither queues nor reports an undeliverable
`OFFER` for a peer that has not registered yet, so the dialer re-offers on a
timer until it is answered rather than waiting for a signal that never comes.

Message types acted on: `OPEN`, `OFFER`, `ANSWER`, `CANDIDATE`, `LEAVE`,
`EXPIRE`, `ERROR`, `ID-TAKEN`, `INVALID-KEY`. Two of them carry operator
meaning: `ID-TAKEN` is the symmetric-role misconfiguration (both parties set the
same `role`), and an `ERROR` whose payload names an invalid key is the wrong
`server.key`.

## Negotiation envelope

- **`OFFER`** payload: the SDP under `sdp`, a `type` of `data`, a
  `connectionId`, and the DataConnection's `metadata`, `label`, `reliable`, and
  `serialization`. `serialization` is load-bearing rather than a preference: the
  receiving PeerJS peer selects its DataConnection subclass from it, so a
  mismatch is a protocol break. It is `binary` (BinaryPack).
- **`ANSWER`** payload: `sdp`, `type`, and `connectionId` only -- no `label`,
  `reliable`, or `serialization`.
- **`CANDIDATE`** payload: the candidate object under `candidate`, plus `type`
  and `connectionId`.

The `connectionId` is PeerJS's `dc_<random>` DataConnection id. A party echoes
the id it adopted from an offer on every frame it sends afterwards, so an
adopted id is bounded: at most 64 characters from `[A-Za-z0-9_-]`. An offered id
outside that shape is not a PeerJS peer's and is ignored, the receiver keeping
the id it generated.

Candidates must be queued until this side's own description has been put on the
broker. Both stacks fire candidates during `setLocalDescription`, before the
description can have reached the broker, and a PeerJS peer discards a candidate
it cannot yet apply -- silently, from the sender's side.

## Framing

PeerJS's chunking is a convention inside BinaryPack messages, not a protocol of
its own. Each datagram is a BinaryPack-packed object; a truthy `__peerData`
marks it as either a chunk envelope or the close sentinel.

- A chunk envelope carries the message id (`__peerData`, starting at 1 and
  incrementing per logical message), the chunk index, the chunk bytes, and the
  total chunk count. Chunks accumulate by id until the count matches the total.
- The chunking threshold is 16300 bytes, well under the SCTP ceiling.
- The browser delivers an assembled chunked frame as a `Uint8Array` and an
  unchunked one as an `ArrayBuffer`; a consumer must normalize both.

The inbound path is bounded before anything is reassembled --
`MAX_WEBRTC_FRAME_BYTES` and the structural scan that goes with it are specified
in [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md#webrtc-data-channel-inbound-bound).

## The clean close

The close sentinel is a `__peerData` close object sent through the same
reliable, ordered channel, which necessarily places it behind every frame
already handed to `send`. The *peer* closes on receipt.

Queuing the sentinel is not delivering the frames in front of it. PeerJS's own
clean close returns the moment the sentinel is queued, with the final frame
still in the sender's outbound buffer -- measured in Chromium at 8.4 MB of a 16
MiB frame still buffered when the close returned, and the peer reading that
frame 1.3 s later. A close that returns there has reported delivery for bytes
that have not left. Both implementations therefore wait, each on the strongest
signal its stack exposes, and the wait is the delivery guarantee rather than
hygiene.

**The web app** waits for the PEER to close the data channel. The peer does that
on reading the sentinel, and the ordered channel places the sentinel behind
every frame already handed to `send`, so the local channel's `close` event is
the peer's receipt of the final frame. That event is the peer's and not this
side's: PeerJS leaves the local channel open on a flushing close (measured:
still `open` after an eight-second window against a peer patched not to close,
with `bufferedAmount` having reached zero early in it). Nothing is torn down
afterwards -- a browser peer has no reason to, and no SCTP-level drain to do
better with.

**The CLI** cannot leave the connection standing, so it drains to
acknowledgement and then tears down:

1. Wait until the peer has ACKNOWLEDGED every byte already handed to the
   channel, then
2. send the sentinel, wait until it has been TRANSMITTED (not acknowledged -- a
   peer closes on reading it and stops acknowledging at exactly that point), and
   only then tear down.

The condition in step 1 is the SCTP association's send and unacknowledged queues
both being empty. It is deliberately not the channel's `bufferedAmount`: that
counter reaches zero while chunks are still unacknowledged, and a close gated on
it loses them -- measured at roughly one frame in three over a loopback channel
with no packet loss at all. This is the acknowledgement the flushing-close half
of the delivery contract requires; "flush the local buffer" is not sufficient on
this transport (see
[COMMUNICATION.md](../COMMUNICATION.md#message-delivery-and-teardown)).

Every wait above also ends when there is no live peer left to deliver to, so a
partner that crashed produces a teardown rather than a wait as long as the
ceiling. For the web that is the peer connection reaching `failed` or `closed`;
a transient `disconnected` is not terminal, because the frame is still in flight
while ICE recovers.

The web wait also ends when the run itself is cancelled. Up to the ceiling the
wait's length is the PEER's to choose -- it holds the wait simply by keeping ICE
alive and never reading the sentinel -- so an operator who cancels does not spend
it. Nor does the drain gate what the run already has: the web app reports its
result and its downloads first and drains afterwards, so a peer that never reads
the sentinel delays neither.

Exactly one exit of the web wait carries a delivery signal: the peer's own close.
Every other exit leaves the partner's copy in doubt on a run whose result this
side has already reported, so the web app raises a non-fatal warning on each of
them. The run's result stands either way; what the operator is told is that the
partner may not have taken the final frame, and to check that their exchange
finished.

The wording follows the exit, because the exits do not mean the same thing:

| Exit | What the operator is told |
| ---- | ------------------------- |
| The peer closed the channel | Nothing -- that close is the delivery signal |
| The ceiling ran out | The partner never confirmed taking the final message within the wait, so their exchange may have ended without it |
| No live peer is left, or the channel was already out of `open` | The connection closed before the partner could confirm, so they may or may not have received it |
| The run was cancelled while the wait stood | The same wording as a connection that closed: the cancel cuts the wait rather than letting it run out, and what the partner got is as unknowable either way. A cancelled run's notice is withheld anyway (below), so this is what the exit means rather than what an operator reads |

The notice is best-effort in two ways. It reaches the operator only when the
drain ends while the run is still on screen, so an operator who leaves as the
results render is told nothing. And it speaks for a run that succeeded here, so a
run that already failed or was cancelled drains the same close silently -- it has
told the operator something stronger already.

A close signal is not proof the partner's application read what was behind it: a
peer that closes without draining its inbound queue is indistinguishable from one
that read everything, and a peer connection torn down by the page rather than by
reading the sentinel resets its stream gracefully -- measured in Chromium, and
pinned in `apps/web/test/browser/webrtcCloseDelivery.test.ts` -- so that teardown
arrives here as the same close. That is also why the cancellation is an exit of
its own rather than whatever the teardown behind it does to the channel: a cancel
folded into the peer's close would report delivery for a wait the operator cut.

What no close can cover is a sender whose stack goes away before its bytes do:
tearing the peer connection down as the close returns delivered nothing at all
-- measured at zero frames of two received, four rounds out of four -- and a
browser tab closed the instant the results appear does the same thing to a frame
still buffered. Waiting narrows that window to the delivery itself rather than
leaving it open for the length of the transfer.

## ICE

A configured `iceServers` list REPLACES the built-in STUN default rather than
adding to it, which is what makes a deliberately configured server list the list
actually used. An empty or absent list means "use the default"; it does not mean
"no STUN". The consequences for an operator -- the default that applies when
nothing is configured, what it discloses, and the unreachable-entry idiom for
gathering host candidates only -- are in [CLI.md](../CLI.md#webrtc-exchanges).

## Application-layer encryption

The `webrtc` channel carries `request_encryption: false`: a data channel is
end-to-end confidential under DTLS against the signaling server and any relay,
so the application-layer AEAD wraps nothing the transport has not already
protected, and the web peer refuses a partner that requests it. The rationale
and the one case that would change it are in
[CHANNEL_SECURITY.md](CHANNEL_SECURITY.md).

## Budgets

Every value below is a ceiling, not a wait: each returns as soon as its
condition holds.

| Budget | Default | What it bounds |
| ------ | ------- | -------------- |
| Broker registration | 30 s | Opening the signaling socket and receiving `OPEN` |
| Rendezvous | 10 min | Both parties finding each other; human-timescale, because one operator may start well before the other |
| Offer retry interval | 1 s | How often the dialer re-offers while unanswered |
| Channel open | 30 s | The data channel opening once both descriptions are exchanged; reaching it means the peer is present but no candidate pair worked |
| Parked receive | 1 h | Peer silence on an open channel; it bounds the peer's single-threaded PSI compute, which sends no keepalive while it runs |
| Close drain | 5 min | The clean close's wait above -- the CLI's acknowledgement drain, the web's wait for the peer's close -- sized from the largest admissible frame and the measured send rate |
| Sentinel hand-off | 2 s | Getting the close sentinel itself onto the wire |

`connection.options.peer_timeout_ms`, when set, replaces both the rendezvous and
the parked-receive budgets: on this channel the documented "total wait for the
partner" is two waits, one before the channel exists and one after.

An interrupt (SIGINT or SIGTERM) does not wait any of them out. The run passes
the transport an abort signal, and the rendezvous fails and tears down the
broker socket and the peer connection on it, so a party that interrupts while
waiting for its partner exits at once rather than at the end of the rendezvous
budget.

Two bounds are memory rather than time, both on inbound signaling: a signaling
frame is refused above 256 KiB before it is parsed, and at most 128 remote
candidates are held while this side's description is not yet applied.

## See also

- [PROTOCOL.md](PROTOCOL.md#webrtc-rendezvous-peer-id-derivation) - the
  normative rendezvous peer-id derivation both implementations reproduce.
- [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md#webrtc-data-channel-inbound-bound) -
  the inbound reassembly bound and the AEAD envelope.
- [COMMUNICATION.md](../COMMUNICATION.md#message-delivery-and-teardown) - the
  delivery contract every channel owes.
- [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md) - why `peerjs` and `werift` are
  exact-pinned, the behavioural premises they rest on, and how to re-verify them.
- [cli-webrtc-stack.md](../notes/cli-webrtc-stack.md) - the library decision and
  the alternatives weighed.
