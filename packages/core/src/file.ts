import Papa from "papaparse";

import type { LocalFile } from "papaparse";

import { UsageError } from "./errors.js";
import { stripBidiControls } from "./utils/bidiControls.js";

/**
 * Per-logical-line byte ceiling for the streamed CSV reads ({@link loadCSVFile}
 * and {@link loadCSVColumnSample}). PapaParse must buffer one whole logical
 * line -- a data row, or the entire header -- before it can yield a chunk, so
 * an input whose first row terminator is far from the start (no newline, an
 * enormous field, or a multi-megabyte header) would otherwise drive memory and
 * CPU linearly-to-quadratically with that span. This ceiling bounds the bytes
 * pulled from the source between row terminators, so those shapes fail fast
 * with a clear error instead.
 *
 * 8 MiB sits comfortably above any realistic operator CSV's single line and
 * well below the hundred-MiB-plus spans that drove the gigabyte-scale memory
 * growth this guards against. The input is the operator's own local file, so
 * this is a robustness safety check, not a partner- or transport-reachable
 * bound. Classification: `docs/spec/CHANNEL_SECURITY.md` (CSV-read
 * single-line byte ceiling).
 */
export const CSV_LINE_BYTE_CEILING = 8 * 1024 * 1024;

/**
 * The error every {@link CSV_LINE_BYTE_CEILING} trip raises. A named subclass so a
 * caller can classify the ceiling trip by `instanceof` -- distinguishing an
 * oversized/unterminated line from an ordinary parse fault -- rather than matching
 * the message string. The message stays operator-readable and holds only the
 * byte ceiling, never file content or a path.
 */
export class CsvLineByteCeilingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvLineByteCeilingError";
  }
}

/**
 * The single operator-readable error every {@link CSV_LINE_BYTE_CEILING} trip
 * raises, shared so the stream guard and the non-stream pre-read below cannot
 * drift to differently-worded messages for the same condition.
 */
function singleLineCeilingError(byteCeiling: number): CsvLineByteCeilingError {
  return new CsvLineByteCeilingError(
    `CSV input exceeded the ${byteCeiling}-byte single-line limit before a ` +
      "line terminator; the file may be malformed (no newline) or hold an " +
      "oversized header or field",
  );
}

/**
 * The error a row-level parse fault raises: PapaParse read the file without a
 * stream error, but at least one row it produced does not correspond to the
 * row in the file. A {@link UsageError} subclass, so the CLI's error
 * boundaries classify a malformed input file as bad input (exit 64) rather
 * than a transport failure, and a front end can tell it from a ceiling trip by
 * `instanceof`. The message holds PapaParse's own fault description and the
 * row number, never a cell value or a path.
 */
export class CsvRowParseError extends UsageError {
  constructor(message: string) {
    super(message);
    this.name = "CsvRowParseError";
  }
}

/**
 * The PapaParse error codes that are NOT a row-level fault, as an allowlist: a
 * code this set does not name refuses the read, so a code a later PapaParse adds
 * fails closed rather than passing unnoticed.
 *
 * `UndetectableDelimiter` is the only benign one. PapaParse emits it for a
 * legitimate single-column CSV (verified by driving the parser: a two-row `id`
 * file yields it) and for an empty input, having defaulted to a comma, which
 * changes nothing about the rows it produces. Every other code -- the quote and
 * field-count faults -- means the parsed rows differ from the file's own.
 */
const BENIGN_CSV_PARSE_ERROR_CODES: ReadonlySet<string> = new Set([
  "UndetectableDelimiter",
]);

/**
 * The operator-readable refusal for one row-level parse fault, shared by both
 * drivers over {@link runSharedCSVParse} so neither can word the same condition
 * differently. `error.row` is PapaParse's 0-based data-row index and counts from
 * the start of the FILE, not the chunk (verified by driving the parser across a
 * multi-chunk read), so it is reported as a 1-based data row the operator can
 * find; a fault PapaParse reports without a row (a delimiter-level one) is named
 * without a position rather than given a wrong one.
 */
