// The transport-agnostic half of the WebRTC data-channel inbound bound
// (docs/spec/CHANNEL_SECURITY.md): the fixed bound constants and the BinaryPack
// structural pre-scan that rejects a frame before it is unpacked. It lives here,
// not beside a transport, because every WebRTC transport speaks the same PeerJS
// BinaryPack wire and must enforce one implementation of these bounds rather
// than a per-transport re-derivation of them.
//
// The half that is NOT here is the part bound to a specific reassembler: the web
// app wraps PeerJS's `_handleChunk`/`_handleDataMessage` internals to apply these
// constants and run this scan at its unpack chokepoint
// (apps/web/src/psi/boundedReassembly.ts).
//
// The scan reads only the BinaryPack wire format -- the marker dispatch in
// `peerjs-js-binarypack`'s `Unpacker.unpack`: fixint/fixraw/fixstr/fixarray/fixmap
// and the 0xc0-0xdf markers, with maps declaring two child values per pair -- never
// the library's API, so it carries a dependency premise on that marker table and one
// more on how `unpack` allocates: a container's store sized from its declared count,
// and a `bin`/`raw` value decoded into a retained per-value copy of its own
// (docs/spec/DEPENDENCY_PINS.md). A misparse cannot silently disable the bound: it
// either over-charges (rejecting early, fail-closed) or runs the cursor off the end,
// which is treated as a malformed frame and delegated to the real unpacker.
//
// This is the BinaryPack analogue of the raw-protobuf element-count scan in
// connection/psiElementScan.ts.

/**
 * Maximum size, in bytes, of a single inbound frame the web WebRTC data-channel
 * receive path will reassemble into memory. The web peer-to-peer transport runs
 * the PeerJS data channel directly: it discards the rotated key and declines the
 * application-layer AEAD wrap under DTLS (see
 * `apps/web/src/psi/authenticateExchange.ts`), so core's
 * `EncryptedMessageConnection` and its ~512 MiB `MAX_FRAME_SIZE_BYTES`
 * envelope -- a file-sync transport control -- never bind here. This is the
 * WebRTC transport's own inbound byte bound, the analogue of the file-sync
 * frame-size cap (docs/spec/CHANNEL_SECURITY.md) for the one transport that cap
 * does not reach. Without it a hostile or buggy peer can stream an oversized PSI
 * set frame (or a flood of never-completed chunk reassemblies) and drive the
 * receiving tab toward memory exhaustion, allocating proportional to what the
 * peer chooses to send.
 *
 * Value: 268,435,456 bytes (256 MiB). Like the file-sync frame-size cap it is a
 * chosen memory bound rather than a derived platform ceiling, but sized against a
 * different envelope: a browser-tab *memory envelope*, in the spirit of the
 * directory-listing cap -- above the realistic largest legitimate PSI set frame
 * (one party's set as raw EC points, 35 bytes/element binary, so a
 * few-million-element set is tens to low-hundreds of MiB; the 100 MiB CSV upload
 * cap, `MAX_CSV_FILE_BYTES`, bounds it), below an allocation that would crash
 * the tab. This counts the *wire* (reassembled) bytes; the deserialized
 * structure those bytes unpack to is bounded separately by
 * {@link MAX_WEBRTC_FRAME_STRUCTURE_BYTES} -- an independent bound this cap does
 * not imply -- because BinaryPack `unpack` can allocate far more than the wire
 * size. Fixed, not operator-configurable: a configurable cap risks being raised
 * to reintroduce the denial of service.
 *
 * This is also the WebRTC half of the single-pass frame cap's per-transport
 * clamp. Single-pass derives a per-exchange reply cap from the exchanged record
 * counts (`singlePassReplyByteCap`) and aborts an exchange
 * whose `keyCount * rows` exceeds `MAX_SINGLE_PASS_CELLS` -- a shared,
 * transport-agnostic check both parties run from authenticated counts, so it
 * binds on the WebRTC path too (in `linkViaSinglePassPSI`). Per the
 * per-transport clamp, WebRTC keeps THIS fixed browser-tab-safe envelope at the
 * reassembly read gate rather than threading the per-exchange cap into it (the
 * file-sync transport, with no such envelope, threads the derived cap into its
 * `get()` read gate instead). At the single-pass ceiling the derived reply cap is
 * ~240 MiB -- below this 256 MiB envelope (now the nearer of the two transport
 * envelopes), so it never rejects a legitimate single-pass reply the count check
 * already admitted; an over-ceiling single-pass exchange fails closed with the same
 * actionable guidance on both transports, before any reply is read.
 * `MAX_SINGLE_PASS_CELLS` is deliberately held below the point where that derived
 * cap would reach this envelope; raising it past that point would require this path
 * to gate on a per-exchange cell budget so a browser fails closed rather than
 * mid-frame. See docs/spec/CHANNEL_SECURITY.md and docs/spec/PROTOCOL.md (the
 * single-pass dataset ceiling).
 */
