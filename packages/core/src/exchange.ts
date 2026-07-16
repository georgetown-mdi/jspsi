import { getLogger } from "./utils/logger.js";
import { inferMetadata, isDisclosedToPartner } from "./config/metadata.js";
import { getDefaultLinkageTerms } from "./defaults/linkageTerms.js";
import { getDefaultStandardization } from "./defaults/standardization.js";
import {
  buildStandardizedDataset,
  assertStandardizationMatchesTerms,
  StandardizedKeyIterable,
} from "./standardization.js";
import { columnValues, inferDateFormat } from "./utils/date.js";
import { sanitizeForDisplay } from "./utils/sanitizeForDisplay.js";
import type { CSVRow } from "./file.js";
import { PSIParticipant } from "./participant.js";
import type { PsiEngine } from "./psiEngine.js";
import {
  exchangeTerms,
  exchangeBootstrapSecret,
  resolveRole,
} from "./protocolSetup.js";
import { reconcileHostKeyFingerprints } from "./hostKeyReconciliation.js";
import {
  linkViaPSI,
  linkViaSinglePassPSI,
  withholdsSenderAssociationTable,
} from "./link.js";
import {
  psiElementBounds,
  singlePassDatasetExceedsCap,
} from "./connection/frameSize.js";
import {
  preparePayload,
  exchangePayloads,
  toCommittedPayload,
  assertPayloadSendDisclosed,
  assertDisclosureMatchesCommitment,
  reconcileReceivedPayload,
} from "./payloadExchange.js";
import type { PayloadWireMessage } from "./payloadExchange.js";
import { buildExchangeRecord, computeTermsHash } from "./exchangeRecord.js";
import {
  buildReceiptContent,
  deriveReceiptBinder,
  exchangeSignedReceipt,
} from "./signedReceipt.js";
import { UsageError } from "./errors.js";
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
import type { MessageConnection } from "./connection/messageConnection.js";
import type { PresentedHostKey } from "./connection/fileSyncConnection.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type { ExchangeSpec } from "./config/exchangeSpec.js";
import type { PartnerPayload } from "./payloadExchange.js";
import type { BuiltExchangeRecord } from "./exchangeRecord.js";
import type { SigningIdentity } from "./signingIdentity.js";
import type { DualSignedRecord, ReceiptContent } from "./signedReceipt.js";

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
}

