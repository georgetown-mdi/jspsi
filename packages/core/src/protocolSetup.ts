import * as z from "zod";

import type { HandshakeRole, PsiRole } from "./types";
import type { LinkageTerms, Output } from "./config/linkageTerms";
import type { PresentedHostKey } from "./connection/fileSyncConnection";
import {
  MAX_LINKAGE_ENTRIES,
  parseLinkageTerms,
  validateCompatibility,
} from "./config/linkageTerms";
import { SHARED_SECRET_REGEX } from "./config/connection";
import { MAX_RECORD_COUNT } from "./connection/frameSize";
import {
  declaredEffectiveKeyCount,
  MAX_KEY_CANDIDATES_PER_ROW,
} from "./fanOutFunctions";
import { randomBytes, toBase64Url } from "./utils/crypto";
import { describeDecodeError } from "./utils/describeDecodeError";
import { boundedArray } from "./utils/boundedArray";
import {
  ConnectionError,
  receiveParsed,
  parseOrProtocolError,
  type MessageConnection,
} from "./connection/messageConnection";

// --- Message schemas ---------------------------------------------------------

// Generous upper bound on the COUNT of partner-supplied abort reasons. A real
// abort carries one reason per failed compatibility check (validateCompatibility
// emits a handful) or a single parse-failure string; 256 is far above any real
// list. The bound is the same class as the linkage-terms count bounds: a partner
// can send abortReasons off the post-handshake frame (MAX_FRAME_SIZE_BYTES), and
// a flat array of millions of invalid entries would otherwise make Zod throw
// `RangeError: Invalid string length` building its error string from one issue
// per entry. boundedArray gates the count before per-element validation.
const MAX_ABORT_REASONS = 256;

// The optional `hostKey` advertisement rides the terms exchange so each party
// advertises the SFTP host key it observed (fingerprint + key type) to the
// other, for cross-party reconciliation against a one-sided interception
// (see reconcileHostKeyFingerprints). Like `save`, it rides the
// terms exchange rather than a dedicated round-trip because that is the one
// bidirectional exchange both parties always perform, and -- being inside the
// authenticated, AEAD-wrapped post-handshake channel -- the advertised value
// cannot be forged by an unauthenticated party. It is omitted entirely by a
// party that observed no host key (a file-drop or proxy path, or an
// unauthenticated exchange that never threads the observed key in), so a
// one-sided absence reconciles to no divergence. The field bounds are
// defense-in-depth, far above any real value (a canonical SHA256 fingerprint is
// 50 chars; a key type such as "ecdsa-sha2-nistp521" is under 30): they cap a
// hostile partner's advertised values, mirroring the invitation decoder's
// per-field size bounds, and the receiver sanitizes both before display.
//
// hostKeyField is fail-soft AND self-classifying. A malformed or over-bound
// advertisement is read as absent rather than aborting the linkage, UNLIKE the
// rest of the terms message and unlike `save`. This is deliberate and specific
// to this field's contract: the reconciliation is a non-fatal advisory that only
// warns even on a genuine fingerprint divergence (see reconcileHostKeyFingerprints),
// so a malformed advertisement -- reachable only from a non-conforming or
// future-versioned peer, since the field rides the AEAD and an unauthenticated
// party cannot set it -- must degrade to "no reconciliation" rather than become a
// terms-exchange abort that blames the (valid) linkage terms. It never affects
// agreement, so dropping a bad value is the correct, contract-preserving outcome.
//
// The raw field is parsed and tagged rather than collapsed to one `undefined`:
// an absent field and a well-formed value both report `malformed: false` (with
// `value` set only in the latter), while a present-but-invalid or over-bound
// value reports `malformed: true` with no `value`. That keeps the signal an
// operator needs to tell a benign no-host-key partner (one that observed none,
// on a file-drop or proxy path) from a non-conforming one: a malformed
// advertisement yields no usable host key and never aborts, but the malformed
// signal survives for the CLI to log at debug (see
// TermsExchangeResult.partnerHostKeyMalformed).
const hostKeyAdvertisement = z.object({
  fingerprint: z.string().max(100),
  keyType: z.string().max(64),
});

/**
 * Classification of the partner's fail-soft `hostKey` advertisement after
 * parsing: `value` is the validated host key, present only when the field was on
 * the wire and well-formed; `malformed` is `true` only when the field was
 * present but failed validation. An absent field and a well-formed value both
 * report `malformed: false`, and `value` is `undefined` whenever `malformed` is
 * `true`.
 */
interface HostKeyAdvertisementParse {
  value: PresentedHostKey | undefined;
  malformed: boolean;
}

const hostKeyField = z
  .unknown()
  .optional()
  .transform((raw): HostKeyAdvertisementParse => {
    // No advertisement to classify: an omitted field arrives as `undefined`, and
    // an explicit `null` (JSON's representation of "no value") is treated the
    // same. Both are the benign no-host-key case, not a malformed attempt to
    // advertise one -- a conforming party that observed no host key omits the
    // field entirely (see the send-side spread in exchangeTerms), so neither
    // shape carries a host key an operator should be warned about.
    if (raw === undefined || raw === null)
      return { value: undefined, malformed: false };
    // Present and non-null but failing validation (wrong shape or over-bound) is
    // a genuine malformed advertisement, reachable only from a non-conforming or
    // future-versioned peer.
    const parsed = hostKeyAdvertisement.safeParse(raw);
    return parsed.success
      ? { value: parsed.data, malformed: false }
      : { value: undefined, malformed: true };
  });

// Each party's raw dataset record count rides the terms-exchange envelope, beside
// `linkageTerms` (like `save` and `hostKey`), so both parties learn each other's
// count on the one bidirectional round-trip they always perform -- there is no
// separate count exchange. It is per-party, per-run role/bounds metadata, NOT a
// linkage term: it stays out of the canonicalized terms and the agreed-terms hash
// (which are built from `linkageTerms` alone). Both counts are consumed by two
// things on every exchange: the both-output role decision (see resolveRole /
// pickRole) and the single-pass frame cap and PSI element bounds (frameSize.ts,
// psiElementBounds), which derive from both counts regardless of output split.
//
// The `.max(MAX_RECORD_COUNT)` bound is load-bearing beyond input hygiene: it
// keeps the decoded count small enough that the cell-count gate's `keyCount *
// recordCount` product stays exact (below 2^53), rather than resting silently on
// the `.int()` safe-integer ceiling. A count above the bound is a clean
// `protocol` ConnectionError at decode. See MAX_RECORD_COUNT in
// connection/frameSize.ts.
/** @internal exported for the record-count decode-bound test. */
export const recordCountField = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_RECORD_COUNT);

