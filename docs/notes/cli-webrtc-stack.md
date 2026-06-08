---
title: "CLI WebRTC Stack Selection"
---

# Choosing a Node WebRTC stack for the CLI transport: candidates, the werift leaning, and what stays open

*Status: exploratory design note - no decision has been made. This records the reasoning and options from a deferred spike (board item 196971324) so the question does not have to be reworked from scratch when the CLI WebRTC transport is picked back up. No prototype has been run; nothing here is binding. See [docs/notes/README.md](README.md).*

The web application already conducts peer-to-peer WebRTC exchanges through PeerJS. Letting the CLI take part in those exchanges needs a Node WebRTC library, and the choice of library and how it is wired turns out to be load-bearing enough that a hands-on spike was scoped to settle it. That spike was deferred before any prototype ran. This note captures where the analysis got to: the problem shape, the candidate libraries, the leaning toward werift and the caveats on it, and - in the most detail, because it is where the cost actually lives - what choosing werift implies for the PeerJS integration.

## The problem

To let the CLI take part in WebRTC exchanges (the CLI<->web case; CLI<->CLI is only an internal stepping stone, never a shipped feature with its own signaling), the CLI needs WebRTC - but Node has no built-in WebRTC, so a library has to supply it. The web stays on PeerJS for the foreseeable future; its own roadmap keeps it there (web item 196035727 still derives a *PeerJS* rendezvous id), so "CLI<->web" necessarily means the CLI speaks the PeerJS broker's signaling.

The dead-end risk is in the signaling layer, not the data channel. Every candidate library is browser-interoperable at DTLS/ICE/SCTP, so any of them can move bytes to a browser once a connection is up. What would lock the CLI out of CLI<->web is non-PeerJS signaling. The binding constraint on whatever is chosen is therefore that signaling stays PeerJS-broker-compatible, or sits behind a swappable interface a PeerJS client drops into.

Research alone could not de-risk the pick, which is why the spike existed. It produces a decision and a minimal proven connection, not shippable transport code; its acceptance criteria (a docs decision record, a Node<->Node frame, a Node<->browser interop proof, the flush-close confirmation, and the peers/peerjs#979 repro status) still stand for when the work resumes.

## Two decisions, not one

The library and the architecture are separable axes, and conflating them obscures the real tradeoff.

- **Path A - PeerJS-in-Node.** Shim the global WebSocket and RTC classes, and run the real PeerJS library in Node. This inherits PeerJS's data framing, its chunking of large messages, and the flush-on-clean-close the transport contract depends on (see [COMMUNICATION.md](../COMMUNICATION.md), "Message delivery and teardown"). The cost is the polyfill frictions: the open peers/peerjs#979 `defineProperty` crash (which hits any native lib used this way) plus whatever quirks a given library's polyfill carries.
- **Path B - drive the library directly.** Use the library's own API and hand-write the two PeerJS-shaped pieces the CLI needs: a signaling client that speaks the broker's WebSocket protocol, and a PeerJS-compatible data framing on top of the raw data channel. More code that we own, but it sidesteps every polyfill quirk and gives the clean separation of signaling from data transport that COMMUNICATION.md notes the current design lacks.

Which path is right depends on the library, because the libraries differ in how cleanly they slot under PeerJS.

## The candidates

| Library | Browser interop | TURN / relay | PeerJS-in-Node (Path A) | Install / ABI | Security surface |
|---|---|---|---|---|---|
| **@roamhq/wrtc** (Chromium libwebrtc) | Highest - it *is* Chrome's stack | Full: UDP + TCP + TLS | #979 to work around | glibc-only prebuilts; no musl, no win-arm64; source build infeasible | Smallest - the most-audited WebRTC anywhere |
| **node-datachannel** (libdatachannel) | High - mature, widely deployed | UDP only in the default prebuilt (libjuice); TCP/TLS only via a libnice source build | read-only `RTCSessionDescription` friction (bridgeable with a wrapper, not a fork) + #979 | Best: N-API (ABI-stable across Node majors) + musl prebuilts (Alpine as-is) | Moderate - C++, conventional DTLS |
| **werift** (pure TypeScript) | Good but youngest | UDP only today; TCP claimed but unverified (roadmap lists it under 2.0) | partial `RTCPeerConnection` compat - the most shimming | Most portable - zero native code | Largest - DTLS/SRTP reimplemented in JS, effectively one author |

In short: @roamhq/wrtc buys the safest interop and complete TURN at the cost of a heavy, platform-tied native dependency; node-datachannel buys the smoothest, most durable install at the cost of a UDP-only default relay and a small PeerJS shim; werift buys maximum portability at the cost of being the youngest, the most solo-maintained, and the one that reimplements the security-critical encryption layer in JavaScript.

## Packaging is not the gate

The CLI ships as a Docker image (currently `node:26-alpine`, i.e. musl, built `linux/amd64,linux/arm64`); end users run the container, including on Windows and macOS via Docker. The maintainer's standing position is that a per-client *build* accommodation - a native build for an extra architecture, a different container base - is acceptable as long as it changes only the build, not the code. So distribution facts that would otherwise rule a library in or out (for example @roamhq/wrtc's glibc-only prebuilts, with no musl and no win-arm64) are not the deciding axis. The pick is made on interop, correctness, and code-brittleness grounds; packaging adapts to the chosen library rather than constraining it.

