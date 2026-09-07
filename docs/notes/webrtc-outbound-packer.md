---
title: "Encoding outbound WebRTC frames without recursion"
---

# Encoding outbound WebRTC frames without recursion

_Status: decided and built, by a 3-panelist design panel deciding 2-1. The
ceiling was measured, the serializer replaced, and the wire left unchanged. See
[docs/notes/README.md](README.md)._

This is design rationale. Nothing here binds an implementation; the normative
rows -- the marker choices, the refusal, the internals the browser install
assumes -- are in
[WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#outbound-encoding) and
[DEPENDENCY_PINS.md](../spec/DEPENDENCY_PINS.md#upgrading-the-peerjs-stack-peerjs--peerjs-js-binarypack),
and this note does not restate them.

## The ceiling

`peerjs-js-binarypack`'s `pack` descends one call frame per element: an array of
`n` values costs `n` nested calls, and an object of `n` keys costs `2n`. Under
Node 26 in the development container, the largest iteration map -- the frame the
PSI round sends, one `{theirIndex, iteration}` entry per matched record -- it
could encode was about 8,000 records, and the boundary moves with the stack
already in use when the frame is packed, so it is not a number an operator can
be told.

Past it, the exchange died on the sender with `Maximum call stack size
exceeded`, after both parties had run the PSI compute. Nothing on the receiving
side was near its own limits: the inbound bounds admit a frame of millions of
elements under the cumulative declared-count rule in
`packages/core/src/connection/binaryPackBounds.ts`, which bounds declared
elements across the frame at one per wire byte under the 256 MiB wire cap --
measured on this build at about 28 bytes per record for the mapped-element
frame (84 MB for 3,000,000 records), which puts the headroom at the wire cap
divided by that figure, on the order of 9 million records -- and both
transports' reassembly and unpack are iterative. The ceiling belonged to one
function on one side of the wire.

## What was decided

Replace the serializer, not the protocol. `packages/core` gains an
explicit-stack BinaryPack encoder that emits the pinned packer's bytes marker
for marker; the CLI's wire module calls it, and the browser installs it over the
PeerJS data connection's own encode step, leaving PeerJS's chunking, buffering
and backpressure alone. The four record-scaling frames keep their shapes, their
validators and their bytes. Nothing in the PSI protocol changes.

Compatibility falls out of that: below the old ceiling the bytes are identical,
and above it only the wider `array32` and `map32` container headers appear,
which the inbound structural scan and `unpack` already read. No negotiation, no
version gate, no spec change to the wire. A partner on a previous release still
fails on its own large outbound frames, so an exchange above the ceiling
completes once both parties have upgraded -- the same condition as before, with
no new failure mode.

The dissent argued instead for pre-encoding the four frames to byte arrays in
core, with a purpose-built codec each. It was set aside on scope: the reshape
reaches three protocol files and their validators, blinds the inbound structural
scan to the frames' structure, and reaches an older partner as a mid-exchange
parse failure rather than a diagnosable version mismatch.

## Which encoder shape

Both majority panelists agreed on the explicit stack and split on how much of
the format to own. One would own the six container headers and delegate every
leaf to the library's `pack`; the other would write the whole encoder.

The whole encoder was built, for two reasons the panel did not weigh.

- Delegating leaves means importing the library at run time from
  `packages/core`, where it is a devDependency today. Core's inbound structural
  scan reads the same wire format with no runtime dependency on the package, by
  decision, so that the guard holds whether or not an app keeps it; the two
  halves of one format should not rest on different assumptions.
- Delegation costs a `Packer` per leaf and an extra copy of every byte-array
  leaf. Measured on the 200,000-record iteration map, the delegating shape took
  about 1.2 s against 0.25 s for the whole encoder, which is also roughly what
  the library itself costs per element at sizes it survives.

What the delegating shape would have bought -- leaf encodings that cannot
diverge from the library's -- is bought instead by requiring byte equality
against the real packer for every frame shape and every marker at its
boundaries, which is the same arrangement the inbound scan already stands on.

## The risk both majority panelists named

A byte-fidelity divergence between psilink's encoder and the library corrupts
frames silently, which is worse than the loud failure it replaces. Three things
hold it.

- Whole-frame byte equality against the real `pack`, over the four record-scaling
  frames at every size the library survives and over the shared frame-fixture
  corpus both transports are driven through. Above the library's ceiling, where
  no oracle exists, a round trip through the real `unpack` and admission by the
  inbound structural scan stand in.
- A loud existence check on every PeerJS send internal the browser install
  touches, run on every connection, so a `peerjs` bump that renames one fails at
  install rather than on the first exchange large enough to reach it.
- A refusal, rather than a guess, for any value kind outside what the wire
  carries.

## The ceiling this does not remove

The CLI's send path pushes a frame's datagrams into the data channel in one
uninterrupted loop, with no backpressure of its own. At 200,000 records that is
336 datagrams of a 5.47 MB frame; driven over a real werift pair through the
repository's own broker, the frame arrives whole. That measurement is the reason
the loop was left alone, not evidence that it has no limit of its own.

Three limits of the encoder's parity with the pinned packer are measured facts,
not properties either implementation states. An object whose prototype, not its
own keys, answers `hasOwnProperty` falsely makes the pinned packer write a map
header it then fills with nothing, while this encoder writes the whole map; the
two diverge only where the packer's own output is itself unreadable past that
header. That packer-survives shape -- an own `hasOwnProperty` answering false
for every key -- is stated in the spec from a measurement, not backed by a
check. And a plain object carrying a `BYTES_PER_ELEMENT` key encodes as an
empty byte string on both sides, mirroring the packer's own dispatch rather
than diverging from it.
