import * as z from "zod";

import type { HandshakeRole, AssociationTable } from "./types.js";
import type { Metadata } from "./config/metadata.js";
import {
  isDisclosedToPartner,
  disclosedColumnNames,
  overlongDisclosedColumnPositions,
} from "./config/metadata.js";
import type { Output, Payload } from "./config/linkageTermsSchema.js";
import { MAX_NAME_LENGTH } from "./config/linkageTermsSchema.js";
import type { CompatibilityMessageFragment } from "./config/compatibilityMessage.js";
import {
  compatibilityMessage,
  quoteTermsValueList,
} from "./config/compatibilityMessage.js";
import type { OutboundPayloadConsent } from "./config/outboundPayloadConsent.js";
import { readRowColumn } from "./file.js";
import type { CSVRow } from "./file.js";
import type { CommittedPayload } from "./records/exchangeRecord.js";
import type { MessageConnection } from "./connection/messageConnection.js";
import {
  ConnectionError,
  receiveParsed,
} from "./connection/messageConnection.js";
import { singleIssueArray } from "./utils/singleIssueArray.js";
import { loneSurrogateIndex } from "./utils/wellFormedString.js";
import { OutboundDisclosureRefusalError, UsageError } from "./errors.js";

/** The payload received from the exchange partner after PSI linkage. */
export interface PartnerPayload {
  /**
   * All payload column names from the partner. Empty when partner had no data.
   */
  columns: string[];
  /**
   * The sender's original row indices, one per entry in {@link rows}.
   * `rowIndices[i]` is the sender's row index for the record in `rows[i]`. As a
   * lookup key, these values correspond to element `[1]` of the receiver's
   * local {@link AssociationTable} (the partner indices stored there are the
   * sender's row indices). Distinct: one entry addresses one of the sender's
   * rows, so a received message repeating an index is refused at parse.
   * Several of the receiver's association entries may address ONE of these --
   * what a deduplicating cardinality groups -- and the receiver joins them all
   * back to the single row it was sent. Empty when partner had no data.
   */
  rowIndices: number[];
  /**
   * Payload rows, one per DISTINCT matched record of the sender. Positional
   * against {@link columns}: `rows[i][j]` is the value the column named at
   * `columns[j]` contributed, so every row has exactly one cell per column
   * and a received message whose rows do not is refused at parse. Empty when
   * partner had no data.
   */
  rows: Array<Array<string | null>>;
}

// `rows` is a 2-D partner-controlled collection, bounded as ONE single-issue
// validator (utils/singleIssueArray.ts) over the whole structure rather than
// `z.array(z.array(z.string().nullable()))`. It is exposed to BOTH Zod
// RangeError classes on Zod 4.4.3: a single row of hundreds of thousands of
// invalid inner cells overflows the call stack spreading one issue per cell up
// through the inner-array and outer-`rows` frames (`Maximum call stack size
// exceeded`, ~300k), and a payload of millions of invalid ROWS throws `Invalid
// string length` building the error string from one issue per row (~3.5M).
// `isPayloadRow` validates a whole row (is-array, every cell string-or-null)
// INSIDE the outer single-issue `every`, so the entire structure yields at
// most one issue regardless of row OR cell count. A `.max()` is unsafe on
// either axis: a real exchange has one row per matched record, each as wide as
// the payload, both legitimately in the millions (MAX_FRAME_SIZE_BYTES bounds
// them). Each predicate stands in for the element schema it replaces --
// `z.string().nullable()` for a cell, the inner `z.array(...)` for a row --
// and the differential in test/payloadExchange.test.ts holds the two to the
// same accepted set.
// A received cell and column name go verbatim into the CommittedPayload the
// receipt MAC and the record commitments are canonically encoded over
// (toCommittedPayload), and that encoder terminates on an unpaired UTF-16
// surrogate -- which JSON escapes on the way out and restores on the way in,
// so one crosses the wire intact. Both are held to the shared well-formedness
// rule here, at the parse, rather than at an encode that runs after the
// exchange has disclosed. See docs/spec/CANONICAL_ENCODING.md, "Strings".
const isPayloadCell = (cell: unknown): boolean =>
  cell === null || (typeof cell === "string" && loneSurrogateIndex(cell) < 0);
const isPayloadRow = (row: unknown): boolean =>
  Array.isArray(row) && row.every(isPayloadCell);

// `rowIndices` is the lookup key the receiver reads the message by: each entry
// names one of the sender's rows and pairs it with the row of `rows` at the
// same position, so a repeat names two payload rows for one record and the
// message does not say which is the record's. A structural property of the
// frame, refused here alongside every other malformed shape rather than
// downstream. The scan runs only on a frame that already passed length parity,
// stops at the first repeat, and its Set is sized by the entries the frame
// already materialized, not by any bound the partner names.
const hasDistinctRowIndices = (rowIndices: ReadonlyArray<number>): boolean => {
  const seen = new Set<number>();
  for (const rowIndex of rowIndices) {
    if (seen.has(rowIndex)) return false;
    seen.add(rowIndex);
  }
  return true;
};