export const MAX_WEBRTC_FRAME_BYTES = 256 * 1024 * 1024;

/**
 * Maximum number of concurrently-incomplete PeerJS chunk reassemblies retained
 * at once. The PSI protocol is strictly lockstep (see docs/spec/PROTOCOL.md):
 * each party sends one frame and waits for the reply, and the reliable, ordered
 * data channel delivers a frame's chunks contiguously, so at most ONE frame is
 * ever mid-reassembly on an honest exchange. This cap is generous headroom above
 * that maximum of one; beyond it the oldest incomplete partial is evicted (by the
 * reassembly wrapper, `boundChunkReassembly` in
 * apps/web/src/psi/boundedReassembly.ts), which bounds a flood of never-completed
 * partials from distinct message ids -- the case PeerJS leaves unbounded, since it
 * retains a partial keyed by message id indefinitely and never evicts one. Fixed,
 * not configurable, for the same reason as the byte bound.
 */
export const MAX_CONCURRENT_REASSEMBLIES = 8;

/**
 * Approximate per-value retained-byte weights the structural pre-scan charges, so
 * the per-frame budget {@link MAX_WEBRTC_FRAME_STRUCTURE_BYTES} is a memory
 * envelope rather than a flat value count. BinaryPack `unpack` allocates a real JS
 * value per declared element, but the retained cost of that value varies by kind,
 * so charging every value `+1` (the prior value-count budget) let a frame of the
 * *heaviest* kind retain far more than a frame of the same value count in the
 * *lightest* kind. Each weight is the measured/approximate V8 resident size of one
 * value of that kind, charged once as the scan reads that value's header:
 *
 * - `object` (64): an empty JS object from a BinaryPack map -- `unpack` does
 *   `new Object()` then assigns each key -- measured ~64 bytes resident (the
 *   JSObject plus its property/elements backing and hidden-class delta). This is
 *   the dominant amplifier the byte budget exists to charge honestly: one wire
 *   byte (a `fixmap` of zero pairs) unpacks to ~64 bytes.
 * - `array` (40): an empty JS array (`new Array(0)`), measured ~40 bytes (the
 *   JSArray plus an empty backing store). A non-empty container's backing slots
 *   are charged on top of this base, `scalar` per declared child.
 * - `scalar` (8): one machine word of a container's backing store, the slot every
 *   declared child occupies whether or not the wire carries that child's bytes.
 *   `unpack_array` reserves the whole backing store from the container's declared
 *   count (`new Array(N)`) before reading any element, so the scan likewise charges
 *   a container's slots at its header rather than as each child is read. A value
 *   that allocates nothing beyond that slot -- an integer, boolean, null, or
 *   undefined -- therefore adds nothing of its own.
 * - `boxedNumber` (16): the heap number a wide number marker's value is held in
 *   when the slot cannot hold it, charged on top of that slot. A fractional value,
 *   or an integer past the engine's small-integer range, is boxed at a measured 24
 *   bytes with its slot; an otherwise unboxed numeric array is forced to
 *   per-element boxing by one non-number mixed in, which makes it general-elements
 *   kind. The charge is decided by the MARKER, not the decoded value: `float`,
 *   `double`, `uint32`, `int32`, `uint64` and `int64` are charged it whatever they
 *   carry, so the model reads the wire alone rather than resting on where a
 *   particular engine draws its small-integer range (the narrower number markers --
 *   `uint8`, `uint16`, `int8`, `int16` and the fixints -- are inside it on any
 *   engine). It over-charges by this weight for a wide marker whose value the slot
 *   would have held, the conservative direction.
 * - `string` (`stringBase` 16 + `stringPerByte` 2 per declared wire byte): a
 *   SeqString header (~16 bytes) plus its characters. `unpack_string` decodes the
 *   declared UTF-8 wire length into a JS string of at most that many UTF-16 code
 *   units (~2 bytes each), so `stringBase + 2 * declaredWireBytes` upper-bounds its
 *   resident size. (A string's *build* transient -- a per-code-point cons-string
 *   tree -- is bounded separately by {@link MAX_WEBRTC_STRING_BYTES}, not here.)
 * - `binary` (256): the per-value overhead a decoded `bin`/`raw` value retains
 *   beyond its container's slot, charged on top of that slot. `unpack_raw` returns
 *   a per-value copy sliced from its input -- a `Uint8Array` over a buffer of its
 *   own when the frame arrives as one (the chunked-completion path and the CLI),
 *   a bare `ArrayBuffer` on the browser's unchunked path -- whose fixed cost
 *   measures ~232 bytes resident at its view-shape worst (~104 as a bare buffer)
 *   even for a one-byte payload, the view shape sharing its floor with the
 *   retained chunk {@link MIN_CHUNK_RESIDENT_BYTES} charges. The payload itself is
 *   charged nothing here: it is ~1x the value's wire bytes and so bounded by
 *   {@link MAX_WEBRTC_FRAME_BYTES} rather than by this structural budget.
 *
 * A map key needs no weight of its own: the scan refuses any frame whose map key
 * is not a string on the wire (see {@link scanFrameStructure}), and a string key
 * IS the property name, already charged in full by the `string` weight.
 *
 * The model is deliberately a *conservative* upper bound for every kind it charges:
 * it charges each object key string in full, though V8 internalizes repeated
 * property keys to one shared string, and each wide number marker its boxed cost,
 * though a small integer written in one is held in the slot -- so the real retained
 * peak of a key-heavy or index-heavy frame is lower. A true memory envelope is
 * simpler for a security reviewer to audit than one resting on V8
 * interning/representation choices an engine update could change; the cost of
 * conservatism is a budget sized above the realistic legitimate frame rather than
 * hugging it (see
 * {@link MAX_WEBRTC_FRAME_STRUCTURE_BYTES}). Fixed, not configurable, for the same
 * reason as the budget itself.
 */
