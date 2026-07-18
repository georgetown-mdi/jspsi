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

import { PREVIEW_SAMPLE_SIZE } from "@psi/previewSamples";
import { createFieldCoverageAccumulator } from "@psi/nonEmptyAggregate";

import { JOB_DATA_ROOT_ENV, JobApiConfigError } from "./gate";
import {
  MAX_STANDARDIZATION_STEPS,
  MAX_STANDARDIZATION_TRANSFORMATIONS,
} from "./intent";

import type { Standardization, getLogger } from "@psilink/core";
import type { FieldValueCoverage } from "@psi/nonEmptyAggregate";

/**
 * The environment variable naming the one operator-mounted directory the server
 * may list and read input CSVs from. Resolved and validated once at startup,
 * fail-closed like the SFTP remotes table (see {@link loadJobInputDirFromEnv}).
 * Unset/empty leaves the feature off: the listing reports `configured: false` and
 * the profile/coverage routes answer an empty-bodied 404. It is set only
 * server-side, never derived from a request, and is never baked into the image, so
 * an upgraded console deployment that has not opted in gets the explicit
 * unconfigured state, not a silently served filesystem directory.
 */
export const JOB_INPUT_DIR_ENV = "JOB_INPUT_DIR";

/**
 * The listing cap: at most this many admitted files are returned, with a
 * `truncated` flag when more exist. Admitted names are sorted BEFORE the cap so
 * truncation is deterministic across readdir orderings.
 */
export const MAX_INPUT_LISTING_ENTRIES = 512;

/** The maximum length of an admissible input file name (a single path segment). */
export const MAX_INPUT_NAME_LENGTH = 255;

/**
 * The byte cap on a coverage request body: a generous bound on the streamed read
 * of the standardization JSON, which is a handful of transformations at most. The
 * input CSV never rides the body -- it is read from the mounted directory -- so
 * this stays small, unlike the job-create body.
 */
export const MAX_COVERAGE_BODY_BYTES = 1024 * 1024;

/** A requested input name that does not resolve to an admitted entry, an inode
 * that no longer matches, or an unreadable/vanished file. Mapped to an
 * empty-bodied response that never echoes the requested name. */
export class UnknownJobInputError extends Error {
  constructor() {
    super("unknown job input");
    this.name = "UnknownJobInputError";
  }
}

/** The named file's open-time size/mtime no longer match the client's profiled
 * snapshot: the file changed under the client, so the coverage is refused rather
 * than computed over content that drifted. */
export class JobInputDriftError extends Error {
  constructor() {
    super("job input changed since it was profiled");
    this.name = "JobInputDriftError";
  }
}

/** A parse/sweep was requested while one is running and another is already
 * queued: the depth-one gate is full (mapped to 429). */
export class JobInputParseBusyError extends Error {
  constructor() {
    super("job input parse/sweep gate is busy");
    this.name = "JobInputParseBusyError";
  }
}

declare global {
  var jobInputDirConfig: { resolvedDir?: string } | undefined;
  var jobInputParseGate: JobInputParseGate | undefined;
}

/** Truncate a stat's float `mtimeMs` to integer epoch milliseconds, the single
 * serialized representation used everywhere (listing, profile, and the coverage
 * drift comparison), so a round-tripped value compares by exact equality. */
function mtimeMsInt(mtimeMs: number): number {
  return Math.trunc(mtimeMs);
}

// C0 controls (which include NUL) and DEL: an operator-controlled name is still
// rendered through the UI, and a control character has no place in a file name.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

/**
 * Whether `name` is an admissible input file name: a single path segment (no `/`,
 * `\`, or NUL), not `.`/`..`, no leading dot (so a `.psilink.key`-shaped file is
 * excluded by construction), no control characters, length 1..255. Symlink and
 * directory exclusion is a separate lstat check ({@link listAdmitted}); this bounds
 * only the name shape.
 */
export function isAdmissibleInputName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_INPUT_NAME_LENGTH) return false;
  if (name === "." || name === "..") return false;
  if (name.startsWith(".")) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (CONTROL_CHAR_PATTERN.test(name)) return false;
  return true;
}

/** One admitted entry, carrying the lstat identity ({@link mtimeMsInt}, `dev`,
 * `ino`) the by-name open recipe rechecks against the fstat. */
interface AdmittedEntry {
  name: string;
  sizeBytes: number;
  modifiedAt: number;
  dev: number;
  ino: number;
}