// A payload row is positional against `columns`: its cell at each offset is
// the value of the column named at that offset, so a row of any other width
// has a value no column names or leaves a named column without one -- and
// a frame naming NO column while holding rows is the whole of one row's
// values against none. The record commits the column names and the row
// VALUES together (toCommittedPayload) while its readable governance list is
// the names alone, so the two halves of one exchange record describe the same
// disclosure only while the widths agree. A structural property of the frame,
// refused here alongside every other malformed shape rather than at the
// record or output stage that reads it. preparePayload emits exactly one cell
// per transmitted column, so no honest frame is narrowed by this. The scan
// reads only the row lengths the frame already materialized and stops at the
// first offender.
//
// Each row is held to being an array before its width is read: a string
// has a `length` of its own, so one spelling the declared count would
// pass a width comparison alone and hand out its characters as the row's
// cells. The wire schema refuses a non-array row at parse, but this guard
// also stands behind an exported entry point whose PartnerPayload argument no
// type ties to a parsed frame.
const hasOneCellPerColumn = (
  columnCount: number,
  rows: ReadonlyArray<ReadonlyArray<string | null>>,
): boolean =>
  rows.every((row) => Array.isArray(row) && row.length === columnCount);

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
      // issue accumulation at one regardless of count
      // (utils/singleIssueArray.ts), which payloadExchange.test.ts drives at a
      // count that would otherwise build that string. A count `.max()` is
      // wrong for `rowIndices` (one per matched record, legitimately in the
      // millions like `rows`) and unnecessary for `columns`; both predicates
      // stand in for the element schema they replace -- typeof-string for
      // `z.string()`, Number.isSafeInteger and `>= 0` for
      // `z.number().int().nonnegative()` -- under the same differential that
      // covers the `rows` predicates.
      //
      // `columns` additionally bounds each NAME's LENGTH to the same
      // MAX_NAME_LENGTH ceiling the operator's own `terms.payload.receive`
      // names have: a received column name flows verbatim into this party's
      // local exchange-record file (via governance.payloadReceived), so it
      // has the same bound those names do. Both the `.min(1)` floor and
      // the MAX_NAME_LENGTH ceiling are enforced here, as a per-ELEMENT length
      // check folded into the same single `every` pass (not a count `.max()`),
      // so it caps accumulation at one issue regardless of element count. The
      // floor is safe against an honest sender: inferMetadata rejects an empty
      // name at intake, so an honest sender never emits a `""` column (e.g.
      // from a trailing-comma CSV header); it instead refuses a partner who
      // hand-crafts `[""]` to suppress this party's record (the
      // exchange-record `.min(1)` remains the on-disk safety check). The
      // well-formedness scan stated at `isPayloadCell` rides in the same pass,
      // a name being committed exactly as a cell is.
      columns: singleIssueArray<string>(
        (value) =>
          typeof value === "string" &&
          value.length >= 1 &&
          value.length <= MAX_NAME_LENGTH &&
          loneSurrogateIndex(value) < 0,
        `each column name must be a string of 1 to ${MAX_NAME_LENGTH} characters with no unpaired UTF-16 surrogate`,
      ),
      rowIndices: singleIssueArray<number>(
        (value) => Number.isSafeInteger(value) && (value as number) >= 0,
        "each row index must be a non-negative integer",
      ),
      rows: singleIssueArray<Array<string | null>>(
        isPayloadRow,
        "each payload row must be an array of strings or nulls with no unpaired UTF-16 surrogate",
      ),
    })
    .superRefine((v, ctx) => {
      // Ordered by cost, so a frame refused on one check never pays the next:
      // parity is a length comparison, the width scan reads lengths and allocates
      // nothing, and only the distinctness scan builds a Set over the entries.
      if (v.rowIndices.length !== v.rows.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "rowIndices and rows must have the same length",
        });
        return;
      }
      if (!hasOneCellPerColumn(v.columns.length, v.rows)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "each payload row must have one value per declared column",
        });
        return;
      }
      if (!hasDistinctRowIndices(v.rowIndices)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "rowIndices must not repeat a row index",
        });
      }
    }),
]);

/**
 * Wire format sent over the connection during payload exchange.
 *
 * Exported only because it is the return type of {@link preparePayload};
 * callers should use type inference rather than naming this type directly. Do
 * not widen this to a documented public API type.
 *
 * @internal
 */
export type PayloadWireMessage = z.infer<typeof payloadWireSchema>;

/**
 * The local rows a payload frame holds for a matched table: each distinct
 * matched row once, in first-occurrence order.
 *
 * A payload row is addressed by the SENDER's own row index, so a frame
 * holds one row per matched RECORD however many pairs that record stands
 * in. Under a deduplicating cardinality the local half of the association
 * table repeats a row -- several of the partner's records link to one of this
 * party's (see {@link AssociationTable}) -- and emitting one payload row per
 * PAIR would repeat an index, which the receiver's parse refuses as a
 * malformed frame, and would put one record's values in the committed
 * payload several times.
 *
 * The re-supply path reproduces this same selection from the retained result
 * file (`reconstructCommittedData`, recordVerification.ts), so a sender
 * reopens its own payload commitment from its own retained files; both sides
 * read this one definition rather than restating it.
 */
export function distinctMatchedRows(
  matchedRows: ReadonlyArray<number>,
): number[] {
  const seen = new Set<number>();
  const distinct: number[] = [];
  for (const row of matchedRows) {
    if (seen.has(row)) continue;
    seen.add(row);
    distinct.push(row);
  }
  return distinct;
}