export const WEBRTC_VALUE_WEIGHTS = {
  object: 64,
  array: 40,
  scalar: 8,
  boxedNumber: 16,
  stringBase: 16,
  stringPerByte: 2,
  binary: 256,
} as const;

/**
 * Maximum approximate *retained-byte* cost a single inbound frame's deserialized
 * structure may reach -- the byte-aware successor to the former value-count
 * budget. {@link MAX_WEBRTC_FRAME_BYTES} bounds the *wire* bytes, but PeerJS
 * (BinaryPack) `unpack`s a frame into a JS structure *synchronously, before
 * delivery and before any schema validation*, and that structure can be far
 * larger than the wire: BinaryPack encodes an empty object or array in one byte
 * but `unpack` allocates a real JS value per element (see
 * {@link WEBRTC_VALUE_WEIGHTS}), and -- worse -- a `new Array(N)` from an
 * `array32` header eagerly allocates N slots even when the elements are absent,
 * since `unpack` reads past the end of the buffer as zero rather than throwing. So
 * a tiny wire frame of array/object headers -- an in-protocol shape, since the
 * association-table and mapped-element frames are arrays of numbers/objects --
 * could deserialize to many GiB. A structural pre-scan (see
 * {@link scanFrameStructure}, run at the unpack chokepoint) sums each declared
 * value's per-kind weight -- a container's backing slots at its own header, so an
 * ancestor's reserved store is charged whether or not its children are on the wire
 * -- and rejects the frame *before* `unpack` allocates if the running cost would
 * exceed this budget, fail-closed. The scan also bounds each declared container by
 * the bytes that follow it (each element needs at least one byte to encode), which
 * ties the value count to the wire size.
 *
 * Value: 1,073,741,824 (2^30, 1 GiB), derived from the largest legitimate frame's
 * *retained* cost. That is the mapped-element frame -- `Array<{theirIndex,
 * iteration}>`, one entry per matched record -- which `unpack`s, per record, to
 * one object (64) + its slot in the root array (8) + the object's four declared
 * slots (8 each) + two key strings ("theirIndex" 16+20, "iteration" 16+18) ~= 174
 * bytes under the weights above, plus the boxed-number weight (16) once the index
 * passes 65,535 and takes a `uint32` marker: a per-record cost the unit tests pin
 * against the real frame shape. 2^30 therefore admits a mapped-element frame of
 * about 5.65 million matched records at that 190-byte cost, and more of the
 * narrower-indexed records below it. This path enforces that budget and
 * {@link MAX_WEBRTC_FRAME_BYTES}, and no element-count ceiling: the two are
 * independent bounds, with no headroom relation between them at the 35 bytes an
 * encrypted element occupies on the wire (see docs/spec/PROTOCOL.md). A set frame
 * filling the 256 MiB wire cap carries about 7.67 million elements, whose
 * mapped-element frame would reach about 1.36 GiB and be rejected here.
 * Residual: every kind is charged at least what `unpack` retains for it, so the
 * per-frame worst case for the deserialized structure is this budget itself. A
 * frame of the heaviest kind (~4.07M declared empty-payload `bin` views at 264
 * charged bytes each with their array slot) meets the refusal at ~4 MB of
 * proportional wire while retaining ~0.79x the budget; the same count with
 * 60-63-byte payloads is equally admitted and retains ~1.09x, its payload bytes
 * the ~1x-wire addition the spec residual states
 * (docs/spec/CHANNEL_SECURITY.md), held by the wire cap rather than here -- the
 * one retention this budget does not itself bound. An all-empty-object frame
 * needs ~16.7M elements and ~16 MiB of wire to meet the same refusal (the
 * per-container byte check ties cost to wire), and a frame of the cheapest boxed
 * numbers needs ~213 MiB of wire -- inside the wire cap, so this budget is what
 * refuses it. Any of them is freed once the schema layer rejects the frame. A
 * tighter budget is available only by making the weights less conservative (e.g.
 * crediting key-string internalization); that aggressiveness is a security-review
 * judgment (see docs/spec/CHANNEL_SECURITY.md). Fixed, not configurable: a
 * configurable bound risks being raised to reintroduce the denial of service.
 */
