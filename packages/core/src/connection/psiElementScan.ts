// Wire-format element-count scanner for the PSI decode seams. It counts the
// encrypted elements a partner-supplied protobuf frame DECLARES, without
// materializing them, so an over-declared frame is rejected BEFORE
// `deserializeBinary` allocates one heap object -- measured ~211 bytes -- per
// declared repeated `bytes` entry. This closes a frame-bytes -> element-count
// memory amplification: a minimal ~2-byte repeated entry deserializes to ~211
// resident bytes (~105x), so a within-frame-cap frame packed with empty entries
// would otherwise exhaust memory (tens of GiB) before any post-deserialize count
// could read it. It is the raw-protobuf analogue of the web path's BinaryPack
// structure scan (apps/web/src/psi/boundedReassembly.ts).
//
// The scan reads only the protobuf WIRE FORMAT -- a stable, public specification:
// varint tags, wire types, length-delimited fields -- never the @openmined/psi.js
// message API, so a library version bump cannot silently change what it parses. It
// takes the wire type from the low 3 bits of each field's first tag byte and never
// computes the field number, so it needs no per-field-number premise. What it DOES
// assume is the message STRUCTURE: the encrypted-element list is a top-level
// repeated field on a Request and a Response, and one submessage level deep on a
// ServerSetup (inside the Raw/GCS/Bloom oneof member). That structural premise, and
// the scan/library element-count equivalence, are pinned by psiElementScan.test.ts
// and must be re-verified on an @openmined/psi.js upgrade.
//
// Safety: the scan counts EVERY length-delimited field at the target depth, so it
// is an upper bound on the elements `deserializeBinary` will actually materialize
// (the library skips unknown fields without allocating a per-element object). It
// therefore never under-counts the amplifying allocation. A frame it cannot parse
// as protobuf (truncated, a group wire type the messages never use) throws, and the
// caller rejects it -- fail-closed and safe, since a conforming peer serializes the
// same standard wire format the scan accepts (pinned by the equivalence tests).

/**
 * The three partner-supplied PSI message kinds decoded at the participant seams.
 * @internal
 */
export type PsiMessageKind = "request" | "response" | "serverSetup";

// encrypted_elements nesting depth per message kind: top level on Request/Response,
// one submessage deep on ServerSetup (the Raw/GCS/Bloom oneof member).
const ELEMENT_DEPTH: Record<PsiMessageKind, number> = {
  request: 0,
  response: 0,
  serverSetup: 1,
};

interface VarintRead {
  value: number;
  pos: number;
}

// Read a base-128 varint at `pos`. Uses `* 2 ** shift` rather than `<< shift` so a
// length up to the ~512 MiB frame cap (30 bits) stays exact. Throws on a truncated
// or over-long varint.
function readVarint(bytes: Uint8Array, pos: number): VarintRead {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (pos >= bytes.length)
      throw new Error("PSI element scan: truncated varint");
    const byte = bytes[pos];
    pos += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, pos };
    shift += 7;
    if (shift > 63) throw new Error("PSI element scan: varint too long");
  }
}

// Count length-delimited (wire type 2) fields at exactly `depth` levels of nesting
// (depth 0 = the top level of `bytes`), recursing only through length-delimited
// fields. Stops as soon as the running count exceeds `ceiling`, returning a value
// > ceiling. Throws on a malformed frame.
function scanCount(bytes: Uint8Array, depth: number, ceiling: number): number {
  const len = bytes.length;
  let pos = 0;
  let count = 0;
  while (pos < len) {
    const wireType = bytes[pos] & 0x07;
    // Consume the tag varint (the field number is not needed).
    pos = readVarint(bytes, pos).pos;
    if (wireType === 2) {
      const lengthRead = readVarint(bytes, pos);
      const start = lengthRead.pos;
      const end = start + lengthRead.value;
      if (end > len || end < start)
        throw new Error("PSI element scan: field length past end");
      pos = end;
      if (depth === 0) {
        count += 1;
      } else {
        count += scanCount(
          bytes.subarray(start, end),
          depth - 1,
          ceiling - count,
        );
      }
      if (count > ceiling) return count;
    } else if (wireType === 0) {
      pos = readVarint(bytes, pos).pos;
    } else if (wireType === 1) {
      pos += 8;
      if (pos > len)
        throw new Error("PSI element scan: truncated 64-bit field");
    } else if (wireType === 5) {
      pos += 4;
      if (pos > len)
        throw new Error("PSI element scan: truncated 32-bit field");
    } else {
      throw new Error(`PSI element scan: unsupported wire type ${wireType}`);
    }
  }
  return count;
}

/**
 * The number of encrypted elements the serialized PSI `kind` frame declares, read
 * from the protobuf wire format without materializing the elements. Stops counting
 * once the total exceeds `ceiling` (returns a value > ceiling then), so an
 * adversarially over-declared frame costs O(ceiling), not O(frame). Throws on a
 * malformed frame. See the module header for the safety argument.
 * @internal
 */
export function countDeclaredPsiElements(
  bytes: Uint8Array,
  kind: PsiMessageKind,
  ceiling: number,
): number {
  return scanCount(bytes, ELEMENT_DEPTH[kind], ceiling);
}