/**
 * Prepares the payload message to send after PSI linkage.
 *
 * Gathers all `isPayload` columns from the matched rows -- each row
 * `associationTable[0]` names, once ({@link distinctMatchedRows}) -- and packages
 * them for transmission. A `role: ignored` column is never transmitted,
 * regardless of its `isPayload` value -- the role is the explicit "use this
 * column for nothing" opt-out, so it wins over any `isPayload: true` left on the
 * column. Returns a no-data message when the dataset has no transmittable payload
 * columns or no matched rows.
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
  const rowIndices = distinctMatchedRows(associationTable[0]);
  const rows = rowIndices.map((idx) => {
    const row = rawRows[idx];
    return columns.map((col) =>
      row ? (readRowColumn(row, col) ?? null) : null,
    );
  });

  return { hasData: true, columns, rowIndices, rows };
}

/**
 * Reject a PRESENT `payload.send` data dictionary that does not name EXACTLY
 * the columns this party transmits.
 *
 * `payload.send` is the operator-authored data dictionary: exchanged with the
 * partner, shown on the consent screen, written into the exchange record's
 * `payloadSent`, and mirrored by a recurring partner into its recorded
 * received-payload expectation. What actually leaves the machine is decided
 * independently by each column's metadata via {@link isDisclosedToPartner}
 * (`isPayload && role !== "ignored"`), the set {@link preparePayload}
 * transmits -- so a dictionary can drift from what metadata sends in either
 * direction: OVER-declaration (a name metadata does not transmit) claims more
 * than was sent; UNDER-declaration (a column metadata transmits but the
 * dictionary omits) claims less, and can make a recurring partner's
 * {@link reconcileReceivedPayload} abort when the omitted column arrives
 * anyway.
 *
 * An ABSENT `payload.send` is not checked: the guided and default paths
 * author no dictionary while metadata still transmits, and the cross-party
 * mirror is lazy on an unauthored `receive`. An acceptor's own outbound set,
 * left unauthored this way, is instead covered by
 * {@link assertOutboundPayloadConsented}. A PRESENT-but-empty dictionary IS
 * checked: it is an explicit "I disclose nothing," so any disclosed column is
 * an under-declaration -- except when `output.shareWithPartner` is false,
 * since `runExchange` then sends nothing regardless of what metadata
 * discloses and there is nothing left to control. The non-empty case is
 * never gated on `output`: the dictionary is exchanged, shown for consent,
 * and recorded whatever the output direction, so it is held to the disclosed
 * set even when the columns never move. `payload.receive` is out of scope:
 * metadata gates sending, not receiving; `validateCompatibility`
 * cross-checks it instead.
 *
 * Enforced at two points, both with the local metadata beside the terms:
 * `prepareForExchange` (every exchange, including paths with no invitation)
 * and the invitation-mint boundary (CLI `validateInvite`, web
 * `generateInvitation`), since the dictionary reaches the partner's consent
 * screen via the invitation token, encoded before `prepareForExchange` runs.
 * Offending names are partner-controlled on the accept side, so the messages
 * below compose through {@link compatibilityMessage}
 * (`config/compatibilityMessage.ts`), as `validateCompatibility`'s
 * payload-mismatch messages do: each name stands in its own delimited run, so
 * none can forge the bracketed list's partition or a clause of psilink's own,
 * and the display escape still runs once where the error is rendered.
 *
 * @param output This party's own output declaration, from the same
 *   {@link LinkageTerms} the `payload` comes from. Required so every call
 *   site states the direction and the `shareWithPartner` reading lives here
 *   alone.
 * @throws {UsageError} when a present `payload.send` does not name exactly the
 *   columns metadata discloses. A {@link UsageError} so the CLI classifies it as a
 *   configuration error (exit 64), not a transport failure.
 */
export function assertPayloadSendDisclosed(
  payload: Payload | undefined,
  metadata: Metadata,
  output: Output,
): void {
  const send = payload?.send;
  if (send === undefined) return;
  if (send.length === 0 && !output.shareWithPartner) return;
  const sendNames = send.map((column) => column.name);
  const disclosed = disclosedColumnNames(metadata);
  const disclosedSet = new Set(disclosed);
  const sendSet = new Set(sendNames);
  const overDeclared = sendNames.filter((name) => !disclosedSet.has(name));
  const underDeclared = disclosed.filter((name) => !sendSet.has(name));
  if (overDeclared.length === 0 && underDeclared.length === 0) return;
  const problems: CompatibilityMessageFragment[] = [];
  const remedies: CompatibilityMessageFragment[] = [];
  if (overDeclared.length > 0) {
    const shown = quoteTermsValueList(overDeclared);
    const plural = overDeclared.length > 1;
    problems.push(
      plural
        ? compatibilityMessage`names columns metadata does not transmit ([${shown}])`
        : compatibilityMessage`names a column metadata does not transmit ([${shown}])`,
    );
    remedies.push(
      plural
        ? compatibilityMessage`Remove [${shown}] from payload.send, or set their metadata to transmit (is_payload: true and role not ignored).`
        : compatibilityMessage`Remove [${shown}] from payload.send, or set its metadata to transmit (is_payload: true and role not ignored).`,
    );
  }
  if (underDeclared.length > 0) {
    const shown = quoteTermsValueList(underDeclared);
    const plural = underDeclared.length > 1;
    problems.push(
      plural
        ? compatibilityMessage`omits columns metadata does transmit ([${shown}])`
        : compatibilityMessage`omits a column metadata does transmit ([${shown}])`,
    );
    // An EMPTY send gets a different remedy: "add them to payload.send" is wrong
    // advice there. On an accepted invitation the empty send is the mirror of the
    // inviter's `payload.receive: []` -- the partner declared it will take nothing
    // -- so widening the declaration locally would not make the disclosure agreed,
    // and the next acceptance would overwrite it. Narrowing what is transmitted,
    // or getting a corrected invitation, are the remedies that exist.
    if (sendNames.length === 0)
      remedies.push(
        compatibilityMessage`Set the metadata for [${shown}] not to transmit (is_payload: false or role ignored). An empty payload.send declares that this party discloses nothing; on an accepted invitation it mirrors the partner's payload.receive, so disclosing these columns instead takes a corrected invitation, not a local edit.`,
      );
    else
      remedies.push(
        plural
          ? compatibilityMessage`Add [${shown}] to payload.send, or set their metadata not to transmit (is_payload: false or role ignored).`
          : compatibilityMessage`Add [${shown}] to payload.send, or set its metadata not to transmit (is_payload: false or role ignored).`,
      );
  }
  // Folded through the tag rather than joined: `join` yields a plain `string`, so
  // the brand -- and with it the compiler's guarantee that nothing partner-chosen
  // entered the clause structure raw -- would be gone before the throw. Both
  // lists are non-empty by the early return above, so the seedless fold is total.
  const problem = problems.reduce(
    (left, right) => compatibilityMessage`${left} and ${right}`,
  );
  const remedy = remedies.reduce(
    (left, right) => compatibilityMessage`${left} ${right}`,
  );
  throw new UsageError(
    compatibilityMessage`payload.send must name exactly the columns this party's metadata discloses, but it ${problem}. ${remedy}`,
  );
}