export const MAX_WEBRTC_FRAME_STRUCTURE_BYTES = 1_073_741_824;

/**
 * Maximum nesting depth the structural pre-scan walks before rejecting. Legitimate
 * frames are shallow (an array of two-key objects is depth three); this bounds the
 * scan's own working stack against a pathologically nested frame and matches
 * `MAX_NESTING_DEPTH` (utils/camelizeKeys.ts). Fixed, not configurable.
 */
export const MAX_WEBRTC_REASSEMBLY_DEPTH = 256;

/**
 * Maximum number of chunks a single reassembly may accumulate. PeerJS retains
 * each chunk as its own `Uint8Array` (measured ~232 bytes resident even for a
 * one-byte slice), an overhead the byte cap -- which counts only payload bytes --
 * undercounts, so a flood of tiny chunks could exhaust memory while staying far
 * under {@link MAX_WEBRTC_FRAME_BYTES}. This caps the count so that overhead is
 * bounded: with {@link MAX_CONCURRENT_REASSEMBLIES} reassemblies at most this many
 * chunks each, retained chunk overhead stays on the order of the byte cap.
 *
 * Value: 131,072 (2^17), ~8x the ~16,500 chunks a 256 MiB frame produces at
 * PeerJS's ~16 KiB (16,300-byte) chunk MTU, so it never rejects a legitimate
 * frame while bounding a tiny-chunk flood. Fixed, not configurable.
 */
export const MAX_CHUNKS_PER_REASSEMBLY = 131_072;

/** Per-chunk retained overhead (a `Uint8Array` plus its slot, measured ~232
 * bytes even for a one-byte slice), the floor each chunk is charged against the
 * byte cap so a tiny-chunk flood is bounded by true memory; see
 * {@link MAX_CHUNKS_PER_REASSEMBLY}. */
export const MIN_CHUNK_RESIDENT_BYTES = 256;

