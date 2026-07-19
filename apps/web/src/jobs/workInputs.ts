import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import {
  CsvLineByteCeilingError,
  INFER_DATE_SCAN_CAP,
  MAX_NAME_LENGTH,
  MAX_TRANSFORM_PATTERN_LENGTH,
  StandardizationSchema,
  inferDateFormat,
  inferDateOfBirthColumn,
  readRowColumn,
  streamCSVRows,
} from "@psilink/core";

import { PREVIEW_SAMPLE_SIZE } from "@psi/columnSamples";
import { createFieldCoverageAccumulator } from "@psi/nonEmptyAggregate";

import { MAX_INPUT_NAME_LENGTH, isAdmissibleInputName } from "./workInputName";
import {
  MAX_STANDARDIZATION_STEPS,
  MAX_STANDARDIZATION_TRANSFORMATIONS,
} from "./intent";

import type { FieldValueCoverage } from "@psi/nonEmptyAggregate";
import type { Standardization } from "@psilink/core";

/**
 * The environment variable naming the one operator-mounted directory the console
 * lists and reads input CSVs from. Unset or empty leaves the feature off: the
 * listing reports `configured: false` with an empty list and the profile/coverage
 * routes answer 404. The operator is present at the host and mounts their own data,
 * so the directory is trusted local input, not a shared-service surface.
 */
export const JOB_INPUT_DIR_ENV = "JOB_INPUT_DIR";

export { MAX_INPUT_NAME_LENGTH, isAdmissibleInputName } from "./workInputName";

/**
 * The byte cap on a coverage request body: a generous bound on the streamed read
 * of the standardization JSON, which is a handful of transformations at most. The
 * input CSV never rides the body -- it is read from the mounted directory -- so
 * this stays small.
 */
export const MAX_COVERAGE_BODY_BYTES = 1024 * 1024;

/** A requested input name that names no regular file in the mounted directory: an
 * inadmissible name, or a file that is absent or is not a regular file. */
export class JobInputNotFoundError extends Error {
  constructor() {
    super("job input not found");
    this.name = "JobInputNotFoundError";
  }
}

/**
 * The closed set of reasons a profile pass fails other than not-found. Carried to
 * the browser as a bare code so the operator gets a meaningful reason without any
 * file content, path, or raw error object riding the wire:
 * - `too_large`: a header, field, or unterminated line exceeded the CSV single-line
 *   byte ceiling, so the file cannot be profiled in bounded memory.
 * - `not_a_csv`: the parse produced no columns -- an empty file or one with no header.
 * - `parse_failed`: any other read or parse fault (a mid-read I/O error, a malformed
 *   structure the parser rejected).
 */
export type JobInputProfileErrorCode =
  "too_large" | "not_a_csv" | "parse_failed";

/** A profile fault the route maps to a 400 carrying only {@link code}. Never wraps
 * the underlying error, so no path or cell bytes reach the response. */
export class JobInputProfileError extends Error {
  constructor(readonly code: JobInputProfileErrorCode) {
    super(`job input profile failed: ${code}`);
    this.name = "JobInputProfileError";
  }
}

/** Signals that a {@link coverageJobInput} pass was aborted through its signal (a
 * client disconnect or a superseded sweep). Carries no path, so the aborted pass
 * never surfaces the mounted directory. */
export class JobInputCoverageAbortedError extends Error {
  constructor() {
    super("job input coverage aborted");
    this.name = "JobInputCoverageAbortedError";
  }
}

declare global {
  var jobInputDirConfig: { resolvedDir?: string } | undefined;
}

/** Truncate a stat's float `mtimeMs` to integer epoch milliseconds, the single
 * serialized representation used in the listing and profile. */
function mtimeMsInt(mtimeMs: number): number {
  return Math.trunc(mtimeMs);
}

/**
 * Resolve `name` to a readable regular file inside `resolvedDir`, returning its path
 * and the stat used to admit it. The name is a single admissible segment
 * ({@link isAdmissibleInputName}) so it never composes a traversal even though the
 * mounted directory is the operator's own; a name that resolves to no regular file
 * is a {@link JobInputNotFoundError}. Returning the stat lets a caller read size and
 * mtime without a second stat that could race the file away and surface a raw fs
 * error carrying the mounted path.
 */