/**
 * Refuse a linkage-terms `algorithm` the run cannot actually honor, before any
 * matched identifier is revealed.
 *
 * Only `psi` is implemented: the run reveals matched identifiers unconditionally
 * (`linkViaPSI` / `linkViaSinglePassPSI`), with no count-only code path. `psi-c`
 * (count-only) is advertised by `AlgorithmSchema` and the consent copy but has no
 * run path, so a `psi-c` run would reveal matched identifiers while its
 * self-attested exchange record asserts count-only disclosure -- an integrity gap
 * in the compliance accounting (HIPAA 45 CFR 164.528 and FERPA disclosure
 * accounting turn on what was ACTUALLY disclosed). Fail closed here so the record
 * can never diverge from the run: a `psi-c` terms value reaching core through ANY
 * mint or accept path -- a hand-crafted token, a CLI-authored config, a non-web
 * mint -- is refused, not left to each client to clamp. This is the run-side half
 * the record-integrity guarantee rests on; a pure record-side clamp would keep the
 * record honest but silently ignore an operator's stated intent to disclose only a
 * count, so the run refuses instead (item 208363104).
 *
 * The guard ALLOWLISTS `psi` rather than denylisting `psi-c`: only the one
 * implemented, identifier-revealing algorithm proceeds, so any algorithm later
 * added to `AlgorithmSchema` is refused by default until it too is explicitly
 * implemented and allowed here. This follows the repo's allowlist-over-blocklist
 * rule (CONTRIBUTING.md, Code Conventions) and keeps enum growth fail-closed --
 * `buildExchangeRecord` copies `algorithm` verbatim with no guard of its own, so a
 * new unimplemented member slipping past this run-side gate is exactly what the
 * allowlist prevents.
 *
 * When a real count-only run path lands, REPLACE this refusal with it and ungate
 * the client-side gates in the same change -- flipping `APPLIED_SETTINGS.psiC`
 * alone is not sufficient while this refusal stands. The full ungate checklist is
 * tracked on the product board (item 208371871, "Implement count-only PSI").
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
  throw new UsageError(
    'this linkage-terms algorithm is not yet implemented: only "psi" is ' +
      "supported, and it reveals matched identifiers. A count-only " +
      '("psi-c"), or any other non-psi algorithm, would disclose differently ' +
      "than its exchange record could attest, so it is refused before any " +
      'identifier is revealed. Set the linkage-terms algorithm to "psi", or ' +
      "wait for support before running.",
  );
}

/**
 * Refuse a linkage-terms `deduplicate: true` the run cannot honor, before any
 * matching begins.
 *
 * Only one-to-one matching is implemented: both parties' locally-duplicated key
 * values are excluded from every round (see `linkViaPSI`), so a deduplicating
 * party's records can never match more than one partner record. Running a
 * `deduplicate: true` term would silently deliver one-to-one matching under a
 * consented many-cardinality term -- the disclosure-fidelity gap this refusal
 * closes. Refused pre-connection in {@link prepareForExchange} for this party's
 * own terms, and for both parties' agreed terms by
 * {@link resolveLinkageCardinality} after the terms exchange, before the PSI
 * rounds begin.
 *
 * Plain {@link UsageError}, deliberately NOT an `OperatorConfigError`, for the
 * same reason as {@link assertAlgorithmImplemented}: on the accept side the
 * value is adopted verbatim from the partner's invitation (see
 * `deriveAcceptedLinkageTerms`), so it is not unconditionally this operator's
 * own content. The message carries only fixed literals.
 */
export function assertDeduplicateImplemented(deduplicate: boolean): void {
  if (!deduplicate) return;
  throw new UsageError(
    "linkage-terms deduplication is not yet implemented: matching currently " +
      'runs strictly one-to-one, so a "deduplicate: true" term would be ' +
      "silently matched one-to-one rather than honored. The exchange is " +
      "refused before matching begins. Set deduplicate to false until " +
      "deduplication is implemented.",
  );
}

/**
 * Resolve the matching cardinality {@link runExchange} passes to the linkage
 * strategies, from the two parties' agreed `deduplicate` settings.
 *
 * Symmetric in its arguments, and each party calls it with the same agreed pair
 * (its own setting plus the partner's, read off the terms exchange), so both
 * parties always derive the same verdict from the same authenticated state --
 * the lockstep PSI rounds cannot be desynced by a divergent resolution. Today
 * only `one-to-one` (both parties `deduplicate: false`) is implemented; any
 * `deduplicate: true` is refused before the rounds begin, never silently
 * collapsed onto one-to-one (see {@link assertDeduplicateImplemented}).
 */