/**
 * Maximum byte length of a single BinaryPack string a frame may contain. The
 * structural budget charges a string its *resident* size (see
 * {@link WEBRTC_VALUE_WEIGHTS}), but `unpack_string` builds that string via a
 * per-code-point concatenation whose transient cons-string tree is many times
 * larger again, so a single ~256 MiB-wire `str32` -- whose resident weight stays
 * within the structure budget -- would spike to multiple GiB *during the build*.
 * This caps each string's declared length so that transient is bounded; binary set
 * frames are `bin` (not strings) and every legitimate string a PSI frame carries
 * (the `{theirIndex, iteration}` keys, a `status` value, a payload cell) is far
 * shorter, so the cap never rejects one.
 *
 * Value: 1,048,576 (1 MiB), orders of magnitude above any legitimate string yet
 * small enough that the worst-case build transient stays in the tens of MiB.
 * Fixed, not configurable.
 */
export const MAX_WEBRTC_STRING_BYTES = 1024 * 1024;

/**
 * Which pre-scan rule refused a frame, with the fixed limit that rule enforces
 * where it has one. {@link scanFrameStructure} returns one of these instead of a
 * bare verdict so the failure an operator (or a support thread) reads names the
 * control that fired rather than one standing in for the rest, and so a caller
 * cannot pair a refusal with the wrong limit.
 *
 * A refusal carries the LIMIT and never the measurement that met it: every field
 * here is a value the receiving side fixed, so nothing the peer chose reaches the
 * rendered message (see {@link describeFrameStructureRefusal}).
 *
 * - `structure-bytes`: the running retained-byte cost passed
 *   `maxStructureBytes` (the budget every per-kind weight is charged against, so
 *   a frame of any one kind -- objects, arrays, strings, `bin`/`raw` views, wide
 *   number markers -- meets it here).
 * - `nesting-depth`: the structure nests deeper than `maxDepth`.
 * - `string-bytes`: a string declares more wire bytes than `maxStringBytes`.
 * - `unbacked-elements`: a container declares more elements than the bytes that
 *   follow it can encode (each element needs at least one byte), so its declared
 *   count is one `unpack` would zero-fill rather than read.
 * - `map-key`: a map key that is not a string on the wire, refused rather than
 *   costed (see {@link scanFrameStructure}).
 */
export type FrameStructureRefusal =
  | { readonly rule: "structure-bytes"; readonly limit: number }
  | { readonly rule: "nesting-depth"; readonly limit: number }
  | { readonly rule: "string-bytes"; readonly limit: number }
  | { readonly rule: "unbacked-elements" }
  | { readonly rule: "map-key" };

/**
 * The predicate a transport puts after "inbound WebRTC frame" to say why the scan
 * refused it -- one wording for every transport, so an operator reading either
 * half of the control sees one message for one rule.
 *
 * Composed from the refusal's fixed limit alone: no length, count, depth, or byte
 * the peer chose is interpolated, so the rendered text is one of a fixed set of
 * strings whatever the frame carried (a unit test holds that by rendering
 * wildly different frames per rule and requiring identical text).
 */
export function describeFrameStructureRefusal(
  refusal: FrameStructureRefusal,
): string {
  switch (refusal.rule) {
    case "structure-bytes":
      return `exceeds its ${refusal.limit}-byte structure limit`;
    case "nesting-depth":
      return `exceeds its ${refusal.limit}-level nesting limit`;
    case "string-bytes":
      return `exceeds its ${refusal.limit}-byte string limit`;
    case "unbacked-elements":
      return "declares a container with more elements than the bytes behind it can encode";
    case "map-key":
      return "keys a map with a value that is not a string";
  }
}

/** A forward-only cursor over one BinaryPack buffer; every read throws
 * `RangeError` past the end, which the scan treats as a malformed/truncated
 * frame. */
class ByteCursor {
  private i = 0;

  constructor(private readonly b: Uint8Array) {}

  remaining(): number {
    return this.b.length - this.i;
  }

  u8(): number {
    if (this.i >= this.b.length) throw new RangeError("underrun");
    return this.b[this.i++];
  }

  u16(): number {
    return this.u8() * 0x100 + this.u8();
  }

  u32(): number {
    return (
      this.u8() * 0x1000000 +
      this.u8() * 0x10000 +
      this.u8() * 0x100 +
      this.u8()
    );
  }

  skip(n: number): void {
    if (n > this.remaining()) throw new RangeError("underrun");
    this.i += n;
  }
}