// The largest effective key count any conforming party can declare: every one of
// the MAX_LINKAGE_ENTRIES keys the terms schema admits fanning out to the full
// MAX_KEY_CANDIDATES_PER_ROW width. It is the outer safety bound alone -- what
// keeps a pathological advertisement out of the products the derived bounds
// multiply, exactly as MAX_RECORD_COUNT does for the record count. The checks that
// actually bind are keyCount-relative and cannot run until the terms are agreed,
// so the schema deliberately admits anything they will decide (0 included) and
// assertPartnerEffectiveKeyCount refuses it with the classified protocol error
// rather than a decode failure blaming the linkage terms.
const MAX_EFFECTIVE_KEY_COUNT =
  MAX_LINKAGE_ENTRIES * MAX_KEY_CANDIDATES_PER_ROW;

// Each party's declared effective key count rides the terms-exchange envelope
// beside `recordCount`: the sum, over the agreed linkage keys, of the candidate
// factor this party declares for each -- MAX_KEY_CANDIDATES_PER_ROW for a key some
// declared fan-out produces values for, 1 otherwise (declaredEffectiveKeyCount in
// fanOutFunctions.ts). Multiplied by the party's record count it is that party's
// value slot count, the authenticated upper bound on its distinct linkage-key value
// count, and it replaces `keyCount * recordCount` in every derived single-pass
// bound (frameSize.ts). A fan-out-free party advertises its plain key count, so
// every fan-out-free bound is unchanged.
//
// It discloses a CONFIGURATION fact (this party declares a fan-out on some keys),
// not a data fact: it is the same number whether or not any row actually splits.
// Like `recordCount` it is per-party, per-run bounds metadata carried on the
// envelope and never inside `linkageTerms`, so it does not enter the
// canonical/agreed-terms hash.
//
// `.optional()` in the SCHEMA because message 2 doubles as the responder's abort
// frame, which carries no role metadata at all (the same reason `recordCount` is
// optional there). It is not optional on a frame that proceeds: the protocol-version
// reconcile admits only a partner advertising this build's exact version, and this
// build always declares a count beside it, so an omission there is a non-conforming
// peer. assertPartnerEffectiveKeyCount refuses it with the classified protocol error
// -- naming the count rather than blaming the linkage terms with a decode failure --
// exactly as it refuses an inadmissible value.
const effectiveKeyCountField = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_EFFECTIVE_KEY_COUNT)
  .optional();

// The psilink exchange-protocol version, advertised by both parties on the terms
// exchange and reconciled fail-closed: a partner that advertises anything other
// than this build's exact version is on an incompatible build, so the exchange
// aborts with an actionable "run the same version" diagnosis before the linkage
// rounds begin, rather than failing later with a cryptic frame-parse error.
// It rides the terms exchange -- the one bidirectional round-trip
// both parties always perform, carrying `linkageTerms`, `recordCount`, `save`,
// and `hostKey` beside it -- so the check adds no new round-trip; on the
// authenticated path it rides the AEAD channel and cannot be forged.
//
// This is a build-level WIRE/PROTOCOL compatibility marker, bumped only on a
// wire-incompatible protocol change -- distinct from the operator-authored
// linkage-terms `version` (compared for equality between the parties' authored
// values, see docs/spec/PROTOCOL.md) and from the file-sync MESSAGE_ENVELOPE_VERSION
// byte (the transport frame format, see fileSyncConnection.ts). The reconcile is
// fail-closed (matching the mode-flag fast-fail precedent), NOT
// fail-soft like the host-key advisory: anything that is not our exact version
// aborts. That covers a PRESENT value -- a different integer, or a garbled/
// wrong-typed value from a non-conforming or corrupted peer, which is why the field
// is read as `unknown` rather than a typed number (a typed schema would bury such a
// value in a generic parse error instead of naming the version skew) -- and equally
// a partner advertising NO readable version at all. Pre-publication no build
// predating this field is deployed, so an unversioned advertisement identifies a
// non-conforming peer rather than an older psilink, and admitting one would leave a
// leg of this reconcile open. The durable, forward-looking guarantee is that a
// partner not running this exact build fails cleanly before the linkage rounds
// begin. That guarantee does not rest on a future bump keeping the envelope's fields
// backward-parseable: the version is read from a lenient probe BEFORE the strict
// parse (see protocolVersionProbe), so a reshaped sibling field cannot throw the
// parse before the version is read and bury the skew diagnosis. The version is
// read independently of the rest of the envelope on both message paths.
// Held at 1: pre-publication there are no deployed peers for this reconcile to
// hold apart, so a wire-format delta -- including the ragged single-pass index
// table a fan-out configuration produces -- ships within version 1 rather than
// bumping it, and a bump is reserved for the first wire-incompatible change made
// once the software is published (docs/spec/PROTOCOL.md, Wire-format deltas).
/** @internal exported for the protocol-version reconcile tests. */
export const PROTOCOL_VERSION = 1;

/**
 * The operator-facing diagnosis surfaced -- and sent to the partner as the abort
 * reason -- when a partner advertises anything but this build's exact
 * {@link PROTOCOL_VERSION}, an unreadable or absent advertisement included. It
 * reads correctly from either side: each party names the other as the one on
 * the incompatible version, and both conclude they must run the same build. It is
 * a fixed literal, carrying nothing the partner authored.
 *
 * @internal exported for the protocol-version reconcile tests.
 */
export const PROTOCOL_VERSION_MISMATCH_MESSAGE =
  "the partner is running an incompatible psilink version; both parties must " +
  "run the same version";

// The optional `save` flag rides the terms exchange so each party advertises
// its zero-setup `--save` intent to the other on the one round-trip both sides
// always perform (see exchangeTerms). It is omitted entirely outside the
// zero-setup save flow -- recurring/authenticated exchanges leave it unset, so
// their on-wire terms messages are unchanged -- and a peer that omits it is read
// as `save: false`. It is advisory metadata, not part of terms agreement, so a
// mismatch never aborts: one party may save while the other does not.
//
// The optional `disclosesPayload` flag rides the terms exchange so each party
// advertises, before linkage, whether it will disclose payload to a partner
// entitled to output -- i.e. whether its own metadata has any column disclosed to
// the partner (isDisclosedToPartner). It is per-party role metadata carried on the
// envelope beside `linkageTerms`, never inside them, so it does not enter the
// canonical/agreed-terms hash. Its one consumer is the single-pass
// association-table withhold gate: the receiver withholds the sender's
// association-table half only when the sender is a non-receiving helper that also
// discloses no payload, and the sender's own flag is what tells the receiver (which
// cannot infer it -- payload disclosure is per-party-local and lazy) that the
// helper needs nothing back. Both parties read the SENDER's advertised flag, so the
// withhold decision is derived from symmetric authenticated session state and they
// stay in lockstep (see linkViaSinglePassPSI and withholdsSenderAssociationTable in
// link.ts). Advertising it leaks nothing new: it is consulted only for a helper
// disclosing payload to a partner that is entitled to receive that payload anyway.
//
// It is `.optional()` in the schema so it sits beside `save` as an omit-able
// envelope field, but the production caller (runExchange) always passes a definite
// boolean, so a terms message always carries it -- and since nothing has shipped,
// both parties always run this same build and always send it, so the withhold
// decision is always computed from a value both sides advertised. The gate
// nonetheless defaults an absent value to "discloses payload" (do not withhold)
// defensively, so a non-conforming peer that omits it can never drive the blind
// path against a helper that actually needs its table.
//
// `recordCount` is required on message 1: it is always the initiator's opening
// terms, never an abort, so a conforming initiator always carries the count and a
// missing one is a clean decode failure at parse (an invariant made a check
// rather than an unenforced assumption).
const termsMessage = z.object({
  linkageTerms: z.unknown(),
  recordCount: recordCountField,
  effectiveKeyCount: effectiveKeyCountField,
  // Read as `unknown`, not a typed number, so a PRESENT-but-non-matching value
  // (a foreign integer, or a garbled/wrong-typed value from a non-conforming or
  // corrupted peer) reconciles to the actionable version mismatch rather than
  // throwing a generic parse error that buries the real cause. `.optional()` for
  // the same reason: the reconcile refuses an absent advertisement itself, ahead
  // of this parse. See PROTOCOL_VERSION and reconcileProtocolVersion.
  protocolVersion: z.unknown().optional(),
  save: z.boolean().optional(),
  disclosesPayload: z.boolean().optional(),
  hostKey: hostKeyField,
});

