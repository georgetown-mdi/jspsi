/**
 * Maximum size, in bytes, of a single inbound frame the transport will read
 * into memory: the static ceiling for every frame, and the upper clamp for the
 * per-exchange single-pass cap below. What it defends against, why the value
 * is what it is, where it is enforced, and why it is not configurable:
 * docs/spec/CHANNEL_SECURITY.md ("Inbound frame-size bound").
 *
 * The literal is hard-coded rather than read from `buffer.constants` so this
 * module stays platform-neutral: it is imported by the transport-agnostic AEAD
 * decorator, which must not pull in Node's `buffer` module.
 */
export const MAX_FRAME_SIZE_BYTES = 536_870_888;

// A conservative lower bound on the on-wire byte footprint of a LEGITIMATE
// encrypted element, kept below the real figure so the element ceiling derived
// from it never under-counts the legitimate maximum and so never rejects a
// real frame.
const MIN_ENCODED_ELEMENT_BYTES = 32;

/**
 * Absolute ceiling on the number of encrypted elements an inbound PSI frame
 * may DECLARE, enforced by a wire-format scan BEFORE deserialization (see
 * {@link countDeclaredPsiElements} in connection/psiElementScan.ts, called at
 * the participant.ts decode call sites). The amplification it closes, its
 * derivation from the frame cap, and what it bounds the worst-case
 * deserialize allocation to: docs/spec/PROTOCOL.md ("The single-pass dataset
 * ceiling") and docs/spec/CHANNEL_SECURITY.md ("Single-pass per-exchange
 * cap"). Fixed, not operator-configurable, for the same reason as the
 * frame-size bound.
 */
export const MAX_PSI_DECODE_ELEMENTS = Math.floor(
  MAX_FRAME_SIZE_BYTES / MIN_ENCODED_ELEMENT_BYTES,
);

/**
 * The single-pass dataset ceiling, expressed as a per-party budget on the value
 * slot count `effectiveKeyCount * recordCount` (NOT a bare row count). It is
 * the real ceiling; the byte cap below is a tightening derived from the same
 * quantity. Its value, the measurement it was derived from, what the terms
 * "cell" and "value slot" mean, and the constraint that binds it are in
 * docs/spec/PROTOCOL.md ("The single-pass dataset ceiling: receiver memory and
 * masking compute").
 *
 * Fixed, NOT operator-configurable: a configurable maximum reintroduces the
 * memory-exhaustion denial of service the bound exists for. Raising it means
 * re-deriving it from a fresh measurement against the conditions that spec
 * section states, never editing this literal alone.
 */
export const MAX_SINGLE_PASS_CELLS = 3_000_000;

/**
 * The explicit upper bound on a decoded record count, enforced at the wire
 * schema (`recordCountField` on the terms-exchange envelope in
 * protocolSetup.ts). It makes the exact-integer-product dependency of
 * {@link singlePassDatasetExceedsCap} and {@link psiElementBounds} a check
 * rather than a silent reliance on the schema's `.int()` safe-integer ceiling.
 * The headroom this value leaves, and why the `frameSize.test.ts` invariant
 * pins it against the EFFECTIVE key count, are in docs/spec/PROTOCOL.md ("The
 * exact-integer precision of the cell-count gate is a check").
 */
export const MAX_RECORD_COUNT = 1_000_000_000_000;

// The per-slot, per-cell, and fixed byte weights the reply cap is derived
// from, tabulated with what each term covers in docs/spec/PROTOCOL.md ("The
// single-pass dataset ceiling: receiver memory and masking compute"). Each is
// an UPPER bound on the real serialized cost: the derived value is a read
// gate, so undershooting would reject a legitimate frame while overshooting
// only loosens defense in depth. The byte layout they weigh is
// `encodeSinglePassReply` in link.ts.
const SINGLE_PASS_BYTES_PER_MASKED_VALUE = 40;
const SINGLE_PASS_BYTES_PER_INDEX_WORD = 4;
const SINGLE_PASS_REPLY_OVERHEAD_BYTES = 256;

/**
 * One party's authenticated single-pass size, as the two quantities every derived
 * bound below is a function of: the `effectiveKeyCount` both parties derive from
 * the agreed terms (the sum of the per-key declared widths) and the party's
 * declared record count, included in the terms exchange. Their product is the
 * party's **value slot** count -- the worst-case upper bound on its distinct
 * linkage-key value count.
 *
 * Named rather than positional because both parties compute every bound below from
 * the SAME pair in the SAME roles, and a swapped sender/receiver pair silently
 * yields a different cap on one side (the sender sends the index table, so the
 * two are not interchangeable).
 */
