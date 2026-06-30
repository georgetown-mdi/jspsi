import Papa from "papaparse";

import type { LocalFile } from "papaparse";

/* function isFile(x: File | NodeJS.ReadableStream): x is File {
  return (x as File).name !== undefined;
} */

/**
 * Per-logical-line byte ceiling for the streamed CSV reads ({@link loadCSVFile}
 * and {@link loadCSVColumnSample}). PapaParse must buffer one whole logical line
 * -- a data row, or the entire header -- before it can yield a chunk, so an input
 * whose first row terminator is far from the start (one giant line with no
 * newline, one enormous field, or a multi-megabyte header) would drive the
 * accumulated partial line, and the repeated re-splitting of it,
 * linearly-to-quadratically with that span no matter how the read is otherwise
 * bounded -- loadCSVColumnSample's row cap, or nothing in loadCSVFile, which reads
 * every row. This ceiling bounds the bytes pulled from the source between row
 * terminators, so those shapes fail fast with a clear error rather than consuming
 * memory and CPU proportional to the span.
 *
 * 8 MiB sits comfortably above any realistic operator CSV's single line -- even a
 * pathologically wide file of tens of thousands of columns is a header of low
 * single-digit MiB and a data row far smaller -- and well below the
 * hundred-MiB-plus spans that drove the gigabyte-scale memory growth this guards
 * against. The input is the operator's own local file, so this is a robustness
 * backstop, not a partner- or transport-reachable bound. Its classification --
 * what the bound does not cover and why it is operator-local rather than a
 * threat-model control -- lives in `docs/spec/CHANNEL_SECURITY.md` (CSV-read
 * single-line byte ceiling).
 */
export const CSV_LINE_BYTE_CEILING = 8 * 1024 * 1024;

/**
 * The single operator-readable error every {@link CSV_LINE_BYTE_CEILING} trip
 * raises, shared so the stream guard and the non-stream pre-read below cannot
 * drift to differently-worded messages for the same condition.
 */
function singleLineCeilingError(byteCeiling: number): Error {
  return new Error(
    `CSV input exceeded the ${byteCeiling}-byte single-line limit before a ` +
      "line terminator; the file may be malformed (no newline) or carry an " +
      "oversized header or field",
  );
}

