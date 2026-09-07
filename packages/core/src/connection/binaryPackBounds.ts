// The transport-agnostic half of the WebRTC data-channel inbound bound
// (docs/spec/CHANNEL_SECURITY.md): the fixed bound constants and the
// BinaryPack structural pre-scan that rejects a frame before it is unpacked.
// It lives here, not beside a transport, because every WebRTC transport
// speaks the same PeerJS BinaryPack wire and must enforce one implementation
// of these bounds.
//
// The half that is NOT here is the part bound to a specific reassembler: the
// web app wraps PeerJS's `_handleChunk`/`_handleDataMessage` internals to
// apply these constants at its unpack chokepoint
// (apps/web/src/psi/transport/boundedReassembly.ts).
//
// The scan reads only the BinaryPack wire format -- the marker dispatch in
// `peerjs-js-binarypack`'s `Unpacker.unpack` -- never the library's API, so
// it rests on an assumption about that marker table and one about how
// `unpack` allocates (docs/spec/DEPENDENCY_PINS.md), both driven against the
// real library by the differential suite. A misparse either refuses the frame
// early (fail-closed) or runs the cursor off the end, treated as a malformed
// frame and delegated to the real unpacker.
//
// The BinaryPack analogue of the raw-protobuf element-count scan in
// connection/psiElementScan.ts.

/**
 * Maximum size, in bytes, of a single inbound frame the web WebRTC
 * data-channel receive path will reassemble into memory. The web
 * peer-to-peer transport runs the PeerJS data channel directly and declines
 * the application-layer AEAD wrap under DTLS (see
 * `apps/web/src/psi/authenticateExchange.ts`), so core's
 * `EncryptedMessageConnection` and its ~512 MiB `MAX_FRAME_SIZE_BYTES`
 * envelope never bind here; this is the WebRTC transport's own inbound byte
 * bound, the analogue of the file-sync frame-size cap
 * (docs/spec/CHANNEL_SECURITY.md) for the one transport that cap does not
 * reach. Without it a hostile or buggy peer can stream an oversized PSI set
 * frame, or a flood of never-completed chunk reassemblies, and drive the
 * receiving tab toward memory exhaustion.
 *
 * Value: 268,435,456 bytes (256 MiB), a chosen browser-tab memory envelope
 * above the realistic largest legitimate PSI set frame (one party's set as
 * raw EC points, 35 bytes/element, so a few-million-element set is tens to
 * low-hundreds of MiB; `MAX_CSV_FILE_BYTES`, 100 MiB, bounds it upstream) and
 * below an allocation that would crash the tab. This counts the wire
 * (reassembled) bytes. BinaryPack `unpack` retains a multiple of them, so this
 * is the quantity the retained structure is bounded against: the measured
 * amplification per frame shape, and what the structural rules
 * ({@link scanFrameStructure}) close, are in docs/spec/CHANNEL_SECURITY.md.
 * Fixed, not operator-configurable: a configurable cap risks being raised to
 * reintroduce the denial of service.
 *
 * Also the WebRTC half of the single-pass frame cap's per-transport clamp:
 * single-pass derives a per-exchange reply cap from the exchanged record
 * counts (`singlePassReplyByteCap`) and aborts an exchange whose
 * `keyCount * rows` exceeds `MAX_SINGLE_PASS_CELLS`, a shared,
 * transport-agnostic check both parties run from authenticated counts
 * (`linkViaSinglePassPSI`). WebRTC keeps this fixed envelope at the
 * reassembly read gate rather than threading the derived cap into it (the
 * file-sync transport threads it into its `get()` read gate instead). At the
 * single-pass ceiling the derived reply cap is ~240 MiB, below this 256 MiB
 * envelope, so it never rejects a legitimate single-pass reply the count
 * check already admitted. `MAX_SINGLE_PASS_CELLS` is held below the point
 * where that derived cap would reach this envelope; raising it past that
 * point would require this path to gate on a per-exchange cell budget too.
 * See docs/spec/CHANNEL_SECURITY.md and docs/spec/PROTOCOL.md.
 */
export const MAX_WEBRTC_FRAME_BYTES = 256 * 1024 * 1024;

/**
 * Maximum number of concurrently-incomplete PeerJS chunk reassemblies
 * retained at once. The PSI protocol is strictly lockstep
 * (docs/spec/PROTOCOL.md): each party sends one frame and waits for the
 * reply, and the reliable, ordered data channel delivers a frame's chunks
 * contiguously, so at most one frame is ever mid-reassembly on an honest
 * exchange. This cap is generous headroom above that maximum of one; beyond
 * it the oldest incomplete partial is evicted (`boundChunkReassembly` in
 * apps/web/src/psi/transport/boundedReassembly.ts), bounding a flood
 * of never-completed partials from distinct message ids -- the case
 * PeerJS leaves unbounded, retaining a partial keyed by message id
 * indefinitely. Fixed, not configurable, for the same reason as the byte
 * bound.
 */