function rowParseFaultError(error: Papa.ParseError): CsvRowParseError {
  const position =
    typeof error.row === "number" ? `data row ${error.row + 1}` : "a data row";
  return new CsvRowParseError(
    `CSV parse failed at ${position}: ${error.message} (${error.code}). The ` +
      "rows this file yields would differ from the rows it contains, so the " +
      "read refuses rather than return them; correct the input file -- an " +
      "unterminated quote, or a row whose field count differs from the " +
      "header, is the usual cause.",
  );
}

/**
 * Reject if the LEADING logical line of a materialized (non-stream) CSV
 * exceeds `byteCeiling` -- the bound {@link loadCSVFile}'s stream guard
 * cannot enforce on a source it does not stream. The web caller passes a
 * browser `File`, read whole through FileReader with no `data` events to
 * scan, so this pre-read scans forward from the start for the first line
 * terminator (LF or CR) before parsing. Finding none within `byteCeiling`
 * bytes means the header -- or the whole file, if it holds no terminator at
 * all -- is a single line past the ceiling, and it rejects with the same
 * {@link singleLineCeilingError} the stream path raises.
 *
 * Scoped to the leading line: it reads only up to the first terminator, so a
 * normal file pays one small read, skipped entirely when the file is no
 * larger than the ceiling. A giant field buried in a LATER row is therefore
 * not caught here; that stays bounded by the web app's intake cap
 * (`MAX_CSV_FILE_BYTES`). Inert for any input without the Blob read surface
 * -- a Node stream (bounded by the stream guard) or a string (parsed whole
 * in one pass) returns at once.
 *
 * @internal exported only so the unit tests can drive its resolve cases
 * directly: loadCSVFile cannot reach them in Node, where a File hits
 * PapaParse's FileReader path (absent there). Not re-exported from the
 * package entry point.
 */
export async function assertLeadingLineWithinByteCeiling(
  file: LocalFile,
  byteCeiling: number,
): Promise<void> {
  const source = file as Partial<{
    size: number;
    slice: (
      start: number,
      end: number,
    ) => {
      arrayBuffer: () => Promise<ArrayBuffer>;
    };
  }>;
  if (typeof source.size !== "number" || typeof source.slice !== "function")
    return;
  if (source.size <= byteCeiling) return;

  // Read the first window only; a well-formed header terminates inside it, so a
  // legitimate large file reads one small slice rather than its whole body. Only
  // an input with no terminator in that window -- already pathological -- reads on
  // to the ceiling to confirm the leading line crosses it. Two reads at most, so
  // no await-in-loop.
  const limit = byteCeiling + 1;
  const window = 256 * 1024;
  // Scan raw bytes for LF or CR. Like the stream guard, this does not honor RFC
  // 4180 quoting -- a quoted newline counts as a terminator, so it never wrongly
  // rejects a valid file (the safe direction), at the cost of not bounding a single
  // quoted field full of embedded newlines (bounded instead by MAX_CSV_FILE_BYTES
  // on this web path). Byte-wise is safe for UTF-8: 0x0a/0x0d are below 0x80, so
  // neither can occur as a continuation byte of a multi-byte character.
  const hasTerminator = (bytes: Uint8Array): boolean =>
    bytes.indexOf(0x0a) !== -1 || bytes.indexOf(0x0d) !== -1;
  const head = new Uint8Array(
    await source.slice(0, Math.min(window, limit)).arrayBuffer(),
  );
  if (hasTerminator(head)) return;
  if (limit > window) {
    const tail = new Uint8Array(
      await source.slice(window, limit).arrayBuffer(),
    );
    if (hasTerminator(tail)) return;
  }
  throw singleLineCeilingError(byteCeiling);
}

/**
 * The Node-stream subset the byte-ceiling guard and the loaders' cleanup use,
 * duck-typed so `@psilink/core` needs no `node:stream` import -- which would pull
 * `node:stream` into the web bundle. A browser File/string lacks these members,
 * which is what makes the stream guard inert for it.
 */
type StreamSource = {
  on?: (event: "data", listener: (chunk: Buffer | string) => void) => void;
  removeListener?: (
    event: "data",
    listener: (chunk: Buffer | string) => void,
  ) => void;
  destroy?: (error?: Error) => void;
};