/**
 * The listing that is the ONLY source of truth for admissible names: readdir the
 * resolved root non-recursively, admit an entry only when its name is admissible
 * ({@link isAdmissibleInputName}) AND `lstat` says a regular file (a symlink's
 * lstat is a symlink, so `isFile()` is false and it is never admitted), and sort
 * the admitted entries by name. Every by-name operation re-runs this and requires
 * exact string equality against an admitted entry, so a crafted name never reaches
 * `path.join` with a non-enumerated value.
 */
function listAdmitted(resolvedDir: string): {
  totalEntries: number;
  admitted: Array<AdmittedEntry>;
} {
  const names = fs.readdirSync(resolvedDir);
  const admitted: Array<AdmittedEntry> = [];
  for (const name of names) {
    if (!isAdmissibleInputName(name)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(path.join(resolvedDir, name));
    } catch {
      // The entry vanished between readdir and lstat, or is otherwise
      // unstattable: skip it rather than fail the whole listing.
      continue;
    }
    if (!stat.isFile()) continue;
    admitted.push({
      name,
      sizeBytes: stat.size,
      modifiedAt: mtimeMsInt(stat.mtimeMs),
      dev: stat.dev,
      ino: stat.ino,
    });
  }
  admitted.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { totalEntries: names.length, admitted };
}

/** One file in the listing response: an admissible name and its lstat size/mtime. */
export interface JobInputFileEntry {
  name: string;
  sizeBytes: number;
  modifiedAt: number;
}

/** The `GET /api/jobs/inputs` response shape. */
export interface JobInputListing {
  /** False when {@link JOB_INPUT_DIR_ENV} is unset -- the actionable "set the var
   * and mount a directory" state -- with an empty list. */
  configured: boolean;
  /** The raw readdir entry count before admission, so the UI can tell an empty
   * directory from one whose entries are all inadmissible. */
  totalEntries: number;
  /** True when more than {@link MAX_INPUT_LISTING_ENTRIES} files were admitted and
   * the list was capped. */
  truncated: boolean;
  files: Array<JobInputFileEntry>;
}

/**
 * List the admissible input files, or the unconfigured state when `resolvedDir` is
 * undefined. Sorts before the {@link MAX_INPUT_LISTING_ENTRIES} cap and reports
 * `totalEntries` (raw readdir count) alongside the capped `files`.
 */
export function listJobInputs(
  resolvedDir: string | undefined,
): JobInputListing {
  if (resolvedDir === undefined)
    return { configured: false, totalEntries: 0, truncated: false, files: [] };
  const { totalEntries, admitted } = listAdmitted(resolvedDir);
  const truncated = admitted.length > MAX_INPUT_LISTING_ENTRIES;
  const files = admitted.slice(0, MAX_INPUT_LISTING_ENTRIES).map((entry) => ({
    name: entry.name,
    sizeBytes: entry.sizeBytes,
    modifiedAt: entry.modifiedAt,
  }));
  return { configured: true, totalEntries, truncated, files };
}

/** An opened, identity-verified input file: the fd to stream from and the
 * open-time fstat size/mtime the caller uses for the response and drift check. */
interface OpenedInput {
  fd: number;
  filePath: string;
  sizeBytes: number;
  modifiedAt: number;
}

/** Open-time errno codes that are indistinguishable from an unknown name to the
 * client: a symlink swapped in after the admission lstat (`ELOOP`, the exact race
 * `O_NOFOLLOW` exists to close), a file that vanished (`ENOENT`), or one made
 * unreadable (`EACCES`). Each maps to {@link UnknownJobInputError} (empty-bodied
 * 404, name never echoed), never a generic error. */
const UNKNOWN_INPUT_OPEN_CODES = new Set(["ELOOP", "ENOENT", "EACCES"]);

/**
 * Open an admitted input for reading, closing the symlink-swap and file-swap TOCTOU
 * windows. Re-runs the admission listing and requires `name` to match an admitted
 * entry by exact string equality (the server opens only names it itself
 * enumerated), then `open(join(root, name), O_RDONLY | O_NOFOLLOW)` and `fstat`,
 * requiring `(dev, ino)` to equal the admission lstat. A name that is not admitted,
 * or an inode that no longer matches, is an {@link UnknownJobInputError}; the fd is
 * closed on any post-open failure so no descriptor leaks. An open that fails on a
 * post-admission race ({@link UNKNOWN_INPUT_OPEN_CODES}: the swapped-in symlink's
 * `ELOOP`, a vanished file's `ENOENT`, an unreadable file's `EACCES`) is mapped to
 * the same {@link UnknownJobInputError} rather than escaping as a generic error that
 * the routes would surface as a 400.
 *
 * `O_NOFOLLOW` protects only the FINAL path component, and the root's realpath was
 * resolved once at boot; a post-boot remount or replacement of an intermediate
 * component is out of model for the appliance (documented in the spec).
 */
