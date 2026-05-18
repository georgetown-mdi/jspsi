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
import { exchangeTerms, resolveRole } from "./protocolSetup.js";
import { linkViaPSI } from "./link.js";

import type { Metadata } from "./config/metadata.js";
import type { LinkageTerms } from "./config/linkageTerms.js";
import type { StandardizedDataset } from "./standardization.js";
import type {
  Connection,
  HandshakeRole,
  AssociationTable,
  PsiRole,
  Prettify,
} from "./types.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type { ExchangeSpec } from "./config/exchangeSpec.js";

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

/** The result returned by {@link runExchange} on successful completion. */
export interface ExchangeResult {
  associationTable: AssociationTable;
  /** Linkage terms received from the partner during the handshake. */
  partnerTerms: LinkageTerms;
  /** The PSI role assigned to this party (sender or receiver). */
  resolvedRole: PsiRole;
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
  conn: Connection,
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
  const { partnerTerms, warnings } = await exchangeTerms(
    conn,
    handshakeRole,
    linkageTerms,
  );
  for (const warning of warnings) onWarning(warning);

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

  return { associationTable, partnerTerms, resolvedRole };
}
