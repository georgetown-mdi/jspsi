import { getLogger } from "./utils/logger.js";
import { inferMetadata } from "./config/metadata.js";
import { getDefaultLinkageTerms } from "./defaults/linkageTerms.js";
import { getDefaultStandardization } from "./defaults/standardization.js";
import {
  buildStandardizedDataset,
  validateStandardizationAgainstTerms,
  StandardizedKeyIterable,
} from "./standardization.js";
import { inferDateFormat } from "./utils/date.js";
import { PSIParticipant } from "./participant.js";
import {
  exchangeTerms,
  exchangeBootstrapSecret,
  resolveRole,
} from "./protocolSetup.js";
import { linkViaPSI } from "./link.js";
import {
  preparePayload,
  exchangePayloads,
  toCommittedPayload,
} from "./payloadExchange.js";
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
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type { ExchangeSpec } from "./config/exchangeSpec.js";
import type { PartnerPayload } from "./payloadExchange.js";
import type { BuiltExchangeRecord } from "./exchangeRecord.js";

/**
 * The subset of an exchange specification that governs data preparation.
 * Connection-agnostic, so both the CLI and the web application can pass their
 * respective config objects (only the shared fields are consumed).
 */
export type ExchangeDataSpec = Prettify<
  Omit<ExchangeSpec, "connection" | "linkageTerms"> &
    Partial<Pick<ExchangeSpec, "linkageTerms">>
>;

/**
 * The result of {@link prepareForExchange}: everything needed to run the PSI
 * protocol, derived from the raw CSV rows and the exchange parameters.
 */
export interface PreparedExchange {
  metadata: Metadata;
  linkageTerms: LinkageTerms;
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
  rawRows: Array<Record<string, string>>;
  rowCount: number;
  /**
   * Non-fatal issues detected during preparation (e.g. unknown standardization
   * outputs).
   */
  warnings: string[];
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
 * - Validates explicit standardization against the linkage terms and collects
 *   any warnings.
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
  rawRows: Array<Record<string, string>>,
  columnNames: Array<string>,
): PreparedExchange {
  const log = getLogger("exchange");
  const warnings: string[] = [];

  const metadata = exchangeDataSpec.metadata ?? inferMetadata(columnNames);
  const linkageTerms =
    exchangeDataSpec.linkageTerms ?? getDefaultLinkageTerms(identity, metadata);

  let dateInputFormat: string | undefined;
  if (exchangeDataSpec.standardization === undefined) {
    const dobCol = metadata.find((c) => c.type === "dateOfBirth");
    if (dobCol !== undefined) {
      dateInputFormat = inferDateFormat(
        rawRows.map((row) => row[dobCol.name] ?? ""),
      );
      if (dateInputFormat !== undefined)
        log.info(`inferred date of birth format: ${dateInputFormat}`);
    }
  }

  const standardization =
    exchangeDataSpec.standardization ??
    getDefaultStandardization(metadata, linkageTerms, { dateInputFormat });

  log.info(
    "will link using keys:",
    linkageTerms.linkageKeys.map((k) => k.name).join(", "),
  );

  const dataset = buildStandardizedDataset(
    standardization,
    rawRows,
    metadata,
    linkageTerms,
  );

  if (exchangeDataSpec.standardization !== undefined) {
    warnings.push(
      ...validateStandardizationAgainstTerms(
        exchangeDataSpec.standardization,
        linkageTerms,
      ),
    );
  }

  return {
    metadata,
    linkageTerms,
    dataset,
    rawRows,
    rowCount: rawRows.length,
    warnings,
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
  associationTable: AssociationTable;
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
   * receipts) together with its private opening data, produced as a pair. The
   * `record` holds commitments to the data exchanged plus a non-secret summary
   * and is safe to retain or share; the `opening` holds the per-commitment salts
   * and a snapshot of the committed data and is as sensitive as the matched data
   * itself. The caller (CLI or web) persists both. See {@link buildExchangeRecord}.
   *
   * A single optional field rather than two independent ones so the record and
   * its opening can never be present apart. Absent only if building the record
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
  const { dataset, linkageTerms, rowCount } = prepared;
  const { psiLibrary } = options;
  const onStage = options.onStage ?? (() => {});
  const onWarning = options.onWarning ?? (() => {});
  const onProtocolConfirmed = options.onProtocolConfirmed ?? (() => {});
  const verbosity = options.verbosity ?? 0;

  onStage(CONFIRMING_PROTOCOL_STAGE_ID);
  const { partnerTerms, warnings, partnerSaveIntent } = await exchangeTerms(
    conn,
    handshakeRole,
    linkageTerms,
    options.saveIntent,
  );
  for (const warning of warnings) onWarning(warning);

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

  const resolvedRole = await resolveRole(
    conn,
    handshakeRole,
    linkageTerms.output,
    partnerTerms.output,
    rowCount,
  );
  onProtocolConfirmed(partnerTerms, resolvedRole);

  const isReceiver = resolvedRole === "receiver";
  const linkageKeyIterables = linkageTerms.linkageKeys.map(
    (key) => new StandardizedKeyIterable(key, dataset, rowCount, isReceiver),
  );

  const participant = new PSIParticipant(
    isReceiver ? "client" : "server",
    psiLibrary,
    {
      role: isReceiver ? "joiner" : "starter",
      verbose: verbosity,
    },
  );

  const associationTable = await linkViaPSI(
    { cardinality: "one-to-one" },
    participant,
    conn,
    linkageKeyIterables,
    verbosity,
    onStage,
  );

  const localPayload = preparePayload(
    prepared.rawRows,
    prepared.metadata,
    associationTable,
  );
  const partnerPayload = await exchangePayloads(
    conn,
    handshakeRole,
    localPayload,
  );

  // Self-attested record: produced from data both sides already hold, with no
  // extra round-trip and no private key. Two disclosure figures, gated
  // differently and deliberately:
  //
  // - recordsExposed is each party's own participating record count (rowCount).
  //   It is a per-direction statement of what this party put into the exchange,
  //   known from its own input alone, so it is recorded for every party
  //   regardless of role and stays meaningful even under a future algorithm that
  //   discloses neither the result size nor the partner's set size.
  // - resultSize (the intersection size) is recorded only in the both-output
  //   case, when both parties' agreed terms have them both receive output -- so it
  //   is stored only when both sides are entitled to the result. A single-output
  //   helper can observe its match count during the clean cascade, but the record
  //   deliberately does not surface it: privacy here is enforced by what the tool
  //   writes down, not by what is theoretically discoverable. (resolveRole's
  //   exchanged record counts are total dataset sizes, not the intersection, and
  //   are not used here.)
  //
  // The association table is committed only when this party is entitled to the
  // result (expectsOutput) -- both parties in a both-output exchange, only the
  // receiver in a single-output one. A single-output helper holds a table from the
  // clean cascade too, but, like the match count, the record does not bind it.
  // Both payloads are normalized to the record's canonical committed form
  // (toCommittedPayload) so a sender and receiver commit over byte-identical data
  // for the same logical payload.
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
    associationTable,
    partnerTerms,
    resolvedRole,
    partnerPayload,
    audit,
    bootstrap,
  };
}
