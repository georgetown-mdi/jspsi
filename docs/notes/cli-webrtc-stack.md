---
title: "The CLI WebRTC Stack"
---

# The CLI WebRTC stack: werift, driven directly

*Status: decided and built. This note records the Node WebRTC library and the
integration architecture chosen for the CLI's WebRTC transport, the validation
spike that settled them, the alternatives weighed and declined, and the
constraints and known costs the transport holds. Nothing here is normative:
the wire the transport speaks is specified in
[WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md), the rendezvous derivation in
[PROTOCOL.md](../spec/PROTOCOL.md#webrtc-rendezvous-peer-id-derivation), and the
delivery guarantee its close must honor in
[COMMUNICATION.md](../COMMUNICATION.md#message-delivery-and-teardown). See
[docs/notes/README.md](README.md).*

The web application conducts peer-to-peer WebRTC exchanges through PeerJS.
Letting the CLI take part in those exchanges needs a Node WebRTC library, and
both the library and the way it is wired underneath PeerJS are critical
enough that a hands-on spike was scoped to settle them rather than research
alone. That spike ran, and the transport it settled is built. This note is the
decision record: what was chosen, what the evidence showed, and what the
transport holds.

## The decision

- **Library: werift, exact-pinned, as the published package.** Version 0.24.4
  was current when the decision was taken. Installs run with
  `--ignore-scripts`; nothing in werift's tree needs an install script, and the
  tree contains no native or compiled content at all. The exact pin and its
  internal assumptions sit with the other reached-past-their-API stacks in
  [DEPENDENCY_PINS.md](../spec/DEPENDENCY_PINS.md#why-these-are-exact-pinned),
  which holds the per-bump re-verification checklist.
- **Architecture: drive werift's native API directly.** No PeerJS runs in Node.
  The CLI speaks the PeerJS broker's WebSocket protocol through a hand-written
  signaling client, and speaks PeerJS-compatible DataConnection framing on the
  raw data channel: BinaryPack through the published, zero-dependency
  `peerjs-js-binarypack`, PeerJS's chunk envelope, and PeerJS's in-band close
  sentinel for the clean close.
- **Signaling: the vendored PeerServer, reused as-is.** The broker already runs
  in Node (`apps/web/src/peerServer.ts`). The CLI adopts the web's
  `HKDF(secret, role)` rendezvous peer-id derivation rather than defining its
  own, which is what puts the two parties on the same connection with no
  coordination backend.
- **Serialization: `binary` (BinaryPack).** Not `json`, and not a simpler
  scheme chosen for our own convenience -- see below.

**Rejected: PeerJS-in-Node.** Shimming the global WebSocket and RTC classes and
running the real PeerJS library in Node was reconsidered on the spike's
evidence, because werift 0.24.4 ships a real W3C compatibility layer (assignable
`onicecandidate` / `ondatachannel` / `onconnectionstatechange` handlers,
`pc.sctp`, `canTrickleIceCandidates`, current and pending descriptions,
`RTCConfiguration` round-tripping, rollback, and a Web Platform Tests runner),
which is what makes the shim route worth weighing at all. It was nonetheless
declined, on two grounds. It reintroduces the polyfill brittleness the direct
route avoids -- a compatibility layer chased across a fast-moving library, in
a stack where a silent behavioral gap costs an exchange. And it un-moots
peers/peerjs#979 (below), which is moot under the direct route purely by
architecture. Against those, driving werift directly is already validated end to
end. The saving PeerJS-in-Node offers is real but small next to what it takes
back.

**Rejected: the `json` serialization as a way to skip BinaryPack.** It
negotiates and round-trips small frames, so it is available for control messages
-- but PeerJS's JSON DataConnection refuses to send past 16300 bytes rather than
chunking it, in both directions, so it cannot hold a PSI frame at all. The cost
it was meant to avoid turned out not to exist:
`peerjs-js-binarypack` is published standalone, MIT, with zero dependencies, and
runs unmodified in Node, where `pack` and `unpack` are synchronous for the
`Buffer` and `Uint8Array` payloads Node produces. Only the chunk envelope around
it had to be written. The web app also depends on the `binary` default
concretely: its inbound reassembly bound reaches into PeerJS's internal chunk
map (`apps/web/src/psi/boundedReassembly.ts`,
[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#webrtc-data-channel-inbound-bound)),
so BinaryPack chunking is wired into a security control, not merely a default.

**Rejected: a media-stripped vendored fork, for install weight.** Vendoring
stays prepared as a fallback for a patch upstream will not take, but stripping
werift's media stack to save install weight is not worth its maintenance. See
[Supply chain and the vendoring fallback](#supply-chain-and-the-vendoring-fallback).

## The problem, and where its risk sits

Node has no built-in WebRTC, so a library has to supply it. The web stays on
PeerJS for the foreseeable future -- the rendezvous derivation replaced a
backend coordination service but kept the PeerJS broker -- so "CLI to web"
necessarily means the CLI speaks PeerJS broker signaling. CLI-to-CLI is an
internal stepping stone only, never a shipped feature with its own signaling.

The dead-end risk is in the signaling layer, not the data channel. Every
candidate library is browser-interoperable at DTLS/ICE/SCTP, so any of them can
move bytes to a browser once a connection is up. What would lock the CLI out of
the CLI-to-web case is non-PeerJS signaling. The binding constraint on the pick
is therefore that signaling stays PeerJS-broker-compatible, or sits behind a
swappable interface a PeerJS client drops into.

## Why werift

| Library | Browser interop | TURN / relay | Install / ABI | Security surface |
|---|---|---|---|---|
| **@roamhq/wrtc** (Chromium libwebrtc) | Highest -- it *is* Chrome's stack | Full: UDP, TCP, TLS | glibc-only prebuilts; no musl, no win-arm64; source build infeasible | Smallest -- the most-audited WebRTC anywhere |
| **node-datachannel** (libdatachannel) | High -- mature, widely deployed | UDP only in the default prebuilt (libjuice); TCP/TLS need a libnice source build | Best: N-API (ABI-stable across Node majors) plus musl prebuilts | Moderate -- C++, conventional DTLS |
| **werift** (pure TypeScript) | Good, and proven against a stock browser peer for this use | UDP, TCP, and TLS relay transports shipped | Most portable -- zero native content, nothing compiles at install | Largest -- DTLS/SRTP reimplemented in JavaScript, effectively one author |

werift wins on portability and on being sufficient rather than best: the CLI
ships as a container image on musl (`node:26-alpine`, `linux/amd64,linux/arm64`)
alongside a glibc FIPS variant, and a dependency that compiles nothing at
install removes a whole class of build accommodation from that matrix. The two
caveats that weigh against it -- what one author's velocity is worth, and how
far its relay transports reach -- are examined below against the shipped
library rather than against its reputation.

**Packaging is not the gate.** A per-client *build* accommodation -- a native
build for an extra architecture, a different container base -- is acceptable as
long as it changes only the build and not the code, and the glibc FIPS variant
is already that precedent. Distribution facts that would otherwise rule a
library out are therefore not the deciding axis; packaging adapts to the chosen
library. werift's install portability is a convenience, not the reason it wins.

**Velocity and backlog.** werift is one author's project by a factor of roughly
27 to the next human contributor, and that is the risk that does not go away.
The activity numbers around it are healthy: eight releases in the last twelve
months, three open pull requests against fifty-two merged in ninety days, and
the current release holding real new capability. High velocity from a single
author is not the same risk profile as a maintained project, though, and a
cleared backlog is a property of solo maintenance rather than a mitigation of
it. The posture that follows is pin-a-version-and-be-ready-to-vendor, for
bus-factor reasons.

**Relay transports.** werift's TURN relay control transport over TCP shipped no
later than 0.20.0, reachable through a `forceTurnTCP` boolean. TURNS over
TLS -- the port-443 lifeline for a peer behind a firewall that blocks UDP
outright, which is precisely a CLI-to-web scenario -- landed in 0.24.0, together
with a full `stun` / `stuns` / `turn` / `turns` URL parser, a `node:tls`
transport, and ICE-TCP host candidates; `forceTurnTCP` is deprecated in favor of
the URL transport parameter in the same release. `turns:relay.example:443?transport=tcp`
parses to a TLS relay, so the port-443 case is expressible. What the spike did
*not* do is drive a real relay: this is the published API surface, the parsing
logic, and upstream's own claims, not a run against a TURN server. See
[Constraints the transport inherits](#constraints-the-transport-inherits).

**What would still change the pick.** If the hand-rolled JavaScript DTLS surface
under one author is judged unacceptable for a security tool, node-datachannel is
the middle option: an N-API-plus-musl install and libdatachannel's more
conventional C++ DTLS, at the cost of a read-only `RTCSessionDescription`
friction and a UDP-only default relay. If throughput is ever elevated to a
requirement, node-datachannel is also the comparison point to measure against
(below). @roamhq/wrtc remains the choice if the most-audited stack is wanted
regardless of platform cost.

## What the spike established

The spike ran the real libraries end to end against the repository's own
vendored PeerServer, with a stock browser `peerjs@1.5.5` peer -- the exact pin
the web app holds -- driven headless in Chromium, and werift in Node on the
other side. Every third-party package involved was installed with
`--ignore-scripts`, and every milestone ran against that tree.

- **Interop.** A stock browser PeerJS peer completed a DataConnection with
  werift-in-Node through the vendored broker and exchanged hash-verified frames
  in both directions, in both roles -- browser dialing and werift dialing --
  with `label`, `metadata`, and `reliable` all preserved across the negotiation.
- **Chunking past the SCTP ceiling.** Both peers advertised a 65536-byte maximum
  message size, so chunking is mandatory rather than optional. 512 KiB, 4 MiB,
  and 32 MiB frames moved in each direction with SHA-256-identical results, the
  32 MiB frames as 2059 chunks. PeerJS's own reassembly engaged on the browser
  side on every large inbound frame -- the same internal map the web app's
  inbound bound reads.
- **Flushing close.** werift handed a 4 MiB final frame to the channel and
  immediately initiated a clean close with no drain wait of any kind. The
  browser received the frame intact and its `close` event landed 3.2 ms after
  the `data` event: data before close, as the transport contract requires.
- **peers/peerjs#979.** Still open upstream -- opened 2022-06-17, last activity
  2024-02-24, no linked fix pull request, no fix version. The crash is a
  `TypeError: Cannot redefine property: candidate` thrown from `webrtc-adapter`'s
  `wrapPeerConnectionEvent` shim, and peerjs 1.5.5 hard-depends on
  `webrtc-adapter@^9.0.0`, so it is unavoidable for any PeerJS-in-Node
  arrangement. Under the chosen architecture it is moot structurally rather than
  by workaround: no PeerJS runs in Node, so nothing constructs the
  adapter-wrapped peer connection and the `defineProperty` path is never
  entered. Importing `peerjs` in Node succeeds on its own -- the adapter no-ops
  without a `window` -- and firing the crash requires a shimmed global
  `RTCPeerConnection`, which is exactly what PeerJS-in-Node would supply.

The framing and signaling the spike hand-wrote came to 456 non-comment lines
across a broker client, a wire/framing module, and the peer negotiation -- an
accurate measure of the shape, not of the work. What the spike left out is most
of what the shipped transport (`apps/cli/src/connection/webrtc/`) had to
include: `LEAVE`/`EXPIRE` handling, the dial retry for a peer that has not
registered yet, peer-id redaction in logs, the inbound bounds, and an error
taxonomy that names a cause -- a symmetric role misconfiguration is treated as
one, rather than as a rendezvous that never completes. A spike's line count is a
floor on a transport, not an estimate of one.

## The PeerJS wire the CLI speaks

The wire itself -- the broker socket, the OFFER/ANSWER/CANDIDATE envelopes, the
BinaryPack chunk framing, and the close sentinel -- is specified normatively in
[WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md). It is not psilink's protocol
to define, but two implementations have to match it exactly, which is what makes
it spec material rather than a note's.

One thing about it belongs here rather than there, because it is a decision
rather than a fact: the clean close is a sentinel, not a buffer flush, and the
spike measured what that costs a party that cannot stay alive. PeerJS's clean
close sends a `__peerData` close object through the same reliable ordered channel
and returns without tearing anything down; the *peer* closes on receipt, which
SCTP ordering necessarily places behind every frame already handed to `send()`.
A browser tab can stop there. A CLI process cannot -- it exits -- so it has to
wait for the peer to acknowledge the data first, and specifically not on
`bufferedAmount` (below).

## Constraints the transport inherits

**The default STUN server is accepted; a configured list must still win.**
`iceServers: []` does not suppress werift's built-in `stun.l.google.com:19302`
default: `getConfiguration()` faithfully reports an empty list while the
library gathers server-reflexive candidates anyway, publishing the host's
public IP. An empty array supplies no server and the ICE layer reads that as
"use the default" rather than "use none". Neither `iceUseIpv6: false`, nor an
`iceServers` entry with an empty `urls` list, nor `iceTransportPolicy:
"relay"` changes it; only `iceLite: true` suppresses it, and that is not a
usable workaround, since it forces the controlled role and gathers no
reflexive candidates at all, suiting only a publicly reachable peer -- which a
NAT'd CLI is not.

The maintainer has ruled the default acceptable as the fallback for an
operator who configures no servers of their own: it is what lets an exchange
traverse NAT for operators without the means to run their own STUN server, and
what it discloses is connection metadata -- the host's public IP and the fact
of a WebRTC session -- never exchange content. The narrower property the
transport owed on top of that -- that a configured server list is the list
actually used -- was measured after this note was written: a non-empty list
REPLACES the built-in default rather than adding to it, so nothing further was
needed (the assumption and its check are in
[DEPENDENCY_PINS.md](../spec/DEPENDENCY_PINS.md)). Separately and optionally, an
upstream issue proposing that an empty or undefined list mean "no STUN" (an
accurate host-candidates-only mode for VPN or LAN deployments) is worth opening
only if a compelling case for that mode emerges; the transport documents the
unreachable-entry idiom in the meantime.

**ICE candidates must be queued until the local description is on the broker.**
werift begins firing candidate events during `setLocalDescription`, before the
offer or answer can have been put on the broker. Browser PeerJS has no
pre-remote-description candidate queue of its own -- it hands a `CANDIDATE`
straight to `addIceCandidate` whenever the connection object exists, which on
the dialing side it already does -- so early candidates are rejected and lost,
silently from the sender's point of view. The spike's first run lost six
candidates this way and connected anyway *only* because werift also inlines its
candidates in the SDP, masking the trickle loss entirely. Queue locally until
the description is sent; the failure mode otherwise is a connection that works
until the day the inlined candidates are not enough.

**Throughput is modest and asymmetric.** On loopback, against a real browser
peer, werift's send path measured 1.42 MiB/s and its receive path 5.27 MiB/s,
over 32 MiB in each direction. The gap has a visible cause:
`bufferedAmount` is a completion edge rather than a progressive gauge. It stays
pinned at its peak for an entire transfer and collapses to zero at the end, and
the low-threshold event fires exactly once, about a millisecond before
completion. PeerJS's own sender pattern -- pause above a buffered ceiling, retry
on a timer -- therefore degenerates on werift into serialized batches: push,
wait for the whole queue, push again. Correctness is unaffected; ordering held
across 2059 chunks in both directions. For unattended scheduled exchanges this
is acceptable, and it is the kind of number a pure-JavaScript DTLS/SCTP stack
pays and a native one does not. A party's set frame near the top of what the
WebRTC frame envelope admits would spend minutes on the wire from the CLI side.
If throughput is ever elevated from a cost to a requirement, node-datachannel is
the comparison point to measure against before the pick is revisited.

**TURN is not verified against a real relay.** The relay transports are present
in the published API and the URL parser resolves the port-443 TLS case, but no
relay was driven. If TURN over TLS is required for a deployment, drive it
first; upstream ships a TURN loopback example as a starting point.

## Supply chain and the vendoring fallback

The posture: depend on the published package at an exact pin, keep vendoring
prepared, and do not vendor speculatively. Vendoring is a practiced fallback
here rather than a novel one -- the project already maintains
`@openmined/psi.js` as a fully vendored fork -- but werift starts one step
earlier on that road: psi.js needed local patches from day one, while werift
has no known defect that a pin does not cover.

What a werift-only install has: 43 packages, 26 MB on disk, no
`preinstall`/`install`/`postinstall` script anywhere in the tree, and no `.node`,
`.wasm`, `.so`, `.dylib`, `.dll`, or `binding.gyp` -- nothing compiles at
install. `npm audit` on that runtime tree reports no vulnerability at any
severity. Licenses are permissive throughout: MIT for werift itself and most of
the tree, with `mediabunny` (MPL-2.0, weak file-level copyleft) the one entry
needing a judgment. It is installed but never loaded by a datachannel-only
peer -- importing werift loads none of it -- so the MPL-2.0 code is not
linked into anything the CLI runs. werift's own development tree reports audit
findings that no consumer installs; under the
[dependency policy](../../CONTRIBUTING.md#dependency-policy) those bear on
vendoring-and-building werift, not on depending on the published package.

Vendoring is cheaper than expected, which is what makes it a credible fallback:
a shallow clone at the pin is a 21 MB working tree, the build is plain `tsc` per
workspace package with no native toolchain or codegen, and it compiles clean in
about 2.5 seconds. The datachannel-relevant source is roughly 18,400 lines of
TypeScript. MIT throughout, so a fork is unencumbered.

What is *not* worth doing is stripping the media stack. There is no narrower
published entry point -- werift publishes only its root and a `nonstandard`
entry, and the sibling packages on npm are the protocol layers, with the peer
connection and data channel living in werift itself. The media stack is not
separable either: `webrtc/src/media` is imported by roughly ten core files
including the peer connection, the SDP machinery, and both transports, so
dropping it means maintaining edits to those across upstream's release cadence.
The entire saving is `mediabunny`'s install weight and its MPL-2.0 entry, and
capturing even that requires the fork, because `mediabunny` is a hard dependency
of two workspace packages and installs whether or not it is imported. What a
datachannel-only peer actually loads is dominated by the X.509 stack DTLS
certificate handling drags in, not by media.

## What stays open

- TURN over TCP and TLS driven against a real relay, before any deployment
  relies on relayed connectivity.
- A throughput comparison against node-datachannel, if and only if throughput is
  promoted from an accepted cost to a requirement.

## See also

- [WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md) -- the normative wire the
  transport speaks: signaling envelopes, framing, the close obligation, and the
  budgets.
- [COMMUNICATION.md](../COMMUNICATION.md#message-delivery-and-teardown) -- the
  message-delivery contract the transport must honor.
- [PROTOCOL.md](../spec/PROTOCOL.md#webrtc-rendezvous-peer-id-derivation) -- the
  normative rendezvous peer-id derivation the CLI must reproduce to meet a web
  peer.
- [CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#webrtc-data-channel-inbound-bound)
  -- the web app's inbound reassembly bound, which rests on PeerJS's BinaryPack
  chunking.
- [DEPENDENCY_PINS.md](../spec/DEPENDENCY_PINS.md#upgrading-the-peerjs-stack-peerjs--peerjs-js-binarypack)
  -- why the PeerJS stack is exact-pinned and what an upgrade must re-verify.
