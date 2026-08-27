import { getLogger } from "./utils/logger.js";
import {
  assertCountOnlyTransmitsNoColumn,
  inferMetadata,
  isDisclosedToPartner,
} from "./config/metadata.js";
import {
  assertCountOnlyTermsShape,
  assertDeduplicateImplemented,
} from "./config/linkageTerms.js";
import { getDefaultLinkageTerms } from "./defaults/linkageTerms.js";
import { getDefaultStandardization } from "./defaults/standardization.js";
import {
  buildStandardizedDataset,
  assertFanOutImplemented,
  assertStandardizationMatchesTerms,
  declaredEffectiveKeyCount,
  MAX_KEY_CANDIDATES_PER_ROW,
  StandardizedKeyIterable,
} from "./standardization.js";
import { columnValues, inferDateFormat } from "./utils/date.js";
import {
  redactAndSanitizeForDisplay,
  sanitizeErrorForDisplay,
} from "./utils/sanitizeErrorForDisplay.js";
import type { CSVRow } from "./file.js";
import { PSIParticipant } from "./participant.js";
import type { PsiEngine, PsiEngineMode } from "./psiEngine.js";
import {
  exchangeTerms,
  exchangeBootstrapSecret,
  reportsCountToSender,
  resolveRole,
  sendAbort,
} from "./protocolSetup.js";
import { reconcileHostKeyFingerprints } from "./hostKeyReconciliation.js";
import {
  linkViaCountOnlyPSI,
  linkViaPSI,
  linkViaSinglePassPSI,
  withholdsSenderAssociationTable,
} from "./link.js";
import type { LinkageCardinality } from "./link.js";
import { InProcessPsiEngine } from "./psiEngine.js";
import {
  partyFansOut,
  psiElementBounds,
  singlePassDatasetExceedsCap,
} from "./connection/frameSize.js";
import {
  preparePayload,
  exchangePayloads,
  toCommittedPayload,
  assertPayloadSendDisclosed,
  assertDisclosedNamesCarriable,
  assertDisclosureMatchesCommitment,
  assertOutboundPayloadConsented,
  reconcileReceivedPayload,
} from "./payloadExchange.js";
import type { PayloadWireMessage } from "./payloadExchange.js";
import { buildExchangeRecord, computeTermsHash } from "./exchangeRecord.js";
import {
  buildReceiptContent,
  deriveReceiptBinder,
  exchangeSignedReceipt,
} from "./signedReceipt.js";
import { OperatorConfigError, UsageError } from "./errors.js";
import type { Metadata } from "./config/metadata.js";
import type { LinkageTerms } from "./config/linkageTerms.js";
import type { StandardizedDataset } from "./standardization.js";
import type {
  HandshakeRole,
  AssociationTable,
  PsiRole,
  Prettify,
  Algorithm,
} from "./types.js";
import { ConnectionError } from "./connection/messageConnection.js";
import type { MessageConnection } from "./connection/messageConnection.js";
import type { PresentedHostKey } from "./connection/fileSyncConnection.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type { ExchangeSpec } from "./config/exchangeSpec.js";
import type { PartnerPayload } from "./payloadExchange.js";
import type { BuiltExchangeRecord } from "./exchangeRecord.js";
import type { SigningIdentity } from "./signingIdentity.js";
import type { SigningMode } from "./config/signing.js";
import type { DualSignedRecord, ReceiptContent } from "./signedReceipt.js";

// The deduplicating-strategy refusal is defined beside the accept path it also
// guards (config/linkageTerms.ts), which cannot import this module without
// closing a cycle, and re-exported here at the run boundary that applies it.
export { assertDeduplicateImplemented };

/**
 * The subset of an exchange specification that governs data preparation.
 * Connection-agnostic, so both the CLI and the web application can pass their
 * respective config objects (only the shared fields are consumed). The
 * `connection` and `authentication` blocks are excluded: both are connection /
 * partner-trust concerns, not data-preparation inputs.
 */
export type ExchangeDataSpec = Prettify<
  Omit<ExchangeSpec, "connection" | "authentication" | "linkageTerms"> &
    Partial<Pick<ExchangeSpec, "linkageTerms">>
>;

/**
 * The result of {@link prepareForExchange}: everything needed to run the PSI
 * protocol, derived from the raw CSV rows and the exchange parameters.
 */
export interface PreparedExchange {
  metadata: Metadata;
  linkageTerms: LinkageTerms;
  /**
   * Optional self-facing retention/disposition pointer carried from the local
   * exchange config (NOT the agreed linkage terms): where this party files its
   * copy of the result and under what retention schedule. Threaded into the
   * self-attested record at the end of the exchange; never sent to the partner
   * and never folded into the agreed-terms hash.
   */
  retentionDisposition?: string;
  /**
   * The payload column set this party has LOCKED IN as what it will receive, if
   * any -- the inviter's `disclosedPayloadColumns` carried on an accepted
   * invitation, or a party's persisted local lock-in (the exchange config's
   * `expectedPayloadColumns`, falling back to the negotiated `payload.receive`).
   * When set, {@link runExchange} verifies the partner's transmitted payload
   * columns match it exactly and aborts otherwise (see
   * {@link reconcileReceivedPayload}); the empty set is enforced strictly
   * ("receive nothing"). When absent (undefined), this party reconciles lazily and
   * accepts whatever the sender's own disclosure metadata transmits.
   *
   * Applies only to an output party. {@link runExchange} independently forces a
   * party with `expectsOutput: false` to receive no payload at all, regardless of
   * this field, so a non-receiving helper does not rely on the caller setting it.
   *
   * Populated by the caller (the accept/exchange front end that holds the token
   * or the persisted config), NOT by {@link prepareForExchange}: it is a
   * consent-fidelity expectation, not a property derived from this party's local
   * data, and the party that is lazy on this direction leaves it undefined.
   */
  expectedPayloadColumns?: string[];
  /**
   * The `deduplicate` the accepted INVITATION declared for the partner's own
   * side, if this run was reached by accepting one. When set,
   * {@link runExchange} holds the value the partner presents at the terms
   * exchange to it and refuses a contradiction before any key or payload moves
   * (see {@link assertPresentedDeduplicateMatchesInvitation}).
   *
   * Populated by the caller -- the accept front end that holds the token, or the
   * recurring front end that restores the acceptance's persisted
   * `expectedPartnerDeduplicate` off its config -- NOT by
   * {@link prepareForExchange}, for the same reason as
   * {@link expectedPayloadColumns} beside it: it is a consent-fidelity
   * expectation carried by the invitation rather than a property derived from
   * this party's own data or terms -- `deriveAcceptedLinkageTerms` sets this
   * party's own `deduplicate` to `false` and retains nothing of the inviter's.
   *
   * Absent (undefined) where no invitation was accepted: an exchange authored
   * from two parties' own configuration files carries no declaration to hold the
   * partner to, and the two documents legitimately differ.
   */
  expectedPartnerDeduplicate?: boolean;
  dataset: StandardizedDataset;
  /**
   * The original parsed CSV rows, retained for payload extraction after
   * linkage.
   *
   * All rows are held in memory from ingestion through the end of
   * {@link runExchange}. This roughly doubles peak memory usage relative to
   * holding only the standardized dataset. If streaming over input data is
   * ever supported, this field will need to be revisited.
   */
  rawRows: Array<CSVRow>;
  rowCount: number;
  /**
   * This party's declared effective key count -- the sum, over the agreed linkage
   * keys, of the candidate factor its configuration declares for each (see
   * `declaredEffectiveKeyCount`). Advertised on the terms exchange, where it
   * becomes the authenticated input every derived single-pass bound reads.
   *
   * Populated by {@link prepareForExchange}, which is the only holder of BOTH
   * authoring surfaces: a `PreparedExchange` retains the built dataset rather than
   * the standardization spec, so one assembled without going through it leaves
   * this undefined and {@link runExchange} advertises the floor the agreed terms
   * alone imply. That is the same terms-half asymmetry `assertFanOutImplemented`
   * carries at the run boundary, and it fails closed the same way: a local fan-out
   * the advertisement does not account for is refused as the single-pass index
   * table is built, not shipped under a bound it exceeds.
   */
  effectiveKeyCount?: number;
}

/**
 * Refuse a linkage-terms `algorithm` this build cannot actually honor, before any
 * matched identifier is revealed.
 *
 * `psi` reveals matched identifiers (`linkViaPSI` / `linkViaSinglePassPSI`), which
 * is what its record attests. `psi-c` (count-only) resolves to the intersection
 * size alone over one round of one key ({@link linkViaCountOnlyPSI}); the shape
 * that round demands is enforced by the count-only refusals rather than here, so
 * this guard answers only whether a run path exists for the algorithm at all.
 *
 * What the refusal protects is the record's integrity: an algorithm with no run path
 * would disclose differently than the self-attested exchange record asserts -- a gap
 * in the compliance accounting (HIPAA 45 CFR 164.528 and FERPA disclosure accounting
 * turn on what was ACTUALLY disclosed). A terms value reaching core through ANY mint
 * or accept path -- a hand-crafted token, a CLI-authored config, a non-web mint -- is
 * refused here rather than left to each client to clamp. This is the run-side half
 * the record-integrity guarantee rests on; a pure record-side clamp would keep the
 * record honest but silently ignore an operator's stated intent to disclose only a
 * count, so the run refuses instead.
 *
 * The guard is an ALLOWLIST, not a denylist of the unimplemented: `psi` and `psi-c`,
 * with any algorithm later added to `AlgorithmSchema` refused by default until it too
 * is implemented and allowed here. This follows the repo's allowlist-over-blocklist
 * rule (CONTRIBUTING.md, Code Conventions) and keeps enum growth fail-closed --
 * `buildExchangeRecord` copies `algorithm` verbatim with no guard of its own, so a new
 * unimplemented member slipping past this run-side gate is exactly what the allowlist
 * prevents.
 *
 * Plain {@link UsageError}, deliberately NOT an `OperatorConfigError`: on the
 * accept side the algorithm is adopted verbatim from the partner's invitation
 * (see `deriveAcceptedLinkageTerms`), so -- like `assertPayloadSendDisclosed` -- it is
 * not unconditionally this operator's own content, and its message stays swallowed
 * by the web's generic alert rather than surfaced. The message names only the
 * fixed enum literals, never partner-controlled free text; the CLI classifies it
 * as a usage error (exit 64).
 */