const abortReasonsField = boundedArray(
  z.string(),
  MAX_ABORT_REASONS,
  `abortReasons must not exceed ${MAX_ABORT_REASONS} entries`,
).optional();

// `recordCount` is optional here (unlike message 1) because this frame doubles as
// the responder's abort frame, which carries no role metadata -- the same reason
// `save` is not spread onto an abort (see sendAbort). On a `proceed` decision the
// initiator enforces its presence; on an `abort` the exchange ends before the
// count is ever read.
const termsWithDecisionMessage = z.object({
  linkageTerms: z.unknown(),
  decision: z.enum(["proceed", "abort"]),
  abortReasons: abortReasonsField,
  recordCount: recordCountField.optional(),
  effectiveKeyCount: effectiveKeyCountField,
  protocolVersion: z.unknown().optional(), // read as unknown; see termsMessage
  save: z.boolean().optional(),
  disclosesPayload: z.boolean().optional(), // per-party payload-intent; see termsMessage
  hostKey: hostKeyField,
});

const decisionMessage = z.object({
  decision: z.enum(["proceed", "abort"]),
  abortReasons: abortReasonsField,
});

/**
 * Every envelope field each terms-exchange slot admits, read off the schemas
 * above rather than restated, so a field added to one appears here with no second
 * edit. The conformance vectors pin the frames each slot actually emits and hold
 * their union to this, which is what keeps a newly added field from riding the
 * wire with nothing pinning it.
 *
 * @internal exported for the terms-envelope conformance vectors.
 */
export const TERMS_ENVELOPE_FIELDS: Readonly<Record<string, Array<string>>> = {
  "message 1": Object.keys(termsMessage.shape),
  "message 2": Object.keys(termsWithDecisionMessage.shape),
  "message 3": Object.keys(decisionMessage.shape),
};

// The dedicated frame that carries a freshly generated shared secret from the
// initiator to the responder during a both-parties `--save` bootstrap (see
// exchangeBootstrapSecret). The token format is pinned to SHARED_SECRET_REGEX -- a
// base64url-encoded 32-byte value -- so it is byte-for-byte the persistent
// secret that authenticateConnection rotates to and saveKeyFile persists; a
// malformed value is a `protocol` ConnectionError on the responder.
const sharedSecretMessage = z.object({
  sharedSecret: z.string().regex(SHARED_SECRET_REGEX),
});

// --- Terms exchange ----------------------------------------------------------

export interface TermsExchangeResult {
  partnerTerms: LinkageTerms;
  /**
   * Non-fatal observations from this terms exchange, for the caller to surface at
   * the run boundary (runExchange hands each to its `onWarning`, which the CLI
   * puts on both stderr and the machine-readable warning event). Display text,
   * carrying no `Error` of its own: any partner-controlled fragment is escaped
   * where it is composed. Currently the terms-compatibility warnings
   * (`validateCompatibility`) and the partner-width notice
   * ({@link partnerWidthAboveAgreedNotice}).
   */
  warnings: string[];
  /**
   * The partner's raw dataset record count, read off the terms message envelope
   * (beside its `linkageTerms`, not inside them). Feeds {@link resolveRole} and
   * the single-pass PSI element bounds; because it rides the terms exchange, no
   * separate count exchange is needed. Always present on a successful exchange (a
   * partner that omits it fails the exchange as a non-conforming peer).
   */
  partnerRecordCount: number;
  /**
   * The partner's declared effective key count, read off the terms message
   * envelope beside its record count and validated against the agreed terms (see
   * {@link assertPartnerEffectiveKeyCount}). With the partner's record count it is
   * the partner's value slot count, the authenticated input every derived
   * single-pass bound reads (see `psiElementBounds` and `singlePassReplyByteCap`
   * in connection/frameSize.ts). Always the partner's own advertised value: a
   * partner that omits it on a frame that proceeds fails the exchange as a
   * non-conforming peer, so nothing is ever defaulted here.
   */
  partnerEffectiveKeyCount: number;
  /**
   * Whether the partner advertised zero-setup `--save` intent on this terms
   * exchange. `false` outside the save flow (the partner omitted the field).
   * The caller uses it to decide whether to establish a shared secret and which
   * post-exchange notice to emit; it never affects whether the terms are agreed.
   */
  partnerSaveIntent: boolean;
  /**
   * Whether the partner advertised that it will disclose payload (its metadata
   * has a column disclosed to us) on this terms exchange. `undefined` when the
   * partner omitted the field -- a peer that does not advertise it, which the
   * single-pass withhold gate treats as "discloses payload" (do not withhold), so
   * a missing advertisement never blinds a helper that needs its table. Consumed
   * only by that gate (see {@link resolveRole}'s caller in exchange.ts and
   * `withholdsSenderAssociationTable` in link.ts); it never affects agreement.
   */
  partnerDisclosesPayload: boolean | undefined;
  /**
   * The SFTP host key the partner advertised observing on its side of the
   * rendezvous (fingerprint + key type), or `undefined` when the partner
   * observed none (a file-drop or proxy path, or an exchange that did not thread
   * an observed key in) or advertised a malformed/over-bound value (read as
   * absent; see the fail-soft `hostKeyField` schema). The caller reconciles it
   * against its own observed key (see {@link reconcileHostKeyFingerprints}); it
   * never affects agreement. When the value was dropped as malformed,
   * {@link partnerHostKeyMalformed} is `true`, distinguishing that case from a
   * genuine absence.
   */
  partnerHostKey: PresentedHostKey | undefined;
  /**
   * Whether the partner's host-key advertisement was present on the wire but
   * failed the fail-soft validation (present-but-malformed), as distinct from
   * being genuinely absent. `true` only for a present-but-rejected value; `false`
   * both when the partner advertised a well-formed key and when it advertised
   * none at all. {@link partnerHostKey} is `undefined` whenever this is `true`
   * (the fail-soft drop). It is a diagnostic signal only -- a malformed
   * advertisement is reachable only from a non-conforming or future-versioned
   * peer, never affects agreement, and never aborts the exchange -- so a caller
   * logs it at a low level (the CLI logs it at debug; see apps/cli/src/protocol.ts).
   */
  partnerHostKeyMalformed: boolean;
}