/**
 * Bound a single logical line on a Node stream `source`: across its `data`
 * events it counts bytes since the last terminator (LF or CR) and, when one
 * unterminated run exceeds `byteCeiling`, destroys the source with
 * {@link singleLineCeilingError}. PapaParse, reading the same source, reports
 * that as a read error through its documented `error` callback, so the bound
 * rests only on the stream's public `on`/`destroy` surface and PapaParse's
 * public error contract. Returns a detach function the caller runs once the
 * parse settles. Inert (a no-op detach) for a source without `on` -- a
 * browser File, bounded instead by {@link assertLeadingLineWithinByteCeiling}.
 *
 * The byte scan ignores RFC 4180 quoting by design, so it never wrongly
 * rejects a valid file (a newline inside a quoted field just resets the run).
 * The cost is one shape this ceiling does NOT bound: a single quoted field
 * holding embedded newlines, which PapaParse buffers whole as one logical row
 * while the run keeps resetting, so memory and CPU scale with the field, not
 * the ceiling -- bounded only by the input being operator-local, or by
 * MAX_CSV_FILE_BYTES on the web; the read was unbounded for this shape before
 * this ceiling too. Byte-wise is safe for UTF-8 (0x0a/0x0d are below 0x80, so
 * neither occurs as a continuation byte of a multi-byte character).
 *
 * @internal exported only for the unit tests, which drive its scan and trip
 * directly against a fake stream source -- isolating the run accounting from
 * PapaParse's row splitting (which never sees CR-only or the inner-overflow case).
 */
export function guardStreamLineByteCeiling(
  source: StreamSource,
  byteCeiling: number,
): () => void {
  if (typeof source.on !== "function") return () => undefined;
  let run = 0;
  let tripped = false;
  const onData = (chunk: Buffer | string): void => {
    if (tripped) return;
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    // Walk terminator to terminator: each segment between them extends the current
    // run, each terminator resets it. Check the run AT each terminator (and at the
    // chunk's unterminated tail) so a run that crosses the ceiling before a later
    // terminator in the same chunk still trips -- the within-chunk overflow case.
    let from = 0;
    while (from < buf.length) {
      const lf = buf.indexOf(0x0a, from);
      const cr = buf.indexOf(0x0d, from);
      const term = lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr);
      if (term === -1) {
        run += buf.length - from;
        break;
      }
      run += term - from;
      if (run > byteCeiling) break;
      run = 0;
      from = term + 1;
    }
    if (run > byteCeiling) {
      tripped = true;
      source.destroy?.(singleLineCeilingError(byteCeiling));
    }
  };
  source.on("data", onData);
  return () => source.removeListener?.("data", onData);
}

/**
 * Detach the line-ceiling guard and release the source once a parse settles.
 * PapaParse's teardown -- whether a natural `complete`, an early `parser.abort()`,
 * or an `error` -- does not close the underlying stream, so an
 * `fs.createReadStream` descriptor would otherwise linger until GC; `destroy` is a
 * no-op once a natural EOF has closed it, and skipped for a non-stream LocalFile
 * (no `destroy`).
 */
function releaseSource(detachGuard: () => void, source: StreamSource): void {
  detachGuard();
  source.destroy?.();
}

/**
 * A parsed CSV row as {@link loadCSVFile} returns it under PapaParse's
 * `header: true`: an object keyed by column name. PapaParse gives no per-cell
 * string guarantee -- a row shorter than the header omits its trailing columns
 * (a by-name read is then `undefined`), and a row with fields beyond the
 * header holds a non-string `__parsed_extra` array. {@link loadCSVFile}
 * normalizes that away, keeping only the string-valued cells (see
 * {@link normalizeCSVRow}), so a present column is a `string` and a missing
 * one is `undefined`, which this type states accurately: the `| undefined`
 * holds even with `noUncheckedIndexedAccess` off, and no cell is ever a
 * non-string a generic value iteration could trip over. Every row consumer --
 * the exchange pipeline, standardization, payload extraction -- threads this
 * type rather than an unsound `Record<string, string>` cast.
 */
export type CSVRow = Record<string, string | undefined>;

/**
 * The parse metadata every read in this module resolves: PapaParse's own
 * {@link Papa.ParseMeta} plus the 1-based positions, in column order, of the
 * header columns whose name lost a bidi control character at ingestion
 * ({@link bidiStrippingHeaderTransform}). Empty for a header that held none.
 *
 * Carried on `meta` rather than beside it so it rides every hop the header
 * already rides -- the web app's parse worker posts `meta` back to the main
 * thread untouched -- and so a consumer reads the positions from the same
 * object as the names they index.
 */
