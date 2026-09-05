import { computeTermsHash, verifyCommitmentOpening } from "./exchangeRecord.js";
import { readRowColumn } from "../file.js";
import { distinctMatchedRows } from "../payloadExchange.js";

import type {
  CommitmentName,
  CommittedPayload,
  ExchangeRecord,
  VerificationKeys,
} from "./exchangeRecord.js";
import type { CanonicalValue } from "../utils/canonical.js";
import type { LinkageTerms } from "../config/linkageTerms.js";
import type { CSVRow } from "../file.js";
import type { AssociationTable } from "../types.js";

// The verification consumer for the self-attested exchange record: it reads
// a stored record and its verification keys, re-derives the record's
// canonical bytes, opens each commitment against re-supplied data, and
// recounts the one disclosure figure no commitment covers (the result
// size) from the pairing they do. It is read-only -- it never mutates or
// re-signs the artifact.
//
// This is the unsigned-record path: "verify" here is internal consistency
// (the agreed-terms hash re-derives, and the commitments open against the
// holder's re-supplied data), not evidence against the partner. Evidence
// against the partner is the separate dual-signed record, whose signature,
// certificate, and pin checks live in signedReceiptVerification.ts on the
// same tri-state report shape.
//
// The verification keys hold only salts, never a data snapshot, so the
// caller re-supplies the committed data (from its own retained input and
// result) and this module recomputes the commitment; see
// docs/spec/EXCHANGE_RECORD.md ("No data snapshot in the keys"). An
// unrecognized record or keys version is rejected earlier, at parse, so a
// record reaching this module is already a recognized version.

/**
 * The outcome of verifying one commitment against its salt and re-supplied data.
 *
 * - `verified`: the salt and the re-supplied data recompute the stored commitment.
 * - `mismatch`: the data was re-supplied but does not reproduce the commitment --
 *   the record was altered, or the re-supplied input/result does not match this
 *   exchange (the two are indistinguishable here; see the diagnosability note in
 *   docs/spec/EXCHANGE_RECORD.md).
 * - `not-supplied`: the commitment is present but its data was not re-supplied, so
 *   it could not be opened (the third-party-auditor case, or a holder that did not
 *   pass the input/result for this data set).
 * - `unopenable`: the commitment is present but has no salt in the keys (a missing
 *   or drifted keys file), or a mandatory commitment is absent from the record.
 */
export type CommitmentStatus =
  "verified" | "mismatch" | "not-supplied" | "unopenable";

/**
 * The outcome of the agreed-terms-hash check. `not-checked` when either party's
 * terms were not re-supplied (the partner's terms are not retained by default, so
 * this is the common case); `mismatch` when the re-supplied terms do not
 * reproduce the recorded hash.
 */
export type TermsHashStatus = "verified" | "mismatch" | "not-checked";

/**
 * The outcome of the recorded result size's check.
 *
 * No commitment covers the figure -- it sits in the record in cleartext.
 * What stands behind it is the association-table commitment, since the
 * field is a count of that table: a table re-supplied and opened against
 * its commitment has the figure's correct value, so the check is a
 * recount rather than an opening. Full rationale: docs/spec/EXCHANGE_RECORD.md
 * ("What verification binds about the result size").
 *
 * - `verified`: the association table opened, and its pair count is the
 *   recorded figure.
 * - `mismatch`: the association table opened and has a DIFFERENT number
 *   of pairs. Unlike a commitment mismatch this is unambiguous: a
 *   re-supplied file that did not belong to this exchange would have
 *   failed the table's own commitment first, leaving `unopenable` below.
 * - `not-supplied`: the association table's data was not re-supplied, so
 *   there was nothing to recount (the third-party-auditor case).
 * - `unopenable`: no opened pairing stands behind the figure -- no
 *   association-table commitment at all (a count-only run's record never
 *   has one), no salt for it, the re-supplied table did not reproduce its
 *   commitment, or it opened but is not shaped as a pairing.
 */
export type ResultSizeStatus =
  "verified" | "mismatch" | "not-supplied" | "unopenable";