/**
 * Validate the partner's advertised effective key count against the AGREED terms
 * and resolve it to the number every derived single-pass bound reads.
 *
 * Called only once the terms are agreed, which is the first point both parties'
 * linkage keys are known to be identical -- so both derive the same `keyCount` and
 * the same floor, and each holds the other to the value the other holds it to.
 * The checks (docs/spec/PROTOCOL.md, Wire-format deltas):
 *
 * - nothing above `keyCount` at all unless the agreed `linkageStrategy` is
 *   `single-pass`: an advertisement above the plain key count declares a fan-out,
 *   and fan-out matching is specified for single-pass alone
 *   (docs/spec/PROTOCOL.md, Fan-out runs under single-pass only), so this is that
 *   rule's run-boundary half -- a symmetric function of the agreed pair, which
 *   both parties refuse in lockstep. It is checked ahead of the shape checks
 *   below because on such an exchange no advertisement above the plain count is
 *   admissible whatever its shape. A count-only exchange needs no separate line:
 *   `psi-c` terms are refused off `cascade` by the terms schema itself;
 * - `keyCount <= effectiveKeyCount <= keyCount * MAX_KEY_CANDIDATES_PER_ROW`, the
 *   range a sum of per-key factors of 1 or 20 can occupy;
 * - `effectiveKeyCount - keyCount` divisible by `MAX_KEY_CANDIDATES_PER_ROW - 1`,
 *   so the implied count of fan-out keys is a whole number in `0 .. keyCount`;
 * - at least the floor the agreed terms imply -- the value derived from the
 *   partner's element transforms alone, which both parties can see. A party may
 *   advertise MORE than that floor, because its own local standardization can fan
 *   out a field the terms do not show; that width is accepted here and surfaced to
 *   the operator by {@link partnerWidthAboveAgreedNotice}.
 *
 * An advertisement failing any of them is a protocol violation, like every other
 * partner-supplied count: a `"protocol"` {@link ConnectionError}, and the caller
 * best-effort sends the partner the abort so neither side waits on a frame the
 * other will not send.
 *
 * An ABSENT advertisement draws the same refusal. Every partner reaching this
 * check advertised this build's exact protocol version (see
 * {@link reconcileProtocolVersion}), and this build always declares a count beside
 * that version, so an omission is a non-conforming peer rather than an older
 * build -- and there is no width its data can be assumed to obey.
 */
function assertPartnerEffectiveKeyCount(
  advertised: number | undefined,
  agreedTerms: LinkageTerms,
): number {
  const keyCount = agreedTerms.linkageKeys.length;
  if (advertised === undefined)
    throw new ConnectionError(
      "partner advertised no effective key count against " +
        `${keyCount} agreed linkage key(s): a partner on this protocol version ` +
        "always declares one",
      "protocol",
    );
  const refuse = (detail: string): never => {
    throw new ConnectionError(
      `partner advertised an unusable effective key count (${advertised} ` +
        `against ${keyCount} agreed linkage key(s)): ${detail}`,
      "protocol",
    );
  };
  if (advertised > keyCount && agreedTerms.linkageStrategy !== "single-pass")
    refuse(
      `a fan-out advertisement on a ${agreedTerms.linkageStrategy} exchange, ` +
        "which matches one value per record",
    );
  if (
    advertised < keyCount ||
    advertised > keyCount * MAX_KEY_CANDIDATES_PER_ROW
  )
    refuse("outside the range a per-key candidate factor can sum to");
  if ((advertised - keyCount) % (MAX_KEY_CANDIDATES_PER_ROW - 1) !== 0)
    refuse("implies a fractional number of fan-out keys");
  if (advertised < declaredEffectiveKeyCount(agreedTerms))
    refuse("below the floor the agreed linkage keys' own transforms imply");
  return advertised;
}

/**
 * The run-boundary notice for a partner running WIDER than the agreed terms alone
 * imply, or `undefined` for one running at exactly the width they imply.
 *
 * The agreed terms fix a floor rather than a width (see
 * {@link assertPartnerEffectiveKeyCount}): a partner's own standardization can fan
 * out a field the terms do not show, so the terms a consent surface displayed can
 * imply one width while the partner legitimately runs at up to
 * `MAX_KEY_CANDIDATES_PER_ROW` times it. Both widths are authenticated session
 * state, and every derived single-pass bound -- and this party's share of the
 * dataset ceiling -- is computed from the ADVERTISED one, so an operator who saw
 * only the terms is told when the two differ.
 *
 * Warn-don't-block: the advertisement is admissible, so this rides the terms
 * warnings the caller surfaces at the run boundary
 * ({@link TermsExchangeResult.warnings}) and never aborts. It interpolates the two
 * integers and no partner-authored text.
 *
 * `agreedTerms` is THIS party's own copy. The compatibility check has already
 * proven the two copies canonically identical -- so the floor here is the same one
 * {@link assertPartnerEffectiveKeyCount} held the advertisement to -- and reading
 * it locally keeps the number the operator is shown as the width THEIR terms
 * imply, rather than one recomputed from the frame that prompted the notice.
 *
 * Held under the per-value display cap (`DEFAULT_MAX_DISPLAY_LENGTH`, 256) at its
 * widest admissible pair of counts: 5,120 advertised against the 5,101 the agreed
 * terms imply when all but one of MAX_LINKAGE_ENTRIES keys declares a fan-out of
 * its own -- the longest rendering, since both counts reach four digits and no
 * admissible pair carries more. That keeps it one readable line rather than
 * bounding its delivery: both CLI sinks carry a terms warning at the
 * composed-warning budget (`WARNING_MESSAGE_MAX_DISPLAY_LENGTH`), which this sits
 * an order of magnitude inside.
 */
function partnerWidthAboveAgreedNotice(
  partnerEffectiveKeyCount: number,
  agreedTerms: LinkageTerms,
): string | undefined {
  const agreedWidth = declaredEffectiveKeyCount(agreedTerms);
  if (partnerEffectiveKeyCount <= agreedWidth) return undefined;
  return (
    "effective key count above the agreed terms: partner advertised " +
    `${partnerEffectiveKeyCount} value slot(s) per record against the ` +
    `${agreedWidth} the agreed linkage keys imply; the extra width is the ` +
    "partner's own declaration and is not shown in the agreed terms"
  );
}

