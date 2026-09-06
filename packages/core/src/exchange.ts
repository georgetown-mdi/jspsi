import { getLogger } from "./utils/logger.js";
import {
  assertCountOnlyTransmitsNoColumn,
  inferMetadata,
  isDisclosedToPartner,
} from "./config/metadata.js";
import {
  assertBothSidedDeduplicateImplemented,
  assertCountOnlyTermsShape,
  assertDeduplicateImplemented,
} from "./linkageTermsPolicy.js";
import { getDefaultLinkageTerms } from "./defaults/builtInLinkageTerms.js";
import { getDefaultStandardization } from "./defaults/builtInStandardization.js";
import {
  buildStandardizedDataset,
  declaredEffectiveKeyCount,
  declaredKeyWidth,
  localFanOutFactor,
  StandardizedKeyIterable,
} from "./standardization.js";
import {
  assertFanOutImplemented,
  assertLinkageTermsSatisfiable,
  assertStandardizationMatchesTerms,
} from "./linkageSatisfiability.js";
import { columnValues, inferDateFormat } from "./utils/date.js";
import {
  redactAndSanitizeForDisplay,
  sanitizeErrorForDisplay,
} from "./utils/sanitizeErrorForDisplay.js";
import type { CSVRow } from "./file.js";
import { PSIParticipant } from "./psi/participant.js";
import type { PsiEngine, PsiEngineMode } from "./psi/psiEngine.js";
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
} from "./psi/link.js";
import type { LinkageCardinality } from "./psi/link.js";
import type { ResolvedRunShape } from "./pairTableProjection.js";
import { InProcessPsiEngine } from "./psi/psiEngine.js";
import {
  partyFansOut,
  psiElementBounds,
  SINGLE_PASS_LOCAL_REMEDY,
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
import {
  buildExchangeRecord,
  computeTermsHash,
} from "./records/exchangeRecord.js";
import {
  buildReceiptContent,
  deriveReceiptBinder,
  exchangeSignedReceipt,
  ReceiptVerificationError,
} from "./records/signedReceipt.js";
import { OperatorConfigError, UsageError, causeChainSome } from "./errors.js";
import type { Metadata, OwnColumnSelection } from "./config/metadata.js";
import type { LinkageTerms } from "./config/linkageTermsSchema.js";
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
import type { BuiltExchangeRecord } from "./records/exchangeRecord.js";
import { certificateAuthorizesIdentity } from "./records/signingIdentity.js";
import type {
  CertificateBody,
  SigningIdentity,
} from "./records/signingIdentity.js";
import { partnerPinIsPresent } from "./config/signing.js";
import type { SigningConfig, SigningMode } from "./config/signing.js";
import type {
  DualSignedRecord,
  ReceiptContent,
} from "./records/signedReceipt.js";

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
   * Optional self-facing retention/disposition pointer, held in the local
   * exchange config (NOT the agreed linkage terms): where this party files its
   * copy of the result and under what retention schedule. Threaded into the
   * self-attested record at the end of the exchange; never sent to the partner
   * and never folded into the agreed-terms hash.
   */
  retentionDisposition?: string;
  /**
   * The payload columns this party has locked in to receive: an accepted
   * invitation's `disclosedPayloadColumns`, or a persisted
   * `expectedPayloadColumns` (falling back to `payload.receive`). When set,
   * {@link runExchange} requires the partner's transmitted columns to match
   * it exactly ({@link reconcileReceivedPayload}); undefined accepts
   * whatever the sender transmits. Set by the caller, not
   * {@link prepareForExchange}. A party with `expectsOutput: false` always
   * receives none, regardless of this field.
   */
  expectedPayloadColumns?: string[];
  /**
   * The `deduplicate` an accepted invitation declared for the partner's
   * side. When set, {@link runExchange} refuses a partner terms value that
   * contradicts it, before any key or payload moves
   * ({@link assertPresentedDeduplicateMatchesInvitation}). Set by the
   * caller, not {@link prepareForExchange}. Undefined when no invitation
   * was accepted, where the two parties' own configs may legitimately
   * differ.
   */
  expectedPartnerDeduplicate?: boolean;
  /**
   * Which of this party's own input columns its result file holds beside
   * the partner's values, passed through from the local config's
   * `include_own_columns` to {@link buildOutputTable}. Undefined writes the
   * result the partner's values alone compose. Nothing about the exchange
   * itself reads it: no frame, no consent display, and no commitment
   * changes with it.
   */
  includeOwnColumns?: OwnColumnSelection;
  dataset: StandardizedDataset;
  /**
   * The original parsed CSV rows, retained for payload extraction after
   * linkage. Held in memory from ingestion through the end of
   * {@link runExchange}, roughly doubling peak memory versus holding only
   * the standardized dataset.
   */
  rawRows: Array<CSVRow>;
  rowCount: number;
}

/**
 * Refuse a linkage-terms `algorithm` this build has no run path for, before
 * any matched identifier is revealed. Allowlists `psi` (reveals matched
 * identifiers) and `psi-c` (count only, {@link linkViaCountOnlyPSI}); any
 * other value -- including one adopted verbatim from a partner's invitation
 * -- is refused so the self-attested record never attests a disclosure the
 * run did not make. Plain {@link UsageError}, not `OperatorConfigError`:
 * the accept path adopts the algorithm from the partner's invitation, so
 * the fault is not provably this operator's own config.
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
 * The refusal raised when the two parties' agreed terms name different
 * algorithms at the run boundary ({@link resolveCountOnlyRun}).
 *
 * A {@link ConnectionError} of kind `protocol`, not {@link UsageError}: this
 * party's own algorithm is its own config, so a divergence means the
 * partner proceeded past the terms-exchange compatibility abort -- a
 * protocol violation, not a local misconfiguration (CLI exit 69, not 64).
 * The message names only the fixed algorithm literals, never partner text.
 */
export class AlgorithmDivergenceError extends ConnectionError {
  constructor(message: string) {
    super(message, "protocol");
    this.name = "AlgorithmDivergenceError";
  }
}

/**
 * Resolve whether this exchange runs the count-only (`psi-c`) path, from
 * both parties' agreed terms, and refuse a count-only exchange outside the
 * shape docs/spec/PROTOCOL.md (PSI-C) admits.
 *
 * Symmetric: each party calls it with its own terms plus the partner's, so
 * a refusal aborts both parties at the same point rather than desyncing
 * the lockstep round -- the same shape as {@link resolveLinkageCardinality}.
 * A pair naming different algorithms is refused as an
 * {@link AlgorithmDivergenceError} rather than resolved to either value.
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
 * Requires an association table to hold well-formed matched pairs, before
 * {@link runExchange} consumes it: halves of equal length, a local
 * half in ascending order, no pair repeated, and a local row repeated only
 * where the given `cardinality` admits it. The payload, the result file,
 * and the attested result size all depend on this shape.
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
 * The result size a record attests for a matched table: its pair count.
 * Under `one-to-one` this equals both parties' matched-record counts; under
 * a deduplicating cardinality they diverge, and the pair count is the
 * figure both parties derive identically from the single exchanged table
 * (docs/spec/EXCHANGE_RECORD.md, Result size under a deduplicating
 * cardinality).
 */
