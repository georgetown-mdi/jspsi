import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import {
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

import type { Standardization } from "@psilink/core";
import type { FieldValueCoverage } from "@psi/nonEmptyAggregate";

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

declare global {
  var jobInputDirConfig: { resolvedDir?: string } | undefined;
}

/** Truncate a stat's float `mtimeMs` to integer epoch milliseconds, the single
 * serialized representation used in the listing and profile. */
function mtimeMsInt(mtimeMs: number): number {
  return Math.trunc(mtimeMs);
}

/**
 * Resolve `name` to a readable regular file inside `resolvedDir`. The name is a
 * single admissible segment ({@link isAdmissibleInputName}) so it never composes a
 * traversal even though the mounted directory is the operator's own; a name that
 * resolves to no regular file is a {@link JobInputNotFoundError}.
 */
function resolveJobInputPath(resolvedDir: string, name: string): string {
  if (!isAdmissibleInputName(name)) throw new JobInputNotFoundError();
  const filePath = path.join(resolvedDir, name);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new JobInputNotFoundError();
  }
  if (!stat.isFile()) throw new JobInputNotFoundError();
  return filePath;
}

/**
 * Resolve an input reference to the mounted file the CLI reads in place. Shared by
 * the job manager, which composes the absolute path into the CLI config without
 * copying the content.
 */
export function jobInputFilePath(resolvedDir: string, name: string): string {
  return resolveJobInputPath(resolvedDir, name);
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
  files: Array<JobInputFileEntry>;
}

/**
 * List the admissible input files, or the unconfigured state when `resolvedDir` is
 * undefined. Reads the directory non-recursively, admits regular files whose name
 * is admissible ({@link isAdmissibleInputName}), and sorts by name. An unreadable
 * directory (a mis-mount) yields an empty list rather than failing -- the operator
 * sees no files and checks their mount.
 */
export function listJobInputs(
  resolvedDir: string | undefined,
): JobInputListing {
  if (resolvedDir === undefined) return { configured: false, files: [] };
  let names: Array<string>;
  try {
    names = fs.readdirSync(resolvedDir);
  } catch {
    return { configured: true, files: [] };
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
  return { configured: true, files };
}

/** The `GET /api/jobs/inputs/profile` response shape. */
export interface JobInputProfile {
  name: string;
  sizeBytes: number;
  modifiedAt: number;
  rowCount: number;
  columns: Array<string>;
  dateInputFormat?: string;
  columnSamples: Record<string, Array<string>>;
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
  const filePath = resolveJobInputPath(resolvedDir, name);
  const stat = fs.statSync(filePath);
  const stream = fs.createReadStream(filePath);
  const samples = new Map<string, Array<string>>();
  const dobSample: Array<string> = [];
  let dobColumn: string | undefined;
  let dobResolved = false;
  let rowCount = 0;
  const columns = await streamCSVRows(stream, (rows, cols) => {
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
  const dateInputFormat =
    dobColumn !== undefined ? inferDateFormat(dobSample) : undefined;
  const columnSamples: Record<string, Array<string>> = {};
  for (const col of columns) columnSamples[col] = samples.get(col) ?? [];
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
 */
export async function coverageJobInput(
  resolvedDir: string,
  name: string,
  standardization: Standardization,
): Promise<Array<FieldValueCoverage>> {
  const filePath = resolveJobInputPath(resolvedDir, name);
  const stream = fs.createReadStream(filePath);
  const accumulator = createFieldCoverageAccumulator(standardization);
  await streamCSVRows(stream, (rows) => {
    for (const row of rows) accumulator.add(row);
  });
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