/**
 * Best-effort delivery of an abort decision to the partner. The send is wrapped
 * so a transport failure coinciding with the abort condition is swallowed: the
 * partner falls back to its own receive timeout, and the caller's subsequent
 * throw - which carries the real diagnostic - is always what surfaces. Pass
 * `localTerms` when aborting from the responder's message-2 slot, which must
 * still carry `linkageTerms`; omit it for the initiator's decision-only frame.
 *
 * The optional `save` intent field is intentionally not spread onto an abort
 * frame. An abort ends the exchange before the bootstrap step, so the partner
 * never reads intent carried here (it throws on the abort first), and advertising
 * a desire to save while refusing the terms would be self-contradictory. Omitting
 * it is the correct signal, not an oversight.
 *
 * The protocol version is the one field that does ride the responder's abort,
 * because the initiator reconciles that frame's version BEFORE it reads the
 * decision and refuses a frame carrying no readable version (see
 * {@link reconcileProtocolVersion}): an abort omitting it would reach a
 * same-version partner as a version skew rather than as the reason it states. The
 * initiator's decision-only frame closes an exchange whose versions both parties
 * have already reconciled, and no reconcile reads it, so it carries none.
 *
 * Exported for the one refusal that fires just PAST this exchange: the
 * invitation-term binding, which `runExchange` applies to the terms this
 * function's caller returned (see `assertPresentedDeduplicateMatchesInvitation`).
 * `abortReasons` is written by the calling code and must stay a fixed literal --
 * the frame is a disclosure to the partner like any other.
 */
export async function sendAbort(
  conn: MessageConnection,
  abortReasons: string[],
  localTerms?: LinkageTerms,
): Promise<void> {
  try {
    await conn.send(
      localTerms !== undefined
        ? {
            linkageTerms: localTerms,
            decision: "abort",
            abortReasons,
            protocolVersion: PROTOCOL_VERSION,
          }
        : { decision: "abort", abortReasons },
    );
  } catch {
    /* swallow: see doc comment */
  }
}

// A lenient probe that extracts ONLY `protocolVersion` from a raw terms frame,
// read BEFORE the strict envelope parse so the reconcile below can always see the
// peer's version -- even when the strict parse would throw. This makes the version
// diagnosis independent of every OTHER envelope field's strictness: a future
// version that reshapes a sibling field (a required `recordCount`, an optional
// `save`, ...) can no longer throw `termsMessage.parse` before the version is read
// and thereby bury the actionable "run the same version" message behind a generic
// "failed to parse". It structurally enforces the rule that every envelope field
// stay backward-parseable across a bump. Like
// `termsMessage`, `protocolVersion` is read as `unknown`, so a garbled value still
// reconciles to the named skew rather than a parse error; a non-object frame, or one
// carrying no version, probes to `undefined`, which the reconcile refuses on the
// same terms as a foreign value. `.catch` degrades a non-object frame to that "no
// readable version" rather than a parse error on this path.
const protocolVersionProbe = z
  .object({ protocolVersion: z.unknown().optional() })
  .catch({ protocolVersion: undefined });

/**
 * Read the partner's advertised protocol version from a raw terms frame without
 * requiring the whole envelope to parse (see {@link protocolVersionProbe}), so
 * {@link reconcileProtocolVersion} can diagnose a version skew even when a sibling
 * field would fail the strict parse. Returns `undefined` for a frame that carries
 * no version, that is not an object, or whose `protocolVersion` read throws -- a
 * throwing getter degrades to the same "no readable version" outcome (pinned by
 * the "throwing protocolVersion getter" test), which the reconcile refuses.
 *
 * @internal exported for the throwing-getter probe test.
 */
export function probeProtocolVersion(rawData: unknown): unknown {
  // A throwing `protocolVersion` getter escapes the schema's `.catch` (which only
  // handles validation failures), so degrade a thrown read to `undefined` here --
  // the same "no readable version" outcome as a garbled or absent value.
  try {
    return protocolVersionProbe.parse(rawData).protocolVersion;
  } catch {
    return undefined;
  }
}

/**
 * Fail-closed reconcile of the partner's advertised {@link PROTOCOL_VERSION}. Only
 * our exact version proceeds; anything else is an incompatible build, so this
 * best-effort sends the partner the abort (so it too fails with the named cause,
 * not a receive timeout) and throws
 * {@link PROTOCOL_VERSION_MISMATCH_MESSAGE}. That covers a different integer, a
 * present-but-garbled/wrong-typed value (the field is read as `unknown` precisely
 * so such a value reaches here rather than throwing a generic parse error), and a
 * partner that advertised NO readable version at all (`undefined`): no deployed
 * build predates the field, so nothing conforming lands on that leg and admitting
 * it would be the one way past this reconcile. The refusal is the same on both
 * message paths and in both directions.
 *
 * Pass `localTerms` when reconciling from the responder's message-2 slot, whose
 * abort frame carries `linkageTerms`; omit it for the initiator's decision-only
 * abort. See {@link PROTOCOL_VERSION}.
 */
async function reconcileProtocolVersion(
  conn: MessageConnection,
  partnerVersion: unknown,
  localTerms?: LinkageTerms,
): Promise<void> {
  if (partnerVersion === PROTOCOL_VERSION) return;
  await sendAbort(conn, [PROTOCOL_VERSION_MISMATCH_MESSAGE], localTerms);
  throw new Error(PROTOCOL_VERSION_MISMATCH_MESSAGE);
}