/** What the scan needs to know about one BinaryPack value, beyond its cost: a
 * `map` alternates key and value children, so the scan must test what kind sits at
 * each key position, and `string` is the only kind a map key may be (see
 * {@link scanFrameStructure}). */
type ValueKind = "map" | "string" | "plain";

/** One BinaryPack value's contribution to the structural scan: `children` is the
 * number of child values a container declares (0 for a scalar or string), and
 * `weight` is the approximate retained bytes this value allocates, a container's
 * declared backing slots included (see {@link WEBRTC_VALUE_WEIGHTS}). A string over
 * the per-string byte cap signals `weight = -1`, the reject sentinel. */
interface ValueHeader {
  children: number;
  weight: number;
  kind: ValueKind;
}

/** Resident-byte weight of a string of `declaredBytes` wire bytes: a SeqString
 * header plus its UTF-16 characters (see {@link WEBRTC_VALUE_WEIGHTS}). */
function stringWeight(declaredBytes: number): number {
  return (
    WEBRTC_VALUE_WEIGHTS.stringBase +
    WEBRTC_VALUE_WEIGHTS.stringPerByte * declaredBytes
  );
}

/** A string value of `declaredBytes` wire bytes: refused (`weight = -1`) if it
 * exceeds `maxStringBytes`, else its payload skipped and its resident weight
 * charged. Shared by every string marker (`fixstr`/`str16`/`str32`) so the
 * per-string cap is enforced uniformly rather than only on the wide markers --
 * a `fixstr` is at most 15 bytes so the cap cannot fire for it in production, but
 * routing it through here keeps the marker dispatch a single rule instead of one
 * that rests on a "fixstr is always small" assumption. */
function stringValue(
  cursor: ByteCursor,
  declaredBytes: number,
  maxStringBytes: number,
): ValueHeader {
  if (declaredBytes > maxStringBytes)
    return { children: 0, weight: -1, kind: "string" };
  cursor.skip(declaredBytes);
  return {
    children: 0,
    weight: stringWeight(declaredBytes),
    kind: "string",
  };
}

/** A container of `children` declared child values: its own base weight plus the
 * backing slot each of those children occupies, charged here at the header.
 * `unpack_array` sizes its store from the declared count (`new Array(size)`)
 * before reading a single element; `unpack_map` grows a plain object by
 * per-entry assignment, so for it the header-time charge is a conservative
 * bound on the store, not the reservation itself
 * (see {@link WEBRTC_VALUE_WEIGHTS}). */
function containerValue(
  children: number,
  base: number,
  kind: ValueKind,
): ValueHeader {
  return {
    children,
    weight: base + children * WEBRTC_VALUE_WEIGHTS.scalar,
    kind,
  };
}

/** A value charged nothing beyond the backing slot its container already charged:
 * an integer, boolean, null, or undefined, which allocate nothing of their own
 * (see {@link WEBRTC_VALUE_WEIGHTS}). */
const SCALAR: ValueHeader = {
  children: 0,
  weight: 0,
  kind: "plain",
};

/** A `bin`/`raw` value: the fixed per-value overhead the `Uint8Array` `unpack_raw`
 * returns retains beyond its container's slot. Its payload is charged nothing, being
 * ~1x its wire bytes and so bounded by {@link MAX_WEBRTC_FRAME_BYTES}
 * (see {@link WEBRTC_VALUE_WEIGHTS}). */
const BINARY: ValueHeader = {
  children: 0,
  weight: WEBRTC_VALUE_WEIGHTS.binary,
  kind: "plain",
};

/** A number marker wider than 16 bits: the heap number its value is held in when
 * the container's slot cannot hold it, charged on top of that slot whatever the
 * marker carries (see {@link WEBRTC_VALUE_WEIGHTS}). */
const BOXED_NUMBER: ValueHeader = {
  children: 0,
  weight: WEBRTC_VALUE_WEIGHTS.boxedNumber,
  kind: "plain",
};