export function matchedPairCount(associationTable: AssociationTable): number {
  return associationTable[0].length;
}

/**
 * Refuse agreed terms that declare a per-record candidate width
 * ({@link partyFansOut}) on a strategy matching a single value per record,
 * before anything goes on the wire: fan-out matching runs under
 * single-pass only (docs/spec/PROTOCOL.md, Fan-out runs under single-pass
 * only). Covers the width a fuzzy comparison declares, which
 * `assertFanOutImplemented` does not reach by step name. A
 * {@link UsageError}: the width is a function of terms the accept path
 * adopts wholesale.
 */
function assertDeclaredWidthMatchesStrategy(
  terms: LinkageTerms,
  effectiveKeyCount: number,
): void {
  if (terms.linkageStrategy === "single-pass") return;
  const keyCount = terms.linkageKeys.length;
  if (!partyFansOut(keyCount, { effectiveKeyCount })) return;
  throw new UsageError(
    "these linkage terms declare " +
      `${effectiveKeyCount} candidate value slot(s) per record against their ` +
      `${keyCount} linkage key(s), so a record may realize several candidates ` +
      "for a key, while they name a strategy that matches a single value per " +
      "record. Matching a candidate set runs under the single-pass linkage " +
      "strategy only. Remove the expanding step or fuzzy comparison from the " +
      "key's elements, or agree terms whose linkage_strategy is single-pass.",
  );
}

/**
 * Refuse a `signing.mode` the exchange has no run path for, before it
 * runs. Allowlists `certificate` (signs and swaps a dual-signed receipt)
 * and `none`; `session-derived` and any other value would otherwise
 * complete the exchange and leave the operator the ordinary unsigned
 * record with no signal that the receipt it asked for was never produced.
 * An {@link OperatorConfigError}: `signing` is always this party's own
 * config, never adopted from the partner.
 */
export function assertSigningModeImplemented(
  mode: SigningMode | undefined,
): void {
  if (mode === undefined || mode === "none" || mode === "certificate") return;
  throw new OperatorConfigError(
    'this receipt signing mode is not yet implemented: only "certificate" ' +
      'signing produces a receipt, and a "session-derived" MAC or any other ' +
      "non-certificate mode is refused before the exchange runs. Set " +
      'signing.mode to "certificate" to sign receipts, or to "none" to run ' +
      "unsigned.",
  );
}

/**
 * Refuse a `certificate`-mode exchange that pins no partner fingerprint,
 * before it runs. The signature swap runs after payloads have crossed and
 * rejects unconditionally on an absent pin, so an unpinned run sends this
 * party's data and terminates with no result and no receipt, keeping at
 * most the self-attested record of that disclosure
 * ({@link exchangeRecordFromFailure}). An {@link OperatorConfigError}:
 * `signing` is always this party's own config. Scoped to `certificate`
 * mode; `none` and an absent block need no pin.
 */
export function assertCertificateModePinsPartner(
  signing: SigningConfig | undefined,
): void {
  if (signing?.mode !== "certificate") return;
  if (partnerPinIsPresent(signing.partnerFingerprint)) return;
  throw new OperatorConfigError(
    "this exchange signs receipts (signing.mode: certificate) but pins no " +
      "partner fingerprint, so it cannot finish: the two sides swap signatures " +
      "after the payloads have crossed, and the certificate the partner " +
      "presents there is refused when nothing is on file to check it against. " +
      "The run would stop having sent this party's data and having written no " +
      "result and no receipt, keeping at most the exchange record of that " +
      "disclosure -- and, where record writing is off, nothing at all. Obtain " +
      "the partner's fingerprint out-of-band -- they " +
      "produce it with 'psilink fingerprint' " +
      '-- and set signing.partner_fingerprint, or set signing.mode to "none" ' +
      "to run unsigned until you hold it.",
  );
}

/**
 * Refuse a `certificate`-mode exchange whose own agreed terms name no
 * party, before it runs. A certificate is trusted by the identity its
 * holder used in the agreed terms, so an unnamed party has nothing for
 * its partner to authorize the certificate against. Held to the resolved
 * `localTerms`, not the identity argument {@link prepareForExchange}
 * takes, since that is what the run puts on the wire. The partner's half
 * is decided at the terms exchange, by
 * {@link assertSignedReceiptNamesBothParties}. An {@link OperatorConfigError}.
 */
export function assertCertificateModeNamesLocalParty(
  signing: SigningConfig | undefined,
  localTerms: LinkageTerms,
): void {
  if (signing?.mode !== "certificate") return;
  if (localTerms.identity !== undefined) return;
  throw new OperatorConfigError(
    "this exchange signs receipts (signing.mode: certificate) but names no " +
      "party, so it cannot finish: a receipt names both parties, and the " +
      "certificate this party presents is trusted by the identity it used in " +
      "the agreed terms -- an unnamed party leaves the partner nothing to " +
      "check that certificate against. The run would stop at terms agreement, " +
      "with no result, no exchange record, and no receipt written. Set " +
      "linkage_terms.identity to this party's name -- or pass --identity, " +
      'where the interface takes one -- or set signing.mode to "none" to run ' +
      "unsigned.",
  );
}

/**
 * Refuse a run that will sign a receipt when either party's agreed terms
 * hold no identity: a certificate is trusted by the identity its holder
 * used in the agreed terms, so an unnamed party has nothing for the pin to
 * authorize. Called at two points over the same pair -- the terms
 * exchange, before the bootstrap frame or any key or payload moves, and
 * the signature swap itself. A {@link ReceiptVerificationError}: the
 * failing binding may be the partner's, not this party's config. Returns
 * the two names it held to being present.
 */
export function assertSignedReceiptNamesBothParties(
  localTerms: LinkageTerms,
  partnerTerms: LinkageTerms,
): { local: string; partner: string } {
  if (localTerms.identity !== undefined && partnerTerms.identity !== undefined)
    return { local: localTerms.identity, partner: partnerTerms.identity };
  throw new ReceiptVerificationError(
    "a signed receipt names both parties, and " +
      (localTerms.identity === undefined
        ? partnerTerms.identity === undefined
          ? "neither party's agreed terms name an identity"
          : "this party's agreed terms name none"
        : "the partner's agreed terms name none") +
      ". A certificate is trusted by the identity its holder used in the " +
      "agreed terms, so an unnamed party cannot present or verify one: set " +
      "linkage_terms.identity on both sides, or run without receipt signing.",
  );
}

/**
 * Refuse a run whose own signing certificate does not authorize the
 * identity in this party's agreed terms: a certificate bound to
 * any other name signs a receipt that verifies nowhere, including its own
 * `verify-receipt`. Applied at the terms exchange, before any linkage key
 * or payload row crosses, and again at the swap
 * ({@link assertReceiptBindingsOrAbort}). An {@link OperatorConfigError},
 * not {@link ReceiptVerificationError}: both disagreeing values are this
 * party's own, nothing partner-controlled. The message names both values,
 * last, after the remedy.
 */
