import * as z from "zod";

import type { HandshakeRole, AssociationTable } from "./types.js";
import type { Metadata } from "./config/metadata.js";
import {
  isDisclosedToPartner,
  disclosedColumnNames,
} from "./config/metadata.js";
import type { Payload } from "./config/linkageTerms.js";
import { MAX_NAME_LENGTH } from "./config/linkageTerms.js";
import type { CSVRow } from "./file.js";
import type { CommittedPayload } from "./exchangeRecord.js";
import type { MessageConnection } from "./connection/messageConnection.js";
import {
  ConnectionError,
  receiveParsed,
} from "./connection/messageConnection.js";
import { singleIssueArray } from "./utils/singleIssueArray.js";
import { UsageError } from "./errors.js";
import { sanitizeForDisplay } from "./utils/sanitizeForDisplay.js";

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

// `rows` is a 2-D partner-controlled collection, bounded as ONE single-issue
// validator (utils/singleIssueArray.ts) over the whole structure rather than
// `z.array(z.array(z.string().nullable()))`. It is exposed to BOTH Zod RangeError
// classes: a single row of hundreds of thousands of invalid inner cells overflows
// the call stack spreading one issue per cell up through the inner-array and
// outer-`rows` frames (`Maximum call stack size exceeded`, ~300k), and a payload
// of millions of invalid ROWS throws `Invalid string length` building the error
// string from one issue per row (~3.5M) -- both on Zod 4.4.3. `isPayloadRow`
// validates a whole row (is-array, every cell string-or-null) INSIDE the outer
// single-issue `every`, so the entire structure yields at most one issue
// regardless of row OR cell count. A `.max()` is unsafe on either axis: a real
// exchange has one row per matched record, each as wide as the payload, both
// legitimately in the millions (MAX_FRAME_SIZE_BYTES bounds them). The predicates
// mirror `z.string().nullable()` (string-or-null) and the inner `z.array(...)`
// (Array.isArray) exactly.
const isPayloadCell = (cell: unknown): boolean =>
  typeof cell === "string" || cell === null;
const isPayloadRow = (row: unknown): boolean =>
  Array.isArray(row) && row.every(isPayloadCell);