/**
 * The overall verdict.
 *
 * - `failed`: a definite inconsistency -- a commitment mismatch, a
 *   terms-hash mismatch, a recorded result size the committed pairing does
 *   not match, or a structurally invalid record. The artifact does not
 *   verify.
 * - `verified`: every present commitment opened, the terms hash
 *   re-derived, and any recorded result size recounted -- nothing was left
 *   unchecked and nothing failed.
 * - `incomplete`: nothing was contradicted, but something could not be
 *   checked (a commitment whose data was not re-supplied, a missing salt,
 *   terms not supplied, or a result size with no opened pairing to
 *   recount). Distinct from `verified` so "we did not check" is never
 *   reported as "it checked out".
 */
export type RecordVerificationOutcome = "verified" | "incomplete" | "failed";

/** The structured result of {@link verifyExchangeRecord}. */
export interface RecordVerificationReport {
  outcome: RecordVerificationOutcome;
  termsHash: TermsHashStatus;
  /** Per-commitment status, one entry per commitment present in the record (plus a
   * mandatory commitment that was expected but absent). */
  commitments: Partial<Record<CommitmentName, CommitmentStatus>>;
  /** The recorded result size's status, reported separately from the commitments
   * so a figure at fault is never read as one of them failing. Omitted entirely
   * when the record has no result size -- the entitlement gate leaves the
   * field out whenever only one party receives output, and that absence is not a
   * fault. */
  resultSize?: ResultSizeStatus;
}

/** The data a caller re-supplies to open a record's commitments and re-derive its
 * terms hash. Every field is optional: an omitted data set leaves its commitment
 * unopened (`not-supplied`), and omitting either party's terms leaves the terms
 * hash `not-checked`. */
interface RecordVerificationInputs {
  /** The committed data sets, keyed by {@link CommitmentName}, re-supplied from the
   * holder's retained input and result and re-canonicalized to the exact bytes the
   * commit used (the {@link CanonicalValue} domain). */
  data?: Partial<Record<CommitmentName, CanonicalValue>>;
  /** This party's linkage terms, for the terms-hash check. */
  localTerms?: LinkageTerms;
  /** The partner's linkage terms, for the terms-hash check (not retained by
   * default, so the check is best-effort). */
  partnerTerms?: LinkageTerms;
}

/**
 * Whether an alteration of the record is the only explanation a failed
 * {@link RecordVerificationReport} leaves: the recorded result size
 * disagrees with the pairing the record itself commits to, while
 * everything else checked out (terms hash re-derived, every commitment
 * verified). Every other failure keeps a hedge a commitment mismatch
 * cannot lift: it cannot tell an altered record from a re-supplied file
 * that does not belong to this exchange. Only a result-size mismatch is
 * unambiguous, because such a file would have failed the table's own
 * commitment first (see docs/spec/EXCHANGE_RECORD.md, "What verification
 * binds about the result size").
 *
 * Requires the association-table commitment itself to be `verified`
 * (not merely absent from a report with no mismatches), and requires
 * `report.outcome === "failed"` rather than trusting a caller's own
 * verdict -- both guard against a vacuous or borrowed accusation.
 */
export function recordAlterationIsTheOnlyExplanation(
  report: RecordVerificationReport,
): boolean {
  return (
    report.outcome === "failed" &&
    report.resultSize === "mismatch" &&
    report.termsHash === "verified" &&
    report.commitments.associationTable === "verified" &&
    Object.values(report.commitments).every((status) => status === "verified")
  );
}

const ALL_COMMITMENTS: readonly CommitmentName[] = [
  "localPayloadSent",
  "partnerPayloadReceived",
  "associationTable",
];

// localPayloadSent and partnerPayloadReceived are mandatory in a
// well-formed record (the schema requires them; the association table is
// optional). A parsed record always has the mandatory pair, so a missing
// one here means a hand-built (unparsed) record -- treated as a
// structural failure rather than silently skipped.
const MANDATORY: ReadonlySet<CommitmentName> = new Set([
  "localPayloadSent",
  "partnerPayloadReceived",
]);