export function assertLocalCertificateAuthorizesAgreedIdentity(
  certificate: CertificateBody,
  agreedIdentity: string,
): void {
  if (certificateAuthorizesIdentity(certificate, agreedIdentity)) return;
  throw new OperatorConfigError(
    "this party's signing certificate does not authorize the identity it " +
      "agreed terms under, so it cannot finish: a certificate is trusted by " +
      "the identity its holder used in the agreed terms, so the partner " +
      "authorizes the presented certificate against that name and refuses it, " +
      "and a receipt signed under it verifies nowhere. Set " +
      "linkage_terms.identity to the name on the certificate, or sign " +
      "with an identity bound to the name in the agreed terms. The " +
      `certificate is bound to "${certificate.identity}"; the agreed terms ` +
      `name "${agreedIdentity}".`,
  );
}

// The abort reasons the two local receipt bindings send. Fixed literals, as
// every reason on this frame must be (see sendAbort): the frame is a
// disclosure to the partner like any other, so neither names a value.
const UNNAMED_PARTY_ABORT_REASON =
  "a signed receipt names both parties and one side's agreed terms name no " +
  "identity";
const CERTIFICATE_DIVERGENCE_ABORT_REASON =
  "a signing certificate does not authorize the identity its holder agreed " +
  "terms under";

/**
 * Hold the two receipt bindings that follow from the agreed terms alone --
 * both parties named ({@link assertSignedReceiptNamesBothParties}) and
 * this party's own certificate authorizing the name it agreed terms under
 * ({@link assertLocalCertificateAuthorizesAgreedIdentity}) -- sending the
 * partner a best-effort abort before either refusal propagates. Applied at
 * the terms exchange and again at the signature swap, over the same three
 * values, so the two points cannot drift into different predicates or
 * abort reasons. Returns the two names.
 *
 * @internal exported for the swap-side abort test, which cannot reach this
 *   point through `runExchange`: the terms-exchange application refuses
 *   the same inputs first.
 */
export async function assertReceiptBindingsOrAbort(
  conn: MessageConnection,
  localTerms: LinkageTerms,
  partnerTerms: LinkageTerms,
  certificate: CertificateBody,
): Promise<{ local: string; partner: string }> {
  let namedParties: { local: string; partner: string };
  try {
    namedParties = assertSignedReceiptNamesBothParties(
      localTerms,
      partnerTerms,
    );
  } catch (err) {
    await sendAbort(conn, [UNNAMED_PARTY_ABORT_REASON]);
    throw err;
  }
  try {
    assertLocalCertificateAuthorizesAgreedIdentity(
      certificate,
      namedParties.local,
    );
  } catch (err) {
    await sendAbort(conn, [CERTIFICATE_DIVERGENCE_ABORT_REASON]);
    throw err;
  }
  return namedParties;
}

/**
 * The refusal raised when a partner presents a `deduplicate` its
 * invitation did not declare
 * ({@link assertPresentedDeduplicateMatchesInvitation}).
 *
 * A {@link ConnectionError} of kind `protocol`, not {@link UsageError}:
 * the contradiction is between two documents the partner authored (CLI
 * exit 69, not 64). Has `psilinkRecoveryHintEmitted` so the CLI's
 * hint-walker suppresses the generic "retry without re-inviting" advisory
 * -- this refusal is terminal against the held invitation and would
 * otherwise loop an unattended recurring exchange.
 */
export class InvitationTermDivergenceError extends ConnectionError {
  readonly psilinkRecoveryHintEmitted = true;

  constructor(message: string) {
    super(message, "protocol");
    this.name = "InvitationTermDivergenceError";
  }
}

/**
 * Bind the `deduplicate` a partner presents at the terms exchange to the
 * value its invitation declared, for a run reached by accepting one: a
 * value presented as `true` where the invitation declared `false` widens
 * what this party's records disclose beyond what was consented to.
 * Refused before any key or payload moves. Scoped to the invitation path:
 * `undefined` ({@link PreparedExchange.expectedPartnerDeduplicate}) is a
 * no-op, since a config-authored exchange states no declaration to hold
 * the partner to.
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
 * Resolve the matching cardinality {@link runExchange} passes to the
 * linkage strategies, from the two parties' agreed `deduplicate`
 * settings. The label is read from the calling party's own side, so the
 * two parties hold mirror labels for one procedure
 * (docs/spec/PROTOCOL.md, Deduplicating cardinalities): `(true, false)`
 * gives the declaring party `many-to-one`; `(true, true)` gives
 * `many-to-many`, which {@link assertBothSidedDeduplicateImplemented}
 * requires a matching strategy for. A refusal is symmetric and aborts
 * both parties at this point.
 */
export function resolveLinkageCardinality(
  localTerms: LinkageTerms,
  partnerTerms: LinkageTerms,
): LinkageCardinality {
  assertDeduplicateImplemented(localTerms);
  assertDeduplicateImplemented(partnerTerms);
  assertBothSidedDeduplicateImplemented(localTerms, partnerTerms);
  if (localTerms.deduplicate && partnerTerms.deduplicate) return "many-to-many";
  if (localTerms.deduplicate) return "many-to-one";
  if (partnerTerms.deduplicate) return "one-to-many";
  return "one-to-one";
}

/**
 * The metadata and linkage terms an exchange resolves from its spec: the
 * config's own where it holds them, else the ones derived from this
 * run's input columns. The single definition {@link prepareForExchange}
 * itself uses, exported so a front end that must inspect either before
 * preparing -- the outbound-payload confirmation -- resolves them exactly
 * as the run does.
 */