export function assertAlgorithmImplemented(algorithm: Algorithm): void {
  if (algorithm === "psi") return;
  if (algorithm === "psi-c") return;
  throw new UsageError(
    "this linkage-terms algorithm is not yet implemented: only " +
      '"psi", which reveals matched identifiers, and "psi-c", which reveals ' +
      "only the count, run today. Any other algorithm would disclose " +
      "differently than its exchange record could attest, so it is refused " +
      "before any identifier is revealed. Set the linkage-terms algorithm to " +
      "one of those, or wait for support before running.",
  );
}

/**
 * The refusal raised when the two parties' agreed terms name different algorithms
 * at the run boundary ({@link resolveCountOnlyRun}).
 *
 * A {@link ConnectionError} of kind `protocol` rather than a {@link UsageError}:
 * this party's own algorithm is its own config, so a divergence is the partner
 * having proceeded past the terms-exchange compatibility abort that refuses one --
 * a peer violating the message protocol, not a local misconfiguration. The CLI's
 * exit-code mapping therefore yields 69 -- the `usage` kind is the one it reads as
 * 64 -- and a consumer keeping per-failure bookkeeping can branch on the type. The
 * message names only the fixed algorithm literals of `AlgorithmSchema`, never
 * partner free text.
 */
export class AlgorithmDivergenceError extends ConnectionError {
  constructor(message: string) {
    super(message, "protocol");
    this.name = "AlgorithmDivergenceError";
  }
}

/**
 * Resolve whether this exchange runs the count-only (`psi-c`) path, from BOTH
 * parties' agreed terms, and refuse a count-only exchange outside the shape the
 * specification admits.
 *
 * The agreed-terms run boundary the specification names (docs/spec/PROTOCOL.md,
 * PSI-C), and the second of the two enforcement points core owns -- the first being
 * the local prepare step, which sees only this party's own terms. Symmetric in the
 * pair: each party calls it with its own terms plus the partner's and asserts over
 * both, so a refusal aborts both parties at the same point rather than desyncing the
 * lockstep round. Same shape and same reason as
 * {@link resolveLinkageCardinality}, which resolves the matching cardinality
 * immediately after the terms exchange.
 *
 * The pair must name ONE algorithm, and a divergent pair is refused here with an
 * {@link AlgorithmDivergenceError} rather than resolved to either party's value:
 * resolving would run the revealing engine while this party's record attested the
 * count-only algorithm its own terms named -- the substitution docs/spec/PROTOCOL.md
 * forbids. `algorithm` is a mandatory-consistency term, so `validateCompatibility`
 * aborts a divergent pair at the terms exchange upstream; this is that invariant
 * encoded at the boundary the run turns on rather than asserted about it. The verdict
 * is then simply whether the agreed algorithm is `psi-c`.
 */
export function resolveCountOnlyRun(
  localTerms: LinkageTerms,
  partnerTerms: LinkageTerms,
): boolean {
  assertAlgorithmImplemented(localTerms.algorithm);
  assertAlgorithmImplemented(partnerTerms.algorithm);
  if (localTerms.algorithm !== partnerTerms.algorithm)
    throw new AlgorithmDivergenceError(
      "the two parties' agreed linkage terms name different algorithms: this " +
        `party runs "${localTerms.algorithm}" and the partner runs ` +
        `"${partnerTerms.algorithm}". The algorithm settles what the run ` +
        "discloses and what each party's exchange record attests, so a " +
        "divergent pair is refused before the round begins rather than " +
        "resolved to either party's value.",
    );
  assertCountOnlyTermsShape(localTerms);
  assertCountOnlyTermsShape(partnerTerms);
  return localTerms.algorithm === "psi-c";
}

/**
 * Requires an association table to carry well-formed matched PAIRS, at the seam
 * {@link runExchange} consumes it: halves of equal length, a local half in
 * ascending order, no pair repeated, and a local row repeated only where the
 * cardinality this exchange resolved produces one.
 *
 * Everything downstream reads the table as a list of pairs. The payload carries
 * one row per DISTINCT matched local row ({@link preparePayload}), the result file
 * one row per pair ({@link buildOutputTable}), and the attested result size the
 * pair count ({@link matchedPairCount}).
 *
 * Which table shapes those readings admit follows from the resolved cardinality,
 * so it is passed in rather than inferred from the table. Under `one-to-one` a
 * matched record of ours stands in exactly one pair and the local half is strictly
 * ascending. A repeat there is admitted only where this party is the "one" side of
 * a deduplicating exchange, several of the partner's records linking to one of
 * ours (`one-to-many`, and `many-to-many`, which fans both ways -- see
 * {@link AssociationTable}). Where this party is the "many" side the multiplicity
 * lands on the PARTNER half, whose repeats sit ACROSS runs of equal local rows --
 * the local half being strictly ascending -- where the pair check below never
 * allocates or fires; a repeat WITHIN one run is a repeated pair and is refused
 * below regardless. Detecting a repeat across the whole half costs an allocation
 * over every matched pair on the `one-to-one` path too, where the local half's
 * strict ascent costs nothing.
 *
 * What no cardinality produces, and what no consumer could read, is refused. A
 * local half out of order would put the result rows and the payload rows in an
 * order the re-supply path does not reproduce, so the record's commitments would
 * not reopen from the retained files. A repeated pair would count one link twice
 * in the attested size and write the same result row twice. Equal local rows are
 * contiguous in an ascending half, so the pair check holds only the partner
 * indices of the run in hand and allocates nothing at all for a strictly ascending
 * table.
 *
 * @internal exported for the association-table invariant test.
 */
export function assertMatchedPairsWellFormed(
  associationTable: AssociationTable,
  cardinality: LinkageCardinality,
): void {
  const [matchedRows, partnerRows] = associationTable;
  if (matchedRows.length !== partnerRows.length)
    throw new Error(
      "the association table's halves have different lengths: " +
        `${matchedRows.length} vs ${partnerRows.length}. Each entry is one ` +
        "matched pair, so the two halves are read together.",
    );
  const localRowMayRepeat =
    cardinality === "one-to-many" || cardinality === "many-to-many";
  let runStart = 0;
  const runPartnerRows = new Set<number>();
  for (let i = 1; i < matchedRows.length; ++i) {
    if (matchedRows[i] > matchedRows[i - 1]) {
      runStart = i;
      runPartnerRows.clear();
      continue;
    }
    if (matchedRows[i] < matchedRows[i - 1])
      throw new Error(
        "the association table's local half is not in ascending order: the " +
          "result rows, the payload rows, and the re-supply path that " +
          "reproduces both from the retained result all read it in this " +
          "party's own row order.",
      );
    if (!localRowMayRepeat)
      throw new Error(
        "the association table repeats a local row index, which the " +
          `"${cardinality}" cardinality this exchange resolved does not ` +
          "produce: one of this party's records stands in exactly one pair " +
          "there, and the payload rows, the result rows, and the attested " +
          "result size are all read against that. Several of the partner's " +
          "records grouping onto one of ours is the deduplicating shape, " +
          "admitted only under the cardinality that asks for it.",
      );
    if (runStart === i - 1) runPartnerRows.add(partnerRows[runStart]);
    if (runPartnerRows.has(partnerRows[i]))
      throw new Error(
        "the association table repeats a matched pair: the attested result " +
          "size counts pairs and the result file writes one row per pair, so " +
          "one link would be counted twice and written twice.",
      );
    runPartnerRows.add(partnerRows[i]);
  }
}

/**
 * The result size a record attests for a matched table: its PAIR count.
 *
 * Under `one-to-one` the pairs, this party's matched records, and the partner's
 * matched records are one figure. Under a deduplicating cardinality they diverge,
 * and the pair count is what the record carries: it is the figure both parties
 * derive identically from the single exchanged table, where a per-party
 * matched-record count would put two different "result sizes" on the two records
 * of one exchange. A repeated row index on one side of a pair is still a pair
 * (docs/spec/EXCHANGE_RECORD.md, Result size under a deduplicating cardinality).
 */
export function matchedPairCount(associationTable: AssociationTable): number {
  return associationTable[0].length;
}

/**
 * Refuse this party's OWN fan-out advertisement on a strategy that matches a
 * single value per record, before the terms exchange carries it.
 *
 * The advertised effective key count exceeding the agreed key count declares a
 * fan-out ({@link partyFansOut}), and fan-out matching runs under single-pass
 * alone (docs/spec/PROTOCOL.md, Fan-out runs under single-pass only). The partner
 * refuses such an advertisement as a protocol violation, so without this the
 * operator whose own `PreparedExchange` carried it reads the partner's message
 * for a fault of its own making -- and reads it as the partner's.
 *
 * Reachable only from a `PreparedExchange` assembled outside
 * {@link prepareForExchange}, which refuses the declared fan-out that would
 * produce this count. The count is this party's own either way -- derived from
 * its terms and standardization, or set by the caller -- so the message names
 * this party's configuration and stays a {@link UsageError}, like the width
 * refusals the single-pass build raises for the same class of over-declared size.
 */
function assertFanOutAdvertisementMatchesStrategy(
  terms: LinkageTerms,
  effectiveKeyCount: number,
): void {
  if (terms.linkageStrategy === "single-pass") return;
  const keyCount = terms.linkageKeys.length;
  if (!partyFansOut(keyCount, { effectiveKeyCount })) return;
  throw new UsageError(
    "this exchange would advertise an effective key count of " +
      `${effectiveKeyCount} against its ${keyCount} agreed linkage key(s), ` +
      "which declares a fan-out, while its linkage terms name a strategy that " +
      "matches a single value per record. Fan-out matching runs under the " +
      "single-pass linkage strategy only, so the partner refuses that " +
      "advertisement rather than serving it. Prepare the exchange from its " +
      "linkage terms and standardization, or agree terms whose " +
      "linkage_strategy is single-pass.",
  );
}