/**
 * Reject if the LEADING logical line of a materialized (non-stream) CSV exceeds
 * `byteCeiling` -- the bound {@link loadCSVFile}'s stream guard cannot enforce on a
 * source it does not stream. The web caller passes a browser `File`, which
 * PapaParse reads whole through FileReader (no `data` events to scan), so the
 * stream guard is inert there; this pre-read covers the no-newline and
 * oversized-header shapes for that path before parsing, by scanning forward from
 * the start for the first line terminator (LF or CR). Finding none within
 * `byteCeiling` bytes of a larger input means the header -- or the whole file,
 * when it carries no terminator at all -- is a single line past the ceiling, so it
 * rejects with the same {@link singleLineCeilingError} the stream path raises.
 *
 * Scoped to the leading line by design: it reads only up to the first terminator
 * (one short window for a well-formed header) and never the whole file, so a
 * normal file pays a single small read -- and skips even that when it is no larger
 * than the ceiling, which cannot then hold an over-ceiling line. A giant field
 * buried in a *later* row on this path is therefore not caught here; it stays
 * bounded by the web app's intake cap (apps/web's `MAX_CSV_FILE_BYTES`), which a
 * whole-file re-scan here would only duplicate at the cost of a second full read.
 * Inert for any input without the Blob read surface -- a Node stream (the guard
 * bounds it) or a string (parsed whole in one pass, no cross-chunk growth) returns
 * at once.
 *
 * @internal exported only so the unit tests can drive its resolve cases directly:
 * loadCSVFile cannot reach them in Node, where a File hits PapaParse's FileReader
 * path (absent there). Not re-exported from the package entry point.
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
  // A file no larger than the ceiling cannot hold a line that exceeds it, so the
  // common case reads nothing at all.
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
 * Bound a single logical line on a Node stream `source`: across its `data` events
 * it counts bytes since the last terminator (LF or CR) and, when one unterminated
 * run exceeds `byteCeiling`, destroys the source with
 * {@link singleLineCeilingError}. PapaParse, reading the same source, reports that
 * as a read error through its documented `error` callback -- so the bound rests
 * only on the stream's public `on`/`destroy` surface and PapaParse's public error
 * contract, never on its `chunk`/`cursor` behavior. Returns a detach function the
 * caller runs once the parse settles. Inert (a no-op detach) for a source without
 * `on` -- a browser File, bounded by {@link assertLeadingLineWithinByteCeiling}.
 *
 * The byte scan deliberately ignores RFC 4180 quoting, so it never wrongly rejects
 * a valid file (a newline inside a quoted field just resets the run -- the safe,
 * false-negative direction). The cost is one shape this ceiling does NOT bound: a
 * single quoted field carrying embedded newlines, which PapaParse buffers whole as
 * one logical row while the run keeps resetting, so its memory and (quadratic)
 * re-split CPU scale with the field, not the ceiling. That shape stays bounded only
 * by the input being operator-local -- the CLI sets no size cap -- or, on the web,
 * by MAX_CSV_FILE_BYTES; it is not a regression, the read was unbounded for it
 * before this ceiling too. Byte-wise is safe for UTF-8 (0x0a/0x0d are below 0x80,
 * so neither occurs as a continuation byte of a multi-byte character).
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
 * Parse a CSV file to its COMPLETE row set. Resolves a {@link Papa.ParseResult}
 * whose `data` and `errors` are accumulated across every PapaParse chunk, so a
 * file larger than one `Papa.LocalChunkSize` chunk is returned whole rather than
 * truncated to its final chunk (see the accumulation note in the body). Rejects
 * on a read/stream error.
 *
 * `byteCeiling` bounds a single logical line -- the partial line PapaParse must
 * buffer whole before it yields a chunk -- so a no-newline file, an oversized
 * header, or one enormous field fails fast with a clear, operator-readable error
 * rather than driving memory and CPU with that span; see
 * {@link CSV_LINE_BYTE_CEILING}. Unlike loadCSVColumnSample (whose row cap also
 * removes real waste), this read genuinely consumes every row of the operator's
 * own file (invite/accept/exchange), so the ceiling is a robustness backstop on a
 * single pathological line, not a memory saving for well-formed input -- a normal
 * file reads exactly as it did before.
 *
 * Two complementary mechanisms enforce it across the inputs this read serves, both
 * on public API only. For the Node stream every CLI caller passes,
 * {@link guardStreamLineByteCeiling} scans the source's own `data` events and
 * destroys it past the ceiling, which PapaParse surfaces through its `error`
 * callback -- bounding every line (header or any data row). For the browser `File`
 * the web caller passes -- which PapaParse reads whole through FileReader, with no
 * `data` events to scan -- a bounded pre-read
 * ({@link assertLeadingLineWithinByteCeiling}) instead rejects an oversized LEADING
 * line (the header, or a no-newline file) before parsing; a giant field in a LATER
 * row on that path stays bounded by the web app's intake cap (apps/web's
 * `MAX_CSV_FILE_BYTES`) rather than scanned for here. See that helper for why the
 * web path is bounded only at its leading line, not every row.
 *
 * Caveat on `meta`: only `meta.fields` (the header) is whole-file-stable. The
 * rest of `meta` (`cursor`, `truncated`, `aborted`, ...) is the FINAL chunk's --
 * it is captured per chunk and only `fields` persists across chunks -- so a
 * consumer must not read whole-file position or truncation state off it. Every
 * current consumer reads only `data` and `meta.fields`.
 */