/** Reads one BinaryPack value's header at the cursor, skipping a scalar's
 * payload, and returns the value's {@link ValueHeader} (its declared child count,
 * its retained-byte weight including a container's declared backing slots, and the
 * kind the map-key rule dispatches on; `weight = -1` for a string whose declared
 * length exceeds `maxStringBytes`). Mirrors `peerjs-js-binarypack`'s
 * `Unpacker.unpack` marker dispatch: a map of K pairs declares 2K children (K keys
 * + K values). A `bin`/`raw` value is charged the decoded view's fixed overhead on
 * top of its parent's slot, its payload alone being ~1x wire and so bounded by the
 * wire-byte cap (see {@link BINARY}); a number marker wider than 16 bits is charged
 * the heap number its value may be boxed in, likewise on top of that slot (see
 * {@link BOXED_NUMBER}). An unknown marker is charged nothing of its own and
 * declares 0 children (BinaryPack returns `undefined` for it without consuming a
 * payload). */
function readValueHeader(
  cursor: ByteCursor,
  maxStringBytes: number,
): ValueHeader {
  const type = cursor.u8();
  if (type < 0x80) return SCALAR; // positive fixint
  if ((type ^ 0xe0) < 0x20) return SCALAR; // negative fixint
  if ((type ^ 0xa0) <= 0x0f) {
    cursor.skip(type ^ 0xa0); // fixraw (binary), payload bounded by the wire cap
    return BINARY;
  }
  if ((type ^ 0xb0) <= 0x0f)
    return stringValue(cursor, type ^ 0xb0, maxStringBytes); // fixstr (<= 15 bytes)
  if ((type ^ 0x90) <= 0x0f)
    return containerValue(type ^ 0x90, WEBRTC_VALUE_WEIGHTS.array, "plain"); // fixarray
  if ((type ^ 0x80) <= 0x0f)
    return containerValue(
      (type ^ 0x80) * 2,
      WEBRTC_VALUE_WEIGHTS.object,
      "map",
    ); // fixmap
  switch (type) {
    case 0xc0: // null
    case 0xc1: // undefined
    case 0xc2: // false
    case 0xc3: // true
    case 0xd4: // unused
    case 0xd5:
    case 0xd6:
    case 0xd7:
      return SCALAR;
    case 0xcc: // uint8
    case 0xd0: // int8
      cursor.skip(1);
      return SCALAR;
    case 0xcd: // uint16
    case 0xd1: // int16
      cursor.skip(2);
      return SCALAR;
    case 0xca: // float
    case 0xce: // uint32
    case 0xd2: // int32
      cursor.skip(4);
      return BOXED_NUMBER;
    case 0xcb: // double
    case 0xcf: // uint64
    case 0xd3: // int64
      cursor.skip(8);
      return BOXED_NUMBER;
    case 0xda: // raw16
      cursor.skip(cursor.u16()); // unpack_raw copies `size` bytes (~1x wire),
      return BINARY; // bounded by the wire-byte cap; the view itself charged here
    case 0xdb: // raw32
      cursor.skip(cursor.u32());
      return BINARY;
    case 0xd8:
      // str16: unpack_string builds a JS string of the declared length, ~2x its
      // wire size and with a large transient cons-string tree, so the per-string
      // byte cap bounds the build (legitimate PSI frames carry only short
      // strings) while the weight bounds its resident size.
      return stringValue(cursor, cursor.u16(), maxStringBytes);
    case 0xd9: // str32
      return stringValue(cursor, cursor.u32(), maxStringBytes);
    case 0xdc: // array16
      return containerValue(cursor.u16(), WEBRTC_VALUE_WEIGHTS.array, "plain");
    case 0xdd: // array32
      return containerValue(cursor.u32(), WEBRTC_VALUE_WEIGHTS.array, "plain");
    case 0xde: // map16
      return containerValue(
        cursor.u16() * 2,
        WEBRTC_VALUE_WEIGHTS.object,
        "map",
      );
    case 0xdf: // map32
      return containerValue(
        cursor.u32() * 2,
        WEBRTC_VALUE_WEIGHTS.object,
        "map",
      );
    default:
      return SCALAR;
  }
}

