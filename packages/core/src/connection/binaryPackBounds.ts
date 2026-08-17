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
// the library's API, so it carries a dependency premise on that marker table, and
// two more on how `unpack` allocates: a container's store sized from its declared
// count, and a map key retained as the property name `map[key] = value` coerces it
// to (docs/spec/DEPENDENCY_PINS.md). A misparse cannot silently disable the bound:
// it either over-charges (rejecting early, fail-closed) or runs the cursor off the
// end, which is treated as a malformed frame and delegated to the real unpacker.
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
 *   undefined -- therefore adds nothing of its own. A `bin`/`raw` value also adds
 *   nothing: its payload is ~1x its wire bytes and so already bounded by
 *   {@link MAX_WEBRTC_FRAME_BYTES}, not by this structural budget. (The number
 *   markers that unpack to a HeapNumber rather than a SMI -- `float`, `double`,
 *   `uint32`/`int32` past the SMI range, `uint64`/`int64` -- retain ~24 bytes
 *   incl. their slot, more than the 8 charged here. A homogeneous numeric array
 *   stores them unboxed at ~8 bytes, matching the charge; but a peer can force
 *   per-element boxing by mixing in one non-number to make the array
 *   general-elements kind, reaching ~24 bytes/value. Each such value costs >= 5
 *   wire bytes, so the wire-byte cap -- not this structure budget -- is the
 *   binding control for a number-heavy frame, bounding even an all-boxed one to
 *   ~1.2 GiB: on the order of, and slightly above, this budget, a fixed transient
 *   freed once the schema layer rejects the frame.)
 * - `string` (`stringBase` 16 + `stringPerByte` 2 per declared wire byte): a
 *   SeqString header (~16 bytes) plus its characters. `unpack_string` decodes the
 *   declared UTF-8 wire length into a JS string of at most that many UTF-16 code
 *   units (~2 bytes each), so `stringBase + 2 * declaredWireBytes` upper-bounds its
 *   resident size. (A string's *build* transient -- a per-code-point cons-string
 *   tree -- is bounded separately by {@link MAX_WEBRTC_STRING_BYTES}, not here.)
 * - `coercedKeyName` (64): the property name a map key that is not already a
 *   string becomes. `unpack_map` assigns `map[key] = value`, so the key is coerced
 *   to a property name: a number reaches at most 24 UTF-16 code units
 *   (`-1.7976931348623157e+308`) and every other primitive is shorter, so
 *   `stringBase + stringPerByte * 24` upper-bounds that name. A container key
 *   coerces to the joined string forms of the values below it, each contributing
 *   at most one value's own name plus a separator, so the same weight is charged
 *   for every non-string value inside such a key. A string needs no charge here at
 *   either position: it contributes its own characters, which its `string` weight
 *   already charges in full (and at a key position it IS the property name, which
 *   V8 internalizes).
 *
 * The model is deliberately a *conservative* upper bound: e.g. it charges every
 * object key string in full, though V8 internalizes repeated property keys to one
 * shared string, so the real retained peak of a key-heavy frame is lower. A true
 * memory envelope is simpler for a security reviewer to audit than one resting on
 * V8 interning/representation choices an engine update could change; the cost of
 * conservatism is a budget sized above the realistic legitimate frame rather than
 * hugging it (see {@link MAX_WEBRTC_FRAME_STRUCTURE_BYTES}). Fixed, not
 * configurable, for the same reason as the budget itself.
 */
export const WEBRTC_VALUE_WEIGHTS = {
  object: 64,
  array: 40,
  scalar: 8,
  stringBase: 16,
  stringPerByte: 2,
  coercedKeyName: 64,
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
 * {@link structureOverBudget}, run at the unpack chokepoint) sums each declared
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
 * bytes under the weights above, a per-record cost the unit tests pin against the
 * real frame shape; 2^30 therefore admits a mapped-element frame of about 6.17
 * million matched records. This path enforces that budget and
 * {@link MAX_WEBRTC_FRAME_BYTES}, and no element-count ceiling: the two are
 * independent bounds, with no headroom relation between them at the 35 bytes an
 * encrypted element occupies on the wire (see docs/spec/PROTOCOL.md). A set frame
 * filling the 256 MiB wire cap carries about 7.67 million elements, whose
 * mapped-element frame would reach about 1.24 GiB and be rejected here.
 * Residual: the per-frame worst case for the kinds this budget charges in full is
 * the budget itself. A frame of the heaviest such kind (~16.7M empty objects)
 * reaches ~1 GiB and is rejected there, and reaching even that requires ~16 MiB
 * of proportional wire (the per-container byte check ties cost to wire), freed
 * once the schema layer rejects the frame. A tighter budget is available only by
 * making the weights less conservative (e.g. crediting key-string
 * internalization); that aggressiveness is a security-review judgment (see
 * docs/spec/CHANNEL_SECURITY.md). Fixed, not configurable: a configurable bound
 * risks being raised to reintroduce the denial of service.
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
 * `map` alternates key and value children, so the scan must charge a coerced
 * property name at each key position, and a `string` is the one kind that needs no
 * such charge (see {@link WEBRTC_VALUE_WEIGHTS}). */
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
 * backing slot it reserves for each of those children, charged here at the header
 * because `unpack_array`/`unpack_map` size the store from the declared count
 * before reading a single element (see {@link WEBRTC_VALUE_WEIGHTS}). */
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

/** A value allocating nothing beyond the backing slot its container already
 * charged: an integer, boolean, null, undefined, or a `bin`/`raw` payload. */
const SCALAR: ValueHeader = {
  children: 0,
  weight: 0,
  kind: "plain",
};