## Current leaning: werift, with caveats

The current leaning is **werift**, on three grounds: it is claimed to have added TCP for TURN, it is under very active development, and it has the fewest platform dependencies (pure TypeScript, no native build). The first two warrant scrutiny, and examining them tempers - without overturning - the leaning.

**Velocity, examined.** werift is alive and genuinely used: on the order of 160k npm downloads per month, ~600 stars, six years old, pushed within the last few days. But the activity is essentially one person's - the lead author has roughly 2,360 commits to the next human contributor's ~90 - and it is bursty rather than sustained (a spike of ~160 commits in a single recent month, near-silent on either side of it). The recent burst is media-focused (h264/opus, mp4/webm, RTP) and largely unreleased: one npm release in the last 90 days, and the pinnable 0.23.0 predates the burst. The contribution backlog is the clearest flag - on the order of 50 open PRs with one merged in 90 days, and a quiet issue tracker. Read together, the practical implication is: do not count on upstream to fix something on our path. Plan to pin a specific version and to vendor-and-patch when needed, and weight the hand-rolled-in-JS DTLS surface accordingly - for a security tool that is the part that matters most, and it is maintained by effectively one author.

**The TCP-TURN claim needs verification.** The public roadmap still lists "TURN - TCP" as a 2.0 item, and the only recent TCP-adjacent work is an ICE-candidate test fix, so TCP TURN - if it exists - is most likely unreleased master code rather than a shipped feature in 0.23.0. Before relying on it, pin the exact version or PR where it landed, and check whether it covers TURNS over TLS (the port-443 case is the actual relay lifeline for a peer behind a firewall that blocks UDP outright, which is precisely a CLI<->web scenario).

## What werift implies for PeerJS integration

This is where werift's cost lives, and it is the main reason this note exists.

PeerJS drives the *browser* W3C WebRTC API: assignable DOM handlers (`pc.onicecandidate = fn`, `pc.ondatachannel = fn`), the `RTCSessionDescription` and `RTCIceCandidate` constructors, and a DOM `RTCDataChannel`. werift exposes its *own* Node-native API with a different, subscription-style event model; browser-`RTCPeerConnection` compatibility is on werift's 2.0 roadmap, not shipped. So unlike @roamhq/wrtc - which *is* the DOM API, making the "swap the global RTC classes" route cheap - werift cannot simply be dropped under PeerJS via global shims. The route that is cheapest for the native libraries is the expensive one for werift.

That leaves two shapes, and werift pushes toward the second:

- **(a) Adapter under PeerJS.** Wrap werift's classes to present the W3C surface so stock PeerJS runs in Node unchanged - translating handler-property assignment into werift's subscribe model, wrapping the description/candidate objects, and exposing a DOM-shaped data channel. This keeps PeerJS's framing, chunking, and flush for free, but it amounts to writing the W3C compatibility layer werift has not shipped yet, and chasing that across a fast-moving library is brittle.
- **(b) Drive werift directly.** Do not run PeerJS in Node at all. Use werift's native API and hand-write a PeerJS-broker signaling client (the broker's WebSocket protocol: OFFER / ANSWER / CANDIDATE / ID / HEARTBEAT) plus PeerJS-compatible DataConnection framing, with the browser staying on stock PeerJS. This is the recommended shape for werift.

**The load-bearing cost of (b) is matching PeerJS's wire format, not just DTLS/SCTP.** Two parts: the DataConnection negotiation envelope (the connection id, label, serialization, and reliability that PeerJS carries in its offer payload, and that the browser peer expects), and the serialization plus chunking. PeerJS's default is BinaryPack with chunking of large messages. Because we control the web app, both ends could be set to `json` or `none` to avoid reimplementing BinaryPack - but chunking cannot be skipped: PSI frames can exceed the SCTP maximum message size, and whatever the CLI sends, the browser PeerJS peer has to reassemble it, so the chunking must be PeerJS-compatible. Flush-on-close becomes ours to implement; werift's data channel exposes `bufferedAmount`, so "drain, then close" is feasible (confirm a low-watermark signal exists so it is not a busy-poll).

Two consequences are worth recording:

- The peers/peerjs#979 crash becomes moot under (b): there is no PeerJS running in Node, so the polyfill `defineProperty` problem cannot arise.
- The interop proof moves to the front. With the native-library Path A, Node<->browser interop is nearly free once PeerJS runs, because it is PeerJS on both ends. With werift via (b), the hand-written signaling and framing are the entire risk, so the first milestone when work resumes is "a stock browser PeerJS peer completes a DataConnection with werift-in-Node and exchanges a frame" - a Node<->Node test would only exercise our own code talking to itself and prove much less.

## Signaling and discovery

Independent of the library choice: the broker is reusable as-is - the vendored PeerServer already runs in Node (apps/web/src/peerServer.ts). Peer *discovery* is the moving piece the CLI must match. The web currently uses a backend rendezvous (the acceptor takes a broker-random peer id and POSTs it to an SSE rendezvous keyed by a session uuid; the inviter waits on that stream and dials it). Web item 196035727 replaces that with a token-derived id (an `HKDF(secret, role)` derivation) and drops the backend. The CLI must mirror whichever is live; the derivation is owned by that web item, and the CLI side adopts it rather than defining its own.

## What would change the pick

- A near-term deployment behind a firewall that blocks UDP makes full TURN over TCP/TLS a must-ship requirement rather than future work. That favors @roamhq/wrtc - the only candidate with complete TURN out of the box - over werift's UDP-only (or unverified-TCP) relay.
- If werift's solo-maintainer and hand-rolled-JS-DTLS risk is judged unacceptable for a security tool, node-datachannel is the middle option: an N-API-plus-musl install and libdatachannel's more conventional C++ DTLS, at the cost of its read-only `RTCSessionDescription` PeerJS friction (bridgeable with a wrapper) and a UDP-only default TURN (libjuice; TCP/TLS needs a libnice build).

## Open questions for when this resumes

- Pin werift's TURN-over-TCP status: the exact version or PR, and whether it covers TURNS over TLS on port 443.
- Decide the serialization and chunking approach against a real browser PeerJS peer (reproduce BinaryPack plus PeerJS chunking, or configure a simpler serialization and supply PeerJS-compatible chunking ourselves).
- Confirm werift's data channel exposes a `bufferedamountlow`-style signal for an efficient flushing close.
- Re-confirm the architecture choice (Path B is assumed for werift) once a prototype exists, against the spike's acceptance criteria.

## See also

- Board item 196971324 - the deferred spike this note preserves; 196962105 - the CLI WebRTC transport implementation it feeds; 196035727 - the web rendezvous-id work whose `HKDF(secret, role)` derivation the CLI must mirror.
- [COMMUNICATION.md](../COMMUNICATION.md) - channels, peer coordination, and the message-delivery and flush-close contract the transport must honor.