export async function loadCSVFile(
  file: LocalFile,
  byteCeiling: number = CSV_LINE_BYTE_CEILING,
): Promise<Papa.ParseResult<unknown>> {
  // Bound the non-stream (browser File) path's leading line before parsing: a File
  // exposes no `data` events for the stream guard below to scan, since PapaParse
  // reads it whole through FileReader. A Node stream or string is a no-op here.
  await assertLeadingLineWithinByteCeiling(file, byteCeiling);
  return new Promise((resolve, reject) => {
    // Accumulate every chunk's rows on THIS thread. PapaParse splits a file into
    // `Papa.LocalChunkSize` chunks, and neither mode's `complete` argument is the
    // whole file: worker mode posts each chunk back separately and hands
    // `complete` only the FINAL chunk (it accumulates across chunks solely inside
    // the worker, where `complete` is a boolean and never fires), and the inline
    // path hands `complete` `undefined` once a `chunk` callback is present. The
    // per-chunk `chunk` callback -- which fires on this thread in BOTH modes -- is
    // the only place every row is seen, so collect there and resolve the union. A
    // missing `chunk` callback is exactly the silent multi-chunk truncation this
    // accumulation removes (the older single-chunk-only contract); a >1-chunk file
    // therefore parses whole rather than to a truncated subset with no error.
    const data: Array<unknown> = [];
    const errors: Array<Papa.ParseError> = [];
    let meta: Papa.ParseMeta | undefined;

    // Bound a single logical line on the Node stream path (the CLI's file/stdin
    // input): the guard scans the source's own `data` events and destroys it past
    // the ceiling, which PapaParse -- reading the same source -- reports through the
    // `error` callback below. Inert for a non-stream LocalFile (a browser File has
    // no `data` events); that path is bounded by the pre-read above instead.
    const source = file as StreamSource;
    const detachGuard = guardStreamLineByteCeiling(source, byteCeiling);

    Papa.parse(file, {
      // Parse INLINE, never in a Web Worker. PapaParse's `worker: true` spawns its
      // worker from its own bundled source by reading the running script's URL -- a
      // self-location trick that survives a dev server (the module is a real,
      // URL-addressable file) but breaks once Vite bundles and minifies PapaParse
      // into a chunk: the spawned worker runs a broken bootstrap that mis-applies
      // `header: true`, so the header row AND the first data row both land in
      // `meta.fields` while `data` comes back empty. The malformed header then
      // crashes the first consumer that treats a field as a string (inferMetadata's
      // `name.toLowerCase()`), so the production web inviter could not generate an
      // invitation of any kind. Dev and the real-Chromium browser tests pass because
      // the worker resolves there -- the failure is specific to the bundled build, so
      // no unit/browser test catches it; the header guard in `complete` below is the
      // executable backstop. Inline parsing blocks the main thread for the parse,
      // acceptable for the once-per-exchange invite/accept file; an off-main-thread
      // parse, if ever wanted for very large files, must go through a Vite-native
      // worker in the web app, not PapaParse's self-hosted one. Under Node (the CLI)
      // PapaParse never honored the worker anyway (`WORKERS_SUPPORTED` is
      // `!!global.Worker`, false there), so this changes only the web build.
      worker: false,
      header: true,
      skipEmptyLines: true,
      chunk: (results) => {
        // Spread-push would pass one argument per row and can overflow the call
        // stack for a chunk holding hundreds of thousands of short rows, so append
        // in a loop (O(n) total, stack-safe).
        for (const row of results.data) data.push(row);
        for (const error of results.errors) errors.push(error);
        // Every chunk's meta carries the header field list (the parser's fields
        // persist across chunks), so keep the latest for `complete`, whose own
        // argument is only the final chunk (worker) or undefined (inline).
        meta = results.meta;
      },
      complete: () => {
        // Detach the guard and release the source. PapaParse's parser teardown does
        // not close the underlying stream, so an fs.createReadStream descriptor
        // would otherwise linger until GC; destroy is a no-op once a natural EOF has
        // closed it, and skipped for a non-stream LocalFile (no `destroy`).
        detachGuard();
        source.destroy?.();
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
        // parse itself malfunctioned (the bundled-worker corruption the `worker:
        // false` note above describes leaks a data row -- an array -- into
        // `meta.fields`). Reject loudly here rather than letting the malformed header
        // flow into inferMetadata and surface as a deep, opaque `toLowerCase` crash.
        if (meta.fields?.some((field) => typeof field !== "string")) {
          reject(
            new Error(
              "CSV header parsed to a non-string column; the file could not be " +
                "read correctly",
            ),
          );
          return;
        }
        resolve({ data, errors, meta });
      },
      error: (error) => {
        // The guard's ceiling trip surfaces here -- it destroys the source with
        // singleLineCeilingError, which PapaParse reports as a read error -- as does
        // a genuine read/stream error. Same release as complete.
        detachGuard();
        source.destroy?.();
        reject(error);
      },
    });
  });
}

/**
 * Read only the column header names from a CSV, without parsing its rows. The
 * Advanced-options editor (apps/web) is column-aware -- it seeds metadata-aware
 * defaults and populates field pickers from the header alone -- and needs those
 * names before the inviter commits to generating, where parsing the whole file
 * (which `loadCSVFile` does, and which `generateInvitation` still does at mint
 * time) would be wasted work held in memory through the edit session.
 *
 * `preview: 1` caps the parse at one data row, so PapaParse reads only enough of
 * the file to yield the header and that first row and then stops, rather than
 * reading the whole file (the header is in `meta.fields` regardless of how many
 * data rows are parsed). Parsed inline (no `worker`): the read is tiny, so the
 * worker's setup cost buys nothing for a one-row preview.
 * Resolves with the header field list (empty when the file has no header row);
 * rejects on a read/parse error, the same failure contract as {@link loadCSVFile}.
 */
