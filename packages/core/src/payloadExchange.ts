import * as z from "zod";

import type { HandshakeRole, AssociationTable } from "./types.js";
import type { Metadata } from "./config/metadata.js";
import type { MessageConnection } from "./connection/messageConnection.js";
import { receiveParsed } from "./connection/messageConnection.js";

/** The payload received from the exchange partner after PSI linkage. */
export interface PartnerPayload {
  /**
   * All payload column names from the partner. Empty when partner had no data.
   */
  columns: string[];
  /**
   * The sender's original row indices, one per entry in {@link rows}.
   * `rowIndices[i]` is the sender's row index for the record in `rows[i]`.
   * When used as a lookup key, these values correspond to element `[1]` of the
   * receiver's local {@link AssociationTable} (the partner indices stored
   * there are the sender's row indices). Empty when partner had no data.
   */
  rowIndices: number[];
  /** Payload rows, one per matched record. Empty when partner had no data. */
  rows: Array<Array<string | null>>;
}

const payloadWireSchema = z.discriminatedUnion("hasData", [
  z.object({ hasData: z.literal(false) }),
  z
    .object({
      hasData: z.literal(true),
      columns: z.array(z.string()),
      rowIndices: z.array(z.number().int().nonnegative()),
      rows: z.array(z.array(z.string().nullable())),
    })
    .refine(
      (v) => v.rowIndices.length === v.rows.length,
      "rowIndices and rows must have the same length",
    ),
]);

/**
 * Wire format sent over the connection during payload exchange.

 * Exported only because it is the return type of {@link preparePayload};
 * callers should use type inference rather than naming this type directly. Do
 * not widen this to a documented public API type.
 *
 * @internal
 */
export type PayloadWireMessage = z.infer<typeof payloadWireSchema>;

/**
 * Prepares the payload message to send after PSI linkage.
 *
 * Gathers all `isPayload` columns from the matched rows (indexed by
 * `associationTable[0]`) and packages them for transmission. Returns a
 * no-data message when the dataset has no payload columns or no matched rows.
 */
export function preparePayload(
  rawRows: Array<Record<string, string>>,
  metadata: Metadata,
  associationTable: AssociationTable,
): PayloadWireMessage {
  const payloadCols = metadata.filter((col) => col.isPayload);
  if (payloadCols.length === 0 || associationTable[0].length === 0) {
    return { hasData: false };
  }

  const columns = payloadCols.map((col) => col.name);
  const rowIndices = [...associationTable[0]];
  const rows = rowIndices.map((idx) =>
    columns.map((col) => rawRows[idx]?.[col] ?? null),
  );

  return { hasData: true, columns, rowIndices, rows };
}

/** Maps a validated payload wire message into a {@link PartnerPayload}. */
function toPartnerPayload(msg: PayloadWireMessage): PartnerPayload {
  if (!msg.hasData) return { columns: [], rowIndices: [], rows: [] };
  return { columns: msg.columns, rowIndices: msg.rowIndices, rows: msg.rows };
}

/**
 * Exchanges payload datasets over an open {@link MessageConnection} after PSI
 * linkage.
 *
 * Initiator sends first; responder receives first then sends. The returned
 * {@link PartnerPayload} rows are in the same order as the association table.
 * Every failure mode (transport error, malformed message, send rejection)
 * surfaces as a rejection of the awaited call, so no listener registration,
 * error buffering, or per-path cleanup is needed.
 */