/**
 * Refuse a `signing.mode` the exchange cannot honor, before it runs.
 *
 * `SigningModeSchema` accepts `session-derived` (a MAC under the shared session
 * key) but no code path produces one: the signing step runs only for a
 * `certificate`-mode block, so a `session-derived` config would complete an
 * exchange and leave the operator with the ordinary unsigned record: the receipt
 * the configuration asked for is never produced, and nothing says so. Refuse it
 * in {@link prepareForExchange} instead, before any credential, terms, or data
 * are sent, so the answer arrives while the operator is still configuring rather
 * than as a missing file after a completed exchange.
 *
 * The guard ALLOWLISTS the two modes the exchange honors -- `certificate` (signs
 * and swaps a dual-signed receipt) and `none` (asks for no receipt, as does an
 * absent block) -- rather than denylisting `session-derived`, so a mode later
 * added to `SigningModeSchema` (the enum is documented as the extensibility seam
 * for an authority-backed trust model) is refused by default until it too is
 * implemented and allowed here. This follows the repo's allowlist-over-blocklist
 * rule (CONTRIBUTING.md, Code Conventions).
 *
 * An {@link OperatorConfigError}, unlike its {@link assertAlgorithmImplemented}
 * and {@link assertDeduplicateImplemented} siblings: those read a linkage-terms
 * value that reaches them from the partner too -- adopted from its invitation,
 * or read off its terms document at {@link resolveLinkageCardinality} -- so the
 * fault is not provably local, while the `signing` block is only ever this
 * party's own config -- it lives on the local {@link ExchangeSpec} and no
 * invitation or accept path carries one (see `config/signing.ts`). That is
 * `OperatorConfigError`'s membership rule, so the fault surfaces as the
 * actionable config category on both front ends rather than as a generic
 * exchange failure; the message names only the fixed enum literals, and the CLI
 * still classifies it as a usage error (exit 64) through the base class.
 *
 * When a session-derived receipt path lands, REPLACE this refusal with it rather
 * than merely widening the allowlist: the mode needs a signing step of its own,
 * not just permission to reach the certificate one.
 */
export function assertSigningModeImplemented(
  mode: SigningMode | undefined,
): void {
  if (mode === undefined || mode === "none" || mode === "certificate") return;
  throw new OperatorConfigError(
    'this receipt signing mode is not yet implemented: only "certificate" ' +
      'signing produces a receipt. A "session-derived" MAC, or any other ' +
      "non-certificate mode, would leave this exchange with the ordinary " +
      "unsigned record while the configuration asks for a signed receipt, so " +
      "it is refused before the exchange runs. Set signing.mode to " +
      '"certificate" to sign receipts, or to "none" to run unsigned.',
  );
}

/**
 * The refusal raised when a partner presents a `deduplicate` its invitation did
 * not declare ({@link assertPresentedDeduplicateMatchesInvitation}).
 *
 * A {@link ConnectionError} of kind `protocol` rather than a {@link UsageError},
 * for the same reason as {@link AlgorithmDivergenceError}: the contradiction is
 * between two documents the PARTNER authored, so the fault is the peer's rather
 * than this operator's configuration. The CLI's exit-code mapping therefore yields
 * 69 -- the `usage` kind is the one it reads as 64 -- and a consumer keeping
 * per-failure bookkeeping can branch on the type.
 *
 * It carries `psilinkRecoveryHintEmitted` (the class-field form its
 * `PeerAbortError` and `FrameSizeExceededError` siblings use in `errors.ts`) so
 * the CLI's hint-walker suppresses the generic "retry the exchange without
 * re-inviting" advisory. The refusal is terminal against the invitation this
 * party holds, and its own message prescribes the opposite step -- obtain an
 * invitation declaring the setting the partner will run -- so the generic line
 * would tell an operator to re-run a refusal that repeats identically, and an
 * unattended recurring exchange would loop on it. The advisory's window is
 * reached on the online path, where the token rotates before the run.
 */
export class InvitationTermDivergenceError extends ConnectionError {
  readonly psilinkRecoveryHintEmitted = true;

  constructor(message: string) {
    super(message, "protocol");
    this.name = "InvitationTermDivergenceError";
  }
}

/**
 * Bind the `deduplicate` a partner presents at the terms exchange to the value
 * its INVITATION declared, for a run this party reached by accepting one.
 *
 * The term is per-party, so nothing in the agreed terms compares the two sides:
 * `deriveAcceptedLinkageTerms` sets this party's own value to `false` and the
 * partner's arrives on its terms message, where a value contradicting the
 * invitation would otherwise run unremarked. The declaration is what the consent
 * surfaces stated and what this party agreed to -- an invitation declaring
 * `false` shows no grouping disclosure at all, while the run its author can
 * produce by presenting `true` widens what this party's own records disclose
 * (more of them match, each disclosing its membership and any payload columns
 * this party sends). So the presented value is held to the declared one, and the
 * exchange is refused before any key or payload moves.
 *
 * Scoped to the invitation path, and NOT a cross-party equality rule: the
 * expectation is set only by an accept path that holds the token
 * ({@link PreparedExchange.expectedPartnerDeduplicate}), and `undefined` -- every
 * exchange authored from two parties' own configuration files -- is a no-op. A
 * one-sided deduplicating exchange whose two documents legitimately differ is
 * exactly what makes one party the "many" side, and it still runs.
 *
 * The message names the contradiction with the two declared booleans and no
 * partner-controlled value: the invitation's `deduplicate` is a schema boolean,
 * and nothing else about the partner's document is quoted.
 */
export function assertPresentedDeduplicateMatchesInvitation(
  invitationDeclared: boolean | undefined,
  presented: boolean,
): void {
  if (invitationDeclared === undefined) return;
  if (invitationDeclared === presented) return;
  throw new InvitationTermDivergenceError(
    "the partner presented linkage terms that contradict the invitation this " +
      `acceptance consented to: the invitation declared deduplicate ` +
      `${invitationDeclared}, and the terms presented at the exchange declare ` +
      `${presented}. That setting decides whether several of the partner's ` +
      "records may match one of this party's, which changes how many of this " +
      "party's records match and therefore what they disclose -- so a value " +
      "the accepted invitation did not state is refused before any key or " +
      "payload moves. Ask your partner for an invitation declaring the " +
      "setting it will run, and accept that one.",
  );
}

/**
 * Resolve the matching cardinality {@link runExchange} passes to the linkage
 * strategies, from the two parties' agreed `deduplicate` settings.
 *
 * Each party calls it with the same agreed pair -- its own terms first, the
 * partner's second, read off the terms exchange -- so both derive one cardinality
 * from the same authenticated state and the lockstep PSI rounds cannot be
 * desynced by a divergent resolution. The label is read from the CALLING party's
 * own side, a `deduplicate: true` party being the "many" one, so the two parties
 * hold mirror labels for the single procedure they run (docs/spec/PROTOCOL.md,
 * Deduplicating cardinalities): `(true, false)` gives the declaring party
 * `many-to-one` and its partner `one-to-many`, and `(false, false)` gives
 * `one-to-one`, which is its own mirror.
 *
 * `(true, true)` is refused. Its round-level pairing follows from the per-side
 * rules -- both sides keep their within-dataset duplicates and every candidate
 * pair is accepted -- but a table carrying multiplicity on both sides links
 * records transitively, and only the transitive closure that resolves it into
 * entity clusters makes such a table actionable for either party. That closure,
 * its interaction with the key cascade, and what it discloses are unspecified and
 * unbuilt, so the pair is refused before the rounds begin rather than paired and
 * handed over unresolved (docs/spec/PROTOCOL.md, `many-to-many` stops at the
 * pairing rules).
 *
 * Every refusal here is a symmetric function of the agreed pair -- each party
 * asserts over BOTH documents and the `(true, true)` test is symmetric in them --
 * so a refused pair aborts both parties at this same point rather than starting a
 * round one side would refuse.
 */
export function resolveLinkageCardinality(
  localTerms: LinkageTerms,
  partnerTerms: LinkageTerms,
): Exclude<LinkageCardinality, "many-to-many"> {
  assertDeduplicateImplemented(localTerms);
  assertDeduplicateImplemented(partnerTerms);
  if (localTerms.deduplicate && partnerTerms.deduplicate)
    throw new UsageError(
      "both parties' linkage terms set deduplicate to true, which resolves to " +
        "a many-to-many match. Its pairing rules are specified, but the " +
        "transitive closure that resolves a both-sided multiplicity into " +
        "entity clusters -- what makes such a table mean anything to either " +
        "party -- is not yet implemented, so the exchange is refused before " +
        "matching begins. Set deduplicate to false on one of the two parties " +
        "to run a many-to-one match.",
    );
  if (localTerms.deduplicate) return "many-to-one";
  if (partnerTerms.deduplicate) return "one-to-many";
  return "one-to-one";
}

/**
 * The metadata and linkage terms an exchange resolves from its spec: the config's
 * own where it carries them, else the ones derived from this run's input columns.
 *
 * This is the single definition {@link prepareForExchange} itself uses, exported so
 * a front end that must inspect either BEFORE preparing -- the outbound-payload
 * confirmation, which shows the set this run would transmit and records the
 * operator's answer into the config prepare then reads -- resolves them exactly as
 * the run does. A front end deriving its own would be free to drift from what is
 * actually transmitted, which is the whole property that confirmation rests on.
 */
export function resolveExchangeInputs(
  exchangeDataSpec: ExchangeDataSpec,
  identity: string,
  columnNames: Array<string>,
): { metadata: Metadata; linkageTerms: LinkageTerms } {
  const metadata = exchangeDataSpec.metadata ?? inferMetadata(columnNames);
  return {
    metadata,
    linkageTerms:
      exchangeDataSpec.linkageTerms ??
      getDefaultLinkageTerms(identity, metadata),
  };
}