export function resolveExchangeInputs(
  exchangeDataSpec: ExchangeDataSpec,
  identity: string | undefined,
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
 * - Fails closed when the input cannot satisfy every linkage key the agreed terms
 *   declare (see {@link assertLinkageTermsSatisfiable}).
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
  identity: string | undefined,
  rawRows: Array<CSVRow>,
  columnNames: Array<string>,
): PreparedExchange {
  const log = getLogger("exchange");

  const { metadata, linkageTerms } = resolveExchangeInputs(
    exchangeDataSpec,
    identity,
    columnNames,
  );

  // Fail closed on an algorithm with no run path before any credential,
  // terms, or data are sent. Refused again at the run boundary (runExchange)
  // so the refusal holds for a PreparedExchange built without this
  // function. See assertAlgorithmImplemented.
  assertAlgorithmImplemented(linkageTerms.algorithm);

  // The local prepare step of the count-only shape refusal; the other is
  // the agreed-terms run boundary (resolveCountOnlyRun). Both run over
  // metadata resolved above, so the transmit rule is never asked of an
  // unresolved block. A no-op on every `psi` exchange. See
  // assertCountOnlyTermsShape and assertCountOnlyTransmitsNoColumn.
  assertCountOnlyTermsShape(linkageTerms);
  assertCountOnlyTransmitsNoColumn(linkageTerms.algorithm, metadata);

  // Fail closed on a deduplicating term the agreed strategy cannot match,
  // before any credential, terms, or data are sent. Refused again from
  // both parties' agreed terms in runExchange (resolveLinkageCardinality).
  // See assertDeduplicateImplemented.
  assertDeduplicateImplemented(linkageTerms);

  // Fail closed on a signing mode with no run path: only certificate mode
  // signs a receipt, so a session-derived block would otherwise run to
  // completion and leave the operator the unsigned record they did not
  // ask for. See assertSigningModeImplemented.
  assertSigningModeImplemented(exchangeDataSpec.signing?.mode);

  // Fail closed when certificate mode pins no partner: the signature swap
  // runs after the payloads have crossed and rejects any certificate
  // against an absent pin, terminating the run with no result and no
  // receipt. See assertCertificateModePinsPartner.
  assertCertificateModePinsPartner(exchangeDataSpec.signing);

  // Fail closed when certificate mode names no party: a certificate is
  // trusted by the identity its holder used in the agreed terms, so the
  // signature swap refuses an unnamed side after the payloads have
  // crossed. See assertCertificateModeNamesLocalParty.
  assertCertificateModeNamesLocalParty(exchangeDataSpec.signing, linkageTerms);

  // Reject a payload data dictionary that does not match what metadata
  // transmits: metadata's isPayload/role is the single source of truth for
  // what leaves the machine. A no-op on the default and guided paths,
  // which author no payload block. See assertPayloadSendDisclosed.
  assertPayloadSendDisclosed(
    linkageTerms.payload,
    metadata,
    linkageTerms.output,
  );

  // Reject a disclosed column whose name is too long to carry, before the
  // frame is sent. Refused again at the run boundary (runExchange), so the
  // refusal holds for a PreparedExchange built without this function. See
  // assertDisclosedNamesCarriable.
  assertDisclosedNamesCarriable(metadata, linkageTerms.output);

  // Fail fast when this party cannot produce a payload disclosure it
  // committed to on a prior invitation (disclosedPayloadColumns): a
  // metadata drift here would otherwise make the partner abort mid-exchange
  // (reconcileReceivedPayload). A no-op when no commitment is on record.
  // See assertDisclosureMatchesCommitment.
  assertDisclosureMatchesCommitment(
    exchangeDataSpec.disclosedPayloadColumns,
    metadata,
  );

  // Fail closed on an outbound payload set this party has not confirmed.
  // An acceptor's own send set is authored by no party, so a recorded
  // confirmation is what makes it chosen rather than inferred. A no-op for
  // every party with no consent record. See assertOutboundPayloadConsented.
  assertOutboundPayloadConsented(
    exchangeDataSpec.outboundPayloadConsent,
    metadata,
    linkageTerms.output,
  );

  // The effective key count the agreed terms declare: the sum over their
  // keys of the width each key's elements declare. Sizes the pre-flight
  // gate below.
  const effectiveKeyCount = declaredEffectiveKeyCount(linkageTerms);

  let dateInputFormat: string | undefined;
  if (exchangeDataSpec.standardization === undefined) {
    // Only a `role: linkage` date_of_birth column participates in linkage,
    // so only one may drive the inferred date format.
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
  // and the exit-64 / web-display contract). Gated on an authored
  // standardization: the terms-only path (undefined) reconstructs one from the
  // terms via getDefaultStandardization above and so cannot contradict them, and
  // is not gated. The same shared assert runs at the `psilink invite`
  // mint boundary, so `invite` never discloses a token this exchange would refuse.
  if (exchangeDataSpec.standardization !== undefined)
    assertStandardizationMatchesTerms(
      exchangeDataSpec.standardization,
      linkageTerms,
    );

  // Fail closed when this input cannot satisfy every linkage key the agreed
  // terms declare -- a key whose fields the columns cannot produce, a key whose
  // own declared cleaning drops every record, or terms declaring no key at all.
  // Such a run would match fewer keys than both parties consented to while its
  // record still names every declared field, so the shortfall is resolved with
  // the partner out of band instead. Fires before any credential, terms, or
  // data are sent. Graded over the AUTHORED standardization rather than the
  // resolved default just below, so a front end grading the same spec earlier
  // cannot disagree with this gate; ordered behind the standardization/terms
  // contradiction above, so an authored transform whose output names no
  // declared field is reported as that rather than as the unsatisfied field it
  // leaves behind. See assertLinkageTermsSatisfiable.
  assertLinkageTermsSatisfiable(
    columnNames,
    linkageTerms,
    exchangeDataSpec.standardization,
    metadata,
  );

  // Fail closed on a transform that fans one value out into several match
  // candidates under a strategy that matches one value per record: the splitting
  // record's candidate set has no round to enter there, and the run would abort
  // once it reached one. Run over the RESOLVED standardization (authored or
  // default, which declares no fan-out) plus the terms' element transforms, so
  // both authoring paths are covered; the terms half is refused again at the
  // run boundary. See assertFanOutImplemented.
  assertFanOutImplemented(linkageTerms, standardization);

  // Pre-flight the single-pass dataset ceiling: a coarse, ONE-PARTY lower
  // bound. It sees only this party's own row count, never the partner's or
  // either side's distinct-value counts (not computed locally or exchanged),
  // so it cannot replace the authoritative, symmetric two-party check in
  // linkViaSinglePassPSI, which runs once both record counts are exchanged.
  // Applies to either role: the ceiling is symmetric (a receiver holds both
  // encrypted sets resident, bounded exactly as the sender's), so this
  // party's own count predicts an abort regardless of which side it plays.
  //
  // Ordered behind the fan-out refusal above, so a fan-out a strategy cannot
  // match is refused for that rather than for size. An OperatorConfigError
  // naming only this party's own counts and a fixed constant -- no
  // partner-authored content, so the accept path never echoes invitation
  // text through it.
  //
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

  // The count this party declares, which is what the ceiling weighs and what the
  // partner reads: its rows times the factor its own cleaning fans them out by.
  // The dataset is what reports that factor, so a fan-out on a field no linkage
  // key reads declares nothing.
  const declaredRecordCount =
    rawRows.length * localFanOutFactor(dataset.declaresFanOut);

  if (
    linkageTerms.linkageStrategy === "single-pass" &&
    singlePassDatasetExceedsCap(effectiveKeyCount, declaredRecordCount)
  ) {
    throw new OperatorConfigError(
      `single-pass linkage cannot carry this dataset: ${declaredRecordCount} ` +
        `declared record(s) across ${linkageTerms.linkageKeys.length} linkage ` +
        `key(s) exceed the single-pass ceiling. ${SINGLE_PASS_LOCAL_REMEDY}` +
        (partyFansOut(linkageTerms.linkageKeys.length, { effectiveKeyCount }) ||
        dataset.declaresFanOut
          ? " A linkage key whose elements expand counts its whole declared " +
            "width toward that ceiling, and cleaning that fans out declares " +
            "the records it stands for, so removing a fan-out is another " +
            "remedy."
          : ""),
    );
  }

  return {
    metadata,
    linkageTerms,
    // A self-facing operator note, passed through untouched from the local
    // config to the record builder; absent when the config omits it.
    retentionDisposition: exchangeDataSpec.retentionDisposition,
    // A local output-composition setting, passed through untouched from the
    // local config to the result formatter; absent when the config omits it.
    includeOwnColumns: exchangeDataSpec.includeOwnColumns,
    // The two invitation commitments -- expectedPayloadColumns (the
    // received-payload set) and expectedPartnerDeduplicate (the partner's
    // declared cardinality side) -- are NOT threaded here, unlike
    // retentionDisposition above. The caller sets each on the returned
    // PreparedExchange after this returns: the accept path's source is the
    // invitation token (not this dataSpec), and the recurring path applies a
    // fallback for the payload set (config expectedPayloadColumns, else
    // payload.receive). A caller that wants a commitment must set it
    // explicitly; see PreparedExchange.expectedPayloadColumns and
    // PreparedExchange.expectedPartnerDeduplicate. (Both ride ExchangeDataSpec
    // only so the exchange command can read them off the parsed config.)
    dataset,
    rawRows,
    rowCount: rawRows.length,
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
   * The size of the intersection, and the whole result of a count-only
   * (`psi-c`) exchange: present exactly when this party ran one AND its agreed
   * terms entitle it to output. `undefined` on every `psi` exchange, whose
   * result is the association table above.
   *
   * Distinguishes a count-only receiver from the withheld-helper shape:
   * `associationTable` stays undefined for BOTH parties on a count-only run
   * (there is no pairing for either to hold), so this field alone tells a
   * count-only helper (receives nothing) from a count-only receiver.
   *
   * Presence follows this party's OWN entitlement, not the both-entitled gate
   * the record's result size takes: a one-sided run's receiver holds a count
   * its own record omits (docs/spec/EXCHANGE_RECORD.md, Count-only records).
   * The sender's copy, when present, is the receiver's report, not a figure it
   * computed itself (docs/spec/PROTOCOL.md, PSI-C).
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
   * threw after the exchange already disclosed, in which case the caller skips
   * persisting -- the record is a secondary audit artifact, so its failure is
   * non-fatal and never discards the exchange result.
   *
   * This is the returning half of the record's delivery. A run that terminates
   * after its payload exchange never reaches this field, and hands the same pair
   * to the caller on its thrown error instead; see
   * {@link exchangeRecordFromFailure}.
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

// Where a terminated run's self-attested record waits for the caller that catches
// the throw. A WeakMap rather than a property on the error: the error is raised by
// a post-disclosure step or by the transport under it, and none of those is this
// module's to mutate -- a frozen or proxied error would refuse the write, and an
// own property would show up in whatever enumerates or serializes the error later.
// The entry lives exactly as long as the error object does.
const recordsByTerminatedRun = new WeakMap<object, BuiltExchangeRecord>();

// The other half of the same answer: the terminated runs that owed a record and
// whose build of it threw. Kept beside the map rather than as a sentinel inside
// it so the record-bearing accessor's return type stays exactly what a caller
// already handles, and so "nothing was owed" and "what was owed could not be
// built" stop sharing one undefined.
const unbuiltRecordsByTerminatedRun = new WeakSet<object>();

/**
 * The self-attested record of the disclosure a terminated run had ALREADY made,
 * recovered from the error {@link runExchange} threw; `undefined` when the failure
 * holds none.
 *
 * A run past its payload exchange has already sent and received its payloads, so
 * the disclosure the record attests occurred whatever the steps after it then do.
 * The record is owed from that point (docs/spec/PROTOCOL.md, Self-attested
 * record), so the caller persists this pair exactly as it persists
 * {@link ExchangeResult.audit}: the run still failed, and the record's own
 * `outcome` field states that rather than passing for a completed run's.
 *
 * A failure raised BEFORE the payload exchange returns holds nothing, this
 * party's own payload having possibly crossed inside it -- the initiator sends
 * before it receives, and a cut in that window leaves no record (the durability
 * point's stated residual: docs/spec/EXCHANGE_RECORD.md, When a record is owed).
 *
 * The lookup walks the `cause` chain, so a caller that re-raises the failure with
 * the original as its `cause` still recovers the record.
 */
export function exchangeRecordFromFailure(
  error: unknown,
): BuiltExchangeRecord | undefined {
  let found: BuiltExchangeRecord | undefined;
  causeChainSome(error, (link) => {
    found = recordsByTerminatedRun.get(link);
    return found !== undefined;
  });
  return found;
}

/**
 * Whether the terminated run behind `error` owed a self-attested record that
 * could not be built, so {@link exchangeRecordFromFailure} returns nothing for a
 * disclosure that nonetheless occurred.
 *
 * True only past the payload exchange: the record was owed (docs/spec/PROTOCOL.md,
 * Self-attested record) and {@link buildExchangeRecord} threw, which the build
 * warns about on the operator log with its cause. This is the same loss the
 * completed path reports as a missing artifact, made queryable on the failing path
 * so a caller can report it on a machine interface rather than only in a log line
 * an unattended run discards. False when the failure owed no record at all, and
 * false once the record is in hand -- the two answers a bare `undefined` from
 * {@link exchangeRecordFromFailure} cannot tell apart.
 *
 * The lookup walks the `cause` chain, as its record-bearing sibling does.
 */
export function exchangeRecordOwedButUnbuilt(error: unknown): boolean {
  return causeChainSome(error, (link) =>
    unbuiltRecordsByTerminatedRun.has(link),
  );
}

/**
 * `error`, marked for the two accessors above: holding `audit` where the record
 * built, and recording the loss where it did not, so a caller can tell that
 * absence from a failure that owed no record. A thrown non-object can hold
 * neither mark, which is warned here: what goes missing is the operator's
 * disclosure-log entry for a disclosure that happened.
 */
function carryingExchangeRecord(
  error: unknown,
  audit: BuiltExchangeRecord | undefined,
): unknown {
  if (typeof error !== "object" || error === null) {
    // Warned only where a record exists and is now unreachable; a record that
    // never built already warned at its build, with the cause this cannot name.
    if (audit !== undefined)
      getLogger("exchange").warn(
        "the exchange disclosed and then failed, and the failure is not an " +
          "object this run's self-attested record could be attached to; no " +
          "record is available to write for a disclosure that occurred",
      );
    return error;
  }
  if (audit === undefined) {
    unbuiltRecordsByTerminatedRun.add(error);
    return error;
  }
  recordsByTerminatedRun.set(error, audit);
  return error;
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
 * Both front ends read this one predicate rather than each restating the role
 * rule: it decides whether the seat's completion copy holds the
 * trust-contingent caveat, and a second reading that disagreed would caveat a
 * locally computed count or present a reported one as this party's own
 * finding.
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
   * Called once after the confirming-protocol stage completes, before the first
   * PSI key stage begins. Useful for reporting partner identity and resolved
   * role without waiting for the full exchange to finish.
   *
   * `runShape` holds what the agreed terms resolved to at this same point --
   * the matching cardinality, the two record counts its derived pair table
   * grows with, and the entitlements deciding which party holds that table and
   * what the other one reads of the match -- so a front end can name the run's
   * cardinality and project that table before the first round. Nothing here
   * refuses or warns on either: the pair-table advisory is a front end's
   * discretion (docs/spec/PROTOCOL.md, The both-sided expansion has no ceiling
   * of its own), and {@link describeResolvedRunShape} is the shared composition
   * each seat renders.
   */
  onProtocolConfirmed?: (
    partnerTerms: LinkageTerms,
    resolvedRole: PsiRole,
    runShape: ResolvedRunShape,
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
   * non-fatal -- the exchange continues -- so a caller reports it as a warning
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
   * not shown: they are unusable, and echoing partner-controlled content into a
   * log is an injection risk.
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

  // Last line of defense for the disclosure-integrity guarantee: refuse an
  // algorithm with no run path before anything goes on the wire, so the
  // self-attested record can never attest a disclosure the run did not make.
  // prepareForExchange refuses it at prepare time; this holds even for a
  // PreparedExchange constructed without going through it, and fires before the
  // terms exchange puts anything on the wire. The partner's half of the same
  // question is decided after the terms exchange, from the agreed pair
  // (resolveCountOnlyRun). See assertAlgorithmImplemented.
  assertAlgorithmImplemented(linkageTerms.algorithm);

  // Refuse a count-only exchange whose input metadata would transmit a column
  // before anything goes on the wire, over the RESOLVED metadata a
  // PreparedExchange always holds -- the rule fails open on an unresolved
  // block, and this is the boundary that holds one. prepareForExchange refuses
  // it at prepare time; this holds for a PreparedExchange assembled without
  // going through it. See assertCountOnlyTransmitsNoColumn.
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

  // What the signed-receipt step needs: a signing identity to sign with AND the
  // session key its binder derives from. Read as ONE predicate, here, so the
  // terms-time identity refusal below, the record build, and the swap itself all
  // gate on the same reading rather than on copies that could drift apart.
  const { signingIdentity, sessionKey } = options;
  const willSignReceipt =
    signingIdentity !== undefined && sessionKey !== undefined;

  // Whether THIS party will disclose payload to a partner entitled to output:
  // true when its metadata transmits any column (isDisclosedToPartner, the single
  // source of truth preparePayload gathers on). Advertised on the terms exchange
  // so the partner can gate the single-pass association-table withholding on it --
  // payload disclosure is per-party-local and lazy, so the partner cannot infer it
  // and needs the explicit, authenticated signal (see the withhold gate below).
  const localDisclosesPayload = prepared.metadata.some(isDisclosedToPartner);

  // The per-key candidate widths the agreed terms declare, and their sum. Both
  // parties derive them from terms they have both agreed, so nothing about width
  // rides the wire and neither party reads the other's declaration.
  const keyWidths = linkageTerms.linkageKeys.map((key, keyIndex) =>
    declaredKeyWidth(key, keyIndex),
  );
  const effectiveKeyCount = declaredEffectiveKeyCount(linkageTerms);

  // This party's own cleaning fan-out, declared as the records it stands for
  // rather than as width: the count that rides the envelope, resolves the role,
  // and multiplies into every bound derived for this side.
  const localFactor = localFanOutFactor(prepared.dataset.declaresFanOut);
  const declaredRecordCount = rowCount * localFactor;

  // Refuse a declared width on a strategy that cannot match a candidate set,
  // before anything goes on the wire. See assertDeclaredWidthMatchesStrategy.
  assertDeclaredWidthMatchesStrategy(linkageTerms, effectiveKeyCount);

  onStage(CONFIRMING_PROTOCOL_STAGE_ID);
  const {
    partnerTerms,
    warnings,
    partnerRecordCount,
    partnerSaveIntent,
    partnerDisclosesPayload,
    partnerHostKey,
    partnerHostKeyMalformed,
  } = await exchangeTerms(
    conn,
    handshakeRole,
    linkageTerms,
    declaredRecordCount,
    options.saveIntent,
    options.observedHostKey,
    localDisclosesPayload,
  );
  for (const warning of warnings) onWarning(warning);

  // Hold the partner's presented `deduplicate` to what its invitation declared,
  // where this run came from accepting one: the term is per-party, so no
  // compatibility rule compares the two sides, and the value this party consented
  // to is the invitation's rather than whatever arrives here. Before the
  // cardinality is resolved from it, and before any key or payload moves. A no-op
  // on an exchange authored from configuration files, which states no
  // declaration. See assertPresentedDeduplicateMatchesInvitation.
  try {
    assertPresentedDeduplicateMatchesInvitation(
      prepared.expectedPartnerDeduplicate,
      partnerTerms.deduplicate,
    );
  } catch (err) {
    // Best-effort abort before the throw, as every refusal inside exchangeTerms
    // sends one. This refusal is one-sided -- only this party holds the
    // declaration -- so without it the partner would wait out its full
    // peer-inactivity budget (a full poll budget on a file channel) for rounds
    // this party never runs. The reason is a fixed literal about values the
    // partner itself declared, so the frame discloses nothing new. What the
    // partner sees from that arrival is not a refusal at all: the frame reaches
    // its PSI binary boundary still awaiting its next round, so that run ends
    // with the PSI library's own "Type not convertible to a Uint8Array" error,
    // with no psilink framing or cause attached -- fast-fail without diagnosis.
    // Classifying that decode failure is follow-on work, not a property this
    // branch claims.
    await sendAbort(conn, [
      "partner presented a deduplicate its invitation did not declare",
    ]);
    throw err;
  }

  // A run that will sign a receipt needs both parties named and its own
  // certificate bound to the name it agreed terms under. Both are decided the
  // moment the partner's terms arrive, so both are held here, at the same point
  // and for the same reason as the deduplicate check above: before the bootstrap
  // frame, before any linkage key, and before any payload row moves. The
  // signature swap holds the same pair again at the point of use. See
  // assertReceiptBindingsOrAbort.
  if (willSignReceipt)
    await assertReceiptBindingsOrAbort(
      conn,
      linkageTerms,
      partnerTerms,
      signingIdentity.certificate,
    );

  // Resolve the matching cardinality from both parties' agreed deduplicate
  // settings as the first step after the terms exchange: the resolution is
  // symmetric, so a refusal (a deduplicating term under a strategy that honors
  // none, or the both-sided pair under one that pairs no many-to-many) aborts
  // BOTH parties at this same point -- before the bootstrap frame and the PSI
  // rounds -- rather than desyncing the lockstep. See resolveLinkageCardinality.
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
  // they observed on the terms exchange just above; compare them, and report a
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

  // Local computation: both parties' DECLARED record counts were already
  // exchanged above (partnerRecordCount), so the role follows without a
  // further message. It is the declared count on both sides, so a party whose own
  // cleaning fans out is weighed at the larger figure and trends toward SENDER,
  // in proportion to the work its fan-out actually costs -- away from the
  // single-pass receiver's sole-resolver seat, which is what leaves a count no
  // partner can check nothing to buy (docs/spec/PROTOCOL.md, Role resolution and
  // work minimization).
  const resolvedRole = resolveRole(
    handshakeRole,
    linkageTerms.output,
    partnerTerms.output,
    declaredRecordCount,
    partnerRecordCount,
  );
  const isReceiver = resolvedRole === "receiver";

  // Single-pass association-table withholding, derived from symmetric
  // authenticated session state so both parties reach the same verdict: when the
  // resolved SENDER is a non-receiving helper (expectsOutput false) disclosing no
  // payload, it needs nothing back, so the receiver suppresses its
  // association-table half entirely and the sender skips awaiting it -- keeping a
  // blind helper blind to its own membership. The sender's properties
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

  // This is where a front end reads the run's resolved shape. It holds the two
  // entitlements as well as the cardinality because the copy composed from it
  // speaks about a result file and about what the partner reads, and neither
  // follows from the cardinality: this party's own entitlement is the same
  // predicate that decides whether it is handed an association table at all
  // (heldResult, below), and the partner reads nothing of the match where its own
  // half is the withheld one -- the single-pass blind-helper case above, which the
  // cascade never reaches.
  onProtocolConfirmed(partnerTerms, resolvedRole, {
    cardinality,
    localRecordCount: rowCount,
    localDeclaredRecordCount: declaredRecordCount,
    partnerRecordCount,
    localExpectsOutput: linkageTerms.output.expectsOutput,
    partnerAssociationTableWithheld:
      linkageTerms.linkageStrategy === "single-pass" &&
      isReceiver &&
      withholdSenderTable,
  });

  const linkageKeyIterables = linkageTerms.linkageKeys.map(
    (key, keyIndex) =>
      new StandardizedKeyIterable(key, dataset, rowCount, isReceiver, keyIndex),
  );

  // Per-message element-count caps for the PSI decode boundaries, from
  // authenticated session state only: the two exchanged record counts and the
  // effective key count both parties derive from the agreed terms. The receiver
  // (joiner) is the PSI sender's counterpart, so the sender's set is the
  // partner's when this party receives; both parties compute identical bounds.
  const singlePassBounds = {
    partnerRecordCount,
    keyWidths,
    localFanOutFactor: localFactor,
  };
  const localSize = {
    effectiveKeyCount,
    recordCount: declaredRecordCount,
  };
  const partnerSize = {
    effectiveKeyCount,
    recordCount: partnerRecordCount,
  };
  const elementBounds = psiElementBounds(
    isReceiver ? partnerSize : localSize,
    isReceiver ? localSize : partnerSize,
  );

  // Single-pass is allowlisted; any other value (including the default) runs the
  // cascade. No mismatch guard needed here -- validateCompatibility already
  // aborted upstream if the two parties' strategies differ. Single-pass takes the
  // exchanged bounds too: the partner's record count and both parties' effective
  // key counts derive the per-exchange frame cap, the abort-if-over-ceiling gate,
  // and the index-table layout, identically on both parties (see
  // linkViaSinglePassPSI and frameSize.ts).
  //
  // Build the crypto engine, then the participant, INSIDE the disposing try.
  // The engine psiEngineFactory returns is a worker (worker_threads in the CLI,
  // a Web Worker in the browser) that must be terminated on every exit path.
  // Evaluating the factory as a constructor argument would spawn that worker
  // BEFORE the PSIParticipant constructor runs, so a throw in the constructor
  // would orphan it; building the engine first and disposing it in the finally
  // when the participant never took ownership makes "the worker is never
  // orphaned" a structural guarantee. The default in-process engine is built
  // here too, from `library`, so the engine the finally disposes is always real
  // -- it holds the library's server or client objects (the secret key among
  // them) whether or not the participant took ownership.
  const psiRole = isReceiver ? "joiner" : "starter";
  const psiId = isReceiver ? "client" : "server";
  // The disclosure this round is built for, fixed once from the agreed
  // algorithm and generated into the engine's key material rather than
  // chosen when the result is read: a count-only engine refuses the
  // operations that would name a match, and an identifier-revealing one
  // refuses to report a cardinality, so a round cannot resolve to the
  // disclosure the other mode's terms agreed. It also rides the receiver's
  // request on the wire, where the partner's sender enforces agreement.
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
    // Every round has been read as far as it ever will be, so each one states
    // the drop and wide-row totals its per-row lines stopped short of. Inside
    // the finally so a round that reached either sink before the PSI phase
    // threw still reports it, and after the disposal, which frees key material
    // and is not to be risked on a diagnostic line. closeRowReporting never
    // throws, so this teardown's own exception -- the failure the operator
    // needs -- is never at risk of being replaced by a diagnostic sink's.
    for (const round of linkageKeyIterables) round.closeRowReporting();
  }

  // One entry per matched PAIR, in this party's own ascending row order, is what
  // every reader below assumes of the table -- the payload's transmitted rows, the
  // result file, and the attested result size. The cardinality resolved above
  // decides which multiplicities those readings admit; see
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
  // A count-only run has no association table to attach payload values to, and
  // its terms declare no payload column in either direction, so it exchanges
  // the empty message -- committed explicitly as empty, never omitted
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

  // The record-owed region opens here. exchangePayloads has returned, so the
  // disclosure the record attests has provably occurred. Only the two guarded
  // steps below -- the received-payload reconciliation and the signed-receipt
  // swap after it -- fail into this party's owed record rather than discarding
  // it (docs/spec/PROTOCOL.md, Self-attested record); what runs between those
  // two windows is uncaught, over locally built values, so a throw there would
  // escape with no record and no mark set. A statement added to this region
  // must join one of the two guarded windows, or the region must gain a single
  // enclosing guard, or it opens that hole rather than closing it. A holder
  // rather than a bare `unknown`, so a thrown `undefined` is still treated as
  // a failure and cannot pass for a run that got through.
  let postDisclosureFailure: { error: unknown } | undefined;

  // Received-payload enforcement, fail-closed before the result is returned (so a
  // mismatched payload is never shown or written as a result):
  // - A count-only run locks in the empty column set unconditionally: psi-c
  //   refuses payload in either direction and its record's payload commitments
  //   are fixed present-and-empty (docs/spec/EXCHANGE_RECORD.md, Count-only
  //   (psi-c) records), so a transmitted column can never be lazily accepted
  //   here regardless of expectsOutput or any commitment the prepare step
  //   holds.
  // - A no-output party (expectsOutput:false) must receive NO payload. The
  //   send-gate above keeps a conforming partner from sending any; expecting the
  //   empty set here closes it fail-closed against a non-conforming one.
  // - An output party enforces the column set it consented to receive (a fresh
  //   acceptor's disclosedPayloadColumns, or a persisted commitment); a lazy
  //   one (expectedPayloadColumns undefined) takes whatever the sender's own
  //   disclosure metadata transmits.
  //
  // The refusal is caught rather than thrown straight through: this party's own
  // payload is already in the partner's hands whatever the partner sent back, so
  // the record of that outbound disclosure is owed. Catching it also skips the
  // signed-receipt swap below, so no further frame goes to a partner that broke
  // the disclosure contract.
  const expectedReceive = countOnly
    ? []
    : linkageTerms.output.expectsOutput
      ? prepared.expectedPayloadColumns
      : [];
  try {
    reconcileReceivedPayload(partnerPayload, expectedReceive);
  } catch (error) {
    postDisclosureFailure = { error };
  }

  // resultSize (the intersection size) is bound only when both parties are
  // entitled to output; heldResult gates both the record's committed table and what
  // is returned to the caller, so it is one predicate. See the
  // ExchangeResult.associationTable JSDoc below for the disclosure rationale.
  const bothExpectOutput =
    linkageTerms.output.expectsOutput && partnerTerms.output.expectsOutput;
  const heldResult = linkageTerms.output.expectsOutput;

  // The intersection size this party can attest, whichever algorithm produced
  // it: the count is a count-only run's whole result, so it takes the
  // result-size field the matched table's length takes under `psi`, under the
  // same unchanged entitlement gate. A count-only run's record holds NO
  // association-table commitment on either side -- neither party holds a
  // pairing to commit to, whatever its entitlement -- and that absence is
  // normative rather than incidental (the commitment's presence is what marks a
  // party as having received the matched pairing). See
  // docs/spec/EXCHANGE_RECORD.md, Count-only records.
  const attestedResultSize = countOnly
    ? intersectionCount
    : associationTable === undefined
      ? undefined
      : matchedPairCount(associationTable);

  // Signed-receipt step: at the conclusion of a disclosing exchange, both parties
  // sign the SAME canonical receipt content (the agreed-terms hash and the two
  // directional payload MACs, plus a session-derived binder) and swap signatures
  // over the live channel, producing one dual-signed record. Gated on a signing
  // identity AND a session key both being present, so the unsigned-record path --
  // the web app (no keys) and a CLI exchange without a signing identity -- runs
  // this function unchanged. Placed after exchangePayloads so the receipt commits
  // to the full result, including payloads.
  //
  // A failure here is NOT swallowed: a fingerprint-pin or signature failure is a
  // security event that terminates the exchange (exchangeSignedReceipt throws a
  // security ConnectionError). It is caught only so the record built below can
  // state what became of the run and be handed back on the throw -- the disclosure
  // this party already made is what that record attests, and it is owed whether or
  // not the swap that follows completes (docs/spec/PROTOCOL.md, Self-attested
  // record). The whole step sits inside the catch, the binder derivation included,
  // so no post-disclosure failure route leaves the caller without a record.
  //
  // Skipped entirely once the reconciliation above has already terminated the
  // run: the swap is a step of an exchange that is over, and its frames would go
  // to the partner whose payload was refused.
  let signedReceipt: DualSignedRecord | undefined;
  let receiptBinder: string | undefined;
  if (willSignReceipt && postDisclosureFailure === undefined) {
    try {
      // Both parties fold in the INITIATOR's role, so both derive the same binder
      // with no extra messages; see deriveReceiptBinder. Derived before the record
      // is built, so both artifacts hold the one value.
      receiptBinder = await deriveReceiptBinder(sessionKey, "initiator");
      // The identity bindings again, at the point of use: a receipt cannot be
      // built from a pair either side of which named nobody, nor signed under a
      // certificate the partner will authorize against a name it is not bound to,
      // whatever route reached this step. The terms exchange holds the same pair
      // over the same three values, so a run reaching here through runExchange was
      // already refused there; this stands whether or not it was, and its abort
      // releases a partner parked on a receipt frame this party will never send.
      // See assertReceiptBindingsOrAbort.
      const namedParties = await assertReceiptBindingsOrAbort(
        conn,
        linkageTerms,
        partnerTerms,
        signingIdentity.certificate,
      );
      // The receipt content is built from the mutually-verifiable facts directly
      // -- the agreed-terms hash and session-keyed MACs of the two directional
      // payloads -- NOT from the salted record commitments (per-party salts are not
      // byte-identical across parties). It is therefore independent of the
      // non-fatal audit build below; a party that could not build its local record
      // can still sign a receipt. The binder it signs is the same value the record
      // holds, which is what pairs the two artifacts to this one run.
      const termsHash = await computeTermsHash(linkageTerms, partnerTerms);
      const content: ReceiptContent = await buildReceiptContent(
        handshakeRole,
        termsHash,
        toCommittedPayload(localPayload),
        toCommittedPayload(partnerPayload),
        receiptBinder,
        sessionKey,
      );
      signedReceipt = await exchangeSignedReceipt(conn, handshakeRole, {
        identity: signingIdentity,
        pinnedFingerprint: options.partnerFingerprint,
        // The partner's agreed-terms identity (not the certificate's own), so the
        // pinned certificate must authorize the identity the partner used in the
        // agreed terms rather than a value it self-asserts in its certificate.
        partnerIdentity: namedParties.partner,
        content,
      });
    } catch (error) {
      postDisclosureFailure = { error };
    }
  }

  // Build the record once the run's outcome is decided, so it can state it. It
  // is a secondary audit artifact, so a failure to build it (e.g. an unexpected
  // non-canonical value) must not fail a run that otherwise succeeded or
  // discard its result: catch, warn, and continue without a record. The caller
  // treats the audit field as optional.
  let audit: BuiltExchangeRecord | undefined;
  try {
    audit = await buildExchangeRecord({
      localTerms: linkageTerms,
      partnerTerms,
      outcome:
        postDisclosureFailure === undefined
          ? "completed"
          : "receipt-swap-terminated",
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
      // above produces; omitted on every path that derived none.
      receiptBinder,
    });
  } catch (err) {
    // Two warnings rather than one conditional tail: on a terminated run there is
    // no result to be unaffected -- the throw below discards it -- so the
    // completed path's reassurance would be a false claim there.
    getLogger("exchange").warn(
      postDisclosureFailure === undefined
        ? "the exchange disclosed but the self-attested record could not be " +
            `built (${sanitizeErrorForDisplay(err)}); the result above is ` +
            "unaffected"
        : "the exchange disclosed and then failed, and the self-attested " +
            `record of that disclosure could not be built (${sanitizeErrorForDisplay(err)}); ` +
            "the run's own failure is reported separately",
    );
  }

  // The failure terminates the run, carrying the record of the disclosure that
  // already occurred so the caller can still persist it.
  if (postDisclosureFailure !== undefined)
    throw carryingExchangeRecord(postDisclosureFailure.error, audit);

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