function resolveJobInputFile(
  resolvedDir: string,
  name: string,
): { filePath: string; stat: fs.Stats } {
  if (!isAdmissibleInputName(name)) throw new JobInputNotFoundError();
  const filePath = path.join(resolvedDir, name);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new JobInputNotFoundError();
  }
  if (!stat.isFile()) throw new JobInputNotFoundError();
  return { filePath, stat };
}

/**
 * Resolve an input reference to the mounted file the CLI reads in place. Shared by
 * the job manager, which composes the absolute path into the CLI config without
 * copying the content.
 */
export function jobInputFilePath(resolvedDir: string, name: string): string {
  return resolveJobInputFile(resolvedDir, name).filePath;
}

/** One file in the listing response: an admissible name and its size/mtime. */
export interface JobInputFileEntry {
  name: string;
  sizeBytes: number;
  modifiedAt: number;
}

/** The `GET /api/jobs/inputs` response shape. */
export interface JobInputListing {
  /** False when {@link JOB_INPUT_DIR_ENV} is unset -- the feature-off state -- with
   * an empty list. */
  configured: boolean;
  /** False when the configured directory could not be enumerated (a mis-mount or a
   * permission fault), so the operator is told the mount is unreadable rather than to
   * place a file in a directory that already holds one. True in every other case,
   * including the unconfigured state (nothing failed to read). The errno and the
   * absolute path are deliberately NOT carried -- only this boolean. */
  readable: boolean;
  files: Array<JobInputFileEntry>;
}

/**
 * List the admissible input files, or the unconfigured state when `resolvedDir` is
 * undefined. Reads the directory non-recursively, admits regular files whose name
 * is admissible ({@link isAdmissibleInputName}), and sorts by name. An unreadable
 * directory (a mis-mount) reports `readable: false` with an empty list rather than an
 * empty-but-readable directory, so the operator checks their mount instead of placing
 * a file that is already there. On any ambiguity the listing still fails toward empty.
 */
