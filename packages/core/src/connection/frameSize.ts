/**
 * Maximum size, in bytes, of a single inbound frame the transport will read
 * into memory. Enforced at the transport read layer -- the `get()` calls in
 * {@link FileSyncConnection}'s poll loop and rendezvous gate, backed by a hard
 * per-read byte cap in each {@link FileTransportClient} adapter -- so an
 * oversized file is refused before it is ingested. This closes the
 * memory-exhaustion denial of service a hostile SFTP/filedrop server admin
 * (an adversary under the threat model in docs/SECURITY_DESIGN.md) could
 * otherwise mount by writing an arbitrarily large frame file: without the bound
 * the read allocates a byte array proportional to the attacker-chosen file
 * size. See docs/spec/CHANNEL_SECURITY.md.
 *
 * Value: 536,870,888 bytes (~512 MiB). This is a chosen memory bound, NOT a
 * derived platform ceiling. It is the static backstop for every frame and the
 * upper clamp for the per-exchange single-pass cap below: the single-pass reply
 * read is bounded instead by a
 * tighter cap derived from the exchanged record counts
 * ({@link singlePassReplyByteCap}), which the receiver threads into this read
 * gate (replacing this constant for that one read) and which can only ever
 * tighten, never widen, this value.
 *
 * It is fixed rather than configurable: a configurable bound risks an operator
 * raising it high enough to reintroduce the DoS. The literal is hard-coded
 * rather than read from `buffer.constants` so this module stays platform-neutral
 * (it is imported by the transport-agnostic AEAD decorator, which must not pull
 * in Node's `buffer` module).
 *
 * Headroom against the realistic worst-case legitimate frame: the largest PSI
 * frame is one party's full encrypted set sent as raw elliptic-curve points
 * (~35 bytes/element serialized on the wire; see docs/spec/PROTOCOL.md). With no
 * base64 expansion the on-wire frame is its raw size plus a small fixed envelope,
 * so 512 MiB carries on the order of 15 million elements -- already more than the
 * single-frame single-pass transport practically ships before the separate
 * single-pass dataset ceiling binds.
 */
export const MAX_FRAME_SIZE_BYTES = 536_870_888;

// A safe lower bound on the on-wire byte footprint of a LEGITIMATE encrypted
// element: a ~33-byte compressed curve point plus protobuf field framing (~35
// bytes in practice). 32 is a conservative floor -- below the real ~35 -- so the
// element ceiling derived from it never under-counts the legitimate maximum and so
// never rejects a real frame.
const MIN_ENCODED_ELEMENT_BYTES = 32;

/**
 * Absolute ceiling on the number of encrypted elements an inbound PSI frame may
 * DECLARE, enforced by a wire-format scan BEFORE deserialization (see
 * {@link countDeclaredPsiElements} in connection/psiElementScan.ts, called at the
 * participant.ts decode seams). It closes a memory-exhaustion amplification the
 * per-message authenticated bound alone does not: google-protobuf
 * `deserializeBinary` allocates one heap object -- measured ~211 bytes -- per
 * declared repeated `bytes` entry, so a frame packed with minimal ~2-byte entries
 * (within the frame byte cap, yet declaring up to ~frameBytes/2 elements) would
 * deserialize into tens of GiB before any post-deserialize count could run.
 *
 * Value: floor(MAX_FRAME_SIZE_BYTES / MIN_ENCODED_ELEMENT_BYTES) = 16,777,215. No
 * legitimate frame within the ~512 MiB frame cap can carry more than this many
 * real (>= ~35-byte) elements, so the ceiling never rejects a legitimate frame; a
 * frame declaring more is necessarily the amplification attack and is refused
 * pre-deserialize. It bounds the worst-case deserialize allocation to about
 * MAX_PSI_DECODE_ELEMENTS * ~211 B ~= 3.3 GiB -- the same order as a legitimate
 * near-cap cascade frame of real curve points, and comfortably below an OOM on the
 * 16 GiB target. The tighter authenticated `keyCount * recordCount` bound still
 * applies where it is smaller (always, for single-pass, via the cell-count gate);
 * this absolute ceiling is what binds a cascade frame whose partner over-declares
 * its record count. Fixed, not operator-configurable, for the same reason as the
 * frame-size bound. See docs/spec/CHANNEL_SECURITY.md.
 */
export const MAX_PSI_DECODE_ELEMENTS = Math.floor(
  MAX_FRAME_SIZE_BYTES / MIN_ENCODED_ELEMENT_BYTES,
);

