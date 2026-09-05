// Wire-format element-count scanner for the PSI decode call sites: counts the
// encrypted elements a partner-supplied protobuf frame declares, without
// materializing them, so an over-declared frame is rejected before
// `deserializeBinary` allocates its ~211-byte object per declared entry --
// closing a frame-bytes-to-element-count memory amplification that could
// otherwise exhaust memory before a post-deserialize count could catch it.
// Raw-protobuf analogue of the WebRTC BinaryPack scan
// (connection/binaryPackBounds.ts).
//
// Reads only the protobuf wire format (varint tags, wire types,
// length-delimited fields), never the @openmined/psi.js message API, so a
// library version bump cannot silently change what it parses. It assumes the
// message structure -- the encrypted-element list sits at the top level on a
// Request/Response and one submessage deep on a ServerSetup -- pinned along
// with the scan/library element-count equivalence by psiElementScan.test.ts;
// re-verify both on an @openmined/psi.js upgrade.
//
// Counts every length-delimited field at the target depth, an upper bound on
// what `deserializeBinary` actually materializes, so it never under-counts.
// An unparseable frame throws and the caller rejects it -- fail closed, since
// a conforming peer serializes the same wire format the scan accepts.

/**
 * The three partner-supplied PSI message kinds decoded at the participant
 * call sites.
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