export interface SinglePassPartySize {
  /**
   * The effective key count the agreed terms declare (`declaredEffectiveKeyCount`),
   * the same number on both parties.
   */
  readonly effectiveKeyCount: number;
  /**
   * The party's declared record count -- its row count times its own local
   * fan-out factor -- as included in the terms exchange.
   */
  readonly recordCount: number;
}

/**
 * One party's **value slot** count: its declared effective key count times its
 * record count. This is the exact product every gate below weighs, exported so an
 * operator-facing diagnosis states the quantity the gate multiplied rather than a
 * neighbouring pair (the agreed key count and the record counts) whose product can
 * sit under a ceiling the same exchange exceeds.
 */
export function valueSlots(party: SinglePassPartySize): number {
  return party.effectiveKeyCount * party.recordCount;
}

/**
 * Does this party fan out -- is its declared effective key count above the agreed
 * key count? The single discriminant every layout-dependent decision reads: the
 * sender's index-table encoder and the receiver's decoder pick (link.ts), the
 * ragged count-prefix term of {@link singlePassReplyByteCap} below, and whether
 * the over-ceiling guidance offers removing a fan-out as a remedy.
 *
 * Written once because a divergence between those is not a cosmetic one: a read
 * gate sized for the fixed-width layout while the frame holds the ragged one
 * rejects a legitimate reply mid-exchange, and the opposite pairing admits a frame
 * the decoder then reads under the wrong shape. The party is passed as an object
 * rather than a second bare count so the two numbers cannot be transposed at a
 * call site.
 */
export function partyFansOut(
  agreedKeyCount: number,
  party: Pick<SinglePassPartySize, "effectiveKeyCount">,
): boolean {
  return party.effectiveKeyCount > agreedKeyCount;
}

/**
 * Does a single party's own dataset alone exceed the single-pass ceiling? True
 * when `effectiveKeyCount * recordCount > MAX_SINGLE_PASS_CELLS`. This is the
 * coarse one-party gate the {@link prepareForExchange} pre-flight uses, when only
 * this party's row count is known: if a party's own contribution already exceeds
 * the budget, single-pass cannot succeed whatever the partner's size. The
 * two-party check production runs post-handshake, once both counts are exchanged,
 * is {@link singlePassCeilingBreach}; {@link singlePassExchangeExceedsCap} is the
 * boolean convenience over it.
 *
 * A party declaring no fan-out passes its plain key count, for which this is the
 * cell-count gate unchanged.
 */
export function singlePassDatasetExceedsCap(
  effectiveKeyCount: number,
  recordCount: number,
): boolean {
  return effectiveKeyCount * recordCount > MAX_SINGLE_PASS_CELLS;
}

/**
 * What a party whose own declared size reached the ceiling can do about it, as
 * both over-ceiling refusals state it -- the coarse prepare-time pre-flight and
 * the authoritative two-party gate -- so the advance notice and the refusal that
 * follows it cannot offer different remedies.
 *
 * The record count and the batching are that party's own to change. The linkage
 * keys are not: they are an agreed term, held identically by both sides, so an
 * acceptor cannot narrow a set its invitation held and an inviter's own
 * narrowing is terms the partner has to run under. Naming that as a
 * renegotiation rather than as an edit is what keeps the remedy true on the seat
 * that did not choose the keys.
 */
export const SINGLE_PASS_LOCAL_REMEDY =
  "Reduce the record count or split the dataset into smaller batches; the " +
  "linkage keys are an agreed term, so declaring fewer of them takes new " +
  "terms agreed with the partner.";

/**
 * Which side of an exchange breached the single-pass ceiling, named from the point
 * of view of the party asking. See {@link singlePassCeilingBreach}.
 */
export type SinglePassCeilingBreach = "local" | "partner" | "both";

/**
 * Which side of an exchange breached the single-pass ceiling, as the two parties
 * named from the point of view of the party asking: `"local"` when only the asking
 * party's own value slot count is over the budget, `"partner"` when only the other
 * party's is, `"both"` when each is, and `undefined` when the exchange is within
 * it.
 *
 * The two parties reach MIRRORED verdicts, never conflicting ones: the per-party
 * predicate is {@link singlePassDatasetExceedsCap} over authenticated session state
 * both hold, so a `"partner"` breach on one side is a `"local"` breach on the
 * other and `"both"`/`undefined` are the same on each. That is what lets an
 * over-ceiling diagnosis name the side whose declaration reached the ceiling while
 * the abort itself stays symmetric -- {@link singlePassExchangeExceedsCap} is this
 * verdict with the orientation dropped.
 */
export function singlePassCeilingBreach(
  local: SinglePassPartySize,
  partner: SinglePassPartySize,
): SinglePassCeilingBreach | undefined {
  const localOver = singlePassDatasetExceedsCap(
    local.effectiveKeyCount,
    local.recordCount,
  );
  const partnerOver = singlePassDatasetExceedsCap(
    partner.effectiveKeyCount,
    partner.recordCount,
  );
  if (localOver && partnerOver) return "both";
  if (localOver) return "local";
  if (partnerOver) return "partner";
  return undefined;
}