export function resolveLinkageCardinality(
  localDeduplicate: boolean,
  partnerDeduplicate: boolean,
): "one-to-one" {
  assertDeduplicateImplemented(localDeduplicate);
  assertDeduplicateImplemented(partnerDeduplicate);
  return "one-to-one";
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
 * Call this before establishing a connection. After the handshake role and PSI
 * role are resolved, {@link runExchange} builds the key iterables and runs
 * the protocol.
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

  const metadata = exchangeDataSpec.metadata ?? inferMetadata(columnNames);
  const linkageTerms =
    exchangeDataSpec.linkageTerms ?? getDefaultLinkageTerms(identity, metadata);

  // Fail closed on a count-only (`psi-c`) algorithm before connecting: no
  // count-only run path exists, so a `psi-c` run would reveal matched identifiers
  // under a self-attested record asserting only a count. Refuse here (friendly,
  // pre-connection, revealing nothing) and again at the run boundary (runExchange)
  // so the refusal holds even for a PreparedExchange built without going through
  // this function. See assertAlgorithmImplemented.
  assertAlgorithmImplemented(linkageTerms.algorithm);

  // Fail closed on a deduplicating term before connecting: matching runs
  // strictly one-to-one, so `deduplicate: true` cannot be honored and would
  // silently under-deliver the consented cardinality. Refused again from both
  // parties' agreed terms in runExchange (resolveLinkageCardinality), which
  // holds for a PreparedExchange built without going through this function. See
  // assertDeduplicateImplemented.
  assertDeduplicateImplemented(linkageTerms.deduplicate);

  // Reject a payload data dictionary that does not match what metadata transmits.
  // `payload.send` is exchanged, consented to, written into the exchange record,
  // and mirrored into a recurring partner's lock-in, while metadata's
  // isPayload/role is the single source of truth for what actually leaves the
  // machine. This is the one step with both in scope, so the CLI and web paths
  // inherit the same fail-closed check; it is a no-op on the default and guided
  // paths, which author no payload block. See assertPayloadSendDisclosed.
  assertPayloadSendDisclosed(linkageTerms.payload, metadata);

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

  // Pre-flight the single-pass dataset ceiling, before connecting. This is a
  // coarse, ONE-PARTY lower-bound gate: it can only see this party's own row
  // count, not the partner's nor either side's distinct-value counts (which are
  // never known before connecting, and never exchanged). If this party's own
  // keyCount * rows already exceeds the budget, single-pass cannot succeed
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
  if (
    linkageTerms.linkageStrategy === "single-pass" &&
    singlePassDatasetExceedsCap(linkageTerms.linkageKeys.length, rawRows.length)
  ) {
    throw new Error(
      `single-pass linkage cannot carry this dataset: ${rawRows.length} ` +
        `record(s) across ${linkageTerms.linkageKeys.length} linkage key(s) ` +
        "exceed the single-pass ceiling. Reduce the number of linkage keys or " +
        "the record count, or split the dataset into smaller batches.",
    );
  }

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

  // Sanitize the key names for display: on the accept side these come from the
  // partner's invitation (charset-unconstrained), and the operator already
  // reviewed the same escaped form when agreeing to the terms (displayInvitation).
  log.info(
    "will link using keys:",
    linkageTerms.linkageKeys.map((k) => sanitizeForDisplay(k.name)).join(", "),
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
    // NOTE: expectedPayloadColumns (the received-payload lock-in) is deliberately
    // NOT threaded here, unlike retentionDisposition above. The caller sets it on
    // the returned PreparedExchange after this returns, because the accept path's
    // source is the invitation token (not this dataSpec) and the recurring path
    // applies a fallback (config expectedPayloadColumns, else payload.receive). A
    // caller that wants the lock-in must set it explicitly; see
    // PreparedExchange.expectedPayloadColumns. (It rides ExchangeDataSpec only so
    // the exchange command can read it off the parsed config.)
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
   * the receiver of a one-sided exchange, get the table as before. The withholding
   * predicate is exactly the one that gates the audit record's committed
   * association table, so the returned result and the record stay one rule: a
   * helper neither receives the table nor binds it in its record.
   */
  associationTable: AssociationTable | undefined;
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

export interface RunExchangeOptions {
  /** The loaded PSI WASM/native library instance. */
  psiLibrary: PSILibrary;
  /**
   * Builds the crypto engine for the PSI participant, given its resolved role and
   * id. When omitted, the participant runs the masking in-process on the calling
   * thread (the default, and what the browser uses). The CLI supplies a factory
   * that spawns a `worker_threads` worker so the masking runs off the
   * event-loop-owning thread, keeping it responsive for the SFTP heartbeat and
   * timers; the returned engine is disposed when the PSI phase ends (board item
   * 208035324).
   */
  psiEngineFactory?: (role: "starter" | "joiner", id: string) => PsiEngine;
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
   * independent views of the server's identity (201058119). Pass it ONLY on the
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

  // Last line of defense for the disclosure-integrity guarantee: refuse a
  // count-only (`psi-c`) algorithm before any matched identifier is revealed, so
  // the self-attested record can never attest count-only over an
  // identifier-revealing run. prepareForExchange refuses it pre-connection; this
  // holds even for a PreparedExchange constructed without going through it, and
  // fires before the terms exchange puts anything on the wire. See
  // assertAlgorithmImplemented.
  assertAlgorithmImplemented(linkageTerms.algorithm);

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
    rowCount,
    options.saveIntent,
    options.observedHostKey,
    localDisclosesPayload,
  );
  for (const warning of warnings) onWarning(warning);

  // Resolve the matching cardinality from both parties' agreed deduplicate
  // settings as the first step after the terms exchange: the resolution is
  // symmetric, so a refusal (any deduplicating term) aborts BOTH parties at this
  // same point -- before the bootstrap frame and the PSI rounds -- rather than
  // desyncing the lockstep. See resolveLinkageCardinality.
  const cardinality = resolveLinkageCardinality(
    linkageTerms.deduplicate,
    partnerTerms.deduplicate,
  );

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
    (key) => new StandardizedKeyIterable(key, dataset, rowCount, isReceiver),
  );

  // Per-message element-count caps for the PSI decode seams, from authenticated
  // session state only: the agreed key count and the two exchanged record counts.
  // The receiver (joiner) is the PSI sender's counterpart, so the sender's set is
  // the partner's when this party receives; both parties compute identical bounds.
  const senderRecordCount = isReceiver ? partnerRecordCount : rowCount;
  const receiverRecordCount = isReceiver ? rowCount : partnerRecordCount;
  const elementBounds = psiElementBounds(
    linkageTerms.linkageKeys.length,
    senderRecordCount,
    receiverRecordCount,
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
  // partner record count too: it (with this party's count and the agreed key
  // count) derives the per-exchange frame cap and the abort-if-over-ceiling gate,
  // identically on both parties (see linkViaSinglePassPSI and frameSize.ts).
  //
  // Build the crypto engine, then the participant, INSIDE the disposing try. The
  // engine psiEngineFactory returns is a worker (a worker_threads worker in the CLI, a
  // Web Worker in the browser) that must be terminated on every exit path. Evaluating
  // the factory as a constructor argument would spawn that worker BEFORE the
  // PSIParticipant constructor runs, so a throw in the constructor would orphan it;
  // building the engine first and disposing it in the finally when the participant
  // never took ownership makes "the worker is never orphaned" a structural guarantee
  // rather than a comment resting on the constructor happening not to throw. The
  // default in-process engine is built inside the constructor from `library`, so
  // `engine` is undefined on that path and the else-branch is a no-op (a constructor
  // throw there allocates nothing to dispose). Nothing above depends on the
  // participant, so this ordering is free.
  const psiRole = isReceiver ? "joiner" : "starter";
  const psiId = isReceiver ? "client" : "server";
  const engine = options.psiEngineFactory?.(psiRole, psiId);

  let participant: PSIParticipant | undefined;
  let associationTable: AssociationTable;
  try {
    participant = new PSIParticipant(
      psiId,
      psiLibrary,
      { role: psiRole, verbose: verbosity },
      elementBounds,
      undefined,
      engine,
    );
    associationTable =
      linkageTerms.linkageStrategy === "single-pass"
        ? await linkViaSinglePassPSI(
            { cardinality },
            participant,
            conn,
            linkageKeyIterables,
            partnerRecordCount,
            withholdSenderTable,
            verbosity,
            onStage,
          )
        : await linkViaPSI(
            { cardinality },
            participant,
            conn,
            linkageKeyIterables,
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
    // dispose the bare injected engine so the worker psiEngineFactory already spawned
    // is still terminated, never orphaned (board item 208035324).
    if (participant !== undefined) participant.dispose();
    else engine?.dispose();
  }

  // Send-gate: transmit payload only to a partner entitled to the result. A party
  // with expectsOutput:false learns no matched records, so it has no use for
  // payload values and must not receive them -- transmitting to it is a one-sided
  // disclosure to a non-receiving helper (docs/notes/one-sided-disclosure.md). The
  // disclosed columns are gathered (and the payload built) only when the partner
  // will receive output; otherwise an empty message goes on the wire and is
  // recorded as such. The disclosure is closed at the source here, not merely
  // declared empty.
  const localPayload: PayloadWireMessage = partnerTerms.output.expectsOutput
    ? preparePayload(prepared.rawRows, prepared.metadata, associationTable)
    : { hasData: false };
  const partnerPayload = await exchangePayloads(
    conn,
    handshakeRole,
    localPayload,
  );

  // Received-payload enforcement, fail-closed before the result or audit record is
  // built (so a mismatched payload is never written to disk or surfaced):
  // - A no-output party (expectsOutput:false) must receive NO payload. The
  //   send-gate above keeps a conforming partner from sending any; expecting the
  //   empty set here closes it fail-closed against a non-conforming one.
  // - An output party enforces the column set it consented to receive (a fresh
  //   acceptor's carried disclosedPayloadColumns, or a persisted lock-in); a lazy
  //   one (expectedPayloadColumns undefined) takes whatever the sender's own
  //   disclosure metadata transmits.
  const expectedReceive = linkageTerms.output.expectsOutput
    ? prepared.expectedPayloadColumns
    : [];
  reconcileReceivedPayload(partnerPayload, expectedReceive);

  // resultSize (the intersection size) is bound only when both parties are
  // entitled to output; heldAssociationTable gates both the record's committed
  // table and the table returned to the caller, so it is one predicate. See the
  // ExchangeResult.associationTable JSDoc below for the disclosure rationale.
  const bothExpectOutput =
    linkageTerms.output.expectsOutput && partnerTerms.output.expectsOutput;
  const heldAssociationTable = linkageTerms.output.expectsOutput;

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
      resultSize: bothExpectOutput ? associationTable[0].length : undefined,
      // Self-facing audit pointer from this party's local config; undefined when
      // unconfigured, in which case the record omits it.
      retentionDisposition,
      associationTable: heldAssociationTable ? associationTable : undefined,
      localPayloadSent: toCommittedPayload(localPayload),
      partnerPayloadReceived: toCommittedPayload(partnerPayload),
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    getLogger("exchange").warn(
      "the exchange succeeded but the self-attested record could not be " +
        `built (${err instanceof Error ? err.message : String(err)}); the ` +
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
  if (
    options.signingIdentity !== undefined &&
    options.sessionKey !== undefined
  ) {
    // The receipt content is built from the mutually-verifiable facts directly --
    // the agreed-terms hash and salt-free digests of the two directional payloads
    // -- NOT from the salted record commitments (per-party salts are not
    // byte-identical across parties). It is therefore independent of the non-fatal
    // audit build above; a party that could not build its local record can still
    // sign a receipt. The binder is derived from the initiator's role by BOTH
    // parties, so both compute the one shared binder with no extra messages; see
    // deriveReceiptBinder.
    const [binder, termsHash] = await Promise.all([
      deriveReceiptBinder(options.sessionKey, "initiator"),
      computeTermsHash(linkageTerms, partnerTerms),
    ]);
    const content: ReceiptContent = await buildReceiptContent(
      handshakeRole,
      termsHash,
      toCommittedPayload(localPayload),
      toCommittedPayload(partnerPayload),
      binder,
    );
    signedReceipt = await exchangeSignedReceipt(conn, handshakeRole, {
      identity: options.signingIdentity,
      pinnedFingerprint: options.partnerFingerprint,
      content,
    });
  }

  return {
    // Withheld (undefined) from a party whose agreed terms give it no output, so
    // a non-receiving helper does not get the result table to write; the receiver
    // and both-output parties get it as before. Same predicate as the record gate.
    associationTable: heldAssociationTable ? associationTable : undefined,
    partnerTerms,
    resolvedRole,
    partnerPayload,
    audit,
    bootstrap,
    signedReceipt,
  };
}