/**
 * The single-pass dataset ceiling, expressed as a per-party budget on the
 * (key, record) cell count `keyCount * recordCount` (NOT a bare row count).
 *
 * Terminology: a "cell" here is one (key, record) pair -- one entry per record
 * per linkage key, the unit the index table is measured in. A party's cell count
 * `keyCount * recordCount` is the worst-case UPPER BOUND on its count of distinct
 * (deduplicated) linkage-key values `D`, reached only when every cell holds a
 * value that occurs nowhere else; for sparse or repeating keys `D` is lower. This
 * budget is on cells, not on `D`: the true `D` is never computed (it would cost a
 * full dedup before connecting) and never exchanged (it would disclose each key's
 * duplication and sparsity structure -- see the role-resolution discussion in
 * docs/spec/PROTOCOL.md), so bounding the cell count is the conservative gate.
 *
 * Single-pass holds both parties' full encrypted value sets resident to run the
 * match and cannot stream, so each party's peak memory is `O(total distinct
 * values)` (docs/spec/PROTOCOL.md, the single-pass dataset ceiling). The cap gates
 * both parties (see {@link singlePassExchangeExceedsCap}), so the binding cost is
 * the heavier party's lifetime peak RSS -- measured to be the SENDER at scale, which
 * holds its own encrypted setup plus the re-encrypted request resident at once. Live
 * retained memory is small -- on the order of a few hundred B per distinct value:
 * psilink JS, transport wire-buffer copies, and a grow-only WebAssembly heap floor
 * -- while the peak RSS is dominated by mostly collectable transient allocation
 * churn the OS allocator does not return. A forced GC at the single-pass phase
 * boundaries (active under the CLI's --expose-gc) relieves that churn; bounding
 * each party's cell count bounds its `D`, and so that peak.
 *
 * Value: 3,000,000 cells per party (so at most 3M distinct values per party). It
 * admits ~214k rows at the ~14-key default template and ~3M rows at a single key.
 * Methodology: a forked measurement of the real linkage with the relief active,
 * at D ~= 2M distinct
 * values near the ceiling (NOT extrapolated from a low-D fit), put the heavier-party
 * (sender) peak at ~3.0 GB and the receiver at ~2.0 GB, over a directly-measured
 * grow-only WASM linear-heap floor of ~0.8 GB and ~0.1 GB of retained JS -- a live
 * floor near 1 GB. Projected to this 3M ceiling the sender peak is ~4.4 GB,
 * comfortable headroom on a 16 GB target. After the relief the binding constraint is
 * no longer receiver memory but the WebRTC per-frame envelope: the cap is shared and
 * transport-agnostic, and the derived reply byte cap at the ceiling (~240 MiB,
 * {@link singlePassReplyByteCap}) must stay below the 256 MiB MAX_WEBRTC_FRAME_BYTES
 * so a legitimate single-pass reply is never rejected mid-exchange on the WebRTC
 * path. 3M is the largest round value that keeps that envelope from binding (a
 * browser, which never exposes gc, is expected to hit its own unrelieved memory
 * wall near the same scale -- estimated from the relief factor, not separately
 * measured), so raising further would help only file-sync and would require
 * decoupling the cap per transport. It is a cell-count budget, not a bare row cap,
 * on purpose: a rows-only cap is off by ~14x between a 1-key and a 14-key linkage at
 * the same memory. The byte cap below is a defense-in-depth tightening derived from
 * the same quantity; this cell-count budget is the real ceiling.
 *
 * Fixed, NOT operator-configurable: a configurable maximum reintroduces the
 * memory-exhaustion denial of service the bound exists for. It MAY be raised again
 * only after a further measured reduction of the transient peak lands in shipped
 * code and the budget is re-derived from a fresh measurement -- never ahead of that,
 * since the transient peak (not the live floor) is what this value bounds -- and any
 * raise past the point where the derived reply byte cap reaches MAX_WEBRTC_FRAME_BYTES
 * additionally needs the WebRTC reassembly path reworked so a browser fails closed
 * rather than mid-frame. The re-derivation must measure the grow-only WASM linear
 * heap directly at high `D` (it grows super-linearly in chunked steps, so a low-`D`
 * linear fit under-projects it), not extrapolate from the wire figure. Methodology
 * in docs/spec/PROTOCOL.md.
 */
export const MAX_SINGLE_PASS_CELLS = 3_000_000;

