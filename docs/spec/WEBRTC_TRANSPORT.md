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
Alcove's own protocol to define -- it is PeerJS 1.5.5's, measured on the wire
and recorded here because a second implementation has to match it exactly. The
library choice and the alternatives weighed are in
[cli-webrtc-stack.md](../notes/cli-webrtc-stack.md); the internal assumptions that
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
| `acceptor` | Dials: creates the data channel, sends the `OFFER`, and offers again on an `EXPIRE` until answered | `initiator` |
| `inviter` | Listens: waits for an `OFFER`, answers it, and takes the channel the remote created | `responder` |

Each party registers with the broker under the id its own role derives and
addresses the id the other's derives, so neither has to be told the other's
address. Both parties must therefore hold different roles; two parties holding
the same one collide at the broker (below).

The handshake role is fixed by the rendezvous role rather than negotiated
separately: the parties already had to disagree about which end they are in
order to meet at all.

Both implementations resolve this table identically or a CLI party and a browser
party cannot complete a handshake with each other, so the pairing -- together
with the request-encryption flag each side sends, `false` on both (see
[Application-layer encryption](#application-layer-encryption)) -- is pinned by
the cross-application conformance vectors at
[`packages/core/test/vectors/webrtc-interop-vectors.json`](../../packages/core/test/vectors/webrtc-interop-vectors.json),
which each application's own suite asserts its own side against. See
[PROTOCOL.md](PROTOCOL.md#webrtc-rendezvous-peer-id-derivation) for what the
file records.

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

Those defaults are one implementation's, not the wire's: a browser peer resolves
an absent `path` to the web app's own broker mount (`/api/`) rather than to `/`.
An invitation endpoint therefore holds the mount point resolved -- `alcove
invite` records the path it will itself dial, `/` included, even where the
`ws:`/`wss:` URL wrote none -- so a locator crossing between the two
applications leaves no field for the consumer to fill in the mount point from a
default the producer does not share.

The port, and with it the scheme, is not resolved the same way: the endpoint
includes `port` only when the connection names one, and an omitted port stays
omitted on the wire rather than being filled from the producer's own default.
The consumer resolves it from its own side instead -- a browser acceptor fills
an absent port from the page's own protocol, and PeerJS infers `secure` from
that same resolved scheme -- so an http-served page (local dev) resolves a
different socket than the CLI's own `wss://` default for a bare-host endpoint,
while a production `https` deployment agrees with it. This is a remaining
consumer-side default, not a gap this endpoint closes. Both mint directions are
pinned by the cross-application conformance vectors (see
[PROTOCOL.md](PROTOCOL.md#webrtc-rendezvous-peer-id-derivation)).

The address is built through the URL API, with `path` assigned as a pathname
rather than concatenated, so the scheme's default port is left implicit in it.
`host` and `path` are refused for shape before anything is dialed, because both
are partner-supplied when the connection came from an invitation endpoint and
each can otherwise contain the delimiters that move a URL's authority:

| Field | Refused |
| ----- | ------- |
| `host` | any of `@ / ? # \` or whitespace, and any value that does not parse as a bare authority (one contributing userinfo, a port, or a path of its own) |
| `path` | a value not beginning with `/`, or containing any of `@ ? # \` or whitespace |

`key` takes no equivalent rule: an invitation endpoint is a strict
`host`/`port`/`path` allowlist and has none, and the value is encoded as a
query parameter rather than interpolated. The finished address is checked
against the configured host once more before the socket is constructed, so an
address naming another authority opens nothing.

The browser acceptor applies the same two delimiter rules -- one
implementation, shared from `@alcove/core` -- to the `host` and `path` of the
invitation endpoint it dials, and refuses before it constructs a peer. It needs
them for a different reason than the CLI: the PeerJS client assembles its
address by concatenating scheme, `host`, `:`, `port`, `path` and `peerjs?key=`,
so a delimiter in either field is read as part of the address rather than as a
value inside it. What each shape does to the assembled address is measured
against the real client in real Chromium
(`apps/web/test/browser/webrtcEndpointAuthority.test.ts`):

| Endpoint field | What the delimiter does to the dialed address |
| -------------- | --------------------------------------------- |
| `host` with `@` | the named host becomes userinfo, and the dial reaches the name after the `@` |
| `host` with whitespace | a tab or newline is deleted and a space percent-encoded, so the dial reaches a third name that is neither |
| `host` with `/ ? # \` | the dial keeps the named host, dropping the endpoint's own port and mount point |
| `path` with `@ ? # \` or whitespace | the dial keeps the named host; the rest of the address is reshaped |
| `path` without a leading `/` | the client inserts one, so the mount point is whatever follows |

Not one of those shapes fails closed on its own: every one assembles an address
the browser accepts, so the refusal is the whole of what stands between a
partner's delimiter and the socket. The browser has no equivalent of the CLI's
second check on the finished address either, since the client builds that
address and opens it internally with no point in between for the app to read it
back. What the acceptor relies on instead is that its dial path resolves the
endpoint through that refusal, which the same file measures by driving the dial
path with each shape and requiring that no peer is ever constructed.

Both rules are a denylist of delimiters rather than an allowlist of host
spellings, and a mapped separator passes: a `host` holding U+3002, U+FF61, or
U+FF0E -- the alternative label separators the URL parser folds onto `.` --
contains none of the refused characters, so the browser dials the mapped name.
That name is one the endpoint itself spells, since the partner chooses the
endpoint host outright, and the CLI's bare-authority check accepts the same
mapped host, so the two consumers agree on the server a locator names.

The server stamps `src` itself from the connecting client's id, so an outbound
frame contains only `type`, `payload`, and `dst`. Heartbeats (`HEARTBEAT`, no
payload) go up every 5 s.

The vendored broker holds frames addressed to a peer that has not registered.
It delivers every held frame at once if the peer registers within about 5 s of
the first being queued. Otherwise it drops them and sends each sender one
`EXPIRE` whose `src` is the absent peer, 5 to 6 s after that first frame. A
frame past one of its hold bounds -- among them eight absent destinations per
sender -- is not held and is answered with `EXPIRE` at once
([CHANNEL_SECURITY.md](CHANNEL_SECURITY.md#web-signaling-surface-bounds), "Relay queue bounds").
It reports nothing about a frame it has handed to the peer's socket, so an
offer delivered to a partner whose socket then drops before it answers is lost
with no `EXPIRE`.

- The CLI acceptor sends its `OFFER` once, and sends it again, with the
  candidates already sent, when an `EXPIRE` arrives before it is answered, or
  once the unreported-offer re-send budget (table below) passes with neither
  an `EXPIRE` nor an answer, for an offer lost unreported. An `EXPIRE` sends
  the offer again no sooner than the minimum offer re-send interval (table
  below) after the last send: every `EXPIRE` arriving inside that interval is
  answered by one send, with its candidates, when the interval ends. It never
  repeats an offer the broker may still hold: PeerJS 1.5.5, given a second `OFFER` for a
  `connectionId` it already holds, closes that connection -- emitting no
  `close` while it is not yet open -- and builds a new one. A browser
  inviter's app has already taken the first, so the data channel would open on
  a connection the app never reads.
- An `EXPIRE` after the acceptor's offer is answered is ignored; the
  channel-open budget bounds a partner that left after answering.
- A CLI inviter takes no action on an `EXPIRE`. It sends only in reply to an
  `OFFER`, so an `EXPIRE` means the acceptor it answered has left the broker.
  An acceptor that returns offers under a new `connectionId`, and the inviter
  follows it under the rule below.
- A browser acceptor dials again, after a delay, when PeerJS reports the
  `EXPIRE` as `peer-unavailable`, under a new `connectionId` each time.

A CLI run presenting a TURN credential it minted replaces its peer connection
each relay-credential renewal interval (table below) the partner has not yet
sent its session description, building the new one with a freshly minted
credential, so a rendezvous longer than the credential's lifetime still
gathers a relay candidate. A partner that has sent its description keeps the
connection it was negotiating with.

- The acceptor's rebuilt connection offers under a new `connectionId`. The replaced connection stays open for the renewal overlap (table below), which starts when the new offer is first sent: during it the acceptor holds two live `connectionId`s, and the first one answered wins -- that connection proceeds and the other is closed and its id forgotten. When the overlap ends unanswered the replaced connection is closed and the new id is the only one. The overlap covers the broker's hold of frames for a late registrant: a browser inviter's app takes the first connection PeerJS hands it, PeerJS answering later offers under other ids automatically, and a registrant can be handed the replaced offer and the new one together.
- The inviter has sent nothing before the partner's `OFFER`, so its replacement is not visible on the wire.
- Each side drops an `ANSWER` or `CANDIDATE` naming a `connectionId` it does not hold -- the acceptor's live ids, the inviter's the one of the `OFFER` it answered plus, during its own overlap, the one it answered before -- and routes a `CANDIDATE` to the connection its id names. One naming none, or reaching an inviter that has not answered yet, is taken as current. A connection that is closed drops the candidates queued for it.
- An inviter that has answered and receives an `OFFER` naming a new `connectionId` treats it as the acceptor's rebuilt connection, since its answer can cross that rebuild in flight: it builds a new peer connection (with a freshly minted credential when the run mints one) and answers the new offer, keeping the connection it answered before open for the renewal overlap, since the acceptor may take that earlier answer instead. Whichever connection the acceptor's data channel arrives on is kept and the other closed. It follows one new `connectionId` at any time and at most one more per renewal interval, an unused interval not carrying over, and drops a surplus `OFFER`. An `OFFER` repeating the current `connectionId` is re-answered.
- A browser inviter whose answer to the replaced offer arrives after the overlap has ended is not followed: the acceptor refuses that late answer. The browser's client answers the new offer automatically regardless, but the web app never adopts that connection; the CLI's data channel opens on it anyway, so that run reports connected and fails when the browser tears down rather than at the rendezvous timeout. A CLI inviter follows the new offer.
- The renewal line an operator sees is printed once the rebuilt connection replaces the old one, and not for a rebuild abandoned because the partner sent its description meanwhile.

Message types acted on: `OPEN`, `OFFER`, `ANSWER`, `CANDIDATE`, `LEAVE`,
`EXPIRE` (by the acceptor, as above), `ERROR`, `ID-TAKEN`, `INVALID-KEY`. Two
of them hold operator meaning: `ID-TAKEN` is the symmetric-role
misconfiguration (both parties set the same `role`), and an `ERROR` whose
payload names an invalid key is the wrong `server.key`.

## Negotiation envelope

- **`OFFER`** payload: the SDP under `sdp`, a `type` of `data`, a
  `connectionId`, and the DataConnection's `metadata`, `label`, `reliable`, and
  `serialization`. `serialization` is critical rather than a preference: the
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

- A chunk envelope holds the message id (`__peerData`, starting at 1 and
  incremented for each message sent in chunks; a message sent whole takes no
  id), the chunk index, the chunk bytes, and the total chunk count. Chunks
  accumulate by id until the count matches the total.
- The chunking threshold is 16300 bytes, well under the SCTP ceiling.
- The browser delivers an assembled chunked frame as a `Uint8Array` and an
  unchunked one as an `ArrayBuffer`; a consumer must normalize both.

The inbound path is bounded before anything is reassembled. Both parties refuse
an envelope whose message id is not an integer, whose count is not a positive
integer, whose index is outside that count, or whose chunk bytes are not binary.
`MAX_WEBRTC_FRAME_BYTES`, the chunk-count cap, and the structural scan that goes
with them are specified in
[CHANNEL_SECURITY.md](CHANNEL_SECURITY.md#webrtc-data-channel-inbound-bound).

### Outbound encoding

Both parties encode an outbound frame with Alcove's own BinaryPack encoder
(`encodeBinaryPackValue`, `packages/core/src/connection/binaryPackEncode.ts`)
rather than with `peerjs-js-binarypack`'s `pack`. It walks a frame's arrays and
objects with an explicit stack, so a frame's element count is bounded by memory;
the library's own packer descends one call frame per element and overflows the
sender's stack at roughly 7,800 matched records, well below what the inbound
bounds admit. The CLI calls it from its wire module; the browser installs it over
the PeerJS data connection's own encode step, leaving PeerJS's chunking and
buffering in place
(`apps/web/src/psi/transport/iterativePacking.ts`).

The wire is unchanged. The encoder emits the bytes the pinned packer emits,
marker for marker, for every value kind Alcove sends:

- null and undefined (`0xc0`), booleans (`0xc2`/`0xc3`).
- Integers on the packer's own ladder -- fixint, then the first unsigned or
  signed marker whose range holds the value -- and non-integral numbers as the
  packer's `double` (`0xcb`), whose exponent and fraction come from a logarithm
  and a truncating multiply rather than from the IEEE-754 bits.
- Strings as UTF-8 under `0xb0 + n` / `0xd8` / `0xd9`, byte arrays
  (`Uint8Array`, `ArrayBuffer`, any typed-array view) under `0xa0 + n` / `0xda`
  / `0xdb`.
- Arrays under `0x90 + n` / `0xdc` / `0xdd` and plain objects as maps under
  `0x80 + n` / `0xde` / `0xdf`, keys packed as strings in `Object.keys` order.

Above the count a 16-bit header can declare, the wider `array32` and `map32`
headers appear; the inbound scan and `unpack` already read both, so a frame
larger than the previous ceiling needs no negotiation. Any other value kind --
a `Date`, a `Map`, a class instance, a number outside the integer range -- is
refused with a `usage`-kind `ConnectionError` rather than guessed at, since a
guess that misses is a silently corrupt frame. Two more frame shapes are refused
so that no frame is written the packer would not have written whole: a value
that holds itself, which the packer meets as a stack overflow and the encoder as
a container already on the walk from the root, and an object with an own
`constructor` or `hasOwnProperty` key, each of which shadows a check the packer
makes -- it reads `value.constructor` to pick the kind and calls
`value.hasOwnProperty(key)` for each key of a map. The encoder refuses that
shadow outright, which is wider than the packer: the packer throws on all but
one of these shapes, and on the one it survives -- an own `hasOwnProperty` that
answers false for every key -- it writes a map header it fills with nothing.

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

**The web app** waits for the peer to close the data channel. The peer does that
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

1. Wait until the peer has acknowledged every byte already handed to the
   channel, then
2. send the sentinel, wait until it has been transmitted (not acknowledged -- a
   peer closes on reading it and stops acknowledging at exactly that point),
   then
3. close the data channel, wait for that close to complete, and only then tear
   down.

Step 3 is what the partner's own wait ends on, and it runs on both halves of a
clean close -- the one this side asks for and the one it answers on reading the
peer's sentinel. The channel's close is the whole of the delivery signal a
browser partner gets: PeerJS takes a receipt off its channel closing, never off
anything sent back to it. A peer connection torn down under a still-open channel
reaches that partner as no close at all -- and as no sentinel either, since
handing the sentinel to the wire is not the peer having it -- leaving it to wait
out ICE. Waiting for the channel's close to complete is the confirmation that
everything ahead of it arrived. The wait is bounded, and it ends early when the
peer connection is already no longer up -- which covers a partner detected as
gone before the close began. It is not the usual reading of a partner that
vanishes: werift leaves the `connected` state about thirty seconds after a peer
disappears, so a partner lost during the teardown itself costs the whole
ceiling.

The condition in step 1 is the SCTP association's send and unacknowledged queues
both being empty. It is not the channel's `bufferedAmount`: that
counter reaches zero while chunks are still unacknowledged, and a close gated on
it loses them -- measured at roughly one frame in three over a loopback channel
with no packet loss at all. This is the acknowledgement the flushing-close half
of the delivery contract requires; "flush the local buffer" is not sufficient on
this transport (see
[COMMUNICATION.md](../COMMUNICATION.md#message-delivery-and-teardown)).

Every wait above also ends when there is nothing live left to deliver over, so a
partner that crashed produces a teardown rather than a wait as long as the
ceiling. For the web that is the peer connection reaching `failed` (ICE gave up
on the peer) or `closed` (this side tore its own link down); a transient
`disconnected` is not terminal, because the frame is still in flight while ICE
recovers.

A teardown on this side reaches the wait as the channel closing, not as a state
change -- closing a peer connection fires no state event, measured on Chromium,
the one engine the browser suite drives -- and the channel closing is otherwise
the peer's receipt. The web wait therefore reads the link at that event rather
than taking the close at face value.

A dead link is not the whole reading, because the peer's close ends this side's
link too: PeerJS closes this side's peer connection as its handling of the
peer's in-band close sentinel, in the same call, before the channel's `closing`
fires. Both parties closing a healthy exchange therefore each reach `closing` on
a link of their own closing, which is the signature of a teardown on the one
ending that lost nothing -- measured on a real pair in Chromium. What separates
the two is whether the end was PeerJS's own doing. PeerJS clears `open` whenever
it itself ends the connection -- reading the peer's close sentinel, this side's
own close call, or its own cleanup on a signaling leave naming this peer, an
inbound OFFER echoing the live connection, ICE reaching failed or closed, or a
send error. So a cleared flag at `closing` means a PeerJS-mediated end and
is treated as the peer's close. Only an end that bypasses PeerJS -- this side's
raw peer-connection teardown -- reports the loss. A partner who ends the link
through signaling (a relayed leave) mid-drain is therefore also treated as the
receipt; the close remains no proof of delivery. So the no-live-peer exit is
taken for a channel that starts closing on a link already gone with no peer
close in hand; a link the peer's own close ended is the peer's receipt.

A CLI partner reaches the same reading by the other route. It closes the data
channel rather than ending the link through signaling, so the channel starts
closing on a link that is still up and that PeerJS has not ended -- a live link
with no teardown of this side's behind it, which the reading takes as the peer's
close. Both routes are measured: the browser pair in
`apps/web/test/browser/webrtcCloseDelivery.test.ts`, and the CLI-to-browser pair
by the live leg.

A partner that closes FIRST leaves no wait to take at all: PeerJS ends the
connection on reading the sentinel, so this side's own close finds it already
ended and starts no drain. That is silence rather than an exit -- the operator
is told nothing, which is what the peer's close means here too.

A completed `close` arriving with no `closing` before it is still read as the
peer's, because a link state read after a close has completed no longer says
whether the link died before the close or in answer to it, and a doubt invented
about a healthy exchange is the worse error. The reading is therefore inert on a
stack that never fires `closing`: every close is treated as the peer's there,
the pre-reading behavior -- the stated limit of this discrimination. The
healthy-exchange reading also assumes the engine dispatches the channel's
`closing` as a queued task after the synchronous close call, as spec-conforming
engines do and as Chromium, the one engine the browser suite drives, measures;
an engine dispatching it synchronously inside the peer connection's close would
report a spurious loss on every healthy exchange there.

The web wait also ends when the run itself is cancelled. Up to the ceiling the
wait's length is the peer's to choose -- it holds the wait simply by keeping ICE
alive and never reading the sentinel -- so an operator who cancels does not spend
it. Nor does the drain gate what the run already has: the web app reports its
result and its downloads first and drains afterwards, so a peer that never reads
the sentinel delays neither.

Exactly one exit of the web wait gives a delivery signal: the peer's own close.
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
| Nothing live is left to deliver over -- the peer connection failed, this side tore it down, or the channel was already out of `open` | The connection closed before the partner could confirm, so they may or may not have received it |
| The run was cancelled while the wait stood | The same wording as a connection that closed: the cancel cuts the wait rather than letting it run out, and what the partner got is as unknowable either way. A cancelled run's notice is withheld anyway (below), so this is what the exit means rather than what an operator reads |

The notice is best-effort in two ways. It reaches the operator only when the
drain ends while the run is still on screen, so an operator who leaves as the
results render is told nothing. And it speaks for a run that succeeded here, so a
run that already failed or was cancelled drains the same close silently -- it has
told the operator something stronger already.

A close signal is not proof the partner's application read what was behind it: a
peer that closes without draining its inbound queue is indistinguishable from one
that read everything. The partner's peer connection torn down by their page
rather than by reading the sentinel resets its stream gracefully -- measured in
Chromium, and pinned in `apps/web/test/browser/webrtcCloseDelivery.test.ts` -- so
that teardown arrives here as the same close. The state of the link, read
together with whether the peer's own close accounts for it, is what tells a
close apart from a teardown, and only this side's link is visible here: it
separates a teardown of this side's that the peer had no part in (above) and can
say nothing about the partner's. That is also why the cancellation is an exit of
its own rather than whatever the teardown behind it does to the channel: a cancel
folded into an exit of the link's would report the link's story for a wait the
operator cut.

What no close can cover is a sender whose stack goes away before its bytes do:
tearing the peer connection down as the close returns delivered nothing at all
-- measured at zero frames of two received, four rounds out of four. A browser
tab closed the instant the results appear does the same thing to a frame still
buffered. Waiting narrows that window to the delivery itself rather than
leaving it open for the length of the transfer, and a teardown that lands inside
it while this page keeps running is reported as the loss it is rather than as a
delivery.

### What each side's wait costs, measured

The two waits above are specified against what each stack exposes, not against a
duration. What they cost when a CLI party and a browser party close the same
healthy exchange is measured by the live leg
([docs/TESTING.md](../TESTING.md#live-webrtc-leg)), which prints both numbers on
every run. The leg gates on the browser party's exit, read against which party
closed first, rather than on either duration, and holds that party's wait under a ceiling set between the two
outcomes it separates: a wait the partner's close ends costs milliseconds, and
one left to end on ICE giving up costs 15 s or more. The durations stay a
tracked limit -- read across runs, with any tighter bound a later decision taken
against the spread rather than against one measurement.

| Side | What it waits for | Measured |
| ---- | ----------------- | -------- |
| The CLI party | The data channel's own close completing, once the peer has the frames ahead of it | under 100 ms |
| The browser party | The peer to close the data channel | under 50 ms, ending on the peer's close |

Conditions, over ten runs: two parties on one machine over a loopback host
candidate, six records between them, Chromium against the shipped CLI
transport, in the development container. The browser party usually reaches its
close first here, so the CLI party's number is usually the half that answers a
sentinel; the half that sends one adds the drain to acknowledgement and the
sentinel ahead of the same channel close, and moves with the data still
unacknowledged on a wide-area link and a real dataset. Neither moves the browser
party's number, which is not a function of the data. Both are round-trip waits
between two processes on one machine, so both rise with load on it -- a
contended container has put either several times higher.

So a completed CLI-to-browser exchange leaves the browser operator no notice
about a partner who may not have taken the final frame: the CLI party's close
either ends the wait or precedes it, and neither is a doubt.

## ICE

A configured `iceServers` list replaces the built-in STUN default rather than
adding to it, which is what makes a configured server list the list
actually used. An empty or absent list means "use the default"; it does not mean
"no STUN". The consequences for an operator -- the default that applies when
nothing is configured, what it discloses, and the unreachable-entry idiom for
gathering host candidates only -- are in [CLI.md](../CLI.md#webrtc-exchanges).

`connection.ice_transport_policy` selects the candidate types this side may
gather: `all`, which is what an absent value leaves in force, or `relay`. Under
`relay` no host or server-reflexive candidate is gathered, so this side's
whole offer is relay candidates and every pair it can form runs through a
configured TURN server. The value is per party and never a term of the exchange:
it is not representable in an invitation endpoint, and it constrains nothing the
partner gathers. A `relay` policy with no `turn` entry and no `ice_provision` is
rejected by the connection schema, since it could gather nothing to pair.

The policy holds for a `turn` entry the transport keeps, and the connection
schema accepts no url the transport would drop, and refuses a few it would
keep (a repeated `transport` parameter, whose first occurrence the transport
reads) rather than rest on which occurrence is read. The transport reads a
turn url's `transport` parameter itself and refuses the whole entry over
a value it does not support, continuing without it, which under `relay`
leaves the run gathering the host candidates the policy exists to keep
off the wire. So the schema accepts a url that leaves `transport` unset or
sets it to lowercase `tcp`, and `udp` on a `turn:` url; every other value --
another protocol, an uppercase spelling, an empty one, or `udp` on a `turns:`
url -- is refused at parse. A url setting the parameter more than once is held
to the same rule at every occurrence, rather than resting on the transport
reading the first. Which values the transport keeps is measured per form in
`apps/cli/test/integration/webrtc/webrtcIceTransportPolicy.test.ts`, which
the grammar in `packages/core/src/config/connection.ts` is drawn from.

The connection schema's webrtc member is a strict object: a key it does not
define is refused at parse, naming the key in the snake_case the document
writes, rather than stripped. A dropped `ice_transport_policy` would leave a
run that asked for relay-only candidates gathering under the default, with
nothing stating that it had -- the reason `authentication` is strict as well
(`packages/core/src/config/connection.ts`).

Every run states the policy it applied as it opens the rendezvous: the
configured value, or the transport's own default where the connection sets
none.

A CLI rendezvous that fails with both parties present -- the peer connection
reporting `failed`, or the channel-open budget running out -- reports the
candidate types this side gathered, the types the partner sent, and how many
candidate pairs were tried, each on a labelled cause link of its own, so a
relay that was never gathered is distinguishable from one that was and still
found no path. A rendezvous that ends on the rendezvous budget, on the
partner's `LEAVE`, or on the data channel closing before it opened reports no
candidate detail. Where the policy is `relay` and no relay candidate was
gathered, the first link names the policy: that run had no direct path to fall
back on, so the policy is part of the diagnosis rather than context the
operator supplies. What an operator
does with that answer is in [CLI.md](../CLI.md#webrtc-exchanges).

`connection.provider_options` is inert on this channel: no transport on either
side reads it, so no key in it reaches the PeerJS client, the peer connection,
or the ICE configuration above, and the only honored form of the map is the SFTP
channel's, filtered through a default-deny allowlist
([EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#connectionprovider_options)).
`npm run check:webrtc-provider-options-unread` holds that claim: it scans the
CLI's and web app's WebRTC sources for a read of the option and fails the moment
one appears. That allowlist rather than a verbatim passthrough is what a
consumer here would be held to, since an opaque map reaching the broker or peer
options could otherwise move where this side connects.

## Application-layer encryption

The `webrtc` channel states `request_encryption: false`: a data channel is
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
| Minimum offer re-send interval | 10 s | The least time between two sends of the CLI acceptor's offer on an `EXPIRE`; above the broker's 5 to 6 s hold, so a copy sent on an `EXPIRE` is never held beside the one before it |
| Unreported offer re-send | 30 s | How long the CLI acceptor waits after sending its offer for an answer or an `EXPIRE` before sending it again; far above the broker's 5 to 6 s report of an undelivered frame, so the copy it replaces is no longer held |
| Relay credential renewal | 30 min | How long a CLI run presenting a minted TURN credential waits for the partner's session description before it rebuilds the peer connection with a new one; half the credential's one-hour lifetime |
| Renewal overlap | 15 s | How long a connection replaced by a relay-credential renewal, or by an inviter following a new offer, stays open and answerable; above the broker's roughly 5 s hold of frames for a late registrant |
| Channel open | 30 s | The data channel opening once both descriptions are exchanged; reaching it means the peer is present but no candidate pair worked |
| Parked receive | 1 h | Peer silence on an open channel; it bounds the peer's single-threaded PSI compute, which sends no keepalive while it runs |
| Close drain | 5 min | The clean close's wait above -- the CLI's acknowledgement drain, the web's wait for the peer's close -- sized from the largest admissible frame and the measured send rate |
| Sentinel hand-off | 2 s | Getting the close sentinel itself onto the wire |
| Channel close | 2 s | The data channel's own close completing on a clean close -- the peer answering the stream reset. A partner that goes during the teardown spends it whole, ICE being slower than this to call the link dead; reaching it closes the session anyway |
| ICE statistics | 2 s | Collecting the candidate report a failure or an open channel is described by; expiring costs the description, not the outcome |
| Transport teardown | 6 min | The whole close of this transport at the run's own teardown point, above the sum of the close drain, sentinel hand-off, channel close and ICE statistics budgets in this table |
| Signaling certificate check | 5 s | The handshake that answers whether a `wss://` socket that failed before registering failed on its certificate; a socket that drops after registering is not asked about, having completed that handshake already, and neither is one on a run configured for an environment proxy, whose dial the handshake does not follow |

The teardown ceiling is the run's, not this transport's: it is applied at the channel-independent point where a run closes what it opened, and every channel declares a value there above its own teardown budgets (the file-based channels' is in [FILE_SYNC.md](FILE_SYNC.md)). The close runs after the run's terminal event, so reaching the ceiling stops the wait and states the elapsed time and the resource kinds still holding the process on the operator log at error level, never on the event stream, which ends at that terminal event ([CLI_EVENTS.md](CLI_EVENTS.md#terminal-event-guarantees)); it changes no exit code. Nothing local is inside it: the result, the exchange record and the receipt are written and awaited before cleanup begins, each with no budget of its own where it goes to a path. The one local wait that is bounded is a result streamed to stdout, whose drain and its outcome are in [CLI_EVENTS.md](CLI_EVENTS.md#error-categories).

Once the run's own work and its teardown are finished, the process returns within **3 s**. A clean event loop exits at once and says nothing -- measured from the command settling to natural exit, a completed two-party `filedrop` exchange drained in 0-1 ms across ten party-runs -- and a loop still held at the budget names the resource kinds still armed on stderr and exits with the status the run already resolved. The handle that held it is not released or swept: a run that reports what held it is how the next one is found.

`connection.options.peer_timeout_ms`, when set, replaces the rendezvous,
channel-open, and parked-receive budgets: on this channel the documented "total
wait for the partner" is three waits, one before the channel exists, one while
it opens, and one after. It is the only setting an operator has on any of them.

An interrupt (SIGINT or SIGTERM) does not wait any of them out. The run passes
the transport an abort signal, and the rendezvous fails and tears down the
broker socket and the peer connection on it, so a party that interrupts while
waiting for its partner exits at once rather than at the end of the rendezvous
budget.

A configured relay leaves one timer armed that this transport cannot release.
werift keeps a TURN allocation alive by re-sending refresh on a timer armed from
the lifetime the relay granted, and tearing the peer connection down leaves a
timer that is already waiting armed; a waiting timer holds the event loop, for
five sixths of the granted lifetime -- about 500 s where a relay grants the
usual 600 s. Everything the exchange owes is complete before that wait begins:
the result, the exchange record and the receipt are written, the channel and
the broker socket are closed, and nothing crosses the wire during it. So what
the timer holds is the loop rather than the run, and the return budget above is
what ends the process, naming the kinds of handle still armed as it goes.
Nothing werift exposes releases the timer, so it is a stated limit rather than
a budget this transport sets; the measurement, and the release paths that were
driven against it, are in
[DEPENDENCY_PINS.md](DEPENDENCY_PINS.md#the-behavioural-assumptions).

Two CLI bounds are memory rather than time, both on inbound signaling: a
signaling frame is refused above 256 KiB of UTF-8 before it is parsed, and at
most 128 remote candidates are held per connection while that connection's
remote description is not yet applied -- during a renewal overlap the
replaced connection and its replacement each hold their own.

## See also

- [PROTOCOL.md](PROTOCOL.md#webrtc-rendezvous-peer-id-derivation) - the
  normative rendezvous peer-id derivation both implementations reproduce.
- [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md#webrtc-data-channel-inbound-bound) -
  the inbound reassembly bound and the AEAD envelope.
- [COMMUNICATION.md](../COMMUNICATION.md#message-delivery-and-teardown) - the
  delivery contract every channel owes.
- [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md) - why `peerjs` and `werift` are
  exact-pinned, the behavioural assumptions they rest on, and how to re-verify them.
- [cli-webrtc-stack.md](../notes/cli-webrtc-stack.md) - the library decision and
  the alternatives weighed.