export function loadCSVColumns(file: LocalFile): Promise<Array<string>> {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      preview: 1,
      skipEmptyLines: true,
      complete: (results, _file) => {
        resolve(results.meta.fields ?? []);
      },
      error: (error, _file) => {
        reject(error);
      },
    });
  });
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
 * For a well-formed CSV this holds peak memory to the header plus one parse chunk
 * rather than the whole input. Two bounds enforce that: `sampleLimit` caps the
 * retained rows, and `byteCeiling` bounds a single logical line. Without the line
 * bound an input whose first terminator is far from the start -- one giant line
 * with no newline, one enormous field, or a multi-megabyte header -- would drive
 * memory (and CPU, via repeated re-splitting of that partial line) with the span,
 * since PapaParse must buffer one whole logical line before it can yield a chunk.
 * The line bound is enforced by {@link guardStreamLineByteCeiling} on the source's
 * own `data` events (it destroys the stream past the ceiling, surfaced through
 * PapaParse's `error` callback), so those shapes reject fast with a clear error;
 * see {@link CSV_LINE_BYTE_CEILING}.
 *
 * `selectColumn` is invoked with the header field list and returns the name of
 * the column to sample (the DOB column, for date-format inference) or `undefined`
 * to collect no sample. It is called once the header lands -- which, for a header
 * longer than the source stream's read buffer, is a later chunk than the first
 * (the same whole-header read `loadCSVFile` performs), so the returned columns are
 * never the truncated prefix a first-chunk-only read would yield. Resolving the
 * column from the header inside the single pass -- rather than the caller
 * re-opening the source -- is what lets the same read serve a non-rewindable
 * stdin stream.
 *
 * The sample holds only non-empty (after-trim) values, capped at `sampleLimit`.
 * Set the cap to {@link inferDateFormat}'s own non-empty-value scan cap and the
 * sampled inference is identical to a full-column scan by construction: that scan
 * never consumes past the cap either, so the first `sampleLimit` non-empty values
 * are the exact prefix it would see.
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

    // Bound a single logical line on the streamed read (init reads a file path or
    // stdin): the guard scans the source's own `data` events and destroys it past
    // the ceiling, which PapaParse -- reading the same source -- reports through the
    // `error` callback below. This bounds the no-terminator / giant-field /
    // giant-header span using only the stream's public `on`/`destroy` and
    // PapaParse's public `error` contract, not its `chunk`/`cursor` internals. The
    // `sampleLimit` / no-column `parser.abort()` below is a separate, public-API
    // early stop. Inert for a non-stream LocalFile (a browser File has no `data`
    // events) -- no current caller passes one.
    const source = file as StreamSource;
    const detachGuard = guardStreamLineByteCeiling(source, byteCeiling);

    Papa.parse(file, {
      // Inline, never a Web Worker -- same reasoning as loadCSVFile (the bundled
      // worker mis-applies header mode); init runs under Node, where the worker is
      // unavailable regardless.
      worker: false,
      header: true,
      skipEmptyLines: true,
      chunk: (results, parser) => {
        if (target === undefined) {
          // Settle the header and the column to sample as soon as a non-empty
          // header is available -- not unconditionally on the first chunk. A
          // header longer than the source stream's read buffer arrives split
          // across the first chunks, so `meta.fields` is `[]` until a later chunk
          // completes the header row (loadCSVFile likewise reads the latest
          // fields, not the first chunk's). Keep the latest and wait: until the
          // header lands there are no data rows to sample anyway.
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
        // own; this guard does the narrowing for the indexing below.
        if (target === undefined) return;
        for (const row of results.data as Array<Record<string, string>>) {
          const value = row[target];
          if (value !== undefined && value.trim() !== "") {
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
        // An early `parser.abort()` (sample cap reached, or no column to sample)
        // tears down PapaParse's parser but not the underlying source, so a Node
        // stream's listeners and an fs.createReadStream's descriptor would linger
        // until GC -- the opposite of the bounded read's intent. Detach the guard
        // and release the source; destroy is a no-op once a natural EOF has closed
        // it, and skipped for a non-stream LocalFile (no `destroy`).
        detachGuard();
        source.destroy?.();
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
        // a genuine read/stream error. Same release as complete.
        detachGuard();
        source.destroy?.();
        reject(error);
      },
    });
  });
}