/**
 * The explicit upper bound on a decoded record count. It makes the cell-count
 * gate's exact-integer-product dependency a CHECK rather than an implicit reliance
 * on the `recordCount` wire schema's `.int()` safe-integer ceiling (2^53).
 *
 * The gate {@link singlePassDatasetExceedsCap} decides `keyCount * recordCount >
 * MAX_SINGLE_PASS_CELLS`. Its precision argument holds only while that product is
 * exact -- i.e. below `Number.MAX_SAFE_INTEGER` (2^53). Today that is true only
 * because the schema's `.int()` caps `recordCount` at 2^53 and the key count is
 * small, a silent dependency that a migration to BigInt or a wider numeric type
 * could break without touching the gate. Bounding the decoded `recordCount` here
 * -- enforced at the schema (see `recordCountField` on the terms-exchange
 * envelope in protocolSetup.ts) -- makes the exact-product requirement a value
 * the gate no longer depends on silently.
 *
 * Value: 1,000,000,000,000 (10^12). With the key count bounded at
 * MAX_LINKAGE_ENTRIES (256, config/linkageTerms.ts), `keyCount * recordCount` at
 * this ceiling is 2.56 x 10^14, about 35x below 2^53, so the product is always
 * exact -- a `frameSize.test.ts` invariant pins that headroom against
 * MAX_LINKAGE_ENTRIES. It is also astronomically above any legitimate
 * dataset (the static frame cap admits ~15M curve points; the single-pass cell
 * cap is 3M), so it never rejects a real record count. Defense-in-depth: the same
 * bound keeps the {@link psiElementBounds} products exact for the same reason.
 */
export const MAX_RECORD_COUNT = 1_000_000_000_000;

// Per-(key, record) byte weights of the single-pass reply frame, used to derive
// the accepted frame size (singlePassReplyByteCap). Each is a deliberate UPPER
// bound on the real serialized cost, so the derived cap can never reject a
// legitimate frame -- it is a read gate, where undershooting would be a
// correctness bug, while overshooting only loosens defense-in-depth slightly.
//   - A masked value (one encrypted curve point) serializes to ~35 bytes in the
//     protobuf `Raw` setup/response (a 33-byte compressed curve point plus
//     protobuf field framing); 40 rounds that up with margin.
//   - An index-table cell is exactly one little-endian Int32 (4 bytes).
// The reply packs, per (key, sender-record), one masked value (in the setup) and
// one index cell; per (key, receiver-record), one masked value (in the response,
// the re-encrypted client request). See docs/spec/PROTOCOL.md (single-pass wire
// format) and the byte-layout in link.ts (encodeSinglePassReply).
const SINGLE_PASS_BYTES_PER_MASKED_VALUE = 40;
const SINGLE_PASS_BYTES_PER_INDEX_CELL = 4;
// Fixed reply-frame overhead the derived cap adds once: the three uint32 length/
// count prefixes inside the reply (12 bytes), plus the AEAD envelope and the
// file-sync message header the transport read gate measures around it (~40
// bytes), plus margin. Generous so the single derived value safely bounds the
// frame at every layer it is checked (the transport read gate, and the
// send-time check in link.ts) without per-layer accounting.
const SINGLE_PASS_REPLY_OVERHEAD_BYTES = 256;

/**
 * Does a single party's own dataset alone exceed the single-pass ceiling? True
 * when `keyCount * recordCount > MAX_SINGLE_PASS_CELLS`. This is the
 * coarse one-party gate the {@link prepareForExchange} pre-flight uses before
 * connecting, when only this party's row count is known: if a party's own
 * contribution already exceeds the budget, single-pass cannot succeed whatever
 * the partner's size. The authoritative two-party check is
 * {@link singlePassExchangeExceedsCap}, run post-handshake once both counts are
 * exchanged.
 */
export function singlePassDatasetExceedsCap(
  keyCount: number,
  recordCount: number,
): boolean {
  return keyCount * recordCount > MAX_SINGLE_PASS_CELLS;
}

/**
 * Does this exchange exceed the single-pass ceiling? True when EITHER party's
 * `keyCount * recordCount` exceeds {@link MAX_SINGLE_PASS_CELLS}.
 * Computed identically on both parties from authenticated session state alone --
 * the two record counts exchanged over the encrypted channel after the handshake
 * and the agreed key count -- so both reach the same verdict and abort in
 * lockstep without either reading the inbound frame. Reads no bytes, name, or
 * transport-listed size from the inbound file.
 */
export function singlePassExchangeExceedsCap(
  keyCount: number,
  senderRecordCount: number,
  receiverRecordCount: number,
): boolean {
  return (
    singlePassDatasetExceedsCap(keyCount, senderRecordCount) ||
    singlePassDatasetExceedsCap(keyCount, receiverRecordCount)
  );
}

