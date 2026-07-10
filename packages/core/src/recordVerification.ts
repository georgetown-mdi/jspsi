import { computeTermsHash, verifyCommitmentOpening } from "./exchangeRecord.js";

import type {
  CommitmentName,
  CommittedPayload,
  ExchangeRecord,
  VerificationKeys,
} from "./exchangeRecord.js";
import type { CanonicalValue } from "./utils/canonical.js";
import type { LinkageTerms } from "./config/linkageTerms.js";
import type { CSVRow } from "./file.js";
import type { AssociationTable } from "./types.js";

// The verification consumer for the self-attested exchange record: it reads a
// stored record and its verification keys, re-derives the record's canonical
// bytes, and opens each commitment against re-supplied data. It is read-only --
// it never mutates or re-signs the artifact.
//
// This is the UNSIGNED-record path: "verify" here is internal consistency (the
// agreed-terms hash re-derives, and the commitments open against the holder's
// re-supplied data), NOT evidence against the partner. Verifying a SIGNED
// evidence bundle -- checking the partner's receipt signature and certificate --
// is deferred work that layers on top of this (see the Signed Exchange Receipts
// epic); the tri-state report here is shaped so that layer can extend it.
//
// The verification keys hold only salts, never a data snapshot, so the caller
// RE-SUPPLIES the committed data (from the holder's own retained input and
// result) and this module recomputes the commitment; see
// docs/spec/EXCHANGE_RECORD.md ("No data snapshot in the keys"). An unrecognized
// record or keys version is rejected earlier, at parse (parseExchangeRecord /
// parseVerificationKeys reject a version literal they do not recognize), so a
// record reaching this module is already a recognized v1.

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
 * The overall verdict.
 *
 * - `failed`: a definite inconsistency -- a commitment mismatch, a terms-hash
 *   mismatch, or a structurally invalid record. The artifact does not verify.
 * - `verified`: every present commitment opened and the terms hash re-derived --
 *   nothing was left unchecked and nothing failed.
 * - `incomplete`: nothing was contradicted, but something could not be checked (a
 *   commitment whose data was not re-supplied, a missing salt, or terms not
 *   supplied). Distinct from `verified` so "we did not check" is never reported as
 *   "it checked out".
 */
export type RecordVerificationOutcome = "verified" | "incomplete" | "failed";

/** The structured result of {@link verifyExchangeRecord}. */
export interface RecordVerificationReport {
  outcome: RecordVerificationOutcome;
  termsHash: TermsHashStatus;
  /** Per-commitment status, one entry per commitment present in the record (plus a
   * mandatory commitment that was expected but absent). */
  commitments: Partial<Record<CommitmentName, CommitmentStatus>>;
}

/** The data a caller re-supplies to open a record's commitments and re-derive its
 * terms hash. Every field is optional: an omitted data set leaves its commitment
 * unopened (`not-supplied`), and omitting either party's terms leaves the terms
 * hash `not-checked`. */