/**
 * Prepare a local dataset for a PSI exchange.
 *
 * Given raw CSV rows and exchange parameters, this function:
 * - Infers column metadata when not provided explicitly.
 * - Builds default linkage terms when not provided explicitly.
 * - Infers the date-of-birth input format when standardization is absent.
 * - Builds a default standardization pipeline when not provided explicitly.
 * - Constructs a {@link StandardizedDataset} ready for key-iterable creation.
 * - Fails closed when an explicit (authoritative) standardization contradicts
 *   the linkage terms.
 *
 * Call this before the exchange's connection is opened. After the handshake role
 * and PSI role are resolved, {@link runExchange} builds the key iterables and
 * runs the protocol.
 *
 * @param exchangeDataSpec  Exchange parameters, loaded from a config if
 *                possible.
 * @param identity An identity string used to create default linkage terms, if
 *                necessary.
 * @param rawRows Parsed CSV rows as plain string maps.
 * @param columnNames Column names from the CSV header (used when `metadata` is
 *                absent from `params`).
 */
export function prepareForExchange(
  exchangeDataSpec: ExchangeDataSpec,
  identity: string,
  rawRows: Array<CSVRow>,
  columnNames: Array<string>,
): PreparedExchange {
  const log = getLogger("exchange");

  const { metadata, linkageTerms } = resolveExchangeInputs(
    exchangeDataSpec,
    identity,
    columnNames,
  );

  // Fail closed on an algorithm with no run path before any credential, terms, or
  // data are sent: such a run would disclose differently than its self-attested
  // record asserts. Refuse here (friendly, revealing nothing) and again at the run
  // boundary (runExchange) so the refusal holds even for a PreparedExchange built
  // without going through this function. See assertAlgorithmImplemented.
  assertAlgorithmImplemented(linkageTerms.algorithm);

  // The local prepare step of the count-only shape refusal, the first of the two
  // enforcement points core owns (the other is the agreed-terms run boundary; see
  // resolveCountOnlyRun). Both run over metadata RESOLVED above -- the config's own
  // or the one inferred from this run's input columns -- so the transmit rule is
  // never asked of an unresolved block, which would pass it vacuously. A no-op on
  // every `psi` exchange. See assertCountOnlyTermsShape and
  // assertCountOnlyTransmitsNoColumn.
  assertCountOnlyTermsShape(linkageTerms);
  assertCountOnlyTransmitsNoColumn(linkageTerms.algorithm, metadata);

  // Fail closed on a deduplicating term the agreed strategy cannot match before
  // any credential, terms, or data are sent: a strategy matching one record per
  // value would under-deliver the consented cardinality. Refused again from both
  // parties' agreed terms in runExchange (resolveLinkageCardinality), which holds
  // for a PreparedExchange built without going through this function. See
  // assertDeduplicateImplemented.
  assertDeduplicateImplemented(linkageTerms);

  // Fail closed on a signing mode with no run path before any credential, terms,
  // or data are sent: only certificate mode signs a receipt, so a session-derived
  // block would otherwise run to completion and leave the operator the unsigned
  // record they did not ask for. See assertSigningModeImplemented.
  assertSigningModeImplemented(exchangeDataSpec.signing?.mode);

  // Reject a payload data dictionary that does not match what metadata transmits.
  // `payload.send` is exchanged, consented to, written into the exchange record,
  // and mirrored into a recurring partner's lock-in, while metadata's
  // isPayload/role is the single source of truth for what actually leaves the
  // machine. This is the one step with both in scope, so the CLI and web paths
  // inherit the same fail-closed check; it is a no-op on the default and guided
  // paths, which author no payload block. See assertPayloadSendDisclosed.
  assertPayloadSendDisclosed(
    linkageTerms.payload,
    metadata,
    linkageTerms.output,
  );

  // Reject a disclosed column whose name is too long to carry. A transmitted
  // column's name rides the payload frame to the partner and is written into this
  // party's own exchange record, and both bound it; metadata inferred from a CSV
  // header passes through no schema, so without this the partner's parse is the
  // first enforcement -- reached only after the frame is sent. Refused again at the
  // run boundary (runExchange), so the refusal holds even for a PreparedExchange
  // built without going through this function. See assertDisclosedNamesCarriable.
  assertDisclosedNamesCarriable(metadata, linkageTerms.output);

  // Fail fast when this party can no longer produce a payload disclosure it
  // committed to on a prior invitation. disclosedPayloadColumns is the send-side
  // commitment persisted by every `psilink invite` mint path (the online
  // invite/bootstrap, offline infer, and offline invite-from-config paths); the
  // partner locked that exact set
  // in as what it will receive, so a metadata drift here would otherwise
  // under- or over-deliver and make the PARTNER abort mid-exchange
  // (reconcileReceivedPayload), a partner-attributed failure. This is the
  // send-side, prior-promise counterpart of assertPayloadSendDisclosed above and
  // is a no-op when no commitment is on record (absent field). See
  // assertDisclosureMatchesCommitment.
  assertDisclosureMatchesCommitment(
    exchangeDataSpec.disclosedPayloadColumns,
    metadata,
  );

  // Fail closed on an outbound payload set this party has not confirmed. An
  // acceptor's own send set is authored by no party -- the invitation authors the
  // inviter's send, the mirror leaves the acceptor's absent, and the set is
  // resolved from its own CSV header -- so a recorded confirmation is what makes it
  // chosen rather than inferred. A front end that shows the set and asks records
  // the answer and passes here; one that does not refuses, before any credential,
  // terms, or data are sent, rather than transmit a set neither party chose. A
  // no-op for every party with no consent record, which is every non-acceptor. See
  // assertOutboundPayloadConsented.
  assertOutboundPayloadConsented(
    exchangeDataSpec.outboundPayloadConsent,
    metadata,
    linkageTerms.output,
  );

  // This party's declared effective key count: the sum over the agreed keys of the
  // candidate factor its configuration declares for each, over BOTH authoring
  // surfaces -- the terms' element transforms and this party's own standardization.
  // The default standardization declares no fan-out, so an unauthored one yields
  // the terms' own floor. It sizes the pre-flight gate below and, carried on the
  // returned PreparedExchange, the bounds every single-pass frame is derived from.
  const effectiveKeyCount = declaredEffectiveKeyCount(
    linkageTerms,
    exchangeDataSpec.standardization,
  );

  let dateInputFormat: string | undefined;
  if (exchangeDataSpec.standardization === undefined) {
    // Only a `role: linkage` date_of_birth column participates in linkage, so
    // only one may drive the inferred date format -- a column roled identifier/
    // payload/ignored does not match and resolveFieldColumns would not bind it as
    // the dob field.
    const dobCol = metadata.find(
      (c) => c.type === "date_of_birth" && c.role === "linkage",
    );
    if (dobCol !== undefined) {
      dateInputFormat = inferDateFormat(columnValues(rawRows, dobCol.name));
      if (dateInputFormat !== undefined)
        log.info(`inferred date of birth format: ${dateInputFormat}`);
    }
  }

  const standardization =
    exchangeDataSpec.standardization ??
    getDefaultStandardization(metadata, linkageTerms, { dateInputFormat });

  // Fail closed on an authoritative config whose standardization contradicts its
  // linkage terms (see assertStandardizationMatchesTerms for the full rationale
  // and the exit-64 / web-surfacing contract). Gated on an authored
  // standardization: the terms-only path (undefined) reconstructs one from the
  // terms via getDefaultStandardization above and so cannot contradict them, and
  // is deliberately not gated. The same shared assert runs at the `psilink invite`
  // mint boundary, so `invite` never discloses a token this exchange would refuse.
  if (exchangeDataSpec.standardization !== undefined)
    assertStandardizationMatchesTerms(
      exchangeDataSpec.standardization,
      linkageTerms,
    );

  // Fail closed on a transform that fans one value out into several match
  // candidates under a strategy that matches one value per record: the splitting
  // record's candidate set has no round to enter there, and the run would abort
  // once it reached one. Run over the RESOLVED standardization (authored or
  // default, which declares no fan-out) plus the terms' element transforms, so
  // both authoring surfaces are covered; the terms half is refused again at the
  // run boundary. See assertFanOutImplemented.
  assertFanOutImplemented(linkageTerms, standardization);

  // Pre-flight the single-pass dataset ceiling. This is a coarse, ONE-PARTY
  // lower-bound gate: it can only see this party's own row count, not the
  // partner's nor either side's distinct-value counts (never computed locally, and
  // never exchanged). If this party's own
  // value slots already exceed the budget, single-pass cannot succeed
  // whatever the partner's size, so fail here rather than after the handshake and
  // the PSI encryption. The authoritative, symmetric two-party check runs in
  // linkViaSinglePassPSI once both record counts are exchanged; that asymmetry --
  // a coarse local pre-flight versus the post-encryption authoritative gate -- is
  // preserved deliberately. The check applies to EITHER role: the cell-count
  // ceiling is symmetric (the receiver holds both encrypted sets resident, so its
  // own dataset is bounded exactly as the sender's), so an over-ceiling exchange
  // aborts whichever side is over -- and the coarse one-party gate predicts that
  // from this party's own count regardless of whether it sends or receives. It is
  // not narrowed to a potential sender: doing so would let a dedicated output-only
  // receiver pay a full handshake and PSI encryption before the authoritative gate
  // caught the same over-ceiling dataset.
  //
  // Ordered BEHIND the fan-out refusal above, so a config declaring a fan-out
  // under a strategy that cannot match one is refused for what actually stops it
  // rather than offered a smaller size that build refuses at any size. A runnable
  // single-pass fan-out reaches this gate, whose fan-out remedy is a real one for
  // it.
  //
  // Every remedy the message names is a configuration the operator can change --
  // fewer keys, fewer records, smaller batches, one less fan-out -- so it is a
  // usage fault (CLI exit 64), like the width refusals the single-pass build
  // raises for the same class of over-declared size. Whether to offer the fan-out
  // remedy is read through partyFansOut, the single layout discriminant, so the
  // guidance and the frame layout cannot disagree about whether this party fans
  // out.
  if (
    linkageTerms.linkageStrategy === "single-pass" &&
    singlePassDatasetExceedsCap(effectiveKeyCount, rawRows.length)
  ) {
    throw new UsageError(
      `single-pass linkage cannot carry this dataset: ${rawRows.length} ` +
        `record(s) across ${linkageTerms.linkageKeys.length} linkage key(s) ` +
        "exceed the single-pass ceiling. Reduce the number of linkage keys or " +
        "the record count, or split the dataset into smaller batches." +
        (partyFansOut(linkageTerms.linkageKeys.length, { effectiveKeyCount })
          ? ` A linkage key that fans out counts as ${MAX_KEY_CANDIDATES_PER_ROW} ` +
            "toward that ceiling, so removing a fan-out is another remedy."
          : ""),
    );
  }

  // Sanitize the key names for display: on the accept side these come from the
  // partner's invitation (charset-unconstrained), and the operator already
  // reviewed the same escaped form when agreeing to the terms (displayInvitation).
  log.info(
    "will link using keys:",
    linkageTerms.linkageKeys
      .map((k) => redactAndSanitizeForDisplay(k.name))
      .join(", "),
  );

  const dataset = buildStandardizedDataset(
    standardization,
    rawRows,
    metadata,
    linkageTerms,
  );

  return {
    metadata,
    linkageTerms,
    // A self-facing operator note, passed through untouched from the local
    // config to the record builder; absent when the config omits it.
    retentionDisposition: exchangeDataSpec.retentionDisposition,
    // NOTE: the two invitation lock-ins -- expectedPayloadColumns (the
    // received-payload set) and expectedPartnerDeduplicate (the partner's declared
    // cardinality side) -- are deliberately NOT threaded here, unlike
    // retentionDisposition above. The caller sets each on the returned
    // PreparedExchange after this returns, because the accept path's source is the
    // invitation token (not this dataSpec) and the recurring path applies a
    // fallback for the payload set (config expectedPayloadColumns, else
    // payload.receive). A caller that wants a lock-in must set it explicitly; see
    // PreparedExchange.expectedPayloadColumns and
    // PreparedExchange.expectedPartnerDeduplicate. (Both ride ExchangeDataSpec only
    // so the exchange command can read them off the parsed config.)
    dataset,
    rawRows,
    rowCount: rawRows.length,
    effectiveKeyCount,
  };
}