function openAdmittedInput(resolvedDir: string, name: string): OpenedInput {
  const { admitted } = listAdmitted(resolvedDir);
  const entry = admitted.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new UnknownJobInputError();
  const filePath = path.join(resolvedDir, name);
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code !== undefined && UNKNOWN_INPUT_OPEN_CODES.has(code))
      throw new UnknownJobInputError();
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (stat.dev !== entry.dev || stat.ino !== entry.ino)
      throw new UnknownJobInputError();
    return {
      fd,
      filePath,
      sizeBytes: stat.size,
      modifiedAt: mtimeMsInt(stat.mtimeMs),
    };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
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
 * Profile an admitted input in ONE streaming pass that retains no rows: columns
 * from the header, `rowCount` by counting, `columnSamples` as the first
 * {@link PREVIEW_SAMPLE_SIZE} non-empty values per column in row order (the
 * `sampleInputValues` semantics the browser preview uses), and `dateInputFormat`
 * via the shared date-of-birth-column composition -- the DOB column is picked with
 * {@link inferDateOfBirthColumn} and its first {@link INFER_DATE_SCAN_CAP} non-empty
 * values are fed to {@link inferDateFormat}, so the format equals a full-column
 * read by the cap-exactness argument. Every accumulator is constant-size, so peak
 * memory is one parse chunk regardless of file size. `sizeBytes`/`modifiedAt` are
 * the open-time fstat values the client keeps for the drift signal.
 */
export async function profileJobInput(
  resolvedDir: string,
  name: string,
): Promise<JobInputProfile> {
  const opened = openAdmittedInput(resolvedDir, name);
  const stream = fs.createReadStream(opened.filePath, { fd: opened.fd });
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
    sizeBytes: opened.sizeBytes,
    modifiedAt: opened.modifiedAt,
    rowCount,
    columns,
    ...(dateInputFormat !== undefined ? { dateInputFormat } : {}),
    columnSamples,
  };
}

/**
 * Sweep an admitted input's per-field coverage in ONE streaming pass, feeding the
 * shared per-row accumulator ({@link createFieldCoverageAccumulator}) so the result
 * equals `computeFieldCoverage` over the same rows. Refuses on drift: the
 * open-time fstat size/mtime must equal the client's submitted pair (its profiled
 * snapshot), else a {@link JobInputDriftError} -- coverage is never computed over
 * content that changed since profiling.
 */
export async function coverageJobInput(
  resolvedDir: string,
  name: string,
  expectedSizeBytes: number,
  expectedModifiedAt: number,
  standardization: Standardization,
): Promise<Array<FieldValueCoverage>> {
  const opened = openAdmittedInput(resolvedDir, name);
  if (
    opened.sizeBytes !== expectedSizeBytes ||
    opened.modifiedAt !== expectedModifiedAt
  ) {
    fs.closeSync(opened.fd);
    throw new JobInputDriftError();
  }
  const stream = fs.createReadStream(opened.filePath, { fd: opened.fd });
  const accumulator = createFieldCoverageAccumulator(standardization);
  await streamCSVRows(stream, (rows) => {
    for (const row of rows) accumulator.add(row);
  });
  return accumulator.result();
}

/**
 * The single-flight gate over the parse/sweep routes: one profile or coverage pass
 * runs at a time (the single-operator appliance bound, doing double duty as the
 * memory bound), a second waits in a depth-one queue, and a third is refused with
 * {@link JobInputParseBusyError} (mapped to 429). The client treats a 429 like a
 * superseded response and its next debounced edit retries.
 */
export class JobInputParseGate {
  private busy = false;
  private waiter: (() => void) | null = null;

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.busy) {
      if (this.waiter !== null) throw new JobInputParseBusyError();
      // Take the single queue slot; release() hands the running flag to us.
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    } else {
      this.busy = true;
    }
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private release(): void {
    const next = this.waiter;
    if (next !== null) {
      // Hand the running flag to the queued waiter without clearing `busy`.
      this.waiter = null;
      next();
    } else {
      this.busy = false;
    }
  }
}

/** The process-wide parse/sweep gate, memoized on globalThis (like the job
 * manager) so dev-mode HMR does not duplicate it. */
export function useJobInputParseGate(): JobInputParseGate {
  return (globalThis.jobInputParseGate ??= new JobInputParseGate());
}

/** Resolve the data root to compare against for containment: its realpath when it
 * exists (the manager creates it lazily, so it may not yet), else its lexical
 * absolute path. */