export interface RecordVerificationInputs {
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

const ALL_COMMITMENTS: readonly CommitmentName[] = [
  "localPayloadSent",
  "partnerPayloadReceived",
  "associationTable",
];

// localPayloadSent and partnerPayloadReceived are mandatory in a well-formed
// record (the schema requires them; the association table is optional). A parsed
// record always carries the mandatory pair, so a missing one here means a
// hand-built (unparsed) record -- treated as a structural failure rather than
// silently skipped.
const MANDATORY: ReadonlySet<CommitmentName> = new Set([
  "localPayloadSent",
  "partnerPayloadReceived",
]);

/**
 * Verify a stored {@link ExchangeRecord} against its {@link VerificationKeys} and
 * re-supplied data: re-derive the agreed-terms hash (when both parties' terms are
 * supplied) and open every present commitment against its salt and re-supplied
 * data. Read-only; it never mutates or re-signs the record.
 *
 * Returns a tri-state {@link RecordVerificationReport} that distinguishes a
 * commitment that opened, one whose data was not re-supplied (so could not be
 * opened), and one that failed to open -- so "not checked" is never conflated with
 * "verified". This is the unsigned-record internal-consistency check; a signed
 * evidence bundle's signature and certificate checks are deferred work that layers
 * on top.
 *
 * Fail-safe: every check yields a status, never an exception. A malformed salt or
 * commitment, re-supplied data outside the canonical domain, or terms that do not
 * canonically encode are reported as a `mismatch` (or leave the check unperformed),
 * not thrown -- so hostile or malformed input always produces a verdict. An
 * unrecognized record/keys version is rejected earlier, at parse.
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
        // A parsed record always carries the mandatory commitments, so a missing
        // one means a hand-built (unparsed) record: structurally invalid, a
        // definite failure -- whether or not the keys still carry an (orphaned)
        // salt for it. Checked before the orphaned-salt case below so a leftover
        // salt cannot downgrade the failure to `incomplete`; matches the sibling
        // verifyRecordCommitments, which also fails this case.
        commitments[name] = "unopenable";
        anyMismatch = true;
      } else if (salt !== undefined) {
        // Orphaned salt on an OPTIONAL commitment: the keys carry material the
        // record does not (a keys/record mismatch, or a hand-built pair). Nothing
        // to open, so unverifiable rather than a definite failure.
        commitments[name] = "unopenable";
        anyUnverified = true;
      }
      // An optional commitment legitimately absent (this party held no
      // association table) is not reported.
      continue;
    }

    if (salt === undefined) {
      // The commitment is present but the keys carry no salt to open it: the wrong
      // or a drifted keys file. Indistinguishable from tamper, so reported as
      // unverifiable (incomplete) rather than a definite failure.
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

  const outcome: RecordVerificationOutcome = anyMismatch
    ? "failed"
    : anyUnverified
      ? "incomplete"
      : "verified";
  return { outcome, termsHash, commitments };
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
export interface ReconstructionSources {
  /** The parsed record being verified -- its governance carries the committed
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
 * surface (e.g. a duplicate-identifier ambiguity). */
export interface ReconstructedData {
  data: Partial<Record<CommitmentName, CanonicalValue>>;
  warnings: string[];
}

// The result file's fixed leading columns: our matched record id, then the
// partner's row index. Payload value columns (if any) follow.
const RESULT_OUR_ID_COLUMN = 0;
const RESULT_PARTNER_INDEX_COLUMN = 1;
const RESULT_VALUE_COLUMN_START = 2;

/**
 * Reconstruct the committed data sets from a holder's retained input, result, and
 * the record's own governance -- the re-supply path that lets a party verify its
 * record without any at-rest snapshot of the matched data (see
 * docs/spec/EXCHANGE_RECORD.md, "No data snapshot in the keys"). The returned
 * `data` feeds {@link verifyExchangeRecord}.
 *
 * The result file lists matched records in this party's association order (its own
 * ascending row index), so `associationTable` and `localPayloadSent` -- both
 * committed in that same order -- reconstruct directly from the result rows:
 * `associationTable` is the two index columns, and `localPayloadSent` is the
 * disclosed columns' values read from the retained input at each matched row.
 *
 * `partnerPayloadReceived`, however, is committed in the PARTNER's send order (its
 * ascending row index), which the result scrambles into this party's order. Both
 * parties' association tables are sorted ascending by their own index (guaranteed
 * by the linkage; see link.ts), so the partner's send order is recovered by
 * sorting the result rows by the partner-index column -- which this function does.
 * If that invariant ever failed, the reconstructed bytes would simply not open the
 * commitment (a reported mismatch), never a false verification.
 *
 * Reconstruction is byte-exact only from UNMODIFIED retained files. Two residual
 * edges are surfaced as warnings rather than silently mis-reconstructed: a
 * duplicate value in the identifier column makes a matched row's index ambiguous
 * (the first occurrence is used), and a result value cell cannot distinguish a
 * committed empty string from a committed null (the result wrote both as an empty
 * cell), so a genuinely-null received cell will not open. Both are documented
 * limitations of reproducing from the human-readable result.
 */
export function reconstructCommittedData(
  sources: ReconstructionSources,
): ReconstructedData {
  const { record, inputRows, result, ourIdColumn } = sources;
  const warnings: string[] = [];
  const data: Partial<Record<CommitmentName, CanonicalValue>> = {};

  // Map an identifier value to its (first) input row index, noting duplicates.
  let idToRow: Map<string, number> | undefined;
  if (ourIdColumn !== undefined) {
    idToRow = new Map();
    let anyDuplicate = false;
    inputRows.forEach((row, index) => {
      const value = row[ourIdColumn];
      if (value === undefined) return;
      if (idToRow!.has(value)) anyDuplicate = true;
      else idToRow!.set(value, index);
    });
    if (anyDuplicate)
      warnings.push(
        `the identifier column "${ourIdColumn}" has duplicate values in the ` +
          "input, so a matched row's index is ambiguous; the first occurrence " +
          "is used",
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

  // associationTable: this party's [our indices, partner indices], already in
  // committed (this party's ascending) order.
  if (record.commitments.associationTable !== undefined) {
    const table: AssociationTable = [ourIndices, partnerIndices];
    data.associationTable = table as unknown as CanonicalValue;
  }

  // localPayloadSent: the disclosed columns' values (from the record's governance)
  // read from the retained input at each matched row, in result order. The empty
  // committed payload is {columns:[], rows:[]}, not one empty row per match.
  const sentColumns = record.governance.payloadSent.map((c) => c.name);
  const localPayloadSent: CommittedPayload =
    sentColumns.length === 0
      ? { columns: [], rows: [] }
      : {
          columns: sentColumns,
          rows: ourIndices.map((index) =>
            sentColumns.map((column) => inputRows[index]?.[column] ?? null),
          ),
        };
  data.localPayloadSent = localPayloadSent as CanonicalValue;

  // partnerPayloadReceived: the received values (result value columns), re-sorted
  // into the partner's ascending send order so they reproduce the committed bytes.
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
    partnerPayloadReceived = {
      columns: receivedColumns,
      rows: bySendOrder.map(([, values]) => values),
    };
  }
  data.partnerPayloadReceived = partnerPayloadReceived as CanonicalValue;

  return { data, warnings };
}

// --- Re-supply input shaping -------------------------------------------------

/**
 * Whether a raw parsed record or keys value carries the one recognized format
 * version. A pre-parse legibility check: `parseExchangeRecord` /
 * `parseVerificationKeys` also reject an unrecognized version (the schema pins the
 * literal), but a caller can run this first to report a future-format or
 * hand-edited file as an unrecognized-version outcome rather than a generic shape
 * error. Reads only the top-level `version`; the schema parse is still the
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
 * Derive the identifier column the exchange keyed on from the result's first
 * header. `buildOutputTable` heads the first result column with the identifier
 * column's name, or `row_id` when the exchange keyed on row indices. When the
 * input has a column of that name it is the identifier (the result's first column
 * holds identifier values to map back to input rows); otherwise the first column
 * is the row index itself, and this returns `undefined`. The lone ambiguity -- an
 * input with a data column literally named `row_id` while the exchange used no
 * identifier -- would open no commitment (a reported mismatch), never a false
 * verification.
 */
export function deriveOurIdColumn(
  resultHeaders: string[],
  inputColumns: ReadonlySet<string>,
): string | undefined {
  const first = resultHeaders[0];
  return first !== undefined && inputColumns.has(first) ? first : undefined;
}