/**
 * Reject a disclosed column whose NAME is longer than {@link MAX_NAME_LENGTH},
 * before any credential, terms, or data are sent.
 *
 * The name of a transmitted column is carried, not just used: it rides the
 * payload frame's `columns` list to the partner, whose parse refuses a
 * longer one, and it is written into this party's own exchange record, whose
 * `name` bound refuses it too. Metadata inferred from a CSV header
 * (`inferMetadata`) passes through no schema, so an oversized header reaches
 * here unbounded; without this check the partner's parse would be the first
 * enforcement, reached only after the frame has been sent.
 *
 * Scoped to the disclosed set ({@link overlongDisclosedColumnPositions}): a
 * column that is never sent carries its name nowhere.
 *
 * Gated on `output`, as {@link assertPayloadSendDisclosed} gates its empty
 * case: `runExchange` builds this party's payload only when the PARTNER is
 * entitled to the result, so with `output.shareWithPartner` false no column
 * leaves the machine and there is no carried name to bound.
 * `validateCompatibility` holds this party's `shareWithPartner` equal to the
 * partner's `expectsOutput`, so the transmission gate cannot disagree.
 *
 * The offending name is not echoed -- it broke a length bound, so it is
 * longer than a readable message -- the error names the input column
 * positions instead, as {@link inferMetadata}'s empty-name refusal does;
 * disclosedNameBound.test.ts holds the refusal to positions, never the name.
 *
 * @param output This party's own output declaration, from the same
 *   {@link LinkageTerms} the metadata is prepared against. Required so every
 *   call site states the direction.
 * @throws {UsageError} when a disclosed column's name exceeds
 *   {@link MAX_NAME_LENGTH} UTF-16 code units. A {@link UsageError} so the CLI
 *   classifies it as a configuration error (exit 64), not a transport failure.
 */
export function assertDisclosedNamesCarriable(
  metadata: Metadata,
  output: Output,
): void {
  if (!output.shareWithPartner) return;
  const positions = overlongDisclosedColumnPositions(metadata);
  if (positions.length === 0) return;
  const plural = positions.length > 1;
  throw new UsageError(
    `metadata column${plural ? "s" : ""} ${positions.join(", ")} ` +
      `(counted in the metadata's own order, which is the file's header order ` +
      `when the metadata was inferred) ` +
      `${plural ? "are" : "is"} sent to the partner, but ` +
      `${plural ? "their names are" : "its name is"} longer than the ` +
      `${MAX_NAME_LENGTH}-character limit on a column name (counted in UTF-16 ` +
      `code units, so a character outside the Basic Multilingual Plane counts as ` +
      `two). A payload column's name travels with its values: the partner's parse ` +
      `of the payload frame refuses a longer name, as does the exchange record ` +
      `this party writes, so the exchange could not complete. Shorten the ` +
      `column name${plural ? "s" : ""}, or set the metadata not to transmit ` +
      `${plural ? "them" : "it"} (is_payload: false or role ignored).`,
  );
}

/**
 * Reject a persisted send-side disclosure COMMITMENT that this party's current
 * metadata can no longer produce.
 *
 * `committed` is the payload column set (in this party's OWN namespace) that
 * it PROMISED to disclose to its partner when the exchange was established --
 * the invitation's `disclosedPayloadColumns`, persisted locally as the
 * exchange config's `disclosedPayloadColumns` by every `psilink invite` mint
 * path that publishes it. The partner locked that exact set in as what it
 * will RECEIVE (its `expectedPayloadColumns`) and enforces it at runtime via
 * {@link reconcileReceivedPayload}. This check runs on the COMMITTING party
 * at prepare time, before any credential, terms, or data are sent, so a
 * drift fails fast and locally instead of surfacing as the partner's
 * mid-exchange abort.
 *
 * Distinct from the two adjacent guards: {@link assertPayloadSendDisclosed}
 * compares a present `payload.send` dictionary against CURRENT metadata; this
 * check compares CURRENT metadata against an EARLIER persisted promise -- a
 * config can pass that guard while still having drifted from what it
 * promised on a prior invitation, which is the gap this closes.
 * {@link reconcileReceivedPayload} is the receive-side runtime enforcement;
 * this is the proactive send-side counterpart that prevents triggering it.
 *
 * The comparison is exact in both directions: the partner locked in the
 * committed set, so UNDER-delivery (a promised column no longer
 * transmittable) AND OVER-delivery (a column now transmitted that was not
 * promised) each abort that partner. Each direction is reported with a DUAL
 * remedy, since narrowing one's own disclosure is always legitimate:
 * re-establishing the exchange is offered beside restoring the column.
 *
 * An ABSENT (undefined) `committed` is the lazy path: no commitment on
 * record (a first-contact party, a config predating this field, or a mint
 * path that did not know its metadata), so nothing is checked. An EMPTY
 * committed set is NOT absent: it is a strict "disclose nothing," so any
 * currently-disclosed column fails -- mirroring the absent/empty semantics of
 * `expectedPayloadColumns` and the token's `disclosedPayloadColumns`.
 *
 * The names are this party's own (metadata- and config-derived) and, like
 * the sibling send-side guard's, are interpolated raw into the error.
 *
 * @throws {OutboundDisclosureRefusalError} when a present `committed` set is
 *   not exactly the columns this party's metadata currently discloses. A
 *   {@link UsageError} subclass, so the CLI classifies it as a local
 *   configuration error (exit 64) -- self-attributed, and raised before any
 *   credential, terms, or data are sent -- distinct from
 *   {@link reconcileReceivedPayload}'s partner-attributed protocol abort
 *   (exit 69), and a caller that bookkeeps failures tells this refusal from a
 *   transport fault.
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
    const shown = noLongerDisclosed.join(", ");
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
    const shown = newlyDisclosed.join(", ");
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
  throw new OutboundDisclosureRefusalError(
    `this party can no longer honor the payload disclosure it committed to when ` +
      `this exchange was established: it ${problems.join(" and ")}. The partner ` +
      `locked in the committed columns, so proceeding would make its exchange ` +
      `abort as a payload disclosure mismatch (a failure attributed to the ` +
      `partner) after data has begun moving. ${remedies.join(" ")}`,
  );
}

/**
 * Derive the {@link OutboundPayloadConsent} record a consenting surface
 * writes -- the WRITER's counterpart to {@link assessOutboundPayloadConsent},
 * which reads the record back before every later run.
 *
 * `metadata` is the metadata the surface resolved and showed the operator, or
 * `undefined` where it could resolve none (no input file was named, or its
 * columns could not satisfy the invitation's linkage keys). The column set
 * is resolved here through {@link disclosedColumnNames} -- the predicate
 * {@link preparePayload} transmits on and
 * {@link assessOutboundPayloadConsent} re-resolves at the run -- so a
 * recorded confirmation cannot name a set other than the one that leaves the
 * machine.
 *
 * The three outcomes are the record's three states:
 * - ABSENT (`undefined`) where `output.shareWithPartner` is false: nothing
 *   crosses, so there is no disclosure to consent to. The same output gate
 *   {@link assessOutboundPayloadConsent} applies when reading.
 * - `pending` where the set was not resolvable, so the first run that can
 *   resolve it shows and confirms it, and an unattended one refuses.
 * - `confirmed` with the resolved set otherwise.
 *
 * Every surface that takes this consent derives its record here -- the
 * CLI's acceptance and the browser's -- so no front end records one on a
 * rule of its own.
 */