function resolveDataRootPath(dataRoot: string): string {
  try {
    return fs.realpathSync(dataRoot);
  } catch {
    return path.resolve(dataRoot);
  }
}

/** Whether `child` is `parent` or nested under it (a lexical containment test over
 * already-resolved absolute paths). */
function containsOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * Read {@link JOB_INPUT_DIR_ENV} and resolve the input directory, or undefined when
 * it is unset. Fail-closed like the SFTP remotes table: every failure is a
 * {@link JobApiConfigError} that refuses startup. Setting it without
 * {@link JOB_DATA_ROOT_ENV} is a configuration error (the directory serves only the
 * job API, which the data root enables), matching the `JOB_SFTP_REMOTES` rule
 * exactly. The configured directory is resolved with `fs.realpathSync` once; one
 * that does not exist or is not a directory refuses startup. Mutual containment
 * with the resolved data root is refused: the input directory must not equal,
 * contain, or be contained by it, so the listing can never expose job workdirs and
 * a job can never be fed its own artifacts or another job's key material.
 */
export function loadJobInputDirFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = (env[JOB_INPUT_DIR_ENV] ?? "").trim();
  if (configured.length === 0) return undefined;

  const dataRoot = (env[JOB_DATA_ROOT_ENV] ?? "").trim();
  if (dataRoot.length === 0)
    throw new JobApiConfigError(
      `${JOB_INPUT_DIR_ENV} is set but ${JOB_DATA_ROOT_ENV} is not; the input ` +
        "directory serves only the job API, which the data root enables. Set " +
        "both or neither.",
    );

  let resolvedDir: string;
  try {
    resolvedDir = fs.realpathSync(configured);
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "unresolvable";
    throw new JobApiConfigError(
      `${JOB_INPUT_DIR_ENV} names a directory that could not be resolved ` +
        `(${code}); it must exist and be a directory`,
    );
  }
  if (!fs.statSync(resolvedDir).isDirectory())
    throw new JobApiConfigError(`${JOB_INPUT_DIR_ENV} must name a directory`);

  const resolvedDataRoot = resolveDataRootPath(dataRoot);
  if (
    containsOrEqual(resolvedDataRoot, resolvedDir) ||
    containsOrEqual(resolvedDir, resolvedDataRoot)
  )
    throw new JobApiConfigError(
      `${JOB_INPUT_DIR_ENV} must not equal, contain, or be contained by ` +
        `${JOB_DATA_ROOT_ENV}; the two directories must be disjoint`,
    );

  return resolvedDir;
}

/**
 * Resolve the input directory once and memoize it on globalThis (like the SFTP
 * remotes table): loaded from the environment on first use, then shared. A
 * {@link JobApiConfigError} propagates to the caller -- the server entry calls this
 * at startup so a misconfiguration refuses to boot. The wrapper distinguishes
 * "loaded, feature off" (an undefined `resolvedDir`) from "not yet loaded".
 */
export function useJobInputDir(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  globalThis.jobInputDirConfig ??= { resolvedDir: loadJobInputDirFromEnv(env) };
  return globalThis.jobInputDirConfig.resolvedDir;
}

/**
 * Log the one boot-diagnostic line for a configured input directory: the resolved
 * realpath, the total readdir count, and the admissible file count. This is the
 * primary mis-mount diagnostic -- an operator who mounted the wrong host path, or
 * whose entries are all filtered out, sees it at boot without touching the API.
 */
export function logJobInputDirBoot(
  resolvedDir: string,
  log: ReturnType<typeof getLogger>,
): void {
  const { totalEntries, admitted } = listAdmitted(resolvedDir);
  log.info(
    `job input directory ${resolvedDir}: ${totalEntries} readdir entries, ` +
      `${admitted.length} admissible`,
  );
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
 * ({@link REGEX_SOURCE_PARAM_BY_FUNCTION}). It is a route-level cap only: the shared
 * intent schema (and the job-create path) is unchanged.
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
 * shared intent schema is deliberately NOT modified -- only this in-process
 * compute endpoint needs the pattern cap.
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
  sizeBytes: number;
  modifiedAt: number;
  standardization: Standardization;
}

/** Schema for the coverage request body. `name` is length-bounded here and
 * exact-matched against the admission listing at open time; `sizeBytes`/`modifiedAt`
 * are the client's profiled snapshot, compared for drift after open. */
export const coverageRequestSchema: z.ZodType<CoverageRequestBody> = z
  .object({
    name: z.string().min(1).max(MAX_INPUT_NAME_LENGTH),
    sizeBytes: z.number().int().nonnegative(),
    modifiedAt: z.number().int().nonnegative(),
    standardization: coverageStandardizationSchema,
  })
  .strict();