export async function exchangePayloads(
  conn: MessageConnection,
  handshakeRole: HandshakeRole,
  localPayload: PayloadWireMessage,
): Promise<PartnerPayload> {
  if (handshakeRole === "initiator") {
    await conn.send(localPayload);
    return toPartnerPayload(await receiveParsed(conn, payloadWireSchema));
  }
  const partnerPayload = toPartnerPayload(
    await receiveParsed(conn, payloadWireSchema),
  );
  // This is the exchange's terminal frame. On a buffering transport (WebRTC) it
  // looks racy: the responder's last act is a fire-and-forget send (resolves on
  // local hand-off, not peer delivery) right before the caller tears the
  // connection down. It is safe because the transport delivery contract
  // guarantees the final frame survives a clean close - either the send is
  // durable (file-sync, where the written file outlives the connection) or the
  // clean close flushes buffered frames before teardown (WebRTC). See the
  // send/close contract in types.ts / messageConnection.ts and
  // docs/COMMUNICATION.md. Do not "fix" this by assuming send has delivered.
  await conn.send(localPayload);
  return partnerPayload;
}

function quoteCsvField(value: string): string {
  return value.includes(",") ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r")
    ? '"' + value.replace(/"/g, '""') + '"'
    : value;
}

/**
 * Formats an exchange result into header and row arrays suitable for CSV
 * output.
 *
 * The first column identifies our matched records and is headed by our
 * identifier column name, or `row_id` when no identifier column exists. The
 * remaining columns are the partner's payload columns, each using their
 * original name, prefixed with `their_` only when a name collides with our
 * local identifier column. When the partner sent no payload data a single
 * `row_id` fallback column (or `their_row_id` on collision) contains the
 * partner's 0-based row index. All values are RFC 4180 escaped. Null cells in
 * the partner's payload (columns present in the schema but absent from a row)
 * are emitted as empty strings.
 */
export function buildOutputTable(
  associationTable: AssociationTable,
  rawRows: Array<Record<string, string>>,
  metadata: Metadata,
  partnerPayload: PartnerPayload,
): { headers: string[]; rows: Array<Array<string>> } {
  if (associationTable[0].length !== associationTable[1].length) {
    throw new Error(
      "association table arrays have different lengths: " +
        `${associationTable[0].length} vs ${associationTable[1].length}`,
    );
  }

  if (partnerPayload.rowIndices.length !== partnerPayload.rows.length) {
    throw new Error(
      "partner payload rowIndices and rows have different lengths: " +
        `${partnerPayload.rowIndices.length} vs ${partnerPayload.rows.length}`,
    );
  }

  const ourIdCol = metadata.find((col) => col.role === "identifier") ?? null;

  const hasPartnerCols = partnerPayload.columns.length > 0;
  const ourBaseName = ourIdCol ? ourIdCol.name : "row_id";

  const ourHeader = quoteCsvField(ourBaseName);
  const theirHeaders = (
    hasPartnerCols ? partnerPayload.columns : ["row_id"]
  ).map((c) => quoteCsvField(c !== ourBaseName ? c : `their_${c}`));

  const headers = [ourHeader, ...theirHeaders];

  const theirIdxToPayloadPos = new Map(
    partnerPayload.rowIndices.map((rowIdx, pos) => [rowIdx, pos]),
  );

  if (theirIdxToPayloadPos.size !== partnerPayload.rowIndices.length) {
    throw new Error("partner payload rowIndices contains duplicate indices");
  }

  if (hasPartnerCols) {
    const missing = associationTable[1].filter(
      (idx) => !theirIdxToPayloadPos.has(idx),
    );
    if (missing.length > 0) {
      throw new Error(
        "partner payload is missing rows for association table indices: " +
          missing.join(", "),
      );
    }
  }

  const rows = associationTable[0].map((ourIdx, i) => {
    const theirIdx = associationTable[1][i];
    const ourId = quoteCsvField(
      ourIdCol
        ? (rawRows[ourIdx]?.[ourIdCol.name] ?? String(ourIdx))
        : String(ourIdx),
    );

    if (!hasPartnerCols) {
      return [ourId, quoteCsvField(String(theirIdx))];
    }

    const partnerRow = partnerPayload.rows[theirIdxToPayloadPos.get(theirIdx)!];
    const theirValues = partnerPayload.columns.map((_, colIdx) =>
      quoteCsvField(partnerRow[colIdx] ?? ""),
    );

    return [ourId, ...theirValues];
  });

  return { headers, rows };
}