// --- Exchange execution ------------------------------------------------------

export const CONFIRMING_PROTOCOL_STAGE_ID = "confirming protocol";

/**
 * A single named step in the post-connection exchange protocol, as returned
 * by {@link describeExchangeStages}. The `id` values match those emitted by
 * the `onStage` callback in {@link runExchange}.
 */
export interface ExchangeStageDefinition {
  id: string;
  label: string;
}

/**
 * Returns the ordered list of protocol stages that {@link runExchange} will
 * pass to its `onStage` callback. Use this before opening a connection to
 * build a progress indicator; the stage `id` values match the strings emitted
 * during execution.
 *
 * Stages: one "confirming protocol" step (terms exchange + role resolution).
 * For the cascade strategy, one "stage N / K" step per linkage key follows, since
 * each key is a separate on-wire PSI round. Single-pass runs every key in one
 * exchange and then replays them locally in-memory, so it emits no per-key stage
 * (the replay is instant); its only enumerated step is confirming protocol, and
 * the encrypt/match stages it emits pass through the caller's onStage unlabeled.
 */
export function describeExchangeStages(
  prepared: PreparedExchange,
): ExchangeStageDefinition[] {
  const confirming: ExchangeStageDefinition = {
    id: CONFIRMING_PROTOCOL_STAGE_ID,
    label: "Confirming protocol",
  };
  if (prepared.linkageTerms.linkageStrategy === "single-pass")
    return [confirming];
  const keyCount = prepared.linkageTerms.linkageKeys.length;
  return [
    confirming,
    ...Array.from({ length: keyCount }, (_, i) => ({
      id: `stage ${i + 1} / ${keyCount}`,
      label: `Linking key ${i + 1} / ${keyCount}`,
    })),
  ];
}

/**
 * Outcome of the zero-setup `--save` shared-secret bootstrap, present on
 * {@link ExchangeResult.bootstrap} only when {@link RunExchangeOptions.saveIntent}
 * was provided (i.e. a zero-setup exchange). `partnerSaveIntent` reports whether
 * the partner also advertised `--save`; `sharedSecret` is the persistent secret
 * established in-band, present only when both parties saved -- the initiator
 * generated it and the responder received it, so both hold the same value.
 */
export interface ExchangeBootstrapResult {
  partnerSaveIntent: boolean;
  sharedSecret?: string;
}

/** The result returned by {@link runExchange} on successful completion. */
export interface ExchangeResult {
  /**
   * The matched association table, or `undefined` when this party's agreed terms
   * give it no output (`output.expectsOutput` is false) -- a one-sided exchange
   * in which this party is the PSI sender / helper. This is the privacy gate: a
   * party not entitled to the result does not receive the result table from the
   * exchange, so neither front end can write it. The table is still computed
   * inside {@link runExchange} (the sender needs it to extract its own outgoing
   * payload) and is withheld only here, at the return. A both-output exchange, and
   * the receiver of a one-sided exchange, get the table. The withholding
   * predicate is exactly the one that gates the audit record's committed
   * association table, so the returned result and the record stay one rule: a
   * helper neither receives the table nor binds it in its record.
   */
  associationTable: AssociationTable | undefined;
  /**
   * The size of the intersection, and the whole result of a count-only (`psi-c`)
   * exchange: present exactly when this party ran one AND its agreed terms entitle it
   * to output. `undefined` on every `psi` exchange, whose result is the association
   * table above -- the count is not a second reading of a `psi` run.
   *
   * This is what keeps a count-only receiver from presenting as the withheld-helper
   * shape: `associationTable === undefined` alone means "this party receives nothing",
   * which is true of a count-only helper and false of a count-only receiver, and only
   * this field tells them apart. A count-only run leaves the table undefined for BOTH
   * parties -- it produces no pairing for either to hold, so there is nothing to
   * withhold -- and the count reaches the sender only through the count-report leg
   * the agreed entitlements gate.
   *
   * Its presence rule is this party's OWN entitlement, deliberately not the
   * both-entitled gate the record's result size takes: in a one-sided run the
   * receiver holds a count its own record does not carry
   * (docs/spec/EXCHANGE_RECORD.md, Count-only records), and that receiver is the
   * party the run was conducted for. The sender's copy, when it gets one, is the
   * receiver's report rather than a figure it computed -- the same trust posture as
   * the `psi` association-table return leg (docs/spec/PROTOCOL.md, PSI-C).
   */
  intersectionCount: number | undefined;
  /** Linkage terms received from the partner during the handshake. */
  partnerTerms: LinkageTerms;
  /** The PSI role assigned to this party (sender or receiver). */
  resolvedRole: PsiRole;
  /** Payload data received from the partner after linkage. */
  partnerPayload: PartnerPayload;
  /**
   * Outcome of the zero-setup `--save` bootstrap. The discriminant is whether
   * {@link RunExchangeOptions.saveIntent} was a boolean, not whether this party
   * passed `--save`: a `false` saveIntent still yields a defined result (with
   * `partnerSaveIntent` set and `sharedSecret` undefined), because a non-saving
   * party must still learn the partner's intent to emit the right notice.
   * `undefined` only when `saveIntent` itself was `undefined` -- every
   * recurring/authenticated exchange, where the bootstrap flow is not entered at
   * all.
   */
  bootstrap?: ExchangeBootstrapResult;
  /**
   * The self-attested audit record of this exchange (Phase 1 of exchange
   * receipts) together with its private verification keys, produced as a pair. The
   * `record` holds commitments to the data exchanged plus a non-secret summary
   * and is safe to retain or share; the `keys` hold only the per-commitment salts
   * -- not a snapshot of the committed data -- so they are not a second copy of the
   * matched data, but remain private (a salt plus the record's commitment can open
   * a low-entropy committed value). The caller (CLI or web) persists both. See
   * {@link buildExchangeRecord}.
   *
   * A single optional field rather than two independent ones so the record and
   * its keys can never be present apart. Absent only if building the record
   * threw after the exchange already succeeded, in which case the caller skips
   * persisting -- the record is a secondary audit artifact, so its failure is
   * non-fatal and never discards the exchange result.
   */
  audit?: BuiltExchangeRecord;
  /**
   * The dual-signed record (Phase 2 of exchange receipts): the mutually-verifiable
   * receipt content plus both parties' certificates and signatures. Present only
   * when a {@link RunExchangeOptions.signingIdentity} and
   * {@link RunExchangeOptions.sessionKey} were supplied AND the signature exchange
   * completed; the caller persists it. Absent on the unsigned path (no signing
   * identity) -- the self-attested record path is unaffected. On a failed signature
   * exchange {@link runExchange} throws (a security {@link ConnectionError}), so a
   * partner signature received without completing the local swap is never returned
   * as a valid artifact.
   */
  signedReceipt?: DualSignedRecord;
}

/**
 * Whether a count-only (`psi-c`) tally this party holds arrived as the PARTNER's
 * report rather than as a figure this party computed. The receiver alone computes
 * the count; the sender's copy, when its terms entitle it to one, travels over the
 * count-report leg and is the receiver's word, which psilink does not check against
 * a run of its own (docs/spec/PROTOCOL.md, PSI-C -- "The sender's knowledge of the
 * count is trust-contingent"). False for every party that computed its own count,
 * and false for a run that produced no count at all.
 *
 * Both front ends read this one predicate rather than each restating the role rule:
 * it decides whether the seat's completion copy carries the trust-contingent caveat,
 * and a second reading that disagreed would caveat a locally computed count or
 * present a reported one as this party's own finding.
 */
export function countIsPartnerReported(
  result: Pick<ExchangeResult, "intersectionCount" | "resolvedRole">,
): boolean {
  return (
    result.intersectionCount !== undefined && result.resolvedRole === "sender"
  );
}