const payloadWireSchema = z.discriminatedUnion("hasData", [
  z.object({ hasData: z.literal(false) }),
  z
    .object({
      hasData: z.literal(true),
      // `columns` and `rowIndices` are flat arrays one object-frame below this
      // object, so a pathological count cannot drive the ~130k STACK overflow
      // `rows` faces -- but a far larger count (~millions of invalid elements,
      // within the frame cap) makes Zod throw a DIFFERENT RangeError ("Invalid
      // string length", ~3.5M on Zod 4.4.3) building its error string from one
      // issue per element. receiveParsed catches that harmlessly as
      // ConnectionError("protocol"), but the single-issue validators below cap
      // issue accumulation at one regardless of count (utils/singleIssueArray.ts)
      // so the burn never happens. A count `.max()` is wrong for `rowIndices`
      // (one per matched record, legitimately in the millions like `rows`) and
      // unnecessary for `columns`; both predicates mirror their replaced element
      // schema exactly -- typeof-string for `z.string()`, Number.isSafeInteger
      // and `>= 0` for `z.number().int().nonnegative()`. `columns` additionally
      // bounds each NAME's LENGTH to the same MAX_NAME_LENGTH ceiling the
      // operator's own `terms.payload.receive` names carry: a received column name
      // flows verbatim into this party's local exchange-record file (via
      // governance.payloadReceived), and it was bounded that way before it began
      // deriving from the partner's wire message rather than from local terms.
      // Both the `.min(1)` floor and the MAX_NAME_LENGTH ceiling those names
      // carry are enforced here. The floor was previously omitted -- an empty
      // partner name was left to RecordPayloadColumnSchema, which rejects it at
      // record build via the non-fatal guard (skipping the record, not failing the
      // exchange) -- because an honest sender could emit a `""` column from a
      // trailing-comma CSV header, and flooring the wire would escalate that
      // common case into a full exchange failure on the peer. inferMetadata now
      // rejects an empty name at intake, so an honest sender never emits one: the
      // floor here can no longer regress an honest exchange, and instead refuses a
      // partner who hand-crafts `[""]` to suppress this party's record (the
      // exchange-record `.min(1)` remains the on-disk backstop). This is a
      // per-ELEMENT length check folded into the same single `every` pass, not a
      // count `.max()`, so it caps accumulation at one issue regardless of element
      // count.
      columns: singleIssueArray<string>(
        (value) =>
          typeof value === "string" &&
          value.length >= 1 &&
          value.length <= MAX_NAME_LENGTH,
        `each column name must be a string of 1 to ${MAX_NAME_LENGTH} characters`,
      ),
      rowIndices: singleIssueArray<number>(
        (value) => Number.isSafeInteger(value) && (value as number) >= 0,
        "each row index must be a non-negative integer",
      ),
      rows: singleIssueArray<Array<string | null>>(
        isPayloadRow,
        "each payload row must be an array of strings or nulls",
      ),
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
 * `associationTable[0]`) and packages them for transmission. A `role: ignored`
 * column is never transmitted, regardless of its `isPayload` value -- the role
 * is the explicit "use this column for nothing" opt-out, so it wins over any
 * `isPayload: true` left on the column. Returns a no-data message when the
 * dataset has no transmittable payload columns or no matched rows.
 */
export function preparePayload(
  rawRows: Array<CSVRow>,
  metadata: Metadata,
  associationTable: AssociationTable,
): PayloadWireMessage {
  const payloadCols = metadata.filter(isDisclosedToPartner);
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

/**
 * Reject a non-empty `payload.send` data dictionary that does not name EXACTLY
 * the columns this party transmits.
 *
 * `payload.send` is the operator-authored data dictionary: it is exchanged with
 * the partner, shown on the consent screen, written verbatim into the
 * self-attested exchange record's `payloadSent`, and mirrored by a recurring
 * partner into its received-payload lock-in. What actually leaves the machine is
 * decided independently by each column's metadata via {@link isDisclosedToPartner}
 * (`isPayload && role !== "ignored"`) -- the single source of truth for
 * disclosure, the exact set {@link preparePayload} transmits. The two surfaces are
 * wired independently, so a dictionary can drift from what metadata sends in
 * either direction.
 *
 * A non-empty `payload.send` must therefore name exactly the disclosed set -- no
 * more and no less:
 * - OVER-declaration (a name metadata does not transmit: `isPayload: false`,
 *   `role: ignored`, or absent from metadata) makes the exchanged, consented, and
 *   recorded dictionary claim MORE than was sent.
 * - UNDER-declaration (a column metadata transmits but the dictionary omits)
 *   makes those surfaces claim LESS than was sent, and -- because a recurring
 *   partner mirrors this dictionary into its `payload.receive` and locks in on it
 *   ({@link reconcileReceivedPayload}) -- causes that partner to lock in too few
 *   columns and abort an otherwise-honest exchange when the metadata-governed
 *   transmission delivers the omitted column.
 *
 * Neither direction leaks: transmission is governed by metadata, which the
 * operator set, so this is a consent-, record-, and lock-in-accuracy guarantee,
 * not a leak control.
 *
 * An ABSENT or EMPTY `payload.send` is the deliberate exception (early return):
 * the guided and default paths author no dictionary while metadata still
 * transmits, and the cross-party mirror is lazy on an unauthored `receive`, so
 * holding an unauthored dictionary to equality would reject every such exchange.
 * Only a non-empty dictionary -- an explicit declaration -- is held to the
 * disclosed set. `payload.receive` is out of scope here: it has no local-metadata
 * counterpart (metadata gates sending, not receiving) and is cross-checked against
 * the partner's advertised `send` in `validateCompatibility`.
 *
 * Enforced at two points, both of which have the local metadata beside the
 * terms. `prepareForExchange` covers every exchange -- including the paths that
 * never mint an invitation (zero-setup, the acceptor, a hand-authored exchange
 * config) -- and protects the exchange record, which is built downstream of it.
 * But the dictionary also reaches the partner's consent screen via the invitation
 * token, which is encoded BEFORE `prepareForExchange` runs, so the check also runs
 * at the invitation-mint boundary (the CLI `validateInvite` config path and the
 * web `generateInvitation` authoring path) to keep the consent surface and the
 * token honest. The two points are disjoint entry paths, not redundant: neither
 * alone covers both the consent screen and the non-invite exchanges. Offending
 * names are partner-controlled on the accept side (the adopted inviter terms), so
 * the message routes each through {@link sanitizeForDisplay}, matching
 * `validateCompatibility`'s payload-mismatch messages.
 *
 * @throws {UsageError} when a non-empty `payload.send` does not name exactly the
 *   columns metadata discloses. A {@link UsageError} so the CLI classifies it as a
 *   configuration error (exit 64), not a transport failure.
 */
export function assertPayloadSendDisclosed(
  payload: Payload | undefined,
  metadata: Metadata,
): void {
  const send = payload?.send ?? [];
  if (send.length === 0) return;
  const sendNames = send.map((column) => column.name);
  const disclosed = disclosedColumnNames(metadata);
  const disclosedSet = new Set(disclosed);
  const sendSet = new Set(sendNames);
  const overDeclared = sendNames.filter((name) => !disclosedSet.has(name));
  const underDeclared = disclosed.filter((name) => !sendSet.has(name));
  if (overDeclared.length === 0 && underDeclared.length === 0) return;
  const problems: string[] = [];
  const remedies: string[] = [];
  if (overDeclared.length > 0) {
    const shown = overDeclared
      .map((name) => sanitizeForDisplay(name))
      .join(", ");
    const plural = overDeclared.length > 1;
    problems.push(
      `names ${plural ? "columns" : "a column"} metadata does not transmit ([${shown}])`,
    );
    remedies.push(
      `Remove [${shown}] from payload.send, or set ${plural ? "their" : "its"} ` +
        `metadata to transmit (is_payload: true and role not ignored).`,
    );
  }
  if (underDeclared.length > 0) {
    const shown = underDeclared
      .map((name) => sanitizeForDisplay(name))
      .join(", ");
    const plural = underDeclared.length > 1;
    problems.push(
      `omits ${plural ? "columns" : "a column"} metadata does transmit ([${shown}])`,
    );
    remedies.push(
      `Add [${shown}] to payload.send, or set ${plural ? "their" : "its"} ` +
        `metadata not to transmit (is_payload: false or role ignored).`,
    );
  }
  throw new UsageError(
    `payload.send must name exactly the columns this party's metadata ` +
      `discloses, but it ${problems.join(" and ")}. A payload column's values ` +
      `are sent only when its metadata has is_payload: true and role is not ` +
      `ignored; payload.send is the data dictionary exchanged with the partner, ` +
      `shown for consent, written into the exchange record, and mirrored into a ` +
      `recurring partner's received-payload lock-in, so a dictionary that does ` +
      `not match the disclosed set mis-states what is actually sent. ` +
      `${remedies.join(" ")}`,
  );
}

/**
 * Reject a persisted send-side disclosure COMMITMENT that this party's current
 * metadata can no longer produce.
 *
 * `committed` is the payload column set (in this party's OWN namespace) that it
 * PROMISED to disclose to its partner when the exchange was established -- the
 * invitation's `disclosedPayloadColumns`, persisted locally as the exchange
 * config's `disclosedPayloadColumns` by every `psilink invite` mint path that
 * publishes it. The partner locked that exact set in as what it will RECEIVE
 * (its `expectedPayloadColumns`) and enforces it at runtime via
 * {@link reconcileReceivedPayload}. This check runs on the COMMITTING party at
 * prepare time, before connecting, so a drift fails fast and locally instead of
 * surfacing later as the partner's mid-exchange abort.
 *
 * Distinct from the two adjacent guards, and complementary to both:
 * - {@link assertPayloadSendDisclosed} compares a present `payload.send`
 *   dictionary against this party's CURRENT metadata (an internal-consistency
 *   equality). This check instead compares CURRENT metadata against an EARLIER
 *   persisted promise -- a set frozen when the data may have differed -- which
 *   neither `payload.send` (held equal to current metadata by that guard) nor the
 *   metadata itself (the thing that drifts) can serve as. A config can pass
 *   `assertPayloadSendDisclosed` while still having drifted from what it promised
 *   a partner on a prior invitation; that is the gap this closes.
 * - {@link reconcileReceivedPayload} is the receive-side runtime lock-in; this is
 *   the proactive send-side counterpart that prevents the situation triggering it.
 *
 * The comparison is exact (both directions): the partner locked in the committed
 * set, so UNDER-delivery (a promised column no longer transmittable) AND
 * OVER-delivery (a column now transmitted that was not promised) each abort that
 * partner. Each direction is reported with a DUAL remedy so the check never
 * pressures the operator toward WIDER disclosure: narrowing one's own disclosure
 * is always legitimate, so re-establishing the exchange is offered beside
 * restoring the column, not as an afterthought.
 *
 * An ABSENT (undefined) `committed` is the lazy path: no commitment on record (a
 * first-contact party, a config predating this field, or a mint path that did not
 * know its metadata), so nothing is checked -- transmission stays governed by
 * metadata alone. An EMPTY committed set is NOT absent: it is a strict "disclose
 * nothing," so any currently-disclosed column fails. Mirrors the absent/empty
 * semantics of `expectedPayloadColumns` and the token's `disclosedPayloadColumns`.
 *
 * The names are this party's own (metadata- and config-derived) but are routed
 * through {@link sanitizeForDisplay} for consistency with the sibling send-side
 * guard.
 *
 * @throws {UsageError} when a present `committed` set is not exactly the columns
 *   this party's metadata currently discloses. A {@link UsageError} so the CLI
 *   classifies it as a local configuration error (exit 64) -- self-attributed and
 *   pre-connection -- distinct from {@link reconcileReceivedPayload}'s
 *   partner-attributed protocol abort (exit 69).
 */
export function assertDisclosureMatchesCommitment(
  committed: string[] | undefined,
  metadata: Metadata,
): void {
  if (committed === undefined) return;
  const disclosed = disclosedColumnNames(metadata);
  const disclosedSet = new Set(disclosed);
  const committedSet = new Set(committed);
  const noLongerDisclosed = committed.filter((name) => !disclosedSet.has(name));
  const newlyDisclosed = disclosed.filter((name) => !committedSet.has(name));
  if (noLongerDisclosed.length === 0 && newlyDisclosed.length === 0) return;
  const problems: string[] = [];
  const remedies: string[] = [];
  if (noLongerDisclosed.length > 0) {
    const shown = noLongerDisclosed
      .map((name) => sanitizeForDisplay(name))
      .join(", ");
    const plural = noLongerDisclosed.length > 1;
    problems.push(
      `no longer discloses ${plural ? "columns" : "a column"} it committed ` +
        `to send ([${shown}])`,
    );
    remedies.push(
      `To honor the commitment, set the metadata for [${shown}] to transmit ` +
        `(is_payload: true and role not ignored). To narrow the disclosure on ` +
        `purpose, re-establish the exchange (re-invite the partner) so it ` +
        `expects the smaller set.`,
    );
  }
  if (newlyDisclosed.length > 0) {
    const shown = newlyDisclosed
      .map((name) => sanitizeForDisplay(name))
      .join(", ");
    const plural = newlyDisclosed.length > 1;
    problems.push(
      `now discloses ${plural ? "columns" : "a column"} it did not commit ` +
        `to send ([${shown}])`,
    );
    remedies.push(
      `To match the commitment, set the metadata for [${shown}] not to ` +
        `transmit (is_payload: false or role ignored). To widen the disclosure ` +
        `on purpose, re-establish the exchange (re-invite the partner) so it ` +
        `expects [${shown}].`,
    );
  }
  throw new UsageError(
    `this party can no longer honor the payload disclosure it committed to when ` +
      `this exchange was established: it ${problems.join(" and ")}. The partner ` +
      `locked in the committed columns, so proceeding would make its exchange ` +
      `abort as a payload disclosure mismatch (a failure attributed to the ` +
      `partner) after data has begun moving. ${remedies.join(" ")}`,
  );
}

/**
 * Enforce, at runtime, that a received payload discloses no column the receiving
 * party did not consent to receive.
 *
 * `declared` is the column set this party LOCKED IN as what it will receive --
 * the inviter's `disclosedPayloadColumns` carried on the invitation (the set the
 * acceptor consented to on its review screen), a recurring party's persisted
 * lock-in, or the EMPTY set for a party not entitled to the result (which must
 * receive no payload at all). `assertPayloadSendDisclosed` is the mint-boundary,
 * forward (send-side) counterpart of this guard: that one keeps a party from
 * over-DECLARING what it sends; this one keeps a party from over-DELIVERING past
 * what the other consented to receive. The party must deliver exactly the
 * locked-in set, or the exchange aborts.
 *
 * The match is byte-exact and element-wise over the sorted column names (NOT a
 * delimiter-joined string, so a partner-controlled name containing the separator
 * cannot make two distinct sets compare equal), mirroring
 * {@link validateCompatibility}'s payload mirror.
 *
 * A PRESENT `declared` -- INCLUDING the empty set -- is enforced strictly: an
 * empty `declared` means "receive nothing," so a non-empty received set against it
 * aborts. That is the fail-closed path for a party not entitled to the result (the
 * caller passes `[]` when its own `expectsOutput` is false) and for an inviter that
 * disclosed nothing (the mint carries `[]`, not an omitted field). Only an ABSENT
 * (undefined) `declared` is lazy -- empty is NOT absent.
 *
 * Two cases are deliberately NOT a mismatch:
 * - `declared` ABSENT (undefined) is the LAZY reconciliation path: the party did
 *   not lock in an expectation, so it takes whatever it is given (zero-setup, and
 *   an output party's own receive side, left blank and filled lazily). This never
 *   widens disclosure -- transmission is governed by the SENDER's own
 *   `isDisclosedToPartner` metadata and `assertPayloadSendDisclosed`, both
 *   unchanged; receiving is not disclosing. A present-but-empty array is NOT this
 *   case: empty is a strict "receive nothing," not "no expectation."
 * - An EMPTY received column set (the partner sent no payload data -- no
 *   transmittable columns, or no matched rows) cannot exceed any consent, so it is
 *   accepted even against a non-empty `declared`. This is also what lets a
 *   correctly-gated no-output party (declared empty, received empty) pass, and
 *   avoids a false abort on a zero-match exchange.
 *
 * @throws {ConnectionError} of kind `"protocol"` when `declared` is present and
 *   the received non-empty column set is not exactly it. A protocol error because
 *   the peer violated the disclosure contract; the receiving party's callers
 *   surface it as a failed exchange. The offending names are partner-controlled,
 *   so both sides of the message route through {@link sanitizeForDisplay}.
 */
export function reconcileReceivedPayload(
  received: PartnerPayload,
  declared: string[] | undefined,
): void {
  if (declared === undefined) return;
  if (received.columns.length === 0) return;
  const got = [...received.columns].sort();
  const want = [...declared].sort();
  const matches =
    got.length === want.length && got.every((name, i) => name === want[i]);
  if (matches) return;
  const gotShown = got.map((name) => sanitizeForDisplay(name)).join(", ");
  const wantShown = want.map((name) => sanitizeForDisplay(name)).join(", ");
  const wantDescription =
    want.length === 0 ? `no payload at all` : `only [${wantShown}]`;
  throw new ConnectionError(
    `payload disclosure mismatch: the partner transmitted columns ` +
      `[${gotShown}] but this party expected to receive ${wantDescription}. ` +
      `The exchange is aborted because the payload received does not match what ` +
      `was consented to.`,
    "protocol",
  );
}

/** Maps a validated payload wire message into a {@link PartnerPayload}. */
function toPartnerPayload(msg: PayloadWireMessage): PartnerPayload {
  if (!msg.hasData) return { columns: [], rowIndices: [], rows: [] };
  return { columns: msg.columns, rowIndices: msg.rowIndices, rows: msg.rows };
}

/**
 * Map either payload representation -- the wire message this party sent, or the
 * {@link PartnerPayload} it received -- into the record's canonical
 * {@link CommittedPayload} form.
 *
 * Routing both sides through this one normalizer is what makes a sender's
 * `localPayloadSent` commitment and the receiver's `partnerPayloadReceived`
 * commitment cover byte-identical data for the same logical payload: the
 * transport-only `hasData` discriminant is dropped, and the no-data case maps to
 * empty arrays on both sides. The wire `rowIndices` are dropped too -- the
 * committed payload binds the column names and the row VALUES only, not the
 * sender's row numbers, so a receiver (which retains the received values but not
 * the partner's row numbers) can reopen its own `partnerPayloadReceived`
 * commitment from its retained result; the pairing is bound separately by the
 * association-table commitment (see {@link CommittedPayload} and
 * docs/spec/EXCHANGE_RECORD.md). The committed shape is owned by the record module
 * (`CommittedPayload`), not by this wire/transport layer; the explicit
 * field-by-field construction here means a future change to `PartnerPayload` or
 * the wire schema cannot silently alter the on-disk record format.
 */
export function toCommittedPayload(
  payload: PayloadWireMessage | PartnerPayload,
): CommittedPayload {
  if ("hasData" in payload && !payload.hasData)
    return { columns: [], rows: [] };
  return {
    columns: payload.columns,
    rows: payload.rows,
  };
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
  // guarantees the final frame survives a clean close - the send is durable
  // (file-sync writes the file before send resolves) and the clean close drains
  // it (waits for the peer to consume the last written file before cleanup
  // deletes it), or the clean close flushes buffered frames before teardown
  // (WebRTC). See the send/close contract in types.ts / messageConnection.ts
  // and docs/COMMUNICATION.md. Do not "fix" this by assuming send has
  // delivered.
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
  rawRows: Array<CSVRow>,
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