/**
 * The accepted byte size of the single-pass reply frame, derived deterministically
 * from the agreed key count and the two exchanged record counts -- identical on
 * both parties. It is the value the receiver's transport read gate enforces
 * (replacing the static {@link MAX_FRAME_SIZE_BYTES} for that one read) and the
 * value the sender's send-time check compares its built reply against, so the two
 * become one computation.
 *
 * Operation order and rounding (fixed so two independent implementations produce
 * the bit-identical integer): with `sCells = keyCount * senderRecordCount` and
 * `rCells = keyCount * receiverRecordCount`, the cap is
 *   (SINGLE_PASS_BYTES_PER_MASKED_VALUE + SINGLE_PASS_BYTES_PER_INDEX_CELL) * sCells
 *   + SINGLE_PASS_BYTES_PER_MASKED_VALUE * rCells
 *   + SINGLE_PASS_REPLY_OVERHEAD_BYTES
 * in exact integer arithmetic (all inputs are non-negative integers well below
 * 2^53, so no rounding occurs). The sender contributes a masked value plus an
 * index cell per (key, record); the receiver contributes a masked value per
 * (key, record). The masked-set terms use `keyCount * recordCount` as the
 * upper bound on each party's distinct-value count, so the result upper-bounds any
 * legitimate frame and never rejects one.
 *
 * Call only for an in-cap exchange (guard with {@link singlePassExchangeExceedsCap}
 * first): at the ceiling the cap is about 240 MiB, below both transports' fixed
 * envelopes (the 256 MiB WebRTC envelope is the nearer one), so the per-transport
 * clamp -- min with {@link MAX_FRAME_SIZE_BYTES}
 * for file-sync, with the web's `MAX_WEBRTC_FRAME_BYTES` for WebRTC -- is applied
 * by the read gate as a backstop and does not bind at the current ceiling. See
 * docs/spec/PROTOCOL.md (the single-pass dataset ceiling) and
 * docs/spec/CHANNEL_SECURITY.md.
 */
export function singlePassReplyByteCap(
  keyCount: number,
  senderRecordCount: number,
  receiverRecordCount: number,
): number {
  const senderCells = keyCount * senderRecordCount;
  const receiverCells = keyCount * receiverRecordCount;
  return (
    (SINGLE_PASS_BYTES_PER_MASKED_VALUE + SINGLE_PASS_BYTES_PER_INDEX_CELL) *
      senderCells +
    SINGLE_PASS_BYTES_PER_MASKED_VALUE * receiverCells +
    SINGLE_PASS_REPLY_OVERHEAD_BYTES
  );
}

/**
 * Per-message upper bounds on the encrypted-element count a received PSI frame may
 * declare, one field per message kind a party can receive. Derived only from the
 * agreed key count and the two authenticated record counts -- never from the
 * inbound frame's own bytes -- and enforced at the `deserializeBinary` seam in
 * participant.ts before the element list drives curve-point materialization in the
 * library. See {@link psiElementBounds}.
 */
export interface PsiElementBounds {
  /** Max elements a received server setup (the sender's masked set) may declare. */
  readonly setup: number;
  /** Max elements a received request (the receiver's masked set) may declare. */
  readonly request: number;
  /**
   * Max elements a received response (the sender's re-encryption of the receiver's
   * request, so it carries the receiver's element count) may declare.
   */
  readonly response: number;
}

/**
 * Derive the per-message element-count bounds from authenticated session state:
 * the agreed key count and the two exchanged record counts. Both parties compute
 * the SAME bounds, and each enforces only the ones for the messages it receives
 * (the sender checks the request; the receiver checks the setup and response).
 *
 * The bound is the same `keyCount * recordCount` cell count the single-pass frame
 * cap sizes against -- the worst-case upper bound on a party's distinct-value
 * count, reached only when every cell holds a value seen nowhere else -- so it
 * upper-bounds any legitimate frame and never rejects one. It applies to both the
 * single-pass and cascade decode paths: single-pass pools each party's distinct
 * values across all keys (at most `keyCount * recordCount`), and the cascade sends
 * one key's values per round (at most `recordCount`, well within the same bound).
 *
 * The setup carries the SENDER's masked set; the request carries the RECEIVER's
 * masked set; the response re-encrypts that request, so it carries the receiver's
 * count too. Inputs are non-negative integers well below 2^53 (record counts are
 * bounded by {@link MAX_RECORD_COUNT}, the key count by MAX_LINKAGE_ENTRIES), so
 * the products are exact.
 */
export function psiElementBounds(
  keyCount: number,
  senderRecordCount: number,
  receiverRecordCount: number,
): PsiElementBounds {
  return {
    setup: keyCount * senderRecordCount,
    request: keyCount * receiverRecordCount,
    response: keyCount * receiverRecordCount,
  };
}