export function listJobInputs(
  resolvedDir: string | undefined,
): JobInputListing {
  if (resolvedDir === undefined)
    return { configured: false, readable: true, files: [] };
  let names: Array<string>;
  try {
    names = fs.readdirSync(resolvedDir);
  } catch {
    return { configured: true, readable: false, files: [] };
  }
  const files: Array<JobInputFileEntry> = [];
  for (const name of names) {
    if (!isAdmissibleInputName(name)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(path.join(resolvedDir, name));
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    files.push({
      name,
      sizeBytes: stat.size,
      modifiedAt: mtimeMsInt(stat.mtimeMs),
    });
  }
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { configured: true, readable: true, files };
}

/** One column's preview samples on the wire: the column name paired with its first
 * {@link PREVIEW_SAMPLE_SIZE} non-empty values. Carried as an array element -- never
 * an object key -- so a column named an `Object.prototype` member (`__proto__`,
 * `constructor`, `prototype`) is ordinary data rather than a prototype-setter hazard. */
export interface ColumnSample {
  column: string;
  values: Array<string>;
}

/** The `GET /api/jobs/inputs/profile` response shape. `columnSamples` is an ordered
 * array of per-column pairs, so a prototype-member column name rides the wire as
 * plain data; the client validates it into a keyed map. */
export interface JobInputProfile {
  name: string;
  sizeBytes: number;
  modifiedAt: number;
  rowCount: number;
  columns: Array<string>;
  dateInputFormat?: string;
  columnSamples: Array<ColumnSample>;
}

/**
 * Profile a mounted input in ONE streaming pass that retains no rows: columns from
 * the header, `rowCount` by counting, `columnSamples` as the first
 * {@link PREVIEW_SAMPLE_SIZE} non-empty values per column in row order (the
 * `sampleInputValues` semantics the browser preview uses), and `dateInputFormat`
 * via the shared date-of-birth-column composition -- the DOB column is picked with
 * {@link inferDateOfBirthColumn} and its first {@link INFER_DATE_SCAN_CAP} non-empty
 * values are fed to {@link inferDateFormat}. Every accumulator is constant-size, so
 * peak memory is one parse chunk regardless of file size.
 */
export async function profileJobInput(
  resolvedDir: string,
  name: string,
): Promise<JobInputProfile> {
  const { filePath, stat } = resolveJobInputFile(resolvedDir, name);
  const stream = fs.createReadStream(filePath);
  const samples = new Map<string, Array<string>>();
  const dobSample: Array<string> = [];
  let dobColumn: string | undefined;
  let dobResolved = false;
  let rowCount = 0;
  let columns: Array<string>;
  try {
    columns = await streamCSVRows(stream, (rows, cols) => {
      if (!dobResolved && cols.length > 0) {
        dobColumn = inferDateOfBirthColumn(cols);
        dobResolved = true;
      }
      for (const row of rows) {
        rowCount++;
        for (const col of cols) {
          let bucket = samples.get(col);
          if (bucket === undefined) {
            bucket = [];
            samples.set(col, bucket);
          }
          if (bucket.length < PREVIEW_SAMPLE_SIZE) {
            const value = readRowColumn(row, col);
            if (value !== undefined && value.trim() !== "") bucket.push(value);
          }
        }
        if (dobColumn !== undefined && dobSample.length < INFER_DATE_SCAN_CAP) {
          const value = readRowColumn(row, dobColumn);
          if (value !== undefined && value.trim() !== "") dobSample.push(value);
        }
      }
    });
  } catch (error) {
    // Classify the fault into a closed code; the underlying error (a read fault
    // embedding the mounted path, or a parser error carrying cell bytes) is never
    // surfaced. A ceiling trip is the one distinguishable non-generic case.
    throw new JobInputProfileError(
      error instanceof CsvLineByteCeilingError ? "too_large" : "parse_failed",
    );
  }
  // A parse that yields no columns is not a usable CSV (an empty file, or one with
  // no header row), a distinct operator-meaningful reason from a parse fault.
  if (columns.length === 0) throw new JobInputProfileError("not_a_csv");
  const dateInputFormat =
    dobColumn !== undefined ? inferDateFormat(dobSample) : undefined;
  const columnSamples: Array<ColumnSample> = columns.map((col) => ({
    column: col,
    values: samples.get(col) ?? [],
  }));
  return {
    name,
    sizeBytes: stat.size,
    modifiedAt: mtimeMsInt(stat.mtimeMs),
    rowCount,
    columns,
    ...(dateInputFormat !== undefined ? { dateInputFormat } : {}),
    columnSamples,
  };
}

/**
 * Sweep a mounted input's per-field coverage in ONE streaming pass, feeding the
 * shared per-row accumulator ({@link createFieldCoverageAccumulator}) so the result
 * equals `computeFieldCoverage` over the same rows.
 *
 * An optional `signal` stops the pass early: when the client disconnects or the
 * browser supersedes the sweep it aborts, the read stream is destroyed, and the pass
 * rejects with a {@link JobInputCoverageAbortedError} rather than scanning the rest
 * of a CLI-scale file. The abort error carries no path or row bytes.
 */
export async function coverageJobInput(
  resolvedDir: string,
  name: string,
  standardization: Standardization,
  signal?: AbortSignal,
): Promise<Array<FieldValueCoverage>> {
  const { filePath } = resolveJobInputFile(resolvedDir, name);
  if (signal?.aborted) throw new JobInputCoverageAbortedError();
  const stream = fs.createReadStream(filePath);
  // A no-op error listener so destroying the stream on abort -- or an open fault that
  // races the abort -- never surfaces as an uncaught 'error'; the parse rejection
  // carries the real fault on the non-abort path.
  stream.on("error", () => {});
  const accumulator = createFieldCoverageAccumulator(standardization);
  const parse = streamCSVRows(stream, (rows) => {
    for (const row of rows) accumulator.add(row);
  });

  if (signal === undefined) {
    await parse;
    return accumulator.result();
  }

  // Race the parse against the abort: an abort destroys the stream so the pass stops
  // rather than scanning the rest of a CLI-scale file. Swallow a late parse rejection
  // once the abort has won the race.
  parse.catch(() => {});
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      stream.destroy();
      reject(new JobInputCoverageAbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([parse, aborted]);
  } catch (error) {
    // An aborted signal always reports the clean aborted error, never a parser
    // rejection that could embed the mounted path on a mid-stream read fault.
    if (signal.aborted) throw new JobInputCoverageAbortedError();
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return accumulator.result();
}

/** Read {@link JOB_INPUT_DIR_ENV} and resolve the input directory to an absolute
 * path, or undefined when it is unset. The mounted directory is trusted operator
 * data, so this is a plain resolve -- no containment check against the data root,
 * no fail-closed existence assertion (a mis-mount surfaces as an empty listing). */
function loadJobInputDir(env: NodeJS.ProcessEnv): string | undefined {
  const configured = (env[JOB_INPUT_DIR_ENV] ?? "").trim();
  if (configured.length === 0) return undefined;
  return path.resolve(configured);
}

/**
 * Resolve the input directory once and memoize it on globalThis, so dev-mode HMR
 * does not re-read it. The wrapper distinguishes "loaded, feature off" (an
 * undefined `resolvedDir`) from "not yet loaded".
 */
export function useJobInputDir(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  globalThis.jobInputDirConfig ??= { resolvedDir: loadJobInputDir(env) };
  return globalThis.jobInputDirConfig.resolvedDir;
}

/**
 * The standardization functions whose named param is compiled to a linear-time
 * regex at pipeline construction (`compileLinearRegex` in core's
 * standardization.ts), paired with that param's camelCase name. These are the only
 * sources whose LENGTH drives the super-linear RE2 compile this route bounds. A
 * plain-string param -- coalesce's `default`, null_if's `value`/`values` -- is never
 * compiled and is unbounded on every other path (core's schema, the browser
 * preview, the job-create intent), so capping it here would 400 a pipeline that runs
 * fine everywhere else. `parse_date`'s format param also compiles, but the shared
 * coverage accumulator already gates every field through `isStepValid`, which bounds
 * that format at its own cap before any compile; only the regex-tier
 * pattern/delimiter sources need this route's pre-parse rejection.
 */
const REGEX_SOURCE_PARAM_BY_FUNCTION: Record<string, string> = {
  replace_regex: "pattern",
  extract_regex: "pattern",
  filter_regex: "pattern",
  split_on: "delimiter",
};

/**
 * Whether every standardization step's compiled regex source stays within
 * {@link MAX_TRANSFORM_PATTERN_LENGTH}. The intent-level schema bounds counts, not
 * pattern length, and while RE2JS execution is linear-time its COMPILE cost lands on
 * this process's event loop before any row streams, so this route caps the source
 * length of exactly the params that reach regex compilation
 * ({@link REGEX_SOURCE_PARAM_BY_FUNCTION}). This is a compute-DoS bound on the one
 * input the browser still supplies (the standardization body), not an access
 * perimeter over the operator's own directory.
 */
function stepPatternsWithinCap(
  transformation: Standardization[number],
): boolean {
  for (const step of transformation.steps ?? []) {
    if (!Object.hasOwn(REGEX_SOURCE_PARAM_BY_FUNCTION, step.function)) continue;
    const value = step.params?.[REGEX_SOURCE_PARAM_BY_FUNCTION[step.function]];
    if (
      typeof value === "string" &&
      value.length > MAX_TRANSFORM_PATTERN_LENGTH
    )
      return false;
  }
  return true;
}

/**
 * The coverage route's standardization validation: core's structural schema plus
 * the same count bounds the intent schema applies (reusing its exported caps) plus
 * the route-level per-step pattern-length cap ({@link stepPatternsWithinCap}). The
 * shared intent schema is deliberately NOT modified -- only this in-process compute
 * endpoint needs the pattern cap.
 */
const coverageStandardizationSchema = StandardizationSchema.refine(
  (transformations) =>
    transformations.length <= MAX_STANDARDIZATION_TRANSFORMATIONS,
  { message: "standardization must not exceed the transformation cap" },
)
  .refine(
    (transformations) =>
      transformations.every(
        (transformation) =>
          (transformation.steps?.length ?? 0) <= MAX_STANDARDIZATION_STEPS,
      ),
    { message: "a standardization transformation exceeds the step cap" },
  )
  .refine(
    (transformations) =>
      transformations.every(
        (transformation) =>
          transformation.output.length <= MAX_NAME_LENGTH &&
          transformation.input.length <= MAX_NAME_LENGTH,
      ),
    { message: "a standardization output or input exceeds the length cap" },
  )
  .refine((transformations) => transformations.every(stepPatternsWithinCap), {
    message: "a standardization step pattern exceeds the length cap",
  });

/** The validated `POST /api/jobs/inputs/coverage` request body. */
export interface CoverageRequestBody {
  name: string;
  standardization: Standardization;
}

/** Schema for the coverage request body. `name` is length-bounded here and
 * resolved against the mounted directory at sweep time. */
export const coverageRequestSchema: z.ZodType<CoverageRequestBody> = z
  .object({
    name: z.string().min(1).max(MAX_INPUT_NAME_LENGTH),
    standardization: coverageStandardizationSchema,
  })
  .strict();
