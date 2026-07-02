import { getLogger } from "./utils/logger.js";
import { inferMetadata } from "./config/metadata.js";
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
import {
  exchangeTerms,
  exchangeBootstrapSecret,
  resolveRole,
} from "./protocolSetup.js";
import { reconcileHostKeyFingerprints } from "./hostKeyReconciliation.js";
import { linkViaPSI, linkViaSinglePassPSI } from "./link.js";
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
import { buildExchangeRecord } from "./exchangeRecord.js";
import type { Metadata } from "./config/metadata.js";
import type { LinkageTerms } from "./config/linkageTerms.js";
import type { StandardizedDataset } from "./standardization.js";
import type {
  HandshakeRole,
  AssociationTable,
  PsiRole,
  Prettify,
} from "./types.js";
import type { MessageConnection } from "./connection/messageConnection.js";
import type { PresentedHostKey } from "./connection/fileSyncConnection.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type { ExchangeSpec } from "./config/exchangeSpec.js";
import type { PartnerPayload } from "./payloadExchange.js";
import type { BuiltExchangeRecord } from "./exchangeRecord.js";

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
 * Stages: one "confirming protocol" step (terms exchange + role resolution),
 * followed by one "stage N / K" step per linkage key.
 */
export function describeExchangeStages(
  prepared: PreparedExchange,
): ExchangeStageDefinition[] {
  const keyCount = prepared.linkageTerms.linkageKeys.length;
  return [
    { id: CONFIRMING_PROTOCOL_STAGE_ID, label: "Confirming protocol" },
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
}

export interface RunExchangeOptions {
  /** The loaded PSI WASM/native library instance. */
  psiLibrary: PSILibrary;
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
  const { psiLibrary } = options;
  const onStage = options.onStage ?? (() => {});
  const onWarning = options.onWarning ?? (() => {});
  const onProtocolConfirmed = options.onProtocolConfirmed ?? (() => {});
  const verbosity = options.verbosity ?? 0;

  onStage(CONFIRMING_PROTOCOL_STAGE_ID);
  const {
    partnerTerms,
    warnings,
    partnerRecordCount,
    partnerSaveIntent,
    partnerHostKey,
    partnerHostKeyMalformed,
  } = await exchangeTerms(
    conn,
    handshakeRole,
    linkageTerms,
    rowCount,
    options.saveIntent,
    options.observedHostKey,
  );
  for (const warning of warnings) onWarning(warning);

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

  const participant = new PSIParticipant(
    isReceiver ? "client" : "server",
    psiLibrary,
    {
      role: isReceiver ? "joiner" : "starter",
      verbose: verbosity,
    },
    elementBounds,
  );

  // Single-pass is allowlisted; any other value (including the default) runs the
  // cascade. No mismatch guard needed here -- validateCompatibility already
  // aborted upstream if the two parties' strategies differ. Single-pass takes the
  // partner record count too: it (with this party's count and the agreed key
  // count) derives the per-exchange frame cap and the abort-if-over-ceiling gate,
  // identically on both parties (see linkViaSinglePassPSI and frameSize.ts).
  const associationTable =
    linkageTerms.linkageStrategy === "single-pass"
      ? await linkViaSinglePassPSI(
          { cardinality: "one-to-one" },
          participant,
          conn,
          linkageKeyIterables,
          partnerRecordCount,
          verbosity,
          onStage,
        )
      : await linkViaPSI(
          { cardinality: "one-to-one" },
          participant,
          conn,
          linkageKeyIterables,
          verbosity,
          onStage,
        );

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

  // Self-attested record: produced from data both sides already hold, with no
  // extra round-trip and no private key. Two disclosure figures, gated
  // differently and deliberately:
  //
  // - recordsExposed is each party's own input row count (rowCount): every
  //   contributed record, not only the rows that resolve to a usable linkage key.
  //   It is a per-direction statement of what this party put into the exchange,
  //   known from its own input alone, so it is recorded for every party
  //   regardless of role and stays meaningful even under a future algorithm that
  //   discloses neither the result size nor the partner's set size.
  // - resultSize (the intersection size) is recorded only in the both-output
  //   case, when both parties' agreed terms have them both receive output -- so it
  //   is stored only when both sides are entitled to the result. A single-output
  //   helper can observe its match count during the clean cascade, but the record
  //   deliberately does not surface it: privacy here is enforced by what the tool
  //   writes down, not by what is theoretically discoverable. (The record counts
  //   carried on the terms exchange are total dataset sizes, not the
  //   intersection, and are not used here.)
  //
  // The association table is committed only when this party is entitled to the
  // result (expectsOutput) -- both parties in a both-output exchange, only the
  // receiver in a single-output one. A single-output helper holds a table from the
  // clean cascade too, but, like the match count, the record does not bind it.
  // Both payloads are normalized to the record's canonical committed form
  // (toCommittedPayload) so a sender and receiver commit over byte-identical data
  // for the same logical payload.
  //
  // heldAssociationTable is the entitlement predicate for the association TABLE: it
  // gates BOTH the record's committed table (below) AND the table returned to the
  // caller (the `associationTable` field of the result). A helper therefore neither
  // receives the result table from the exchange nor binds it in its record -- the
  // returned-result gate and the record gate are deliberately one rule (see
  // ExchangeResult). It scopes the result TABLE only; the payload channel is now
  // gated consistently with it: the send-gate above transmits payload solely to a
  // partner entitled to output, and the receive-side check fails closed if a
  // non-receiving party is sent payload regardless. So a non-receiving helper no
  // longer receives the partner's disclosed payload values -- the one-sided
  // disclosure formerly carried on this channel is closed here, not left as a
  // residual (docs/notes/one-sided-disclosure.md).
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
  };
}