/**
 * Exchange {@link LinkageTerms} with a partner over an established
 * connection, validate compatibility, and obtain agreement from both parties to
 * proceed.
 *
 * The three-message protocol mirrors the sequencing of the handshake:
 *   1. Initiator  -> Responder : `{ linkageTerms, recordCount, effectiveKeyCount, protocolVersion }`
 *   2. Responder  -> Initiator : `{ linkageTerms, recordCount, effectiveKeyCount, decision, protocolVersion }`
 *   3. Initiator  -> Responder : `{ decision }`
 *
 * If either party finds the terms incompatible, it sends `decision: "abort"`
 * with its reasons and this function throws. On success, returns the partner's
 * validated terms, its record count, and any non-fatal warnings (e.g. a `date`
 * mismatch). Call {@link resolveRole} afterwards to determine each party's PSI
 * role -- it is a local computation over the counts exchanged here, with no
 * further messages.
 *
 * Both parties advertise this build's {@link PROTOCOL_VERSION} on their terms
 * message (message 1 for the initiator, message 2 for the responder, an abort in
 * that slot included) and check the partner's before weighing the terms. Anything
 * but this build's exact version -- a different integer, a present-but-garbled
 * value, or no readable version at all -- fail-closes with
 * {@link PROTOCOL_VERSION_MISMATCH_MESSAGE}, so both sides learn the real cause
 * instead of a later cryptic frame-parse error. See
 * {@link reconcileProtocolVersion}.
 *
 * `localRecordCount` (this party's raw dataset row count) rides both terms
 * messages, and the partner's is read back as
 * {@link TermsExchangeResult.partnerRecordCount}. It rides the terms exchange
 * rather than a dedicated round-trip because that is the one bidirectional
 * exchange both parties always perform. It is per-party role and
 * element-bounds metadata carried on the envelope beside `linkageTerms`, never
 * inside them, so it does not enter the canonical/agreed-terms hash.
 *
 * `localEffectiveKeyCount` (this party's declared per-key candidate factors,
 * summed) rides both terms messages beside the record count and on the same terms,
 * and the partner's is read back -- after the range, divisibility, and
 * agreed-terms-floor checks of {@link assertPartnerEffectiveKeyCount} -- as
 * {@link TermsExchangeResult.partnerEffectiveKeyCount}. Omitting it advertises the
 * floor the agreed terms alone imply, which is correct for any caller holding no
 * local standardization that fans out.
 *
 * When `localSaveIntent` is set, this party's zero-setup `--save` intent is
 * advertised on its terms message (message 1 for the initiator, message 2 for
 * the responder), and the partner's intent is read back from the message it
 * sends. The flag rides this exchange rather than a dedicated round-trip
 * precisely because the terms exchange is the one bidirectional round-trip both
 * parties always perform, so a party learns the other's intent even when it
 * passed nothing itself. `localSaveIntent` left `undefined` omits the field
 * entirely, leaving the non-save (recurring/authenticated) wire format
 * unchanged. The returned {@link TermsExchangeResult.partnerSaveIntent} is the
 * partner's advertised value (absent -> `false`); it never affects agreement.
 *
 * When `localDisclosesPayload` is set, this party's payload-intent flag (whether
 * its metadata discloses any column to the partner) is advertised on its terms
 * message, and the partner's is read back as
 * {@link TermsExchangeResult.partnerDisclosesPayload}. The production caller
 * always passes a definite boolean; it is the authenticated input the single-pass
 * association-table withhold gate reads (see exchange.ts and
 * `withholdsSenderAssociationTable` in link.ts) to decide, in lockstep on both
 * sides, whether a non-receiving helper's table half is withheld at the source.
 * Like `save` it rides the one bidirectional round-trip and never affects whether
 * the terms are agreed; left `undefined` it omits the field.
 *
 * When `localHostKey` is set, this party's observed SFTP host key (fingerprint +
 * key type) is advertised on its terms message and the partner's is read back,
 * returned as {@link TermsExchangeResult.partnerHostKey} for cross-party
 * reconciliation. Left `undefined` (a party that observed no host
 * key) it omits the field, so the partner reconciles against nothing and a
 * one-sided absence is not a divergence. Like `save`, it never affects whether
 * the terms are agreed.
 *
 * The partner's advertisement is fail-soft: a present-but-malformed value is
 * dropped (read as no host key) rather than aborting. That drop is reported via
 * {@link TermsExchangeResult.partnerHostKeyMalformed} so a caller can tell a
 * non-conforming peer from one that simply observed no host key; a genuine
 * absence leaves the flag `false`.
 */