export interface CSVParseMeta extends Papa.ParseMeta {
  bidiStrippedColumns: Array<number>;
}

/**
 * Read one column's value from a parsed {@link CSVRow} by name, returning
 * `undefined` when the row omits that column.
 *
 * A parsed row is a plain object, so `row[column]` for a column the row lacks
 * walks the prototype chain: a column named exactly an `Object.prototype`
 * member (`toString`, `valueOf`, `constructor`, `hasOwnProperty`, ...) would
 * read the INHERITED function rather than `undefined`, and that non-string
 * value slips past a nullish/undefined guard into standardization, the
 * transmitted payload, and the on-disk table -- the realistic trigger is a
 * short row (a malformed but operator-local CSV) omitting such a column. An
 * own-property check ({@link Object.hasOwn}) treats a missing column as
 * absent regardless of the prototype chain, so every by-name row read must go
 * through here rather than index `row[column]` directly.
 *
 * @internal used across the core row consumers (standardization, payload
 * extraction, date inference); not a supported public entry point.
 */
export function readRowColumn(row: CSVRow, column: string): string | undefined {
  return Object.hasOwn(row, column) ? row[column] : undefined;
}

/**
 * Normalize one raw PapaParse row to a {@link CSVRow}, dropping any non-string
 * cell -- the `__parsed_extra` array PapaParse attaches to a row longer than the
 * header -- so every retained value is a genuine string. A row that is already
 * all-string (the common well-formed row) is returned by reference; only a row
 * holding a non-string cell is rebuilt without it.
 *
 * The fault gate in {@link runSharedCSVParse} refuses an over-long row upstream of
 * this (PapaParse reports `TooManyFields` for the same rows it attaches
 * `__parsed_extra` to), so this stands as the structural guarantee behind the
 * {@link CSVRow} type for whatever PapaParse hands over, not as the defense the
 * malformed-row case rests on.
 */
function normalizeCSVRow(row: unknown): CSVRow {
  const source = row as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.every((key) => typeof source[key] === "string"))
    return source as CSVRow;
  const cleaned: CSVRow = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") cleaned[key] = value;
  }
  return cleaned;
}

/**
 * The PapaParse configuration every CSV read in this module shares -- the ONE
 * config object behind both the whole-file loader ({@link loadCSVFile}) and
 * the streaming row-consumer ({@link streamCSVRows}). Config identity is what
 * makes the two drivers parse-equivalent: a row one produces is
 * byte-identical to the other's, and neither can silently drift from the
 * browser's parse.
 *
 * Parse INLINE, never in a Web Worker: PapaParse's `worker: true` spawns its
 * worker by reading the running script's URL, which breaks once Vite bundles
 * and minifies PapaParse -- the spawned worker mis-applies `header: true`,
 * landing the header row AND the first data row in `meta.fields` while `data`
 * comes back empty, which crashed the production web inviter outright. No
 * unit/browser test catches it, since dev and real-Chromium tests resolve the
 * worker; the header guard in {@link runSharedCSVParse} is the executable
 * safety check. Inline parsing blocks the main thread, acceptable for the
 * once-per-exchange invite/accept file. Under Node, PapaParse never honored
 * the worker anyway (`WORKERS_SUPPORTED` is `!!global.Worker`, false there),
 * so this changes only the web build.
 *
 * The header transform is not here because it records per-parse state; every
 * read composes this object with one from
 * {@link bidiStrippingHeaderTransform}.
 */
const SHARED_CSV_PARSE_CONFIG = {
  worker: false,
  header: true,
  skipEmptyLines: true,
} as const;