export interface RunExchangeOptions {
  /** The loaded PSI WASM/native library instance. */
  psiLibrary: PSILibrary;
  /**
   * Builds the crypto engine for the PSI participant, given its resolved role, id,
   * and the disclosure mode the agreed algorithm resolved to. When omitted, the
   * masking runs in-process on the calling thread (the default, and what the browser
   * uses). The CLI supplies a factory that spawns a `worker_threads` worker so the
   * masking runs off the event-loop-owning thread, keeping it responsive for the SFTP
   * heartbeat and timers; the returned engine is disposed when the PSI phase ends.
   *
   * The mode is passed rather than assumed: it is generated into the engine's key
   * material, so an engine built for the other mode refuses the match this run needs
   * instead of quietly producing the other disclosure.
   */
  psiEngineFactory?: (
    role: "starter" | "joiner",
    id: string,
    mode: PsiEngineMode,
  ) => PsiEngine;
  /**
   * Called at the start of each protocol stage. The `id` values match those
   * returned by {@link describeExchangeStages}.
   */
  onStage?: (id: string) => void;
  /** Called for each non-fatal warning produced during terms exchange. */
  onWarning?: (msg: string) => void;
  /**
   * Called once after the confirming-protocol stage completes, before the
   * first PSI key stage begins. Useful for surfacing partner identity and
   * resolved role without waiting for the full exchange to finish.
   */
  onProtocolConfirmed?: (
    partnerTerms: LinkageTerms,
    resolvedRole: PsiRole,
  ) => void;
  /**
   * Zero-setup `--save` intent for this party. `undefined` (the default) keeps
   * this exchange out of the bootstrap flow entirely: no `save` field is put on
   * the wire and {@link ExchangeResult.bootstrap} is `undefined`, so the
   * recurring/authenticated path is byte-for-byte unchanged. A `boolean` opts
   * in: the intent is advertised on the terms exchange, the partner's intent is
   * read back, and -- only when both parties opt in -- the initiator transmits a
   * fresh shared secret in-band (see {@link exchangeBootstrapSecret}).
   */
  saveIntent?: boolean;
  /**
   * This party's observed SFTP host key (fingerprint + key type), advertised in
   * the post-handshake terms exchange so the two parties can reconcile their
   * independent views of the server's identity. Pass it ONLY on the
   * authenticated path -- the value is unforgeable only because it rides the
   * AEAD-wrapped terms exchange, so a caller threading it over an unauthenticated
   * channel would defeat the check. `undefined` (the default) advertises
   * nothing, which is correct for any channel that observes no host key (a
   * file-drop or proxy path) and for the web/WebRTC caller. The partner's
   * advertised value is reconciled against this one; a divergence is reported via
   * {@link onHostKeyDivergence}.
   */
  observedHostKey?: PresentedHostKey;
  /**
   * Called once, after the terms exchange, when the two parties' advertised SFTP
   * host-key fingerprints diverge (see {@link reconcileHostKeyFingerprints}). The
   * argument is a complete, display-safe warning naming both observed values.
   * Not called when the fingerprints match, when either party observed no host
   * key, or when {@link observedHostKey} was not supplied. The divergence is
   * non-fatal -- the exchange continues -- so a caller surfaces it as a warning
   * rather than aborting.
   */
  onHostKeyDivergence?: (message: string) => void;
  /**
   * Called once, after the terms exchange, when the partner's host-key
   * advertisement was present on the wire but failed the fail-soft validation
   * (present-but-malformed; see `exchangeTerms`'s `partnerHostKeyMalformed`). Not
   * called when the partner advertised a well-formed key or none at all, so a
   * benign no-host-key partner (a file-drop or proxy path) stays quiet. The
   * malformed value is dropped either way and reconciliation is skipped for it
   * -- this is a diagnostic-only signal, so a caller logs it at a low level (the
   * CLI logs it at debug) rather than warning or aborting. The dropped bytes are
   * deliberately not surfaced: they are unusable, and echoing partner-controlled
   * content into a log is an injection risk.
   */
  onPartnerHostKeyMalformed?: () => void;
  /**
   * This party's long-lived signing identity, from `signing.identity_file`. When
   * present (together with {@link sessionKey}), the signing step runs at the
   * conclusion of the exchange: both parties sign the same canonical receipt
   * content and swap signatures, yielding {@link ExchangeResult.signedReceipt}.
   * Absent (the default) skips the step entirely, so the unsigned-record path --
   * the web app (no keys/key-exchange) and a CLI exchange without a signing
   * identity -- runs {@link runExchange} unchanged. The CLI threads it only on the
   * authenticated file-sync path, which is the only path that holds a session key.
   */
  signingIdentity?: SigningIdentity;
  /**
   * The pinned partner certificate fingerprint (`signing.partner_fingerprint`),
   * consulted only when {@link signingIdentity} is present. The signing step
   * verifies the partner's presented certificate against this pin BEFORE the
   * signature; absent, the step fails closed (no partner certificate can be
   * trusted). Field-shape-validated by the config schema.
   */
  partnerFingerprint?: string;
  /**
   * The 32-byte session key from the authenticated key exchange, needed to derive
   * the per-exchange replay binder that the signed receipt commits to. Present only
   * on the authenticated path (the CLI discards it otherwise; the web has no key
   * exchange). Required for the signing step: {@link signingIdentity} without it
   * leaves the step un-runnable, so the caller threads them together or not at all.
   */
  sessionKey?: Uint8Array<ArrayBuffer>;
  verbosity?: number;
}

/**
 * Execute the PSI exchange protocol over an already-open connection.
 *
 * This function handles everything after the connection is established (and,
 * for the CLI, after synchronization): it exchanges linkage terms with the
 * partner, resolves the PSI role, and runs the multi-key PSI protocol.
 *
 * Connection setup and (for the CLI) synchronization remain the caller's
 * responsibility because they are transport-specific.
 *
 * @param conn           An open, ready-to-use connection.
 * @param handshakeRole  This party's role in the handshake ("initiator" or
 *                       "responder"), known after connection / synchronization.
 * @param prepared       Output of {@link prepareForExchange}.
 * @param options        PSI library instance, callbacks, and verbosity level.
 */