export const MAX_CONCURRENT_REASSEMBLIES = 8;

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
 * Maximum byte length of a single BinaryPack string a frame may contain.
 * `unpack_string` builds a string by concatenating one code point at a time,
 * and the cons-string tree that leaves retains about 32 bytes per declared
 * wire byte -- the same amplification whether the frame spends its bytes on
 * one long string or many short ones, so this cap bounds a single value's
 * retention rather than the frame's.
 *
 * Value: the web app's CSV intake cap (`MAX_CSV_FILE_BYTES`,
 * apps/web/src/components/csvIntake.ts), which is what bounds the longest
 * cell a partner can hold: a payload cell is not length-bounded upstream
 * (only column names are), so a cap below the intake cap could refuse a
 * legitimate frame. `apps/web/test/unit/psi/boundedReassembly.test.ts` holds
 * the two together -- core cannot import an app. Fixed, not configurable.
 */
export const MAX_WEBRTC_STRING_BYTES = 100 * 1024 ** 2;

/**
 * Which pre-scan rule refused a frame, with the fixed limit that rule
 * enforces where it has one. {@link scanFrameStructure} returns one of
 * these instead of a bare verdict, so the failure an operator (or a support
 * thread) reads names the control that fired rather than one standing in
 * for the rest.
 *
 * A refusal holds the LIMIT and never the measurement that met it: every
 * field here is a value the receiving side fixed, so nothing the peer chose
 * reaches the rendered message (see {@link describeFrameStructureRefusal}).
 *
 * - `nesting-depth`: the structure nests deeper than `maxDepth`.
 * - `string-bytes`: a string declares more wire bytes than `maxStringBytes`.
 * - `unbacked-elements`: a container declares more elements than the bytes
 *   that follow it can encode, so its declared count is one `unpack` would
 *   zero-fill rather than read.
 * - `map-key`: a map key that is not a string on the wire (see
 *   {@link scanFrameStructure}).
 */
export type FrameStructureRefusal =
  | { readonly rule: "nesting-depth"; readonly limit: number }
  | { readonly rule: "string-bytes"; readonly limit: number }
  | { readonly rule: "unbacked-elements" }
  | { readonly rule: "map-key" };

/**
 * The predicate a transport puts after "inbound WebRTC frame" to say why
 * the scan refused it -- one wording for every transport, so an operator
 * reading either half of the control sees one message for one rule.
 *
 * Composed from the refusal's fixed limit alone: no length, count, depth,
 * or byte the peer chose is interpolated, so the rendered text is one of a
 * fixed set of strings whatever the frame held (a unit test holds that by
 * rendering wildly different frames per rule and requiring identical text).
 */