export async function exchangeTerms(
  conn: MessageConnection,
  handshakeRole: HandshakeRole,
  localTerms: LinkageTerms,
  localRecordCount: number,
  localSaveIntent?: boolean,
  localHostKey?: PresentedHostKey,
  localDisclosesPayload?: boolean,
  localEffectiveKeyCount?: number,
): Promise<TermsExchangeResult> {
  // This party's declared effective key count is always advertised. A caller that
  // holds a local standardization passes the value derived from BOTH authoring
  // surfaces; one that does not gets the floor the terms alone imply, which is the
  // most a party without a local fan-out could declare.
  const effectiveKeyCount =
    localEffectiveKeyCount ?? declaredEffectiveKeyCount(localTerms);
  // Spread into the outgoing terms frame only when this party is saving, so a
  // non-save exchange sends no `save` field at all.
  const saveField = localSaveIntent === true ? { save: true } : {};
  // Likewise the observed host key: spread only when this party observed one, so
  // a party with nothing to advertise sends no `hostKey` field at all.
  const hostKeyField =
    localHostKey !== undefined ? { hostKey: localHostKey } : {};
  // The payload-intent advertisement: spread when the caller supplies it (the
  // production caller always does, as a definite boolean), so both a
  // payload-disclosing and a no-payload party carry an explicit flag the partner's
  // single-pass withhold gate reads. Omitted only by a caller that passes nothing
  // (test helpers that do not exercise the withhold path); an omitted flag is read
  // by the gate as "discloses payload" (do not withhold). See the schema comment.
  const disclosesPayloadField =
    localDisclosesPayload !== undefined
      ? { disclosesPayload: localDisclosesPayload }
      : {};

  if (handshakeRole === "initiator") {
    await conn.send({
      linkageTerms: localTerms,
      recordCount: localRecordCount,
      effectiveKeyCount,
      protocolVersion: PROTOCOL_VERSION,
      ...saveField,
      ...disclosesPayloadField,
      ...hostKeyField,
    });

    // Message 2: receive partner's terms + decision. Raw receive so the protocol
    // version is read from the lenient probe and reconciled BEFORE the strict parse:
    // a malformed sibling field on this frame must not throw the parse before the
    // skew is diagnosed, which would strand the responder awaiting our message 3 with
    // no abort sent (see protocolVersionProbe / reconcileProtocolVersion).
    const rawMsg = await conn.receive();

    // Fail-closed protocol-version check first -- before the strict parse and before
    // any terms are weighed. A version skew is the root cause, so its actionable
    // diagnosis (and the abort it best-effort sends the responder) wins over a
    // record-count, terms, or sibling-field parse difference the mismatch might also
    // produce. A conforming responder advertises its version on this frame whether it
    // proceeds or aborts (see sendAbort), so a genuine abort passes the reconcile and
    // surfaces its own reasons at the decision check below.
    await reconcileProtocolVersion(conn, probeProtocolVersion(rawMsg));

    const msg = parseOrProtocolError(termsWithDecisionMessage, rawMsg);

    if (msg.decision === "abort") {
      throw new Error(
        "partner aborted linkage terms exchange" +
          (msg.abortReasons?.length ? `: ${msg.abortReasons.join("; ")}` : ""),
      );
    }

    // A `proceed` frame always carries the partner's record count (only the abort
    // frame omits it; see termsWithDecisionMessage). Its absence here is a
    // non-conforming or version-mismatched peer -- the count feeds role
    // resolution and the single-pass element bounds, so a missing one is a
    // protocol failure, not something to default.
    if (msg.recordCount === undefined) {
      await sendAbort(conn, ["partner omitted record count"]);
      throw new Error("partner omitted record count on terms exchange");
    }

    let partnerTerms: LinkageTerms;
    try {
      partnerTerms = parseLinkageTerms(msg.linkageTerms);
    } catch (parseErr) {
      await sendAbort(conn, ["partner linkage terms failed to parse"]);
      // These terms are genuinely partner-controlled, so the parse error is
      // rendered through describeDecodeError, which escapes each Zod issue-path
      // segment via sanitizeForDisplay and relays the schema-fixed message text
      // (the shared chokepoint contract; see utils/describeDecodeError). The
      // path escaping is load-bearing, not cosmetic: Zod's `invalid_key` code on
      // the bounded `z.record` key in `transform.params`
      // (z.string().max(MAX_NAME_LENGTH)) places the offending raw key VERBATIM
      // into the issue PATH, which a raw `ZodError.message` JSON-dumps -- so a
      // partner key carrying bidi-override / zero-width / homoglyph bytes would
      // otherwise reach the operator unescaped. Escaping at the source makes the
      // invariant real here rather than leaning on the display-sink backstop.
      // The message text needs no escaping: unknown keys are stripped by the
      // non-strict `z.object` schemas rather than echoed via `unrecognized_keys`
      // (pinned by the "strips an unknown partner key" test), and the other
      // reachable codes (type mismatch, enum, semver/date format, too_small)
      // report the expected type/options, not the received value -- only the
      // path carries partner bytes.
      throw new Error(
        "partner linkage terms failed to parse: " +
          describeDecodeError(parseErr),
      );
    }

    const { errors, warnings } = validateCompatibility(
      localTerms,
      partnerTerms,
    );

    if (errors.length > 0) {
      await sendAbort(conn, errors);
      throw new Error(`linkage terms are incompatible: ${errors.join("; ")}`);
    }

    // Held to the AGREED terms, which the compatibility check just proved
    // identical to ours, so both parties apply the same range, divisibility, and
    // floor to each other's advertisement. Best-effort abort first so the
    // responder fails with the cause rather than on its receive timeout.
    let partnerEffectiveKeyCount: number;
    try {
      partnerEffectiveKeyCount = assertPartnerEffectiveKeyCount(
        msg.effectiveKeyCount,
        partnerTerms,
      );
    } catch (err) {
      await sendAbort(conn, [
        "partner advertised an unusable effective key count",
      ]);
      throw err;
    }

    // Accepted, and above the width the agreed terms alone imply: the run
    // proceeds, and the operator hears about the gap at the run boundary.
    const widthNotice = partnerWidthAboveAgreedNotice(
      partnerEffectiveKeyCount,
      localTerms,
    );

    await conn.send({ decision: "proceed" });

    return {
      partnerTerms,
      warnings:
        widthNotice === undefined ? warnings : [...warnings, widthNotice],
      partnerRecordCount: msg.recordCount,
      partnerEffectiveKeyCount,
      partnerSaveIntent: msg.save === true,
      partnerDisclosesPayload: msg.disclosesPayload,
      partnerHostKey: msg.hostKey.value,
      partnerHostKeyMalformed: msg.hostKey.malformed,
    };
  } else {
    // Message 1: receive partner's terms. Raw receive + inline parse (rather
    // than receiveParsed) so a malformed frame can be answered with an
    // abort-with-reasons message before we throw, rather than stranding the
    // initiator until its receive timeout.
    const rawData = await conn.receive();

    let partnerTerms: LinkageTerms;
    // Placeholder overwritten by the parse below; only read on the success path,
    // which requires `recordCount` (message 1's schema makes it mandatory, so a
    // missing count is caught as a parse error before this value is returned).
    let partnerRecordCount = 0;
    let partnerAdvertisedEffectiveKeyCount: number | undefined;
    let partnerSaveIntent = false;
    let partnerDisclosesPayload: boolean | undefined;
    let partnerHostKey: PresentedHostKey | undefined;
    let partnerHostKeyMalformed = false;
    // Read the version from the lenient probe BEFORE the strict parse, so the
    // reconcile below runs on the peer's version even when `termsMessage.parse`
    // throws -- whether on the linkage terms (a version skew is the likely cause) or
    // on any OTHER envelope field a future version might reshape. This no longer
    // depends on the strict parse succeeding at all (see protocolVersionProbe).
    const partnerProtocolVersion: unknown = probeProtocolVersion(rawData);
    let parseError: string | undefined;
    try {
      const parsed = termsMessage.parse(rawData);
      partnerRecordCount = parsed.recordCount;
      partnerAdvertisedEffectiveKeyCount = parsed.effectiveKeyCount;
      partnerSaveIntent = parsed.save === true;
      partnerDisclosesPayload = parsed.disclosesPayload;
      partnerHostKey = parsed.hostKey.value;
      partnerHostKeyMalformed = parsed.hostKey.malformed;
      partnerTerms = parseLinkageTerms(parsed.linkageTerms);
    } catch (parseErr) {
      // describeDecodeError escapes the partner-controlled Zod issue path at the
      // source (the `invalid_key`/bounded-`z.record`-key path included) and
      // relays the schema-fixed message text -- see the parse-error note in the
      // initiator branch above.
      parseError = describeDecodeError(parseErr);
    }

    // Fail-closed protocol-version check first: a version skew is the root cause,
    // so its actionable diagnosis wins over a terms parse/compat error the same
    // mismatch would otherwise surface. The abort carries localTerms
    // (the responder's message-2 slot always does).
    await reconcileProtocolVersion(conn, partnerProtocolVersion, localTerms);

    const { errors, warnings } =
      parseError !== undefined
        ? {
            errors: [`partner linkage terms failed to parse: ${parseError}`],
            warnings: [],
          }
        : validateCompatibility(localTerms, partnerTerms!);

    if (errors.length > 0) {
      await sendAbort(conn, errors, localTerms);
      throw new Error(`linkage terms are incompatible: ${errors.join("; ")}`);
    }

    // See the initiator branch: held to the agreed terms, aborted best-effort.
    let partnerEffectiveKeyCount: number;
    try {
      partnerEffectiveKeyCount = assertPartnerEffectiveKeyCount(
        partnerAdvertisedEffectiveKeyCount,
        partnerTerms!,
      );
    } catch (err) {
      await sendAbort(
        conn,
        ["partner advertised an unusable effective key count"],
        localTerms,
      );
      throw err;
    }

    // See the initiator branch: an admissible width above the agreed floor is
    // surfaced at the run boundary rather than refused.
    const widthNotice = partnerWidthAboveAgreedNotice(
      partnerEffectiveKeyCount,
      localTerms,
    );

    await conn.send({
      linkageTerms: localTerms,
      decision: "proceed",
      recordCount: localRecordCount,
      effectiveKeyCount,
      protocolVersion: PROTOCOL_VERSION,
      ...saveField,
      ...disclosesPayloadField,
      ...hostKeyField,
    });

    const msg = await receiveParsed(conn, decisionMessage);
    if (msg.decision === "abort") {
      throw new Error(
        "partner aborted linkage terms exchange" +
          (msg.abortReasons?.length ? `: ${msg.abortReasons.join("; ")}` : ""),
      );
    }

    return {
      partnerTerms: partnerTerms!,
      warnings:
        widthNotice === undefined ? warnings : [...warnings, widthNotice],
      partnerRecordCount,
      partnerEffectiveKeyCount,
      partnerSaveIntent,
      partnerDisclosesPayload,
      partnerHostKey,
      partnerHostKeyMalformed,
    };
  }
}

// --- Shared-secret bootstrap -------------------------------------------------

