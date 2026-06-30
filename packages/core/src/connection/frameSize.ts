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
 * derived platform ceiling. It once equalled Node's maximum string length
 * (`buffer.constants.MAX_STRING_LENGTH` on 64-bit) because the read path
 * `.toString()`d each frame before parsing it (through `parseBoundedJson`) and
 * `Buffer.prototype.toString()` throws above that length, so the string limit
 * was the true hard ceiling and anchoring the cap there avoided rejecting any
 * frame the transport could otherwise decode. That anchor is now void: the
 * transport carries a binary frame as raw bytes and never stringifies it (the
 * AEAD envelope and the file-sync message body are both binary; see
 * encryptedMessageConnection.ts and fileSyncConnection.ts), so a frame larger
 * than the former string limit can be read. The numeric value is retained
 * unchanged -- still a reasonable ~512 MiB single-frame memory cap. It is the
 * static backstop for every frame and the upper clamp for the per-exchange
 * single-pass cap below: the single-pass reply read is bounded instead by a
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
 * Single-pass holds both parties' full encrypted value sets resident on the
 * receiver to run the match, so its peak memory is `O(total distinct values)` and
 * cannot stream (docs/spec/PROTOCOL.md, the single-pass dataset ceiling). The
 * binding cost is the receiver's lifetime peak RSS. Live retained memory is small
 * -- ~130 B per distinct value (board item 206377899) -- but the peak RSS climbs
 * ~2-4 KB per distinct value in transient allocation churn that neither V8 nor
 * emmalloc returns to the OS; bounding each party's cell count bounds its `D`, and
 * so that peak.
 *
 * Value: 2,000,000 cells per party (so at most 2M distinct values per party). At
 * the ~2-4 KB/value transient peak slope that projects to roughly 6-8 GB peak RSS,
 * which the current value holds headroom against on a 16 GB target; it admits
 * ~143k rows at the ~14-key default template and ~2M rows at a single key. That
 * projection is the transient peak, not live data (2M distinct values is only
 * ~260 MB live), so the budget is conservative against the true memory wall. It is
 * a cell-count budget, not a bare row cap, on purpose: a rows-only cap is off by
 * ~14x between a 1-key and a 14-key linkage at the same memory. The byte cap below
 * is a defense-in-depth tightening derived from the same quantity; this cell-count
 * budget is the real ceiling.
 *
 * Fixed, NOT operator-configurable: a configurable maximum reintroduces the
 * memory-exhaustion denial of service the bound exists for. It is slated to rise
 * as board item 206377899 lowers the transient peak (a packages/core JS-churn and
 * GC-pressure task) and re-derives the budget; the methodology is in
 * docs/spec/PROTOCOL.md.
 */
export const MAX_SINGLE_PASS_CELLS = 2_000_000;

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
 * first): at the ceiling the cap is about 168 MB, below both transports' fixed
 * envelopes, so the per-transport clamp -- min with {@link MAX_FRAME_SIZE_BYTES}
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