export function describeFrameStructureRefusal(
  refusal: FrameStructureRefusal,
): string {
  switch (refusal.rule) {
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

/** What the scan needs to know about one BinaryPack value: a `map` alternates
 * key and value children, so the scan must test what kind sits at each key
 * position, and `string` is the only kind a map key may be. `over-cap-string`
 * is a string declaring more wire bytes than the per-string cap allows (see
 * {@link scanFrameStructure}). */
type ValueKind = "map" | "string" | "plain" | "over-cap-string";

/** One BinaryPack value as the walk reads it: `children` is the number of child
 * values a container declares (0 for a scalar or string), and `kind` is what the
 * map-key and per-string rules dispatch on. */
interface ValueHeader {
  children: number;
  kind: ValueKind;
}

/** A string value of `declaredBytes` wire bytes: refused if it exceeds
 * `maxStringBytes`, else its payload skipped. Shared by every string marker
 * (`fixstr`/`str16`/`str32`), so the per-string cap is enforced by one rule
 * rather than resting on a "fixstr is always small" assumption. */
function stringValue(
  cursor: ByteCursor,
  declaredBytes: number,
  maxStringBytes: number,
): ValueHeader {
  if (declaredBytes > maxStringBytes)
    return { children: 0, kind: "over-cap-string" };
  cursor.skip(declaredBytes);
  return { children: 0, kind: "string" };
}

/** A container of `children` declared child values. */
function containerValue(children: number, kind: ValueKind): ValueHeader {
  return { children, kind };
}

/** A value that declares no children of its own: an integer, boolean, null,
 * undefined, a `bin`/`raw` payload, or a number in any marker width. */
const LEAF: ValueHeader = {
  children: 0,
  kind: "plain",
};

/** Reads one BinaryPack value's header at the cursor, skipping the payload of a
 * value that has one, and returns its {@link ValueHeader}: the declared child
 * count and the kind the map-key and per-string rules dispatch on. Mirrors
 * `peerjs-js-binarypack`'s `Unpacker.unpack` marker dispatch: a map of K pairs
 * declares 2K children, and each marker's payload width is the width that
 * unpacker advances by. An unknown marker declares 0 children. */
function readValueHeader(
  cursor: ByteCursor,
  maxStringBytes: number,
): ValueHeader {
  const type = cursor.u8();
  if (type < 0x80) return LEAF; // positive fixint
  if ((type ^ 0xe0) < 0x20) return LEAF; // negative fixint
  if ((type ^ 0xa0) <= 0x0f) {
    cursor.skip(type ^ 0xa0); // fixraw (binary), payload bounded by the wire cap
    return LEAF;
  }
  if ((type ^ 0xb0) <= 0x0f)
    return stringValue(cursor, type ^ 0xb0, maxStringBytes); // fixstr (<= 15 bytes)
  if ((type ^ 0x90) <= 0x0f) return containerValue(type ^ 0x90, "plain"); // fixarray
  if ((type ^ 0x80) <= 0x0f) return containerValue((type ^ 0x80) * 2, "map"); // fixmap
  switch (type) {
    case 0xc0: // null
    case 0xc1: // undefined
    case 0xc2: // false
    case 0xc3: // true
    case 0xd4: // unused
    case 0xd5:
    case 0xd6:
    case 0xd7:
      return LEAF;
    case 0xcc: // uint8
    case 0xd0: // int8
      cursor.skip(1);
      return LEAF;
    case 0xcd: // uint16
    case 0xd1: // int16
      cursor.skip(2);
      return LEAF;
    case 0xca: // float
    case 0xce: // uint32
    case 0xd2: // int32
      cursor.skip(4);
      return LEAF;
    case 0xcb: // double
    case 0xcf: // uint64
    case 0xd3: // int64
      cursor.skip(8);
      return LEAF;
    case 0xda: // raw16
      cursor.skip(cursor.u16()); // unpack_raw copies `size` bytes (~1x wire),
      return LEAF; // bounded by the wire-byte cap
    case 0xdb: // raw32
      cursor.skip(cursor.u32());
      return LEAF;
    case 0xd8: // str16
      return stringValue(cursor, cursor.u16(), maxStringBytes);
    case 0xd9: // str32
      return stringValue(cursor, cursor.u32(), maxStringBytes);
    case 0xdc: // array16
      return containerValue(cursor.u16(), "plain");
    case 0xdd: // array32
      return containerValue(cursor.u32(), "plain");
    case 0xde: // map16
      return containerValue(cursor.u16() * 2, "map");
    case 0xdf: // map32
      return containerValue(cursor.u32() * 2, "map");
    default:
      return LEAF;
  }
}

/**
 * Scans the BinaryPack value in `buf`, returning the
 * {@link FrameStructureRefusal} of the first rule that fires, or `undefined`
 * if the frame is admitted. A frame is refused when it nests deeper than
 * `maxDepth`, contains a string longer than `maxStringBytes`, declares any
 * container with more elements than the bytes that follow it can encode, or
 * keys a map with anything but a string. It walks the structure reading only
 * container headers and payload lengths, never materializing the payload, so
 * it refuses at the offending header before `unpack` allocates and skips a
 * large binary set frame in O(1).
 *
 * What the three rules leave admitted is a multiple of the frame's wire
 * bytes, measured per shape in docs/spec/CHANNEL_SECURITY.md and pinned
 * against the real unpacker by
 * `packages/core/test/connection/binaryPackRetention.test.ts`. The wire-byte
 * cap ({@link MAX_WEBRTC_FRAME_BYTES}) is what that multiple applies to.
 *
 * A map key that is not a string on the wire is REFUSED. The `pack` side of
 * this dependency emits a map only for a plain JS object, whose own keys are
 * strings by construction, so no legitimate frame holds one -- an assumption
 * the differential suite holds the real packer to. Refusing is what keeps the
 * admitted structure tied to the wire at all: `unpack_map` assigns
 * `map[key] = value`, retaining the key's coerced string form as the property
 * name, and a container key coerces to the joined forms of everything beneath
 * it, which grows with the declared descendants `unpack` zero-fills rather
 * than with the bytes the wire spends.
 *
 * A read past the end (a malformed/truncated frame) is admitted: the bytes
 * past the end unpack as zero-valued integers into slots an ancestor's
 * declared count already committed, and PeerJS's own unpack handles the
 * malformation downstream. The key rule is decided on the key's own marker
 * byte before the scan descends into it, so an underrun deeper in the frame
 * cannot let a non-string key slip past this point.
 */
export function scanFrameStructure(
  buf: Uint8Array,
  maxDepth: number,
  maxStringBytes: number = MAX_WEBRTC_STRING_BYTES,
): FrameStructureRefusal | undefined {
  const cursor = new ByteCursor(buf);
  // remaining[d] = child values still to read at nesting level d; one root value.
  const remaining: Array<number> = [1];
  // mapLevel[d] = whether level d is a map's children, which alternate key, value,
  // key, ... so an even count still to read is a key position.
  const mapLevel: Array<boolean> = [false];
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
      const { children, kind } = readValueHeader(cursor, maxStringBytes);
      if (kind === "over-cap-string")
        return { rule: "string-bytes", limit: maxStringBytes };
      // A map key must be a string on the wire; anything else is refused before the
      // scan descends into it, since the property name `map[key] = value` coerces it
      // to is not bounded by what the frame spends to declare it.
      if (atKeyPosition && kind !== "string") return { rule: "map-key" };
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