export function deriveOutboundPayloadConsent(
  output: Output,
  metadata: Metadata | undefined,
): OutboundPayloadConsent | undefined {
  if (!output.shareWithPartner) return undefined;
  if (metadata === undefined) return { status: "pending" };
  return { status: "confirmed", columns: disclosedColumnNames(metadata) };
}

/**
 * What this party's recorded {@link OutboundPayloadConsent} says about the column
 * set the run it is about to make would actually transmit. Produced by
 * {@link assessOutboundPayloadConsent}; a front end reads it to show and confirm
 * the set, and {@link assertOutboundPayloadConsented} turns the one blocking case
 * into a refusal.
 */
type OutboundPayloadConsentVerdict =
  | {
      /** Nothing to check: no consent record, or nothing is transmitted at all. */
      status: "not-required";
      reason: "no-record" | "nothing-transmitted";
    }
  | {
      /** The resolved set is exactly the one this party confirmed. */
      status: "current";
      columns: string[];
    }
  | OutboundPayloadConsentConfirmationRequired;

/** The one blocking {@link OutboundPayloadConsentVerdict} case. */
export interface OutboundPayloadConsentConfirmationRequired {
  status: "confirmation-required";
  /**
   * `unconfirmed` -- a `pending` record: this party has never confirmed a set.
   * `changed` -- a `confirmed` record the resolved set no longer matches.
   */
  reason: "unconfirmed" | "changed";
  /** The set this run would transmit, resolved from this party's own metadata. */
  columns: string[];
  /** The previously confirmed set; `undefined` for `unconfirmed`. */
  confirmed: string[] | undefined;
  /** Columns this run would transmit that were not confirmed. */
  added: string[];
  /** Confirmed columns this run would no longer transmit. */
  removed: string[];
}

/**
 * Compare this party's recorded consent to its own outbound payload set
 * against the set its CURRENT metadata would actually transmit.
 *
 * The resolved set is {@link disclosedColumnNames} over the metadata --
 * exactly what {@link preparePayload} transmits -- so a front end that shows
 * this verdict cannot overstate or understate what leaves the machine. The
 * comparison is by membership (as {@link assertPayloadSendDisclosed}'s is),
 * not order: metadata order decides the order columns are transmitted in but
 * not WHICH are, so a reordered input header is not a change of disclosure.
 *
 * Two cases need no confirmation and are reported as such:
 * - No consent record (the field absent). Every non-acceptor is here -- an
 *   inviter authored its own set at mint and pinned it as
 *   `disclosedPayloadColumns`, a zero-setup or hand-authored config never
 *   consented to one -- the lazy path that leaves prior behavior untouched.
 * - `output.shareWithPartner` false. `runExchange` builds this party's
 *   payload only when the PARTNER is entitled to the result, so nothing
 *   leaves the machine and there is no disclosure to confirm -- the same
 *   output gate {@link assertPayloadSendDisclosed} applies to its empty
 *   case, matching what an acceptance displays for that invitation shape.
 *
 * Narrowing is a mismatch exactly as widening is: the confirmed set is what
 * the exchange record and the partner-facing consent surface state, so a run
 * transmitting FEWER columns than confirmed still transmits a set no party
 * chose. Both directions are reported, and the front end asks again.
 */
