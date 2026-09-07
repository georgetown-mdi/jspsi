---
title: "Retiring the WebRTC Frame-Structure Weight Model"
---

# Retiring the WebRTC frame-structure weight model: a measured envelope in place of a modelled one

_Status: decided by a 3-panelist design panel converging 3-0 on the retirement and 2-1 on keeping no count ceiling, and built. The rules that remain, the constants they use, and the measured envelope are specified in [CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#webrtc-data-channel-inbound-bound); this note records why the model was retired rather than tuned, and what the replacement does and does not bound. See [docs/notes/README.md](README.md)._

The WebRTC receive path scans an inbound BinaryPack frame before PeerJS unpacks it. The scan used to charge each declared value a modelled retained-byte weight and refuse the frame when the running sum passed a 1 GiB budget. This note records why that model is gone.

## What the model claimed, and what it did

The weights were per-kind figures -- 64 bytes for an object, 40 for an array, 8 per declared backing slot, 16 for a boxed number, `16 + 2/byte` for a string, 256 for a binary value -- summed as the scan walked the wire, and the budget was derived from the largest legitimate frame's modelled cost. Retiring the model, its budget and the two suites' cost oracles removed about 900 lines net, most of them test.

Two measurements against the real unpacker decided it.

**The model was wrong in the unsafe direction, on its own central case.** A 255.6 MiB frame of 64-byte strings is charged 580 MiB against the 1 GiB budget and admitted, while the real `unpack` retains about 6.5 GiB for it: the cons-string tree `unpack_string` builds retains 25 to 32 bytes per character at these lengths, against the 2 the string weight charged. The error is a factor of about 6.5 on the shape the budget was sized for.

**No test could see the error.** Both differential suites scored the scan's charge against the same weight table applied to the real unpacker's decoded inventory. Both sides of the comparison were the model, so a weight set below what `unpack` retains was invisible to every check -- the spec said as much, in a residual paragraph. That is the shape `CONTRIBUTING.md` rules out for a dependency's behavior: drive the real tool, or state the limit.

## Why it was retired rather than tuned

Tuning buys a smaller factor than the model is wrong by. The weight table exists to discriminate between the largest legitimate frame and the cheapest hostile one, and that discrimination is worth roughly 4x; the measured error is larger than the thing being bought. A tighter honest bound is not available at any complexity either, because amplification saturates near 32x for strings, 64x for empty maps and 208x for empty binary values -- a non-binary wire cap tight enough to hold retention under 1 GiB would refuse the legitimate payload frame.

So the walk stays and the arithmetic goes. What remains are the exact structural rules, each of which closes a shape whose retention no wire quantity bounds: the nesting-depth cap, the byte-backed-elements check, the non-string map-key refusal, and the per-string cap. Those rules carry the whole property the control ever held, in about forty lines.

## The per-string cap bounds a value, not a frame

Raising the per-string cap to the CSV intake cap (`MAX_CSV_FILE_BYTES`) closes a false refusal rather than loosening a bound. A payload cell is not length-bounded upstream -- only column names are -- so a cell from an admitted 100 MiB file could exceed the retired 1 MiB cap and be refused as hostile. And the cap never bounded a frame in the first place: string retention is about 32x the wire bytes whether the frame spends them on one long string or on four million short ones, so the frame-level figure is the same either way.

## What the replacement does not bound

The envelope the remaining rules leave is about 2,250 times the admitted wire bytes, because the depth cap permits up to 256 levels to each reserve a backing store over the same wire bytes. At the 256 MiB wire cap that is more memory than a browser tab has: a peer that spends its wire budget on a deeply nested chain of byte-backed `array32` headers ends the receiving tab or process, and no rule here refuses it. The retired budget did refuse that shape -- on a charge that was itself a model, and while admitting the string frame that retains 6.5 GiB.

This is availability defense in depth against an authenticated party under a signed legal agreement who can abort the exchange at any point, so the posture is a stated bound rather than a memory guarantee. The only lever that would change it is a cap on non-binary wire bytes below the 256 MiB the binary set frame needs. The measurement that decision would rest on is recorded in the spec: the largest legitimate non-binary frames at the single-pass ceiling are 84.0 MB, 48.0 MB and 30.0 MB of wire, retaining 2.3x, 6.0x and 1.6x respectively -- so a non-binary cap has room to sit far below the wire cap without refusing anything psilink sends.

## The check that replaces the model

One measurement test decodes each worst-measured shape through the real pinned unpacker under `--expose-gc`, drops it, collects, and asserts the retained bytes per admitted wire byte stay under a generous per-shape bound, with the measured figure in the assertion message (`packages/core/test/connection/binaryPackRetention.test.ts`). It is a drift detector on the dependency rather than a security bound: a `peerjs-js-binarypack` bump that changes how much `unpack` retains per reserved slot, per string character or per binary value reddens, instead of moving the envelope the spec states without anyone noticing.