/**
 * Scans the BinaryPack value in `buf`, returning the {@link FrameStructureRefusal}
 * of the first rule that fires -- or `undefined` if the frame is admitted. A frame
 * is refused when it would deserialize to a structure whose approximate
 * retained-byte cost exceeds `maxStructureBytes`, nest deeper than `maxDepth`,
 * contain a string longer than `maxStringBytes`, declare any container with more
 * elements than the bytes that follow it can encode, or key a map with anything but
 * a string. Walks the structure reading only container headers and
 * scalar lengths -- never materializing the payload -- and charges each declared
 * value its per-kind weight
 * (see {@link WEBRTC_VALUE_WEIGHTS}), rejecting as soon as the running cost
 * breaches the budget, a container over-declares, or a string over-declares, so an
 * over-budget frame is caught before `unpack` allocates (the empty-object/array
 * amplification, the `new Array(N)`-from-a-tiny-header case, and the giant-string
 * case where `unpack_string` builds a JS string far larger than its slot).
 *
 * A container's backing slots are charged at the container's own header, from its
 * declared count, rather than where the wire spends bytes: `unpack_array` reserves
 * its whole store up front (`new Array(size)`) and reads past the end of the
 * buffer as zero rather than throwing, so a declared child that no wire byte
 * backs still costs its slot; `unpack_map` grows a plain object by per-entry
 * assignment, so its header-time charge is a conservative bound on the store
 * rather than a mirror of the allocation.
 *
 * A map key that is not a string on the wire is REFUSED rather than costed. The
 * `pack` side of this dependency emits a map only for a plain JS object, whose own
 * keys are strings by construction (and refuses a `Map` or `Set` outright), so no
 * legitimate frame carries one -- a premise the differential suite holds the real
 * packer to. Refusing is what makes the cost model total: `unpack_map`
 * assigns `map[key] = value`, retaining the key's *coerced* string form as the
 * property name, and a container key coerces to the joined forms of everything
 * beneath it -- a cost that grows with the declared descendants `unpack` zero-fills
 * past the end of the buffer, not with the bytes the wire actually spends, so no
 * charge taken as the scan walks can bound it.
 *
 * A read past the end (a malformed/truncated frame) is admitted: every value it
 * passed was within the byte budget, the bytes past the end unpack as zero-valued
 * integers into slots this scan has already charged, so the structure it commits
 * `unpack` to is already bounded, and PeerJS's own unpack handles the malformation
 * downstream. The key rule is decided on the key's own marker byte, before the scan
 * descends into it, so an underrun deeper in the frame cannot carry a non-string key
 * past this point.
 */
export function scanFrameStructure(
  buf: Uint8Array,
  maxStructureBytes: number,
  maxDepth: number,
  maxStringBytes: number = MAX_WEBRTC_STRING_BYTES,
): FrameStructureRefusal | undefined {
  const cursor = new ByteCursor(buf);
  // remaining[d] = child values still to read at nesting level d; one root value.
  const remaining: Array<number> = [1];
  // mapLevel[d] = whether level d is a map's children, which alternate key, value,
  // key, ... so an even count still to read is a key position.
  const mapLevel: Array<boolean> = [false];
  // Running sum of the approximate retained bytes the structure has committed
  // `unpack` to allocate: every value's per-kind weight, a container's declared
  // backing slots included.
  let cost = 0;
  try {
    while (remaining.length > 0) {
      const top = remaining.length - 1;
      if (remaining[top] === 0) {
        remaining.pop();
        mapLevel.pop();
        continue;
      }
      // A map's children alternate key, value, key, ...; the keys are the ones
      // read at an even count still to read.
      const atKeyPosition = mapLevel[top] && remaining[top] % 2 === 0;
      remaining[top]--;
      const { children, weight, kind } = readValueHeader(
        cursor,
        maxStringBytes,
      );
      // A string over the per-string byte cap (`weight = -1`) is refused outright.
      if (weight < 0) return { rule: "string-bytes", limit: maxStringBytes };
      // A map key must be a string on the wire; anything else is refused before the
      // scan descends into it, since the property name `map[key] = value` coerces it
      // to is not bounded by what the frame spends to declare it.
      if (atKeyPosition && kind !== "string") return { rule: "map-key" };
      cost += weight;
      if (cost > maxStructureBytes)
        return { rule: "structure-bytes", limit: maxStructureBytes };
      if (children > 0) {
        // Each declared element needs at least one byte to encode, so a container
        // claiming more elements than the bytes that follow is a zero-fill lie.
        if (children > cursor.remaining()) return { rule: "unbacked-elements" };
        if (remaining.length >= maxDepth)
          return { rule: "nesting-depth", limit: maxDepth };
        remaining.push(children);
        mapLevel.push(kind === "map");
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}