export function assessOutboundPayloadConsent(
  consent: OutboundPayloadConsent | undefined,
  metadata: Metadata,
  output: Output,
): OutboundPayloadConsentVerdict {
  if (consent === undefined)
    return { status: "not-required", reason: "no-record" };
  if (!output.shareWithPartner)
    return { status: "not-required", reason: "nothing-transmitted" };
  const columns = disclosedColumnNames(metadata);
  if (consent.status === "pending")
    return {
      status: "confirmation-required",
      reason: "unconfirmed",
      columns,
      confirmed: undefined,
      added: [],
      removed: [],
    };
  const confirmedSet = new Set(consent.columns);
  const resolvedSet = new Set(columns);
  const added = columns.filter((name) => !confirmedSet.has(name));
  const removed = consent.columns.filter((name) => !resolvedSet.has(name));
  if (added.length === 0 && removed.length === 0)
    return { status: "current", columns };
  return {
    status: "confirmation-required",
    reason: "changed",
    columns,
    confirmed: consent.columns,
    added,
    removed,
  };
}

/**
 * The refusal for a blocking {@link OutboundPayloadConsentVerdict}, built
 * here so the fail-closed safety check ({@link assertOutboundPayloadConsented})
 * and a front end that refuses after showing the set cannot state the
 * condition two ways.
 *
 * The column names are this party's OWN (metadata- and config-derived) and
 * are interpolated raw, like the sibling guards': an error is escaped once
 * where it is rendered. The remedies name no command, since both a CLI run
 * and a browser acceptance reach this; the surface that catches it supplies
 * its own invocation.
 *
 * An {@link OutboundDisclosureRefusalError}, so the CLI's `instanceof
 * UsageError` check classifies it as a local configuration error (exit 64) --
 * self-attributed, and raised before any credential, terms, or data are sent
 * -- rather than a transport failure (69), and a caller that bookkeeps
 * failures tells this refusal from a transport fault.
 */
export function outboundPayloadConsentRefusal(
  verdict: OutboundPayloadConsentConfirmationRequired,
): OutboundDisclosureRefusalError {
  const shown =
    verdict.columns.length === 0
      ? "no columns"
      : `[${verdict.columns.join(", ")}]`;
  if (verdict.reason === "unconfirmed")
    return new OutboundDisclosureRefusalError(
      `this exchange has not confirmed which of its own columns it sends to the ` +
        `partner for matched records, and would send ${shown}. Accepting an ` +
        `invitation settles what you RECEIVE; what you SEND comes from your own ` +
        `input file, so it is confirmed separately and was not confirmed when ` +
        `this exchange was accepted (no input file was named then, or its ` +
        `columns could not satisfy the linkage keys). Run the exchange from an ` +
        `interactive terminal, where the columns are shown and confirmed before ` +
        `any credential, terms, or data are sent; or accept the invitation again ` +
        `naming your input file, which confirms them at that point.`,
    );
  const changes: string[] = [];
  if (verdict.added.length > 0)
    changes.push(
      `it would now send ${verdict.added.length > 1 ? "columns" : "a column"} ` +
        `you did not confirm ([${verdict.added.join(", ")}])`,
    );
  if (verdict.removed.length > 0)
    changes.push(
      `it would no longer send ${verdict.removed.length > 1 ? "columns" : "a column"} ` +
        `you did confirm ([${verdict.removed.join(", ")}])`,
    );
  return new OutboundDisclosureRefusalError(
    `the columns this exchange sends to the partner for matched records are not ` +
      `the ones you confirmed for it: ${changes.join(" and ")}. Your input file ` +
      `decides the set, so a changed file changes your disclosure -- and the ` +
      `exchange record and your partner's consent surface state the confirmed ` +
      `set, so a narrower one is a mismatch no less than a wider one. Run the ` +
      `exchange from an interactive terminal to review and confirm ${shown}, or ` +
      `use the input file whose columns you confirmed.`,
  );
}

/**
 * Fail closed, before any credential, terms, or data are sent, on an
 * outbound payload set this party has not confirmed -- the run-boundary
 * safety check behind {@link assessOutboundPayloadConsent}.
 *
 * The boundary this and its two sibling prepare-time guards hold is what has
 * been SENT, not whether a socket is open: an unpinned SFTP configuration
 * establishes first-use host-key trust over a credential-free probe ahead of
 * them, so a refusal here cannot claim that nothing has connected -- only
 * that nothing this party discloses has left the machine.
 *
 * Enforced from `prepareForExchange`, so every path that prepares an
 * exchange inherits it whether or not its front end ran the confirmation
 * flow. A front end that DOES run one (showing the resolved set and asking)
 * records the answer, so this passes; one that does not -- an unattended
 * run, a caller that skipped the flow -- refuses here rather than
 * transmitting a set neither party chose. A no-op for every party with no
 * consent record on file, which is every non-acceptor.
 *
 * @throws {OutboundDisclosureRefusalError} when a recorded consent does not
 *   cover the set this run would transmit. See
 *   {@link outboundPayloadConsentRefusal}.
 */
export function assertOutboundPayloadConsented(
  consent: OutboundPayloadConsent | undefined,
  metadata: Metadata,
  output: Output,
): void {
  const verdict = assessOutboundPayloadConsent(consent, metadata, output);
  if (verdict.status !== "confirmation-required") return;
  throw outboundPayloadConsentRefusal(verdict);
}