export async function runExchange(
  conn: MessageConnection,
  handshakeRole: HandshakeRole,
  prepared: PreparedExchange,
  options: RunExchangeOptions,
): Promise<ExchangeResult> {
  const { dataset, linkageTerms, rowCount, retentionDisposition } = prepared;

  // Last line of defense for the disclosure-integrity guarantee: refuse an algorithm
  // with no run path before anything goes on the wire, so the self-attested record
  // can never attest a disclosure the run did not make. prepareForExchange refuses it
  // at prepare time; this holds even for a PreparedExchange constructed without going
  // through it, and fires before the terms exchange puts anything on the wire. The
  // partner's half of the same question is settled after the terms exchange, from the
  // agreed pair (resolveCountOnlyRun). See assertAlgorithmImplemented.
  assertAlgorithmImplemented(linkageTerms.algorithm);

  // Refuse a count-only exchange whose input metadata would transmit a column before
  // anything goes on the wire, over the RESOLVED metadata a PreparedExchange always
  // carries -- the rule fails open on an unresolved block, and this is the boundary
  // that holds one. prepareForExchange refuses it at prepare time; this holds for a
  // PreparedExchange assembled without going through it. See
  // assertCountOnlyTransmitsNoColumn.
  assertCountOnlyTransmitsNoColumn(linkageTerms.algorithm, prepared.metadata);

  // Refuse a fan-out element transform under a strategy that matches one value
  // per record before the terms go on the wire, so a PreparedExchange built
  // without going through prepareForExchange cannot start a run that aborts at
  // its first splitting row. This reaches the terms half only: a PreparedExchange
  // retains the built dataset, not the standardization spec, so a fan-out
  // authored there and assembled outside prepareForExchange is refused when that
  // row's candidate set reaches the linkage strategy -- at the point of harm, but
  // after this party's terms have gone on the wire. See assertFanOutImplemented.
  assertFanOutImplemented(linkageTerms);

  // Refuse a disclosed column whose name is too long to carry before anything goes
  // on the wire. prepareForExchange refuses it at prepare time; this holds for a
  // PreparedExchange assembled without going through it, where the partner's parse
  // of the payload frame would otherwise be the first enforcement -- reached only
  // after this party has transmitted the name. See assertDisclosedNamesCarriable.
  assertDisclosedNamesCarriable(prepared.metadata, linkageTerms.output);

  const { psiLibrary } = options;
  const onStage = options.onStage ?? (() => {});
  const onWarning = options.onWarning ?? (() => {});
  const onProtocolConfirmed = options.onProtocolConfirmed ?? (() => {});
  const verbosity = options.verbosity ?? 0;

  // Whether THIS party will disclose payload to a partner entitled to output:
  // true when its metadata transmits any column (isDisclosedToPartner, the single
  // source of truth preparePayload gathers on). Advertised on the terms exchange
  // so the partner can gate the single-pass association-table withholding on it --
  // payload disclosure is per-party-local and lazy, so the partner cannot infer it
  // and needs the explicit, authenticated signal (see the withhold gate below).
  const localDisclosesPayload = prepared.metadata.some(isDisclosedToPartner);

  // This party's declared effective key count, advertised on the terms exchange as
  // the authenticated input the single-pass bounds are derived from.
  // prepareForExchange holds both authoring surfaces and computes it; a
  // PreparedExchange assembled elsewhere retains no standardization spec, so it
  // falls back to the floor the terms alone imply (see
  // PreparedExchange.effectiveKeyCount).
  const localEffectiveKeyCount =
    prepared.effectiveKeyCount ?? declaredEffectiveKeyCount(linkageTerms);

  // Refuse this party's own fan-out advertisement on a strategy that cannot
  // match one, before it goes on the wire and comes back as the partner's
  // refusal. See assertFanOutAdvertisementMatchesStrategy.
  assertFanOutAdvertisementMatchesStrategy(
    linkageTerms,
    localEffectiveKeyCount,
  );

  onStage(CONFIRMING_PROTOCOL_STAGE_ID);
  const {
    partnerTerms,
    warnings,
    partnerRecordCount,
    partnerEffectiveKeyCount,
    partnerSaveIntent,
    partnerDisclosesPayload,
    partnerHostKey,
    partnerHostKeyMalformed,
  } = await exchangeTerms(
    conn,
    handshakeRole,
    linkageTerms,
    rowCount,
    options.saveIntent,
    options.observedHostKey,
    localDisclosesPayload,
    localEffectiveKeyCount,
  );
  for (const warning of warnings) onWarning(warning);

  // Hold the partner's presented `deduplicate` to what its invitation declared,
  // where this run came from accepting one: the term is per-party, so no
  // compatibility rule compares the two sides, and the value this party consented
  // to is the invitation's rather than whatever arrives here. Before the
  // cardinality is resolved from it, and before any key or payload moves. A no-op
  // on an exchange authored from configuration files, which carries no
  // declaration. See assertPresentedDeduplicateMatchesInvitation.
  try {
    assertPresentedDeduplicateMatchesInvitation(
      prepared.expectedPartnerDeduplicate,
      partnerTerms.deduplicate,
    );
  } catch (err) {
    // Best-effort abort before the throw, as every refusal inside exchangeTerms
    // sends one. This one is one-sided -- only this party holds the declaration
    // -- so the partner derives no refusal of its own and would otherwise wait
    // out its whole peer-inactivity budget (a full poll budget on a file
    // channel) for rounds this party will never run. Sent in the abort
    // decision's own shape rather than as a private signal of its own, though no
    // decision slot is left to read it here: what ends the partner's run is the
    // frame's arrival, and the specific fault stays with this party. The reason
    // is a fixed literal about values the partner itself declared, so the frame
    // discloses nothing new. What the partner surfaces from that arrival is not
    // a refusal at all: the frame reaches the partner's PSI binary seam still
    // awaiting its own next round, so that run ends with the PSI library's own
    // "Type not convertible to a Uint8Array" error, with no psilink framing or
    // cause attached -- fast-fail without diagnosis. Classifying that seam's
    // decode failure is follow-on work, not a property this branch claims.
    await sendAbort(conn, [
      "partner presented a deduplicate its invitation did not declare",
    ]);
    throw err;
  }

  // Resolve the matching cardinality from both parties' agreed deduplicate
  // settings as the first step after the terms exchange: the resolution is
  // symmetric, so a refusal (many-to-many, or a deduplicating term under
  // single-pass) aborts BOTH parties at this same point -- before the bootstrap
  // frame and the PSI rounds -- rather than desyncing the lockstep. See
  // resolveLinkageCardinality.
  const cardinality = resolveLinkageCardinality(linkageTerms, partnerTerms);

  // Resolve which disclosure this exchange runs from both parties' agreed terms, at
  // the same point and for the same reason as the cardinality above: the resolution
  // is symmetric, so a count-only exchange outside the specified shape aborts BOTH
  // parties here -- before the bootstrap frame and the PSI round -- rather than
  // starting a round one side would refuse. See resolveCountOnlyRun.
  const countOnly = resolveCountOnlyRun(linkageTerms, partnerTerms);

  // Surface a present-but-malformed partner advertisement as a diagnostic. The
  // value was already dropped by the fail-soft parse (partnerHostKey is
  // undefined), so reconciliation below is a no-op for it; this signal lets the
  // caller distinguish a non-conforming peer from one that observed no host key.
  // A genuine absence leaves the flag false, so the benign no-host-key path
  // emits nothing.
  if (partnerHostKeyMalformed) options.onPartnerHostKeyMalformed?.();

  // Cross-party host-key reconciliation. Both parties advertised the host key
  // they observed on the terms exchange just above; compare them, and surface a
  // divergence (no-op when either party observed none, or when the fingerprints
  // match -- see reconcileHostKeyFingerprints). It is advisory, like the save
  // intent, and never aborts the exchange.
  const hostKeyDivergence = reconcileHostKeyFingerprints(
    options.observedHostKey,
    partnerHostKey,
  );
  if (hostKeyDivergence !== undefined)
    options.onHostKeyDivergence?.(hostKeyDivergence);

  // Zero-setup `--save` bootstrap. Only build a result when the caller opted in
  // (saveIntent defined), so every other exchange returns bootstrap: undefined.
  // The shared secret is transmitted only when BOTH parties advertised intent;
  // both learned that from the terms exchange just above, so they agree on
  // whether this frame is sent. It rides directly after terms (before role
  // resolution) so the message ordering is fixed on both sides.
  let bootstrap: ExchangeBootstrapResult | undefined;
  if (options.saveIntent !== undefined) {
    const sharedSecret =
      options.saveIntent && partnerSaveIntent
        ? await exchangeBootstrapSecret(conn, handshakeRole)
        : undefined;
    bootstrap = { partnerSaveIntent, sharedSecret };
  }

  // Local computation: both parties' record counts were carried on the terms
  // exchange above (partnerRecordCount), so the role follows without a further
  // message.
  const resolvedRole = resolveRole(
    handshakeRole,
    linkageTerms.output,
    partnerTerms.output,
    rowCount,
    partnerRecordCount,
  );
  onProtocolConfirmed(partnerTerms, resolvedRole);

  const isReceiver = resolvedRole === "receiver";
  const linkageKeyIterables = linkageTerms.linkageKeys.map(
    (key, keyIndex) =>
      new StandardizedKeyIterable(key, dataset, rowCount, isReceiver, keyIndex),
  );

  // Per-message element-count caps for the PSI decode seams, from authenticated
  // session state only: the two exchanged record counts and the two advertised
  // effective key counts. The receiver (joiner) is the PSI sender's counterpart, so
  // the sender's set is the partner's when this party receives; both parties
  // compute identical bounds.
  const singlePassBounds = {
    partnerRecordCount,
    localEffectiveKeyCount,
    partnerEffectiveKeyCount,
  };
  const localSize = {
    effectiveKeyCount: localEffectiveKeyCount,
    recordCount: rowCount,
  };
  const partnerSize = {
    effectiveKeyCount: partnerEffectiveKeyCount,
    recordCount: partnerRecordCount,
  };
  const elementBounds = psiElementBounds(
    isReceiver ? partnerSize : localSize,
    isReceiver ? localSize : partnerSize,
  );

  // Single-pass association-table withholding, derived from symmetric
  // authenticated session state so both parties reach the same verdict: when the
  // resolved SENDER is a non-receiving helper (expectsOutput false) disclosing no
  // payload, it needs nothing back, so the receiver suppresses its
  // association-table half entirely and the sender skips awaiting it -- keeping a
  // genuinely blind helper blind to its own membership. The sender's properties
  // come from whichever side we are: our own when we are the sender, the partner's
  // (read off the terms exchange) when we are the receiver. A missing partner flag
  // (undefined -- a non-conforming peer that did not advertise it) defaults to
  // "discloses payload", so it never blinds a helper that needs its table. Only
  // consulted on the single-pass path (see withholdsSenderAssociationTable and
  // link.ts).
  const senderExpectsOutput = isReceiver
    ? partnerTerms.output.expectsOutput
    : linkageTerms.output.expectsOutput;
  const senderDisclosesPayload = isReceiver
    ? (partnerDisclosesPayload ?? true)
    : localDisclosesPayload;
  const withholdSenderTable = withholdsSenderAssociationTable(
    senderExpectsOutput,
    senderDisclosesPayload,
  );

  // Single-pass is allowlisted; any other value (including the default) runs the
  // cascade. No mismatch guard needed here -- validateCompatibility already
  // aborted upstream if the two parties' strategies differ. Single-pass takes the
  // exchanged bounds too: the partner's record count and both parties' effective
  // key counts derive the per-exchange frame cap, the abort-if-over-ceiling gate,
  // and the index-table layout, identically on both parties (see
  // linkViaSinglePassPSI and frameSize.ts).
  //
  // Build the crypto engine, then the participant, INSIDE the disposing try. The
  // engine psiEngineFactory returns is a worker (a worker_threads worker in the CLI, a
  // Web Worker in the browser) that must be terminated on every exit path. Evaluating
  // the factory as a constructor argument would spawn that worker BEFORE the
  // PSIParticipant constructor runs, so a throw in the constructor would orphan it;
  // building the engine first and disposing it in the finally when the participant
  // never took ownership makes "the worker is never orphaned" a structural guarantee
  // rather than a comment resting on the constructor happening not to throw. The
  // default in-process engine is built here too, from `library`, so the engine the
  // finally disposes is a real one on every path -- it holds the library's server or
  // client objects (the secret key among them) whether or not the participant took
  // ownership of it. Nothing above depends on the participant, so this ordering is
  // free.
  const psiRole = isReceiver ? "joiner" : "starter";
  const psiId = isReceiver ? "client" : "server";
  // The disclosure this round is built for, settled once from the agreed algorithm
  // and generated into the engine's key material rather than chosen when the result
  // is read: a count-only engine refuses the operations that would name a match, and
  // an identifier-revealing one refuses to report a cardinality, so a round cannot
  // resolve to the disclosure the other mode's terms agreed. It also rides the
  // receiver's request on the wire, where the partner's sender enforces agreement.
  const engineMode: PsiEngineMode = countOnly
    ? "count-only"
    : "identifier-revealing";
  const engine =
    options.psiEngineFactory?.(psiRole, psiId, engineMode) ??
    new InProcessPsiEngine(psiLibrary, psiRole, psiId, engineMode);

  let participant: PSIParticipant | undefined;
  let associationTable: AssociationTable | undefined;
  let intersectionCount: number | undefined;
  try {
    participant = new PSIParticipant(
      psiId,
      psiLibrary,
      { role: psiRole, verbose: verbosity },
      elementBounds,
      engine,
    );
    if (countOnly)
      // One round over one key, resolving to the intersection size and nothing that
      // names a match. The count-report leg is part of the same call: both parties
      // derive whether it runs from the agreed entitlements, so the receiver never
      // sends a frame the sender will not read and the sender never awaits one the
      // receiver will not send. The reported figure is bounded by the smaller of the
      // two exchanged record counts, which is authenticated session state on both
      // sides -- an intersection cannot exceed either party's dataset.
      intersectionCount = await linkViaCountOnlyPSI(
        participant,
        conn,
        linkageKeyIterables,
        reportsCountToSender(
          linkageTerms.output.expectsOutput,
          partnerTerms.output.expectsOutput,
        ),
        Math.min(rowCount, partnerRecordCount),
        verbosity,
        onStage,
      );
    else
      associationTable =
        linkageTerms.linkageStrategy === "single-pass"
          ? await linkViaSinglePassPSI(
              { cardinality },
              participant,
              conn,
              linkageKeyIterables,
              singlePassBounds,
              withholdSenderTable,
              verbosity,
              onStage,
            )
          : await linkViaPSI(
              { cardinality },
              participant,
              conn,
              linkageKeyIterables,
              partnerRecordCount,
              verbosity,
              onStage,
            );
  } finally {
    // Dispose the crypto engine once the PSI phase is done (or has thrown); the
    // participant is not used past this point. Disposing the participant frees its
    // engine -- the default in-process engine frees its library server/client objects
    // (the secret key among the WASM-heap state they hold), and a worker-backed engine
    // terminates its worker, so a ref'd worker handle can never hold the process open
    // at teardown. If the constructor threw before the participant took ownership,
    // dispose the engine directly -- whether psiEngineFactory spawned a worker or the
    // default in-process engine was built above, it is a live engine here and never
    // orphaned.
    if (participant !== undefined) participant.dispose();
    else engine.dispose();
  }

  // One entry per matched PAIR, in this party's own ascending row order, is what
  // every reader below assumes of the table -- the payload's transmitted rows, the
  // result file, and the attested result size. The cardinality resolved above
  // settles which multiplicities those readings admit; see
  // assertMatchedPairsWellFormed for the shapes that would break them.
  if (associationTable !== undefined)
    assertMatchedPairsWellFormed(associationTable, cardinality);

  // Send-gate: transmit payload only to a partner entitled to the result. A party
  // with expectsOutput:false learns no matched records, so it has no use for
  // payload values and must not receive them -- transmitting to it is a one-sided
  // disclosure to a non-receiving helper (docs/notes/one-sided-disclosure.md). The
  // disclosed columns are gathered (and the payload built) only when the partner
  // will receive output; otherwise an empty message goes on the wire and is
  // recorded as such. The disclosure is closed at the source here, not merely
  // declared empty.
  //
  // A count-only run has no association table to attach payload values to, and its
  // terms carry no payload column in either direction, so it exchanges the empty
  // message -- committed explicitly as empty, never omitted
  // (docs/spec/EXCHANGE_RECORD.md, Count-only records).
  const localPayload: PayloadWireMessage =
    partnerTerms.output.expectsOutput && associationTable !== undefined
      ? preparePayload(prepared.rawRows, prepared.metadata, associationTable)
      : { hasData: false };
  const partnerPayload = await exchangePayloads(
    conn,
    handshakeRole,
    localPayload,
  );

  // Received-payload enforcement, fail-closed before the result or audit record is
  // built (so a mismatched payload is never written to disk or surfaced):
  // - A count-only run locks in the empty column set unconditionally: psi-c
  //   refuses payload in either direction and its record's payload commitments
  //   are fixed present-and-empty (docs/spec/EXCHANGE_RECORD.md, Count-only
  //   (psi-c) records), so a transmitted column can never be lazily accepted
  //   here regardless of expectsOutput or any lock-in the prepare step carries.
  // - A no-output party (expectsOutput:false) must receive NO payload. The
  //   send-gate above keeps a conforming partner from sending any; expecting the
  //   empty set here closes it fail-closed against a non-conforming one.
  // - An output party enforces the column set it consented to receive (a fresh
  //   acceptor's carried disclosedPayloadColumns, or a persisted lock-in); a lazy
  //   one (expectedPayloadColumns undefined) takes whatever the sender's own
  //   disclosure metadata transmits.
  const expectedReceive = countOnly
    ? []
    : linkageTerms.output.expectsOutput
      ? prepared.expectedPayloadColumns
      : [];
  reconcileReceivedPayload(partnerPayload, expectedReceive);

  // resultSize (the intersection size) is bound only when both parties are
  // entitled to output; heldResult gates both the record's committed table and what
  // is returned to the caller, so it is one predicate. See the
  // ExchangeResult.associationTable JSDoc below for the disclosure rationale.
  const bothExpectOutput =
    linkageTerms.output.expectsOutput && partnerTerms.output.expectsOutput;
  const heldResult = linkageTerms.output.expectsOutput;

  // The intersection size this party can attest, whichever algorithm produced it: the
  // count is a count-only run's whole result, so it takes the result-size field the
  // matched table's length takes under `psi`, under the same unchanged entitlement
  // gate. A count-only run's record carries NO association-table commitment on either
  // side -- neither party holds a pairing to commit to, whatever its entitlement --
  // and that absence is normative rather than incidental (the commitment's presence
  // is what marks a party as having received the matched pairing). See
  // docs/spec/EXCHANGE_RECORD.md, Count-only records.
  const attestedResultSize = countOnly
    ? intersectionCount
    : associationTable === undefined
      ? undefined
      : matchedPairCount(associationTable);

  // What the signed-receipt step needs: a signing identity AND the session key
  // its binder derives from, resolved once here so the record build below and the
  // step itself read ONE predicate. That single predicate is what makes the
  // record's binder present exactly when a receipt exists to pair with it, so an
  // absent binder in a written record states that no receipt belongs to it --
  // which is what lets a verifier read an unpaired receipt as a mismatch rather
  // than as merely unchecked. The binder is derived here, before the record is
  // built, so both artifacts carry the one value; a failure derives nothing and
  // throws, unlike the record build below, because the signing step is fatal and
  // could not run without it.
  const signing =
    options.signingIdentity !== undefined && options.sessionKey !== undefined
      ? {
          identity: options.signingIdentity,
          sessionKey: options.sessionKey,
          // Both parties fold in the INITIATOR's role, so both derive the same
          // binder with no extra messages; see deriveReceiptBinder.
          binder: await deriveReceiptBinder(options.sessionKey, "initiator"),
        }
      : undefined;

  // Build the record after the exchange has fully succeeded. It is a secondary
  // audit artifact, so a failure to build it (e.g. an unexpected non-canonical
  // value) must not fail the exchange or discard its result: catch, warn, and
  // return without a record. The caller treats the audit field as optional.
  let audit: BuiltExchangeRecord | undefined;
  try {
    audit = await buildExchangeRecord({
      localTerms: linkageTerms,
      partnerTerms,
      recordsExposed: rowCount,
      resultSize: bothExpectOutput ? attestedResultSize : undefined,
      // Self-facing audit pointer from this party's local config; undefined when
      // unconfigured, in which case the record omits it.
      retentionDisposition,
      associationTable: heldResult ? associationTable : undefined,
      localPayloadSent: toCommittedPayload(localPayload),
      partnerPayloadReceived: toCommittedPayload(partnerPayload),
      createdAt: new Date().toISOString(),
      // The run's shared binder, so this record pairs with the receipt the step
      // below produces; omitted on every path that produces no receipt.
      receiptBinder: signing?.binder,
    });
  } catch (err) {
    getLogger("exchange").warn(
      "the exchange succeeded but the self-attested record could not be " +
        `built (${sanitizeErrorForDisplay(err)}); the ` +
        "result above is unaffected",
    );
  }

  // Signed-receipt step: at the conclusion of a successful exchange, both parties
  // sign the SAME canonical receipt content (the agreed-terms hash and the record
  // commitments, plus a session-derived binder) and swap signatures over the live
  // channel, producing one dual-signed record. Gated on a signing identity AND a
  // session key both being present, so the unsigned-record path -- the web app (no
  // keys) and a CLI exchange without a signing identity -- runs this function
  // unchanged. Unlike the audit record above, a failure here is NOT swallowed: a
  // fingerprint-pin or signature failure is a security event that terminates the
  // exchange (exchangeSignedReceipt throws a security ConnectionError). Placed
  // after exchangePayloads and the record build so the receipt commits to the full
  // result, including payloads.
  let signedReceipt: DualSignedRecord | undefined;
  if (signing !== undefined) {
    // The receipt content is built from the mutually-verifiable facts directly --
    // the agreed-terms hash and session-keyed MACs of the two directional payloads
    // -- NOT from the salted record commitments (per-party salts are not
    // byte-identical across parties). It is therefore independent of the non-fatal
    // audit build above; a party that could not build its local record can still
    // sign a receipt. The binder it signs is the same value the record above
    // carries, which is what pairs the two artifacts to this one run.
    const termsHash = await computeTermsHash(linkageTerms, partnerTerms);
    const content: ReceiptContent = await buildReceiptContent(
      handshakeRole,
      termsHash,
      toCommittedPayload(localPayload),
      toCommittedPayload(partnerPayload),
      signing.binder,
      signing.sessionKey,
    );
    signedReceipt = await exchangeSignedReceipt(conn, handshakeRole, {
      identity: signing.identity,
      pinnedFingerprint: options.partnerFingerprint,
      // The partner's agreed-terms identity (not the certificate's own), so the
      // pinned certificate must authorize the identity the partner used in the
      // agreed terms rather than a value it self-asserts in its certificate.
      partnerIdentity: partnerTerms.identity,
      content,
    });
  }

  return {
    // Withheld (undefined) from a party whose agreed terms give it no output, so
    // a non-receiving helper does not get the result table to write; the receiver
    // and both-output parties get it as before. Same predicate as the record gate.
    associationTable: heldResult ? associationTable : undefined,
    // The count-only run's whole result, under the same entitlement gate the table
    // takes: a party whose agreed terms give it no output does not receive the count
    // either. In a one-sided count-only run that party is the PSI sender, and the
    // count-report leg is suppressed for it upstream (reportsCountToSender), so this
    // gate is the entitlement predicate applied once more at the boundary rather than
    // the only thing standing between a helper and a count.
    intersectionCount: heldResult ? intersectionCount : undefined,
    partnerTerms,
    resolvedRole,
    partnerPayload,
    audit,
    bootstrap,
    signedReceipt,
  };
}