/**
 * The header transform every CSV read in this module applies: each column name
 * goes through {@link stripBidiControls}, and the 1-based position of a name
 * that lost a character is appended to `strippedPositions`.
 *
 * At the PARSE boundary rather than after it, for two reasons. PapaParse keys
 * each row object by the header string it ends with (verified by driving it
 * under `header: true`: `meta.fields` and the row keys both hold the
 * transformed name), so a name changed after the parse would need every row
 * re-keyed or its values are lost. And this is the one boundary the browser
 * parse, the console server's profiling pass, and the CLI's own read all cross,
 * so the name each of them matches on, discloses, and sends to the partner is
 * the same string -- both parties describe a column the same way, whichever
 * seat read the file.
 *
 * Removing rather than refusing the file: the header is the operator's own, and
 * an operator who cannot edit a vendor export would lose the exchange over a
 * character that carries no meaning in a name. The seats report what was
 * removed and where (see the web app's `sanitizedColumnsAlert`).
 *
 * A name stripped to empty, or onto another column's name, is not special-cased
 * here: the empty name meets the unnamed-column refusal every intake already
 * applies, and a collision meets PapaParse's own duplicate-header renaming,
 * which a header holding two identical names already reaches.
 */
function bidiStrippingHeaderTransform(
  strippedPositions: Array<number>,
): (header: string, index: number) => string {
  return (header, index) => {
    const stripped = stripBidiControls(header);
    if (stripped !== header) strippedPositions.push(index + 1);
    return stripped;
  };
}

/**
 * Drive a PapaParse read of `file` under {@link SHARED_CSV_PARSE_CONFIG} and the
 * single-line byte ceiling, handing each chunk's normalized rows to
 * `consumeChunk`. The whole-file loader ({@link loadCSVFile}) and the streaming
 * row-consumer ({@link streamCSVRows}) are the two drivers over this one runner,
 * so neither can drift to different parse semantics. Resolves with the final
 * {@link Papa.ParseMeta} once the parse settles; rejects on a read/parse error or
 * a ceiling trip.
 *
 * `byteCeiling` bounds a single logical line -- the partial line PapaParse
 * must buffer whole before it yields a chunk -- so a no-newline file, an
 * oversized header, or one enormous field fails fast instead of driving
 * memory and CPU with that span (see {@link CSV_LINE_BYTE_CEILING}). Enforced
 * by two complementary, public-API-only mechanisms: {@link
 * guardStreamLineByteCeiling} for the Node stream a CLI or server caller
 * passes, and {@link assertLeadingLineWithinByteCeiling} for the browser
 * `File` the web caller passes, which exposes no `data` events to scan.
 *
 * PapaParse's per-chunk `chunk` callback is the only place every row is seen:
 * in both inline and worker mode, `complete`'s argument is the FINAL chunk
 * (worker) or `undefined` (inline, once a `chunk` callback is present), never
 * the whole file, so a driver reading `complete` alone would silently
 * truncate a multi-chunk file. Rows are normalized to {@link CSVRow} at this
 * single boundary, dropping the non-string `__parsed_extra` PapaParse
 * attaches to an over-long row, so both drivers see the accurate row type
 * without a per-site cast.
 *
 * Caveat on `meta`: only `meta.fields` (the header) and `bidiStrippedColumns`
 * are whole-file-stable; the rest (`cursor`, `truncated`, `aborted`, ...) is the
 * FINAL chunk's, so a consumer must not read whole-file position or truncation
 * state off it.
 */