/**
 * Establish a fresh persistent shared secret in-band, for a zero-setup exchange
 * in which BOTH parties passed `--save`. The initiator generates the token and
 * transmits it on a dedicated frame; the responder receives it. Both ends return
 * the same value, which the caller persists to its key file as the basis for
 * future recurring exchanges.
 *
 * Call this only when both parties advertised save intent (see
 * {@link exchangeTerms}). Both sides learn that fact from the terms exchange, so
 * they agree on whether this single frame is sent without further negotiation;
 * sending it directly after terms means the initiator emits message 3 of the
 * terms exchange and then this frame back-to-back -- a brief speaker-stutter, the
 * only frame that follows the terms exchange.
 *
 * The secret is a base64url-encoded 32 random bytes -- the same format as a
 * rotation token (see auth.ts) and {@link SHARED_SECRET_REGEX} -- so it drops
 * straight into the key file. On a zero-setup exchange there is no application-
 * layer AEAD, so this frame is protected only by the transport (SSH for SFTP,
 * DTLS for WebRTC, operator access controls for a file-drop). That is the
 * documented, accepted trust model for `--save`: the bootstrap relies on the
 * same transport trust as the zero-setup exchange carrying it (see
 * docs/SECURITY_DESIGN.md "Bootstrapping a shared secret"). A party that wants
 * the secret never to traverse the server uses `psilink invite` instead.
 *
 * @returns the established shared secret, identical on both sides.
 */
export async function exchangeBootstrapSecret(
  conn: MessageConnection,
  handshakeRole: HandshakeRole,
): Promise<string> {
  if (handshakeRole === "initiator") {
    const sharedSecret = toBase64Url(randomBytes(32));
    await conn.send({ sharedSecret });
    return sharedSecret;
  }
  const msg = await receiveParsed(conn, sharedSecretMessage);
  return msg.sharedSecret;
}

// --- Count-only report leg ---------------------------------------------------

// The count-only round's report frame: the receiver's tally, carried to the sender
// over the same channel the rest of the exchange runs on. The count is bounded like
// every other partner-supplied integer -- a non-negative safe integer no larger than
// the ceiling the caller derives from the two exchanged record counts, since an
// intersection cannot exceed either party's dataset. That bound rejects an absurd
// figure; it does not make the number checkable, which psi-c deliberately does not
// offer (docs/spec/PROTOCOL.md, PSI-C: the sender's knowledge of the count is
// trust-contingent).
const countReportMessage = (maxCount: number) =>
  z.object({ intersectionCount: recordCountField.max(maxCount) });

/**
 * Whether a count-only (`psi-c`) round's tally travels from the receiver to the
 * sender: exactly when both parties' agreed terms entitle them to output.
 *
 * Symmetric in its arguments, and each party calls it with the same agreed pair (its
 * own entitlement plus the partner's, cross-validated by `validateCompatibility`), so
 * the receiver's decision to send and the sender's decision to await are always the
 * same verdict -- neither blocks awaiting a frame the other will not send.
 *
 * In the one-sided case the entitled party IS the receiver ({@link resolveRole}), so
 * it already holds the count and no frame is sent at all. The frame is suppressed
 * ENTIRELY rather than sent empty, the same discipline the single-pass table
 * withholding follows: a present-but-empty frame would still mark, by its presence,
 * that a count existed to report (docs/spec/PROTOCOL.md, PSI-C).
 */
export function reportsCountToSender(
  localExpectsOutput: boolean,
  partnerExpectsOutput: boolean,
): boolean {
  return localExpectsOutput && partnerExpectsOutput;
}

/**
 * Send the count-only round's tally to the sender. Called by the RECEIVER, and only
 * when {@link reportsCountToSender} holds.
 */
export async function sendCountReport(
  conn: MessageConnection,
  intersectionCount: number,
): Promise<void> {
  await conn.send({ intersectionCount });
}

/**
 * Receive the count-only round's tally. Called by the SENDER, and only when
 * {@link reportsCountToSender} holds.
 *
 * @param maxCount The largest count this exchange could legitimately produce --
 *   the smaller of the two parties' record counts, both authenticated session state
 *   from the terms exchange. A larger figure is a protocol violation, not a result.
 */
export async function receiveCountReport(
  conn: MessageConnection,
  maxCount: number,
): Promise<number> {
  const message = await receiveParsed(conn, countReportMessage(maxCount));
  return message.intersectionCount;
}

// --- Role resolution ---------------------------------------------------------

// The work-minimizing PSI role assignment for two both-output parties, from
// their exchanged row counts: the smaller-row party becomes the receiver. The
// receiver's distinct-value set crosses the wire twice (its request, then that
// request re-encrypted in the reply) and it bears the larger share of the curve
// operations, so it is the heavier side; placing the smaller dataset there
// minimizes total work (communication + compute) across both linkage strategies
// for the near-unique keys linkage requires. The full derivation -- including
// why the single-pass index table does not outweigh that re-encryption term --
// is in docs/spec/PROTOCOL.md (Role resolution and work minimization). A tie is
// work-neutral and broken deterministically: initiator -> receiver.
function pickRole(
  localCount: number,
  partnerCount: number,
  handshakeRole: HandshakeRole,
): PsiRole {
  if (localCount < partnerCount) return "receiver";
  if (localCount > partnerCount) return "sender";
  return handshakeRole === "initiator" ? "receiver" : "sender";
}

/**
 * Determine this party's PSI role from the record counts already exchanged.
 *
 * This is a pure local computation with no connection I/O: both parties' record
 * counts ride the terms exchange (see {@link exchangeTerms}), so by the time the
 * terms are agreed each party holds its own count and the partner's, and the role
 * follows without a further message. Both output cases resolve locally.
 *
 * When exactly one party has `expectsOutput: true`, that party is the receiver
 * regardless of the counts -- it is the only party that learns the result. When
 * both parties expect output the assignment is free, so it minimizes total work:
 * the smaller-row party becomes the receiver, a tie broken in favour of the
 * initiator (see {@link pickRole} and docs/spec/PROTOCOL.md, Role resolution and
 * work minimization). The counts are still carried on the terms exchange in the
 * one-sided case too -- the role does not consume them there, but the single-pass
 * element bounds do (see exchange.ts, psiElementBounds).
 *
 * Call this after a successful {@link exchangeTerms}, whose
 * {@link TermsExchangeResult.partnerRecordCount} supplies `partnerRecordCount`.
 */
export function resolveRole(
  handshakeRole: HandshakeRole,
  localOutput: Output,
  partnerOutput: Output,
  localRecordCount: number,
  partnerRecordCount: number,
): PsiRole {
  // One-sided output: the party that expects output is the receiver regardless
  // of the counts -- it is the only party that learns the result.
  if (localOutput.expectsOutput && !partnerOutput.expectsOutput)
    return "receiver";
  if (!localOutput.expectsOutput && partnerOutput.expectsOutput)
    return "sender";

  // Both expect output: the assignment is free, so minimize total work.
  return pickRole(localRecordCount, partnerRecordCount, handshakeRole);
}