// Whether a re-supplied half is a list of row indices. The linkage produces
// non-negative integers on both sides of a pair, and the chokepoint that admits
// a partner-supplied half holds it to exactly that (utils/partnerIndices.ts), so
// anything else is not a half of the table this figure counts.
function isRowIndexHalf(half: readonly unknown[]): boolean {
  return half.every(
    (entry) =>
      typeof entry === "number" && Number.isInteger(entry) && entry >= 0,
  );
}

// The pair count a re-supplied association table states: the entries in
// its two halves, read together. The value arrives as a CanonicalValue --
// the domain the commitment opened over, not a parsed AssociationTable --
// so the shape is enforced here rather than assumed: a caller may hand
// this anything it handed verifyExchangeRecord. Only a value shaped as the
// committed table (exactly two halves, both arrays of row indices, of
// equal length) has a pair count; every other value yields none, so a
// figure is never recounted from something that is not a pairing.
function suppliedPairCount(
  value: CanonicalValue | undefined,
): number | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [ourRows, partnerRows] = value;
  if (!Array.isArray(ourRows) || !Array.isArray(partnerRows)) return undefined;
  if (ourRows.length !== partnerRows.length) return undefined;
  if (!isRowIndexHalf(ourRows) || !isRowIndexHalf(partnerRows))
    return undefined;
  return ourRows.length;
}

// The recorded result size against the pairing the record commits to.
// Nothing commits to the figure itself, so the association-table
// commitment is what stands behind it: only a table that OPENED is the
// committed one, and only then does its pair count attest what the field
// should say. Every other state leaves the figure unchecked rather than
// at fault -- a re-supplied result that does not belong to this exchange
// fails the table's own commitment first, so it can never be mistaken
// here for an altered figure.
function checkResultSize(
  recordedSize: number | undefined,
  tableStatus: CommitmentStatus | undefined,
  suppliedTable: CanonicalValue | undefined,
): ResultSizeStatus | undefined {
  if (recordedSize === undefined) return undefined;
  if (tableStatus === "not-supplied") return "not-supplied";
  if (tableStatus !== "verified") return "unopenable";
  const pairs = suppliedPairCount(suppliedTable);
  if (pairs === undefined) return "unopenable";
  return pairs === recordedSize ? "verified" : "mismatch";
}

/**
 * Verify a stored {@link ExchangeRecord} against its {@link VerificationKeys}
 * and re-supplied data: re-derive the agreed-terms hash (when both parties'
 * terms are supplied), open every present commitment against its salt and
 * re-supplied data, and recount the recorded result size from the
 * association table those commitments cover. Read-only; it never mutates
 * or re-signs the record.
 *
 * Returns a tri-state {@link RecordVerificationReport} that distinguishes a
 * commitment that opened, one whose data was not re-supplied, and one that
 * failed to open -- so "not checked" is never conflated with "verified".
 * The result size takes that same reading on its own field
 * ({@link ResultSizeStatus}), never on a commitment's, so an altered
 * figure is not treated as a commitment failing. This is the unsigned-record
 * internal-consistency check; the signature and certificate checks that
 * make a dual-signed record evidence against the partner belong to
 * `verifyDualSignedRecord`.
 *
 * Fail-safe: every check yields a status, never an exception -- a
 * malformed salt or commitment, re-supplied data outside the canonical
 * domain, or terms that do not canonically encode are reported as a
 * `mismatch` rather than thrown, so hostile or malformed input always
 * produces a verdict.
 */