async function runSharedCSVParse(
  file: LocalFile,
  byteCeiling: number,
  consumeChunk: (
    rows: Array<CSVRow>,
    errors: Array<Papa.ParseError>,
    meta: Papa.ParseMeta,
  ) => void,
): Promise<CSVParseMeta> {
  // Bound the non-stream (browser File) path's leading line before parsing: a File
  // exposes no `data` events for the stream guard below to scan, since PapaParse
  // reads it whole through FileReader. A Node stream or string is a no-op here.
  await assertLeadingLineWithinByteCeiling(file, byteCeiling);
  return new Promise((resolve, reject) => {
    let meta: Papa.ParseMeta | undefined;
    let faulted = false;
    const bidiStrippedColumns: Array<number> = [];

    // Bound a single logical line on the Node stream path (CLI file/stdin, or the
    // server's opened input file): the guard scans the source's own `data` events
    // and destroys it past the ceiling, which PapaParse -- reading the same source
    // -- reports through the `error` callback below. Inert for a non-stream
    // LocalFile (a browser File has no `data` events); that path is bounded by the
    // pre-read above instead.
    const source = file as StreamSource;
    const detachGuard = guardStreamLineByteCeiling(source, byteCeiling);

    Papa.parse(file, {
      ...SHARED_CSV_PARSE_CONFIG,
      transformHeader: bidiStrippingHeaderTransform(bidiStrippedColumns),
      chunk: (results, parser) => {
        // Refuse the whole read on the first row-level fault, BEFORE the chunk
        // reaches the consumer. PapaParse reports an unterminated quote or a
        // field-count mismatch here and parses on, having dropped, merged, or
        // shifted values around the fault, so a driver reading only `data`
        // would silently return a dataset differing from the file. Aborting
        // rather than reading to the end also stops the read at the fault.
        // The refusal is at this shared runner rather than at each caller so
        // no read site can forget it.
        const fault = results.errors.find(
          (error) => !BENIGN_CSV_PARSE_ERROR_CODES.has(error.code),
        );
        if (fault !== undefined) {
          faulted = true;
          parser.abort();
          releaseSource(detachGuard, source);
          reject(rowParseFaultError(fault));
          return;
        }
        // Spread-push would pass one argument per row and can overflow the call
        // stack for a chunk holding hundreds of thousands of short rows, so build
        // the chunk's row array in a loop (O(n) total, stack-safe), normalizing
        // each row here at the single boundary.
        const rows: Array<CSVRow> = [];
        for (const row of results.data) rows.push(normalizeCSVRow(row));
        consumeChunk(rows, results.errors, results.meta);
        // Every chunk's meta holds the header field list (the parser's fields
        // persist across chunks), so keep the latest for `complete`, whose own
        // argument is only the final chunk (worker) or undefined (inline).
        meta = results.meta;
      },
      complete: () => {
        releaseSource(detachGuard, source);
        // The abort above settles this promise itself and leaves `meta` unset when
        // the fault fell in the first chunk, so stop here rather than fall into the
        // no-chunk invariant below, which that abort would otherwise trip.
        if (faulted) return;
        // `meta` is set by the chunk callback, which fires at least once before
        // complete for any input (PapaParse parses at least one chunk, even an
        // empty file). Rejecting on the unreachable no-chunk case makes that an
        // executable invariant rather than a silent fallback that could mask a
        // future PapaParse callback-ordering change.
        if (meta === undefined) {
          reject(new Error("CSV parse completed without producing a chunk"));
          return;
        }
        // The header must be a flat list of string column names. A correct
        // `header: true` parse always produces that; a non-string field means the
        // parse itself malfunctioned (the bundled-worker corruption the shared
        // config note above describes leaks a data row -- an array -- into
        // `meta.fields`). Reject loudly here rather than letting the malformed
        // header flow into inferMetadata and surface as a deep, opaque
        // `toLowerCase` crash.
        if (meta.fields?.some((field) => typeof field !== "string")) {
          reject(
            new Error(
              "CSV header parsed to a non-string column; the file could not be " +
                "read correctly",
            ),
          );
          return;
        }
        resolve(Object.assign(meta, { bidiStrippedColumns }));
      },
      error: (error) => {
        // The guard's ceiling trip surfaces here -- it destroys the source with
        // singleLineCeilingError, which PapaParse reports as a read error -- as does
        // a genuine read/stream error.
        releaseSource(detachGuard, source);
        reject(error);
      },
    });
  });
}

/**
 * Parse a CSV file to its COMPLETE row set. Resolves a {@link Papa.ParseResult}
 * whose `data` and `errors` are accumulated across every PapaParse chunk, so a
 * file larger than one `Papa.LocalChunkSize` chunk is returned whole rather than
 * truncated to its final chunk. Rejects on a read/stream error, and -- through the
 * shared runner's fault gate -- on a row-level parse fault with a
 * {@link CsvRowParseError}, so the resolved `data` is the file's own rows or
 * nothing. The resolved `errors` therefore holds only the codes the gate
 * classifies as benign; a caller needs no check of its own.
 *
 * The single-line `byteCeiling` and the parse semantics are the shared runner's
 * ({@link runSharedCSVParse}); this driver's whole contribution is to accumulate
 * every chunk's rows on this thread. Unlike loadCSVColumnSample (whose row cap
 * also removes real waste), this read genuinely consumes every row of the
 * operator's own file, so the ceiling is a robustness safety check on a single
 * pathological line, not a memory saving for well-formed input. The whole-file
 * streaming counterpart that retains NOTHING is {@link streamCSVRows}.
 *
 * Caveat on `meta`: only `meta.fields` and `meta.bidiStrippedColumns` are
 * whole-file-stable (see the runner); every current consumer reads only `data`
 * and those two.
 */