/**
 * Does this exchange exceed the single-pass ceiling? True when EITHER party's
 * value slot count exceeds {@link MAX_SINGLE_PASS_CELLS}.
 * Computed identically on both parties from authenticated session state alone --
 * the two record counts and the two declared effective key counts exchanged over
 * the encrypted channel after the handshake -- so both reach the same verdict and
 * abort in lockstep without either reading the inbound frame. Reads no bytes,
 * name, or transport-listed size from the inbound file.
 */
export function singlePassExchangeExceedsCap(
  sender: SinglePassPartySize,
  receiver: SinglePassPartySize,
): boolean {
  return singlePassCeilingBreach(sender, receiver) !== undefined;
}

/**
 * The accepted byte size of the single-pass reply frame, derived deterministically
 * from the agreed key count and the two parties' authenticated sizes -- identical
 * on both parties. It is the value the receiver's transport read gate enforces
 * (replacing the static {@link MAX_FRAME_SIZE_BYTES} for that one read) and the
 * value the sender's send-time check compares its built reply against, so the two
 * become one computation.
 *
 * The term order below, its coefficients, and the exact integer arithmetic are
 * fixed so two independent implementations produce the same value; they are
 * specified in docs/spec/PROTOCOL.md ("The single-pass dataset ceiling:
 * receiver memory and masking compute"), which also states why the
 * candidate-count prefix term is charged unconditionally.
 *
 * Call only for an in-cap exchange, guarded with
 * {@link singlePassCeilingBreach} or its boolean convenience
 * {@link singlePassExchangeExceedsCap}. The per-transport clamp the read gate
 * applies -- min with {@link MAX_FRAME_SIZE_BYTES} for file-sync, with
 * `MAX_WEBRTC_FRAME_BYTES` (connection/binaryPackBounds.ts) for WebRTC -- is a
 * safety check that does not bind at the current ceiling.
 */
export function singlePassReplyByteCap(
  keyCount: number,
  sender: SinglePassPartySize,
  receiver: SinglePassPartySize,
): number {
  return (
    (SINGLE_PASS_BYTES_PER_MASKED_VALUE + SINGLE_PASS_BYTES_PER_INDEX_WORD) *
      valueSlots(sender) +
    SINGLE_PASS_BYTES_PER_MASKED_VALUE * valueSlots(receiver) +
    SINGLE_PASS_BYTES_PER_INDEX_WORD * keyCount * sender.recordCount +
    SINGLE_PASS_REPLY_OVERHEAD_BYTES
  );
}

/**
 * Per-message upper bounds on the encrypted-element count a received PSI frame may
 * declare, one field per message kind a party can receive. Derived only from the
 * two parties' authenticated sizes -- never from the inbound frame's own bytes --
 * and enforced at the `deserializeBinary` call site in participant.ts before
 * the element list drives curve-point materialization in the library. See
 * {@link psiElementBounds}.
 */
export interface PsiElementBounds {
  /** Max elements a received server setup (the sender's masked set) may declare. */
  readonly setup: number;
  /** Max elements a received request (the receiver's masked set) may declare. */
  readonly request: number;
  /**
   * Max elements a received response (the sender's re-encryption of the receiver's
   * request, so it holds the receiver's element count) may declare.
   */
  readonly response: number;
}

/**
 * Derive the per-message element-count bounds from authenticated session state:
 * the two exchanged record counts and the two declared effective key counts. Both
 * parties compute the SAME bounds, and each enforces only the ones for the messages
 * it receives (the sender checks the request; the receiver checks the setup and
 * response).
 *
 * The bound is the same value slot count the single-pass frame cap sizes against --
 * the worst-case upper bound on a party's distinct-value count, reached only when
 * every slot holds a value seen nowhere else -- so it upper-bounds any legitimate
 * frame and never rejects one. It applies to both the single-pass and cascade
 * decode paths: single-pass pools each party's distinct values across all keys (at
 * most its slot count), and the cascade sends one key's values per round (at most
 * `recordCount`, well within the same bound).
 *
 * The setup holds the SENDER's masked set; the request holds the RECEIVER's
 * masked set; the response re-encrypts that request, so it holds the receiver's
 * count too. Inputs are non-negative integers well below 2^53 (record counts are
 * bounded by {@link MAX_RECORD_COUNT}, effective key counts by
 * MAX_EFFECTIVE_KEY_COUNT), so the products are exact.
 */
export function psiElementBounds(
  sender: SinglePassPartySize,
  receiver: SinglePassPartySize,
): PsiElementBounds {
  return {
    setup: valueSlots(sender),
    request: valueSlots(receiver),
    response: valueSlots(receiver),
  };
}
