import type { Argv, Arguments } from "yargs";
import fs from "node:fs";
import logLibrary from "loglevel";

import {
  EXCHANGE_KEYS_VERSION,
  EXCHANGE_RECORD_VERSION,
  loadCSVFile,
  parseExchangeRecord,
  parseVerificationKeys,
  reconstructCommittedData,
  sanitizeForDisplay,
  UsageError,
  verifyExchangeRecord,
} from "@psilink/core";
import type {
  CommitmentStatus,
  ExchangeRecord,
  LinkageTerms,
  RecordVerificationReport,
  RetainedResult,
  TermsHashStatus,
  VerificationKeys,
} from "@psilink/core";

import { loadConfigLinkageSource } from "../config";
import { expandTilde } from "../fileUtils";
import { keysPathFor } from "../recordFile";
import { parseSensitiveJson } from "../sensitiveFile";
import {
  configureLogging,
  exitWithError,
  LOG_LEVELS,
  openInputSource,
  parseOrExit,
  singleValue,
} from "../util/cli";

// `psilink verify-receipt` reads a stored exchange record and reports whether it
// is internally consistent: its commitments open against the holder's re-supplied
// data, and (when both parties' terms are supplied) its agreed-terms hash
// re-derives. It is READ-ONLY -- it never mutates or re-signs the record.
//
// This is the UNSIGNED-record path. Verifying a SIGNED evidence bundle (checking
// the partner's receipt signature and certificate) is deferred work; until it
// lands, the command says so rather than implying it checked signatures.
//
// The verification keys hold only salts, so the committed data is RE-SUPPLIED from
// the holder's retained input and result and re-canonicalized (see
// reconstructCommittedData). With no input/result the command still runs -- the
// third-party-auditor case: it checks structure and version and reports each
// commitment as not-opened rather than failing.

export function builder(cmd: Argv): Argv {
  return cmd
    .usage(
      "Usage: $0 verify-receipt <record> [input-file] [result-file] [options]",
    )
    .positional("record", {
      type: "string",
      describe: "the stored exchange record to verify (psilink-record-*.json)",
    })
    .positional("input-file", {
      type: "string",
      describe:
        "the input CSV this party contributed (or - for stdin); needed to open " +
        "the sent-payload and pairing commitments",
    })
    .positional("result-file", {
      type: "string",
      describe:
        "the result file this party retained; needed to open the received-" +
        "payload and pairing commitments",
    })
    .option("keys", {
      type: "string",
      describe:
        "the verification-keys file (default: the record path with a " +
        ".keys.json suffix)",
    })
    .option("config-file", {
      type: "string",
      describe:
        "this party's exchange config, for its linkage terms (with " +
        "--partner-terms, checks the agreed-terms hash). Not auto-loaded.",
    })
    .option("partner-terms", {
      type: "string",
      describe:
        "the partner's linkage terms (config or exported terms), for the " +
        "agreed-terms hash check; the partner's terms are not retained by default",
    })
    .option("log-level", {
      type: "string",
      describe: "silent | error | warn | info | debug | trace; default=info",
    })
    .option("log-file", {
      type: "string",
      describe:
        "append all log output to this file instead of the terminal; the " +
        "parent directory must already exist",
    });
}

// --- File readers ------------------------------------------------------------