export async function loadCSVFile(
  file: LocalFile,
  byteCeiling: number = CSV_LINE_BYTE_CEILING,
): Promise<Omit<Papa.ParseResult<CSVRow>, "meta"> & { meta: CSVParseMeta }> {
  const data: Array<CSVRow> = [];
  const errors: Array<Papa.ParseError> = [];
  const meta = await runSharedCSVParse(
    file,
    byteCeiling,
    (rows, chunkErrors) => {
      for (const row of rows) data.push(row);
      for (const error of chunkErrors) errors.push(error);
    },
  );
  return { data, errors, meta };
}

/**
 * Stream a CSV file to `consumeChunk`, retaining NOTHING: each PapaParse chunk's
 * normalized rows are handed to the consumer and then dropped, so peak memory is
 * one chunk regardless of file size. The server-side profile and coverage passes
 * over CLI-scale mounted inputs (millions of rows, gigabytes) use this -- they
 * accumulate only constant-size summaries (a row counter, bounded per-column
 * samples, a running coverage count), never the rows. `consumeChunk` also receives
 * the header column list (`meta.fields`, stable across chunks) so a consumer can
 * key per-column state without a separate read.
 *
 * Shares {@link runSharedCSVParse}'s config, single-line byte ceiling, row
 * normalization, and row-level fault gate with {@link loadCSVFile} -- one
 * config, two drivers -- so a streaming server pass and a browser worker
 * wrapping loadCSVFile parse identically. Resolves with the header column list
 * and the positions the header transform stripped ({@link CSVParseMeta}) once
 * the parse settles; rejects the same way as loadCSVFile: a
 * ceiling trip with {@link CsvLineByteCeilingError}, a row-level fault with
 * {@link CsvRowParseError}. The fault gate refuses the read before the
 * faulting chunk reaches `consumeChunk`, so a consumer never accumulates rows
 * the file does not contain -- but chunks BEFORE the fault have already been
 * handed over, so a consumer with side effects must discard its own state on
 * a rejection.
 */
export async function streamCSVRows(
  file: LocalFile,
  consumeChunk: (rows: Array<CSVRow>, columns: Array<string>) => void,
  byteCeiling: number = CSV_LINE_BYTE_CEILING,
): Promise<{ columns: Array<string>; bidiStrippedColumns: Array<number> }> {
  const meta = await runSharedCSVParse(
    file,
    byteCeiling,
    (rows, _errors, chunkMeta) => consumeChunk(rows, chunkMeta.fields ?? []),
  );
  return {
    columns: meta.fields ?? [],
    bidiStrippedColumns: meta.bidiStrippedColumns,
  };
}

/**
 * Read a CSV's column header plus a bounded sample of one column's values,
 * without materializing the full row set {@link loadCSVFile} returns. Streams the
 * file in PapaParse chunks and stops (`parser.abort()`) as soon as the header
 * yields no column to sample or `sampleLimit` non-empty values of the selected
 * column have been collected -- the read path `init` uses to infer column metadata
 * from the header and the date-input format from the date-of-birth column, neither
 * of which needs every row.
 *
 * For a well-formed CSV this holds peak memory to the header plus one parse
 * chunk. Two bounds enforce that: `sampleLimit` caps the retained rows, and
 * `byteCeiling` bounds a single logical line, enforced by
 * {@link guardStreamLineByteCeiling}; see {@link CSV_LINE_BYTE_CEILING}.
 *
 * `selectColumn` is invoked with the header field list and returns the name
 * of the column to sample (the DOB column, for date-format inference) or
 * `undefined` to collect no sample. Called once the header lands -- for a
 * header longer than the source stream's read buffer, a later chunk than the
 * first -- so the returned columns are never a truncated prefix. Resolving
 * the column from the header inside the single pass, rather than the caller
 * re-opening the source, is what lets the same read serve a non-rewindable
 * stdin stream.
 *
 * The sample holds only non-empty (after-trim) values, capped at `sampleLimit`.
 * Set the cap to {@link inferDateFormat}'s own non-empty-value scan cap and the
 * sampled inference matches a full-column scan: that scan never consumes past the
 * cap either, so the first `sampleLimit` non-empty values are the exact prefix it
 * would see (the two are compared in inferDateInputFormat.test.ts).
 *
 * Parsed inline (no `worker`), like the loaders above. Resolves with the header
 * field list (empty when the file has no header), the column `selectColumn`
 * chose (`undefined` when it selected none), and the bounded sample; rejects on a
 * read/parse error, the same contract as {@link loadCSVFile}. Returning the
 * resolved column lets a caller key the sample without re-running `selectColumn`.
 */