export async function verifyExchangeRecord(
  record: ExchangeRecord,
  keys: VerificationKeys,
  inputs: RecordVerificationInputs = {},
): Promise<RecordVerificationReport> {
  const commitments: Partial<Record<CommitmentName, CommitmentStatus>> = {};
  let anyMismatch = false;
  let anyUnverified = false;

  for (const name of ALL_COMMITMENTS) {
    const commitment = record.commitments[name];
    const salt = keys.salts[name];
    const supplied = inputs.data?.[name];

    if (commitment === undefined) {
      if (MANDATORY.has(name)) {
        // A parsed record always has the mandatory commitments, so a
        // missing one means a hand-built (unparsed) record: structurally
        // invalid, a definite failure -- whether or not the keys still
        // hold an (orphaned) salt for it. Checked before the orphaned-salt
        // case below so a leftover salt cannot downgrade the failure to
        // `incomplete`; matches the sibling verifyRecordCommitments, which
        // also fails this case.
        commitments[name] = "unopenable";
        anyMismatch = true;
      } else if (salt !== undefined) {
        // Orphaned salt on an OPTIONAL commitment: the keys hold material
        // the record does not (a keys/record mismatch, or a hand-built
        // pair). Nothing to open, so unverifiable rather than a definite
        // failure.
        commitments[name] = "unopenable";
        anyUnverified = true;
      }
      // An optional commitment legitimately absent (this party held no
      // association table) is not reported.
      continue;
    }

    if (salt === undefined) {
      // The commitment is present but the keys hold no salt to open it:
      // the wrong or a drifted keys file. Indistinguishable from tamper,
      // so reported as unverifiable (incomplete) rather than a definite
      // failure.
      commitments[name] = "unopenable";
      anyUnverified = true;
      continue;
    }

    if (supplied === undefined) {
      commitments[name] = "not-supplied";
      anyUnverified = true;
      continue;
    }

    const opened = await verifyCommitmentOpening(
      name,
      salt,
      supplied,
      commitment,
    );
    commitments[name] = opened ? "verified" : "mismatch";
    if (!opened) anyMismatch = true;
  }

  let termsHash: TermsHashStatus;
  if (inputs.localTerms === undefined || inputs.partnerTerms === undefined) {
    termsHash = "not-checked";
    anyUnverified = true;
  } else {
    let recomputed: string | undefined;
    try {
      recomputed = await computeTermsHash(
        inputs.localTerms,
        inputs.partnerTerms,
      );
    } catch {
      // Terms outside the canonical encoding domain cannot reproduce the hash: a
      // mismatch, not a throw, keeping the contract fail-safe.
      recomputed = undefined;
    }
    termsHash = recomputed === record.termsHash ? "verified" : "mismatch";
    if (termsHash === "mismatch") anyMismatch = true;
  }

  const resultSize = checkResultSize(
    record.resultSize,
    commitments.associationTable,
    inputs.data?.associationTable,
  );
  if (resultSize === "mismatch") anyMismatch = true;
  else if (resultSize !== undefined && resultSize !== "verified")
    anyUnverified = true;

  const outcome: RecordVerificationOutcome = anyMismatch
    ? "failed"
    : anyUnverified
      ? "incomplete"
      : "verified";
  return {
    outcome,
    termsHash,
    commitments,
    ...(resultSize !== undefined ? { resultSize } : {}),
  };
}

// --- Re-supply reconstruction ------------------------------------------------

/** A parsed result file (the CSV a party retained): the header row and the data
 * rows as unquoted string cells. */
export interface RetainedResult {
  headers: string[];
  rows: string[][];
}

/** The retained artifacts a holder re-supplies to reconstruct the committed data
 * for {@link verifyExchangeRecord}. */
interface ReconstructionSources {
  /** The parsed record being verified -- its governance holds the committed
   * column names, so the reconstruction does not have to un-prefix the result's
   * `their_`-disambiguated headers. */
  record: ExchangeRecord;
  /** The holder's retained input CSV rows (the input it contributed). */
  inputRows: readonly CSVRow[];
  /** The holder's retained result file (association table + received payload). */
  result: RetainedResult;
  /** The identifier column's name, when the exchange used one (metadata
   * `role: "identifier"`), so a result's first column (an identifier value) can be
   * mapped back to an input row index. Omit when the exchange keyed on row indices
   * (the result's first column is then the row index itself). */
  ourIdColumn?: string;
}