function readTextFile(pathValue: string, kind: string): string {
  try {
    return fs.readFileSync(expandTilde(pathValue), "utf8");
  } catch (err: unknown) {
    throw new UsageError(
      `${kind} file ${pathValue} could not be read: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

// Reject an unrecognized version with a clear, specific message BEFORE the schema
// parse -- so a future-format or hand-edited file is not mis-reported as a generic
// shape error. The version literal is also enforced by the schema; this only makes
// the failure legible.
function assertRecognizedVersion(
  raw: unknown,
  expected: string,
  pathValue: string,
  kind: string,
): void {
  const version =
    raw !== null && typeof raw === "object"
      ? (raw as Record<string, unknown>)["version"]
      : undefined;
  if (version !== expected)
    throw new UsageError(
      `${kind} file ${pathValue} has an unrecognized version ` +
        `(${typeof version === "string" ? version : "missing"}); this build ` +
        `recognizes ${expected}`,
    );
}

/** @internal exported for testing */
export function readExchangeRecordFile(pathValue: string): ExchangeRecord {
  // parseSensitiveJson routes through the bounded-JSON chokepoint (so an oversized
  // hostile record is refused before parse) and reports path-only on a syntax
  // error (so no source bytes leak).
  const raw = parseSensitiveJson(
    readTextFile(pathValue, "record"),
    `record file ${pathValue}`,
  );
  assertRecognizedVersion(raw, EXCHANGE_RECORD_VERSION, pathValue, "record");
  try {
    return parseExchangeRecord(raw);
  } catch (err) {
    throw new UsageError(
      `record file ${pathValue} is not a valid exchange record: ` +
        firstIssue(err),
    );
  }
}

/** @internal exported for testing */
export function readVerificationKeysFile(pathValue: string): VerificationKeys {
  const raw = parseSensitiveJson(
    readTextFile(pathValue, "verification-keys"),
    `verification-keys file ${pathValue}`,
  );
  assertRecognizedVersion(
    raw,
    EXCHANGE_KEYS_VERSION,
    pathValue,
    "verification-keys",
  );
  try {
    return parseVerificationKeys(raw);
  } catch (err) {
    throw new UsageError(
      `verification-keys file ${pathValue} is not valid: ` + firstIssue(err),
    );
  }
}

function firstIssue(err: unknown): string {
  const issues = (
    err as { issues?: Array<{ path?: unknown[]; message: string }> }
  ).issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const issue = issues[0];
    const at =
      Array.isArray(issue.path) && issue.path.length > 0
        ? `${issue.path.join(".")}: `
        : "";
    return `${at}${issue.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// --- Result parsing / id-column derivation -----------------------------------

/** Turn a parsed result CSV into positional headers + string rows (the shape the
 * reconstruction consumes: our id, the partner index, then payload values).
 * @internal exported for testing */
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
 * header: buildOutputTable heads the first column with the identifier column's
 * name, or `row_id` when the exchange keyed on row indices. When the input has a
 * column of that name it is the identifier (the result's first column is an
 * identifier value to map back to a row); otherwise the first column is the row
 * index itself. The lone ambiguity -- an input that has a data column literally
 * named `row_id` while the exchange used no identifier -- would open no commitment
 * (a reported mismatch), never a false verification.
 * @internal exported for testing
 */
export function deriveOurIdColumn(
  resultHeaders: string[],
  inputColumns: ReadonlySet<string>,
): string | undefined {
  const first = resultHeaders[0];
  return first !== undefined && inputColumns.has(first) ? first : undefined;
}

// --- Report formatting -------------------------------------------------------

const COMMITMENT_WORD: Record<CommitmentStatus, string> = {
  verified: "opened and matches",
  mismatch: "DOES NOT MATCH",
  "not-supplied": "not opened (no data re-supplied)",
  unopenable: "not opened (no salt in the keys file)",
};
const TERMS_WORD: Record<TermsHashStatus, string> = {
  verified: "re-derives and matches",
  mismatch: "DOES NOT MATCH",
  "not-checked": "not checked (pass --config-file and --partner-terms)",
};

/** Render the verification report to output lines and an exit code (0 unless a
 * check definitively failed). @internal exported for testing */
export function formatVerificationReport(
  report: RecordVerificationReport,
  warnings: string[],
): { lines: string[]; exitCode: number } {
  const lines: string[] = [];
  if (report.outcome === "failed")
    lines.push(
      "VERIFICATION FAILED: a check did not match -- the record may have been " +
        "altered, or a re-supplied input/result/terms does not match this exchange.",
    );
  else if (report.outcome === "incomplete")
    lines.push(
      "INCOMPLETE: nothing contradicted the record, but not everything could " +
        "be checked (see below).",
    );
  else lines.push("VERIFIED: the record is internally consistent.");

  for (const [name, status] of Object.entries(report.commitments) as Array<
    [string, CommitmentStatus]
  >)
    lines.push(`  commitment ${name}: ${COMMITMENT_WORD[status]}`);
  lines.push(`  agreed-terms hash: ${TERMS_WORD[report.termsHash]}`);
  // A reconstruction warning interpolates a column name drawn from the supplied
  // files, so route it through the display-boundary sanitizer (as every sibling
  // command does for partner- or file-controlled text) before it reaches the
  // terminal -- the commitment/terms lines above are fixed strings and need none.
  for (const warning of warnings)
    lines.push(`  note: ${sanitizeForDisplay(warning)}`);
  lines.push(
    "  partner receipt signatures are not verified (deferred: signed evidence " +
      "bundles).",
  );
  return { lines, exitCode: report.outcome === "failed" ? 1 : 0 };
}

// --- Handler -----------------------------------------------------------------

function localTermsFrom(
  configFile: string | undefined,
): LinkageTerms | undefined {
  if (configFile === undefined) return undefined;
  return loadConfigLinkageSource(expandTilde(configFile))?.linkageTerms;
}

export async function handler(argv: Arguments): Promise<void> {
  const logLevel = parseOrExit((): logLibrary.LogLevelNumbers => {
    const raw = (
      (singleValue(argv, "log-level") as string | undefined) || "info"
    ).toLowerCase();
    const resolved = LOG_LEVELS[raw];
    if (resolved === undefined)
      throw new UsageError(`unrecognized log-level: ${argv["log-level"]}`);
    return resolved;
  });
  const { log, close: closeLogging } = parseOrExit(() =>
    configureLogging({
      logLevel,
      logFile: singleValue(argv, "log-file") as string | undefined,
      name: "verify-receipt",
    }),
  );

  try {
    const recordPath = singleValue(argv, "record") as string | undefined;
    if (recordPath === undefined || recordPath.length === 0)
      throw new UsageError("a record file to verify is required");
    const inputFile = singleValue(argv, "input-file") as string | undefined;
    const resultFile = singleValue(argv, "result-file") as string | undefined;
    const keysArg = singleValue(argv, "keys") as string | undefined;
    const configFile = singleValue(argv, "config-file") as string | undefined;
    const partnerTermsFile = singleValue(argv, "partner-terms") as
      | string
      | undefined;

    if ((inputFile === undefined) !== (resultFile === undefined))
      throw new UsageError(
        "supply both an input file and a result file to open the commitments, " +
          "or neither (a structure-only check)",
      );

    const record = readExchangeRecordFile(recordPath);
    const keysPath = keysArg ?? keysPathFor(recordPath);
    const keys = readVerificationKeysFile(keysPath);

    const warnings: string[] = [];
    let data: Awaited<ReturnType<typeof reconstructCommittedData>>["data"] = {};
    if (inputFile !== undefined && resultFile !== undefined) {
      const inputParse = await loadCSVFile(
        openInputSource(inputFile, { allowStdin: true }),
      );
      const resultParse = await loadCSVFile(openInputSource(resultFile));
      const result = toRetainedResult(resultParse);
      const ourIdColumn = deriveOurIdColumn(
        result.headers,
        new Set(inputParse.meta.fields ?? []),
      );
      const reconstructed = reconstructCommittedData({
        record,
        inputRows: inputParse.data,
        result,
        ourIdColumn,
      });
      data = reconstructed.data;
      warnings.push(...reconstructed.warnings);
    }

    const report = await verifyExchangeRecord(record, keys, {
      data,
      localTerms: localTermsFrom(configFile),
      partnerTerms: localTermsFrom(partnerTermsFile),
    });

    const { lines, exitCode } = formatVerificationReport(report, warnings);
    // The verdict is the command's result, so it goes to stdout; the log level
    // still governs any diagnostics the readers above emit.
    for (const line of lines) console.log(line);
    process.exitCode = exitCode;
  } catch (err) {
    exitWithError(
      log,
      err,
      err instanceof UsageError
        ? 64
        : ((err as { exitCode?: number }).exitCode ?? 69),
    );
  } finally {
    closeLogging();
  }
}
