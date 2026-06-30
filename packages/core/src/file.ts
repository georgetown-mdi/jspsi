import Papa from "papaparse";

import type { LocalFile } from "papaparse";

/* function isFile(x: File | NodeJS.ReadableStream): x is File {
  return (x as File).name !== undefined;
} */

/**
 * Parse a CSV file to its COMPLETE row set. Resolves a {@link Papa.ParseResult}
 * whose `data` and `errors` are accumulated across every PapaParse chunk, so a
 * file larger than one `Papa.LocalChunkSize` chunk is returned whole rather than
 * truncated to its final chunk (see the accumulation note in the body). Rejects
 * on a read/stream error.
 *
 * Caveat on `meta`: only `meta.fields` (the header) is whole-file-stable. The
 * rest of `meta` (`cursor`, `truncated`, `aborted`, ...) is the FINAL chunk's --
 * it is captured per chunk and only `fields` persists across chunks -- so a
 * consumer must not read whole-file position or truncation state off it. Every
 * current consumer reads only `data` and `meta.fields`.
 */
export function loadCSVFile(
  file: LocalFile,
): Promise<Papa.ParseResult<unknown>> {
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
 * Per-logical-line byte ceiling for {@link loadCSVColumnSample}'s streamed read.
 * Its row cap bounds the number of retained rows, but PapaParse must buffer one
 * whole logical line -- a data row, or the entire header -- before it can yield a
 * chunk and the read can stop, so an input whose first row terminator is far from
 * the start (one giant line with no newline, one enormous field, or a
 * multi-megabyte header) would drive the accumulated partial line, and the
 * repeated re-splitting of it, linearly-to-quadratically with that span no matter
 * the row cap. This ceiling bounds the bytes pulled from the source between row
 * terminators, so those shapes fail fast with a clear error rather than consuming
 * memory and CPU proportional to the span.
 *
 * 8 MiB sits comfortably above any realistic operator CSV's single line -- even a
 * pathologically wide file of tens of thousands of columns is a header of low
 * single-digit MiB and a data row far smaller -- and well below the
 * hundred-MiB-plus spans that drove the gigabyte-scale memory growth this guards
 * against. The input is the operator's own local file, so this is a robustness
 * backstop on the bounded read's own guarantee, not a partner- or
 * transport-reachable bound.
 */
export const CSV_LINE_BYTE_CEILING = 8 * 1024 * 1024;

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
 * retained rows, and `byteCeiling` caps the bytes pulled from the source between
 * row terminators -- the accumulated partial line PapaParse must buffer whole
 * before it yields a chunk. Because PapaParse buffers one logical line (a data
 * row, or the entire header) before its first chunk, without the byte ceiling an
 * input whose first terminator is far from the start -- one giant line with no
 * newline, one enormous field, or a multi-megabyte header -- would still drive
 * memory (and CPU, via repeated re-splitting of that partial line) with the span.
 * The ceiling makes those shapes reject fast with a clear error instead; see
 * {@link CSV_LINE_BYTE_CEILING}.
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

    // Bound the span between row terminators (the accumulated partial line), not
    // just the retained rows. `bytesPulled` counts every byte the source emits;
    // `spanStart` is reset to it each time the parse cursor advances past a
    // completed line (the header, or a data row), so `bytesPulled - spanStart` is
    // the bytes pulled since the last terminator -- the partial line PapaParse is
    // still buffering. A well-formed input terminates each line well under the
    // ceiling and never trips; a no-terminator / giant-field / giant-header input
    // keeps the cursor pinned while bytes pile up, so the span crosses the ceiling
    // and the read fails fast. The source streams in chunks (fs.createReadStream
    // and stdin deliver <=64 KiB reads), so the cursor advances chunk by chunk and
    // the span tracks the partial line to within one chunk.
    let bytesPulled = 0;
    let spanStart = 0;
    let lastCursor = 0;
    let ceilingError: Error | undefined;

    // Count bytes off the source's raw `data` events, BEFORE PapaParse buffers
    // them: the unterminated partial line is invisible to the chunk callback,
    // which sees only parsed rows, never the remainder. Registered before
    // Papa.parse so it precedes PapaParse's own `data` listener and `bytesPulled`
    // is current when the chunk callback reads it -- the source is a Node stream
    // for every caller (init reads a file path or stdin). A non-stream LocalFile
    // (a browser File/string, no current caller) has no `on`, so the ceiling is
    // inert there: such a source is already materialized whole, with no streamed
    // accumulation to bound.
    const source = file as {
      on?: (event: "data", listener: (chunk: Buffer | string) => void) => void;
      removeListener?: (
        event: "data",
        listener: (chunk: Buffer | string) => void,
      ) => void;
      destroy?: () => void;
    };
    const isStream = typeof source.on === "function";
    const countBytes = (chunk: Buffer | string): void => {
      bytesPulled +=
        typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    };
    if (isStream) source.on?.("data", countBytes);

    Papa.parse(file, {
      // Inline, never a Web Worker -- same reasoning as loadCSVFile (the bundled
      // worker mis-applies header mode); init runs under Node, where the worker is
      // unavailable regardless.
      worker: false,
      header: true,
      skipEmptyLines: true,
      chunk: (results, parser) => {
        // Reset the span baseline whenever the cursor advances past a completed
        // line, then check the bytes pulled since: an over-ceiling span is a line
        // or header with no terminator in range. Checked before the header logic
        // below, which returns early until the header lands -- the exact window a
        // no-terminator input would otherwise spin in, accumulating unbounded.
        if (results.meta.cursor > lastCursor) {
          lastCursor = results.meta.cursor;
          spanStart = bytesPulled;
        }
        if (bytesPulled - spanStart > byteCeiling) {
          ceilingError = new Error(
            `CSV input exceeded the ${byteCeiling}-byte single-line limit ` +
              "before a line terminator; the file may be malformed (no newline) " +
              "or carry an oversized header or field",
          );
          parser.abort();
          return;
        }
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
        // An early `parser.abort()` tears down PapaParse's parser but not the
        // underlying source, so a Node stream's listeners (and an
        // fs.createReadStream's file descriptor) would linger until GC -- the
        // opposite of the bounded read's intent. Detach the byte counter and
        // release the source explicitly; destroy is a no-op once a natural
        // end-of-input has already closed it, and skipped for a non-stream
        // LocalFile (a browser File/string has no `destroy`).
        if (isStream) source.removeListener?.("data", countBytes);
        if (typeof source.destroy === "function") source.destroy();
        // The byte ceiling tripped: reject before the no-chunk invariant below,
        // since a no-terminator input aborts before any header lands (leaving
        // columns unset), and its operator-readable cause must win over the
        // generic message.
        if (ceilingError) {
          reject(ceilingError);
          return;
        }
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
        if (isStream) source.removeListener?.("data", countBytes);
        reject(error);
      },
    });
  });
}