/** The reconstructed committed data plus any non-fatal caveats a caller should
 * report (e.g. a duplicate-identifier ambiguity). */
interface ReconstructedData {
  data: Partial<Record<CommitmentName, CanonicalValue>>;
  warnings: string[];
}

// The result file's fixed leading columns: our matched record id, then the
// partner's row index. Payload value columns (if any) follow.
const RESULT_OUR_ID_COLUMN = 0;
const RESULT_PARTNER_INDEX_COLUMN = 1;
const RESULT_VALUE_COLUMN_START = 2;

function sameCells(
  a: ReadonlyArray<string | null>,
  b: ReadonlyArray<string | null>,
): boolean {
  return a.length === b.length && a.every((cell, i) => cell === b[i]);
}

/**
 * Reconstruct the committed data sets from a holder's retained input,
 * result, and the record's own governance -- the re-supply path that lets
 * a party verify its record without any at-rest snapshot of the matched
 * data. The returned `data` feeds {@link verifyExchangeRecord}. Full
 * algorithm and its residual edges: docs/spec/EXCHANGE_RECORD.md ("No data
 * snapshot in the keys").
 *
 * `associationTable` reconstructs directly from the result's two index
 * columns, one entry per row, in this party's own association order. The
 * two payloads are committed one row per matched RECORD, not per pair
 * ({@link distinctMatchedRows}): `localPayloadSent` reads the retained
 * input at each distinct matched row of ours; `partnerPayloadReceived`
 * recovers the partner's send order by sorting the result rows by the
 * partner-index column and taking each distinct partner row once, and
 * collapses repeated copies of one partner row only where they agree cell
 * for cell -- a divergent copy is kept alongside the first rather than
 * merged into it, so it stays covered by the commitment. If either
 * ordering invariant ever failed, the reconstructed bytes would simply not
 * open the commitment (a reported mismatch), never a false verification.
 *
 * Byte-exact only from UNMODIFIED retained files. Three residual edges are
 * reported as warnings rather than silent mis-reconstruction (duplicate
 * identifiers, a missing identifier, disagreeing copies of one partner
 * record); a fourth -- a genuinely-null received cell reproducing as an
 * empty string -- cannot be seen here and is named as a possible cause
 * once a verdict is in hand, by {@link reproductionMismatchCauses}.
 */