export function loadCSVColumnSample(
  file: LocalFile,
  selectColumn: (columns: Array<string>) => string | undefined,
  sampleLimit: number,
  byteCeiling: number = CSV_LINE_BYTE_CEILING,
): Promise<{
  columns: Array<string>;
  sampledColumn: string | undefined;
  sample: Array<string>;
}> {
  return new Promise((resolve, reject) => {
    let columns: Array<string> | undefined;
    let target: string | undefined;
    const sample: Array<string> = [];

    // Bound a single logical line on the streamed read (init reads a file
    // path or stdin), using only the stream's public `on`/`destroy` surface
    // and PapaParse's public `error` contract (see
    // {@link guardStreamLineByteCeiling}). The `sampleLimit` / no-column
    // `parser.abort()` below is a separate, public-API early stop. Inert for
    // a non-stream LocalFile -- no current caller passes one.
    const source = file as StreamSource;
    const detachGuard = guardStreamLineByteCeiling(source, byteCeiling);

    Papa.parse(file, {
      // Inline, never a Web Worker -- same reasoning as loadCSVFile (the bundled
      // worker mis-applies header mode); init runs under Node, where the worker is
      // unavailable regardless.
      worker: false,
      header: true,
      skipEmptyLines: true,
      // The same header transform the shared runner applies, so the column names
      // this read hands to config authoring are the names the exchange's own read
      // of the file will key its rows by. The stripped positions are dropped: this
      // read has no operator-facing notice to compose them into.
      transformHeader: bidiStrippingHeaderTransform([]),
      chunk: (results, parser) => {
        if (target === undefined) {
          // Fix the header and the column to sample as soon as a non-empty
          // header is available -- not unconditionally on the first chunk,
          // since a header longer than the source stream's read buffer
          // arrives split across the first chunks (`meta.fields` is `[]`
          // until a later chunk completes it, as loadCSVFile also accounts
          // for). Until the header lands there are no data rows to sample
          // anyway.
          columns = results.meta.fields ?? [];
          if (columns.length === 0) return;
          target = selectColumn(columns);
          if (target === undefined) {
            // Nothing to sample: the header alone is the whole result, so stop
            // rather than stream the rest of the file for values no one reads.
            parser.abort();
            return;
          }
        }
        // `target` is non-undefined past this point, but it is an outer-scope
        // `let` read inside this callback, which TypeScript will not narrow on its
        // own; this guard does the narrowing for the row read below.
        if (target === undefined) return;
        for (const row of results.data as Array<Record<string, unknown>>) {
          const value = readRowColumn(row as CSVRow, target);
          if (typeof value === "string" && value.trim() !== "") {
            sample.push(value);
            // Enough to reproduce a full scan; stop reading the rest of the file.
            if (sample.length >= sampleLimit) {
              parser.abort();
              return;
            }
          }
        }
      },
      complete: () => {
        releaseSource(detachGuard, source);
        // chunk fires at least once for any input -- even an empty or header-only
        // file -- so columns is set unless the parse produced no chunk. Reject that
        // unreachable case rather than mask it, matching loadCSVFile's invariant.
        if (columns === undefined) {
          reject(new Error("CSV parse completed without producing a chunk"));
          return;
        }
        resolve({ columns, sampledColumn: target, sample });
      },
      error: (error) => {
        // The guard's ceiling trip surfaces here -- it destroys the source with
        // singleLineCeilingError, which PapaParse reports as a read error -- as does
        // a genuine read/stream error.
        releaseSource(detachGuard, source);
        reject(error);
      },
    });
  });
}