/** Reads one BinaryPack value's header at the cursor, skipping a scalar's
 * payload, and returns the value's {@link ValueHeader} (its declared child count,
 * its retained-byte weight including a container's declared backing slots, and the
 * kind the coerced-key-name rule dispatches on; `weight = -1` for a string whose
 * declared length exceeds `maxStringBytes`). Mirrors `peerjs-js-binarypack`'s
 * `Unpacker.unpack` marker dispatch: a map of K pairs declares 2K children (K keys
 * + K values). A `bin`/`raw` value allocates nothing beyond its parent's slot, its
 * payload being ~1x wire and so bounded by the wire-byte cap. An unknown marker
 * yields the same and 0 children (BinaryPack returns `undefined` for it without
 * consuming a payload). */
function readValueHeader(
  cursor: ByteCursor,
  maxStringBytes: number,
): ValueHeader {
  const type = cursor.u8();
  if (type < 0x80) return SCALAR; // positive fixint
  if ((type ^ 0xe0) < 0x20) return SCALAR; // negative fixint
  if ((type ^ 0xa0) <= 0x0f) {
    cursor.skip(type ^ 0xa0); // fixraw (binary), payload bounded by the wire cap
    return SCALAR;
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
      return SCALAR;
    case 0xcb: // double
    case 0xcf: // uint64
    case 0xd3: // int64
      cursor.skip(8);
      return SCALAR;
    case 0xda: // raw16
      cursor.skip(cursor.u16()); // unpack_raw copies `size` bytes (~1x wire),
      return SCALAR; // bounded by the wire-byte cap; charged the scalar slot only
    case 0xdb: // raw32
      cursor.skip(cursor.u32());
      return SCALAR;
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
 * Whether the BinaryPack value in `buf` would deserialize to a structure whose
 * approximate retained-byte cost exceeds `maxStructureBytes`, nest deeper than
 * `maxDepth`, contain a string longer than `maxStringBytes`, or declare any
 * container with more elements than the bytes that follow it can encode. Walks the
 * structure reading only container headers and scalar lengths -- never
 * materializing the payload -- and charges each declared value its per-kind weight
 * (see {@link WEBRTC_VALUE_WEIGHTS}), rejecting as soon as the running cost
 * breaches the budget, a container over-declares, or a string over-declares, so an
 * over-budget frame is caught before `unpack` allocates (the empty-object/array
 * amplification, the `new Array(N)`-from-a-tiny-header case, and the giant-string
 * case where `unpack_string` builds a JS string far larger than its slot).
 *
 * Two charges are made where `unpack` allocates rather than where the wire spends
 * bytes, since the two diverge:
 *
 * - A container's backing slots are charged at its own header, from its declared
 *   count, because `unpack_array`/`unpack_map` reserve the whole store up front and
 *   read past the end of the buffer as zero rather than throwing -- so a declared
 *   child that no wire byte backs still costs its slot.
 * - A map key that is not a string is charged {@link WEBRTC_VALUE_WEIGHTS}'s
 *   `coercedKeyName`, and so is every non-string value beneath such a key, because
 *   `map[key] = value` retains the key's coerced string form as the property name.
 *
 * A read past the end (a malformed/truncated frame) returns `false`: every value it
 * passed was within the byte budget, the bytes past the end unpack as zero-valued
 * integers into slots this scan has already charged, so the structure it commits
 * `unpack` to is already bounded, and PeerJS's own unpack handles the malformation
 * downstream.
 */
export function structureOverBudget(
  buf: Uint8Array,
  maxStructureBytes: number,
  maxDepth: number,
  maxStringBytes: number = MAX_WEBRTC_STRING_BYTES,
): boolean {
  const cursor = new ByteCursor(buf);
  // remaining[d] = child values still to read at nesting level d; one root value.
  const remaining: Array<number> = [1];
  // mapLevel[d] = whether level d is a map's children, which alternate key, value,
  // key, ... so an even count still to read is a key position.
  const mapLevel: Array<boolean> = [false];
  // The level a coerced property name's subtree begins at, or -1 outside one:
  // `unpack_map` joins every value at or below a non-string key into that name.
  let keyNameLevel = -1;
  // Running sum of the approximate retained bytes the structure has committed
  // `unpack` to allocate (every value's per-kind weight: the root, every
  // container's declared backing slots, and every coerced property name).
  let cost = 0;
  try {
    while (remaining.length > 0) {
      const top = remaining.length - 1;
      if (remaining[top] === 0) {
        remaining.pop();
        mapLevel.pop();
        if (top === keyNameLevel) keyNameLevel = -1;
        continue;
      }
      // A map's children alternate key, value, key, ...; the keys are the ones
      // read at an even count still to read.
      const atKeyPosition = mapLevel[top] && remaining[top] % 2 === 0;
      const withinKeyName = keyNameLevel >= 0 || atKeyPosition;
      remaining[top]--;
      const { children, weight, kind } = readValueHeader(
        cursor,
        maxStringBytes,
      );
      // A string over the per-string byte cap (`weight = -1`) is refused outright.
      if (weight < 0) return true;
      cost += weight;
      if (withinKeyName && kind !== "string")
        cost += WEBRTC_VALUE_WEIGHTS.coercedKeyName;
      if (cost > maxStructureBytes) return true;
      if (children > 0) {
        // Each declared element needs at least one byte to encode, so a container
        // claiming more elements than the bytes that follow is a zero-fill lie.
        if (children > cursor.remaining()) return true;
        if (remaining.length >= maxDepth) return true;
        if (withinKeyName && keyNameLevel < 0) keyNameLevel = remaining.length;
        remaining.push(children);
        mapLevel.push(kind === "map");
      }
    }
  } catch {
    return false;
  }
  return false;
}