/**
 * Enforce, at runtime, that a received payload discloses no column the
 * receiving party did not consent to receive.
 *
 * `declared` is the column set this party LOCKED IN as what it will receive
 * -- the inviter's `disclosedPayloadColumns` held on the invitation (the
 * set the acceptor consented to on its review screen), a recurring party's
 * persisted expectation, or the EMPTY set for a party not entitled to the
 * result (which must receive no payload at all). `assertPayloadSendDisclosed`
 * is the mint-boundary, forward (send-side) counterpart of this guard: that
 * one keeps a party from over-DECLARING what it sends; this one keeps a party
 * from over-DELIVERING past what the other consented to receive. The party
 * must deliver exactly the locked-in set, or the exchange aborts.
 *
 * The match is byte-exact and element-wise over the sorted column names (NOT
 * a delimiter-joined string, so a partner-controlled name containing the
 * separator cannot make two distinct sets compare equal), mirroring
 * {@link validateCompatibility}'s payload mirror.
 *
 * A PRESENT `declared` -- INCLUDING the empty set -- is enforced strictly: an
 * empty `declared` means "receive nothing," so a non-empty received set
 * against it aborts -- the fail-closed path for a party not entitled to the
 * result (the caller passes `[]` when its own `expectsOutput` is false) and
 * for an inviter that disclosed nothing (the mint holds `[]`, not an
 * omitted field). Only an ABSENT (undefined) `declared` is lazy -- empty is
 * NOT absent.
 *
 * Two cases are NOT a mismatch:
 * - `declared` ABSENT (undefined): the LAZY reconciliation path, where the
 *   party did not lock in an expectation and takes whatever it is given
 *   (zero-setup, and an output party's own receive side, left blank and
 *   filled lazily). This never widens disclosure -- transmission stays
 *   governed by the SENDER's own `isDisclosedToPartner` metadata and
 *   `assertPayloadSendDisclosed`; receiving is not disclosing. A
 *   present-but-empty array is NOT this case.
 * - An EMPTY received column set (the partner sent no payload data): cannot
 *   exceed any consent, so it is accepted even against a non-empty
 *   `declared`. This also lets a correctly-gated no-output party (declared
 *   empty, received empty) pass, and avoids a false abort on a zero-match
 *   exchange. The values riding with the columns are held to the names by
 *   the wire schema, which admits no row a column does not name, so an
 *   empty received set holds nothing to consent to.
 *
 * @throws {ConnectionError} of kind `"protocol"` when `declared` is present
 *   and the received non-empty column set is not exactly it. A protocol
 *   error because the peer violated the disclosure contract; the receiving
 *   party's callers surface it as a failed exchange. The offending names are
 *   partner-controlled and interpolated raw, escaped once where the error is
 *   rendered.
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
  const gotShown = got.join(", ");
  const wantShown = want.join(", ");
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

function toPartnerPayload(msg: PayloadWireMessage): PartnerPayload {
  if (!msg.hasData) return { columns: [], rowIndices: [], rows: [] };
  return { columns: msg.columns, rowIndices: msg.rowIndices, rows: msg.rows };
}

/**
 * Map either payload representation -- the wire message this party sent, or
 * the {@link PartnerPayload} it received -- into the record's canonical
 * {@link CommittedPayload} form.
 *
 * Routing both sides through this one normalizer is what makes a sender's
 * `localPayloadSent` commitment and the receiver's `partnerPayloadReceived`
 * commitment cover byte-identical data for the same logical payload: the
 * transport-only `hasData` discriminant is dropped, and the no-data case
 * maps to empty arrays on both sides. The wire `rowIndices` are dropped too
 * -- the committed payload binds the column names and the row VALUES only,
 * not the sender's row numbers, so a receiver (which retains the received
 * values but not the partner's row numbers) can reopen its own
 * `partnerPayloadReceived` commitment from its retained result; the pairing
 * is bound separately by the association-table commitment (see
 * {@link CommittedPayload} and docs/spec/EXCHANGE_RECORD.md). The committed
 * shape is owned by the record module (`CommittedPayload`), not this
 * wire/transport layer; the explicit field-by-field construction here means
 * a future change to `PartnerPayload` or the wire schema cannot silently
 * alter the on-disk record format.
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
 * {@link PartnerPayload} rows are in the SENDER's matched-row order, one per
 * distinct row it matched, and are joined to this party's association
 * entries by the row indices that ride with them ({@link buildOutputTable}).
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
  // This is the exchange's terminal frame. On a buffering transport (WebRTC)
  // it looks racy: the responder's last act is a fire-and-forget send
  // (resolves on local hand-off, not peer delivery) right before the caller
  // tears the connection down. It is safe because the transport delivery
  // contract guarantees the final frame survives a clean close -- the send is
  // durable (file-sync writes the file before send resolves) and the clean
  // close drains it (waits for the peer to consume the last written file
  // before cleanup deletes it), or the clean close flushes buffered frames
  // before teardown (WebRTC). See the send/close contract in types.ts /
  // messageConnection.ts and docs/COMMUNICATION.md. Do not "fix" this by
  // assuming send has delivered.
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

// Pick a column name not already taken, starting from `base` and falling back to
// a `their_`-prefixed (then numbered) variant. Used for the partner row-index
// column so it never collides with our identifier column or a partner payload
// column, mirroring the their_-prefix disambiguation the payload columns use.
function uniqueColumnName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  const prefixed = `their_${base}`;
  if (!taken.has(prefixed)) return prefixed;
  let n = 2;
  while (taken.has(`${prefixed}_${n}`)) n++;
  return `${prefixed}_${n}`;
}

/**
 * Formats an exchange result into header and row arrays suitable for CSV
 * output.
 *
 * One result row per association PAIR. Under a deduplicating cardinality a
 * row index repeats on one side of the table -- several of our records
 * against one of the partner's, or the reverse -- and each such pair is its
 * own result row: our identifier repeats down the column where the
 * multiplicity is ours, and one partner payload row is written against each
 * of our records where it is the partner's. The partner's payload holds
 * one row per distinct record IT matched ({@link distinctMatchedRows}), so
 * the join below addresses that row once per pair rather than expecting one
 * payload row per pair.
 *
 * The first column identifies our matched records, headed by our identifier
 * column name (or `row_id` when no identifier column exists). The second
 * holds the partner's 0-based row index for each matched record, headed
 * `row_id` (disambiguated to `their_row_id`, then `their_row_id_2`, ... on
 * collision). It is emitted in every result -- not only when the partner sent
 * no payload -- so the result stays self-sufficient for later verification:
 * it is the partner side of the association table the record's commitments
 * bind, and (once the payload commitment stopped binding the partner's row
 * indices) it is not otherwise recoverable from the payload values. The
 * remaining columns are the partner's payload columns, each using its
 * original name, prefixed with `their_` only when it collides with our
 * identifier column. All values are RFC 4180 escaped. Null cells in the
 * partner's payload are emitted as empty strings; a payload collection that
 * is not an array, a row that is not an array or whose width disagrees with
 * the declared columns, and a cell that is neither a string nor null, are
 * each refused.
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

  // Each collection is held to being an array before anything is read from it, so
  // a caller past the type -- this is an exported entry point whose
  // PartnerPayload argument no type ties to a parsed frame -- gets the same shape
  // refusal the malformed rows below get rather than a TypeError from the first
  // array method that misses.
  for (const [field, collection] of [
    ["columns", partnerPayload.columns],
    ["rowIndices", partnerPayload.rowIndices],
    ["rows", partnerPayload.rows],
  ] as const) {
    if (!Array.isArray(collection)) {
      throw new Error(
        `partner payload ${field} is not an array: ` +
          "refusing to read entries from a value that holds none",
      );
    }
  }

  if (!partnerPayload.columns.every((column) => typeof column === "string")) {
    throw new Error(
      "a partner payload column name is not a string: " +
        "refusing to write a header of another shape into the result",
    );
  }

  if (partnerPayload.rowIndices.length !== partnerPayload.rows.length) {
    throw new Error(
      "partner payload rowIndices and rows have different lengths: " +
        `${partnerPayload.rowIndices.length} vs ${partnerPayload.rows.length}`,
    );
  }

  // One pass, refusing a row that is not a row and a cell that is not a cell. The
  // cell half is what keeps a value of another shape out of the CSV: quoteCsvField
  // looks for the characters RFC 4180 escapes with `includes`, which an ARRAY
  // answers by element rather than by substring, so an array cell holding a
  // separator reports none and would reach the result unquoted, breaking the row's
  // framing. isPayloadCell is the wire schema's own cell predicate.
  for (const row of partnerPayload.rows) {
    if (!Array.isArray(row)) {
      throw new Error(
        "a partner payload row is not an array of cells: " +
          "refusing to read cell values from a non-row value",
      );
    }
    if (!row.every(isPayloadCell)) {
      throw new Error(
        "a partner payload cell is neither a string nor null: " +
          "refusing to write a value of another shape into the result",
      );
    }
  }

  const columnCount = partnerPayload.columns.length;
  if (!hasOneCellPerColumn(columnCount, partnerPayload.rows)) {
    throw new Error(
      "partner payload rows do not have one cell per declared column: " +
        `expected ${columnCount} cell${columnCount === 1 ? "" : "s"} per row`,
    );
  }

  const ourIdCol = metadata.find((col) => col.role === "identifier") ?? null;

  const hasPartnerCols = partnerPayload.columns.length > 0;
  const ourBaseName = ourIdCol ? ourIdCol.name : "row_id";

  const valueHeaders = partnerPayload.columns.map((c) =>
    c !== ourBaseName ? c : `their_${c}`,
  );
  // The partner row-index column sits between our column and the payload columns,
  // made unique against both.
  const partnerIndexHeader = uniqueColumnName(
    "row_id",
    new Set([ourBaseName, ...valueHeaders]),
  );

  const headers = [
    quoteCsvField(ourBaseName),
    quoteCsvField(partnerIndexHeader),
    ...valueHeaders.map(quoteCsvField),
  ];

  const theirIdxToPayloadPos = new Map(
    partnerPayload.rowIndices.map((rowIdx, pos) => [rowIdx, pos]),
  );

  // A repeated index is a MALFORMED payload -- a sender emitting a row it
  // should have sent once -- refused under every cardinality: the frame
  // names two payload rows for one of the sender's records without saying
  // which is the record's. Multiplicity is held on the association
  // table's side of the join, never here. The wire schema refuses the
  // repeat at parse, but this is an exported entry point taking a plain
  // PartnerPayload whose argument no type ties to a parsed frame, so the
  // invariant keeps a check of its own rather than resting on that call
  // path.
  if (theirIdxToPayloadPos.size !== partnerPayload.rowIndices.length) {
    throw new Error("partner payload rowIndices contains duplicate indices");
  }

  if (hasPartnerCols) {
    // Named once each: a partner row our table pairs with several of our records
    // is one missing payload row, not one per pair.
    const missing = [
      ...new Set(
        associationTable[1].filter((idx) => !theirIdxToPayloadPos.has(idx)),
      ),
    ];
    if (missing.length > 0) {
      throw new Error(
        "partner payload is missing rows for association table indices: " +
          missing.join(", "),
      );
    }
  }

  const rows = associationTable[0].map((ourIdx, i) => {
    const theirIdx = associationTable[1][i];
    const ourRow = rawRows[ourIdx];
    const ourIdValue =
      ourIdCol && ourRow ? readRowColumn(ourRow, ourIdCol.name) : undefined;
    const ourId = quoteCsvField(ourIdValue ?? String(ourIdx));
    const partnerIndexCell = quoteCsvField(String(theirIdx));

    if (!hasPartnerCols) {
      return [ourId, partnerIndexCell];
    }

    const partnerRow = partnerPayload.rows[theirIdxToPayloadPos.get(theirIdx)!];
    const theirValues = partnerPayload.columns.map((_, colIdx) =>
      quoteCsvField(partnerRow[colIdx] ?? ""),
    );

    return [ourId, partnerIndexCell, ...theirValues];
  });

  return { headers, rows };
}