export function reconstructCommittedData(
  sources: ReconstructionSources,
): ReconstructedData {
  const { record, inputRows, result, ourIdColumn } = sources;
  const warnings: string[] = [];
  const data: Partial<Record<CommitmentName, CanonicalValue>> = {};

  let idToRow: Map<string, number> | undefined;
  if (ourIdColumn !== undefined) {
    idToRow = new Map();
    let anyDuplicate = false;
    inputRows.forEach((row, index) => {
      const value = readRowColumn(row, ourIdColumn);
      if (value === undefined) return;
      if (idToRow!.has(value)) anyDuplicate = true;
      else idToRow!.set(value, index);
    });
    if (anyDuplicate)
      warnings.push(
        `the identifier column "${ourIdColumn}" has duplicate values in the ` +
          "input, so a matched row's index is ambiguous; the first occurrence " +
          "is used. An input holding several rows for one individual -- what a " +
          "deduplicating exchange sets out to group -- has duplicates here " +
          "whenever its identifier names the individual rather than the row, so " +
          "this is the expected case for such an input rather than an unusual " +
          "one. Every later duplicate then reproduces the first row's values " +
          "and the commitments report a mismatch; an identifier column unique " +
          "per row reproduces exactly",
      );
  }

  // Resolve, per result row, this party's matched input-row index and the
  // partner's matched row index. Row order is this party's association order.
  const ourIndices: number[] = [];
  const partnerIndices: number[] = [];
  let anyMissingIdentity = false;
  for (const row of result.rows) {
    const ourCell = row[RESULT_OUR_ID_COLUMN] ?? "";
    let ourIndex: number;
    if (ourIdColumn !== undefined) {
      const resolved = idToRow!.get(ourCell);
      if (resolved === undefined) {
        anyMissingIdentity = true;
        ourIndex = -1;
      } else {
        ourIndex = resolved;
      }
    } else {
      ourIndex = Number(ourCell);
    }
    ourIndices.push(ourIndex);
    partnerIndices.push(Number(row[RESULT_PARTNER_INDEX_COLUMN] ?? ""));
  }
  if (anyMissingIdentity)
    warnings.push(
      "the result references an identifier not present in the supplied input, " +
        "so the input may not match this exchange",
    );

  // associationTable: this party's [our indices, partner indices], one entry per
  // result row, already in committed (this party's ascending) order.
  if (record.commitments.associationTable !== undefined) {
    const table: AssociationTable = [ourIndices, partnerIndices];
    data.associationTable = table as unknown as CanonicalValue;
  }

  // localPayloadSent: the disclosed columns' values (from the record's governance)
  // read from the retained input at each DISTINCT matched row, in result order --
  // the selection preparePayload transmitted and committed. The empty committed
  // payload is {columns:[], rows:[]}, not one empty row per match.
  const sentColumns = record.governance.payloadSent.map((c) => c.name);
  const localPayloadSent: CommittedPayload =
    sentColumns.length === 0
      ? { columns: [], rows: [] }
      : {
          columns: sentColumns,
          rows: distinctMatchedRows(ourIndices).map((index) => {
            const row = inputRows[index];
            return sentColumns.map((column) =>
              row ? (readRowColumn(row, column) ?? null) : null,
            );
          }),
        };
  data.localPayloadSent = localPayloadSent as CanonicalValue;

  // partnerPayloadReceived: the received values (result value columns),
  // re-sorted into the partner's send order and taken once per distinct
  // partner row, collapsing repeated copies only where they agree cell for
  // cell -- see the function's own doc comment for why.
  const receivedColumns = record.governance.payloadReceived.map((c) => c.name);
  let partnerPayloadReceived: CommittedPayload;
  if (receivedColumns.length === 0) {
    partnerPayloadReceived = { columns: [], rows: [] };
  } else {
    const bySendOrder = result.rows
      .map((row, i): [number, Array<string | null>] => [
        partnerIndices[i],
        row.slice(RESULT_VALUE_COLUMN_START),
      ])
      .sort((a, b) => a[0] - b[0]);
    const rows: Array<Array<string | null>> = [];
    let previous: { index: number; values: Array<string | null> } | undefined;
    let anyDivergentCopy = false;
    for (const [index, values] of bySendOrder) {
      if (previous !== undefined && previous.index === index) {
        if (sameCells(previous.values, values)) continue;
        anyDivergentCopy = true;
      }
      previous = { index, values };
      rows.push(values);
    }
    if (anyDivergentCopy)
      warnings.push(
        "the result has several rows for one partner record whose " +
          "received values differ. The partner sent one row for that record " +
          "and the received-payload commitment binds it once, so the copies a " +
          "grouped result writes against this party's records have to agree; " +
          "they are reproduced as they stand, so a commitment reports a " +
          "mismatch -- the received payload's where a value cell is what " +
          "differs, and the association table's where a partner row index " +
          "moved instead",
      );
    partnerPayloadReceived = { columns: receivedColumns, rows };
  }
  data.partnerPayloadReceived = partnerPayloadReceived as CanonicalValue;

  return { data, warnings };
}

function isCanonicalObject(
  value: CanonicalValue | undefined,
): value is { readonly [key: string]: CanonicalValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Whether a re-supplied payload has an empty-string cell. The value arrives
// as a CanonicalValue -- the domain the commitment opened over, not a parsed
// CommittedPayload -- so its rows are read structurally: a caller may hand this
// anything it handed verifyExchangeRecord.
function carriesEmptyCell(value: CanonicalValue | undefined): boolean {
  if (!isCanonicalObject(value)) return false;
  const rows = value["rows"];
  if (!Array.isArray(rows)) return false;
  return rows.some(
    (row) => Array.isArray(row) && row.some((cell) => cell === ""),
  );
}

/**
 * The reproduction limitations that could themselves account for a
 * mismatch in `report`, as notes for the same sink a verification consumer
 * renders the {@link ReconstructedData} warnings on. Empty when nothing in
 * the verdict is explained by one -- most runs.
 *
 * One limitation qualifies today: a result value cell cannot distinguish a
 * committed empty string from a committed null, since the result writes
 * both as an empty cell. A partner value that was null when committed
 * therefore reproduces as an empty string, mismatching
 * `partnerPayloadReceived` with nothing in the re-supplied files naming
 * the cause -- so the note is raised only where the re-supplied data has
 * an empty cell and the commitment mismatched. Only
 * `partnerPayloadReceived` is subject to it: `localPayloadSent`
 * re-supplies from the retained input file, read through the same reader
 * that wrote it, so an empty cell there is reproduced rather than guessed
 * at.
 *
 * Call it after {@link verifyExchangeRecord} with the same `data` passed
 * in; it never contradicts a verdict -- a mismatch stays a mismatch, since
 * the record cannot say which value was committed.
 */
export function reproductionMismatchCauses(
  report: RecordVerificationReport,
  data: Partial<Record<CommitmentName, CanonicalValue>> = {},
): string[] {
  if (report.commitments.partnerPayloadReceived !== "mismatch") return [];
  if (!carriesEmptyCell(data.partnerPayloadReceived)) return [];
  return [
    "the re-supplied received payload has empty cells, and a result cell " +
      "cannot distinguish a committed empty string from a committed null -- " +
      "the result writes both as an empty cell. A partner-sent null in one of " +
      "those cells would reproduce here as an empty string and report this " +
      "mismatch; the commitment covers the whole payload, so this is one " +
      "possible cause, not a confirmation that nothing else differs.",
  ];
}

// --- Re-supply input shaping -------------------------------------------------

/**
 * Whether a raw parsed record or keys value has the one recognized format
 * version. A pre-parse check: `parseExchangeRecord` / `parseVerificationKeys`
 * also reject an unrecognized version (the schema pins the literal), but a
 * caller can run this first to report a future-format or hand-edited file
 * as an unrecognized-version outcome rather than a generic shape error.
 * Reads only the top-level `version`; the schema parse is still the
 * authority for the rest of the shape.
 */
export function recordedVersionMatches(
  raw: unknown,
  expected: string,
): boolean {
  const version =
    raw !== null && typeof raw === "object"
      ? (raw as Record<string, unknown>)["version"]
      : undefined;
  return version === expected;
}

/**
 * Turn a parsed result CSV (header-keyed rows, the shape a CSV parser returns)
 * into the positional {@link RetainedResult} {@link reconstructCommittedData}
 * consumes: the header row and each data row projected onto it, with a missing
 * cell read as the empty string. The result's fixed leading columns are our
 * matched record id then the partner row index, with payload value columns after.
 */
export function toRetainedResult(parsed: {
  meta: { fields?: string[] };
  data: Array<Record<string, string | undefined>>;
}): RetainedResult {
  const headers = parsed.meta.fields ?? [];
  const rows = parsed.data.map((row) => headers.map((h) => row[h] ?? ""));
  return { headers, rows };
}

/**
 * Derive the identifier column the exchange keyed on from the result's
 * first header. `buildOutputTable` heads the first result column with the
 * identifier column's name, or `row_id` when the exchange keyed on row
 * indices. When the input has a column of that name it is the identifier;
 * otherwise the first column is the row index itself and this returns
 * `undefined`. The lone ambiguity -- an input with a data column literally
 * named `row_id` while the exchange used no identifier -- would open no
 * commitment (a reported mismatch), never a false verification.
 */
export function deriveOurIdColumn(
  resultHeaders: string[],
  inputColumns: ReadonlySet<string>,
): string | undefined {
  const first = resultHeaders[0];
  return first !== undefined && inputColumns.has(first) ? first : undefined;
}
