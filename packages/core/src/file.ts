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
 * Read a CSV's column header plus a bounded sample of one column's values,
 * without materializing the full row set {@link loadCSVFile} returns. Streams the
 * file in PapaParse chunks and stops (`parser.abort()`) as soon as the header
 * yields no column to sample or `sampleLimit` non-empty values of the selected
 * column have been collected, so peak memory is bounded by one parse chunk rather
 * than the input size -- the read path `init` uses to infer column metadata from
 * the header and the date-input format from the date-of-birth column, neither of
 * which needs every row.
 *
 * `selectColumn` is invoked once with the header field list and returns the name
 * of the column to sample (the DOB column, for date-format inference) or
 * `undefined` to collect no sample. Resolving the column from the header inside
 * the single pass -- rather than the caller re-opening the source -- is what lets
 * the same read serve a non-rewindable stdin stream.
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
): Promise<{
  columns: Array<string>;
  sampledColumn: string | undefined;
  sample: Array<string>;
}> {
  return new Promise((resolve, reject) => {
    let columns: Array<string> | undefined;
    let target: string | undefined;
    const sample: Array<string> = [];
    Papa.parse(file, {
      // Inline, never a Web Worker -- same reasoning as loadCSVFile (the bundled
      // worker mis-applies header mode); init runs under Node, where the worker is
      // unavailable regardless.
      worker: false,
      header: true,
      skipEmptyLines: true,
      chunk: (results, parser) => {
        if (columns === undefined) {
          // The header field list persists across chunks, so the first chunk
          // settles both the returned columns and which column (if any) to sample.
          columns = results.meta.fields ?? [];
          target = selectColumn(columns);
          if (target === undefined) {
            // Nothing to sample: the header alone is the whole result, so stop
            // rather than stream the rest of the file for values no one reads.
            parser.abort();
            return;
          }
        }
        // Once a column is selected it stays set for every later chunk, and the
        // no-column case already aborted, so this never returns at runtime -- its
        // job is to narrow `target` to a string for the indexing below.
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
        // opposite of the bounded read's intent. Release it explicitly; a no-op
        // once a natural end-of-input has already closed it, and skipped for a
        // non-stream LocalFile (a browser File/string has no `destroy`).
        const source = file as { destroy?: () => void };
        if (typeof source.destroy === "function") source.destroy();
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
        reject(error);
      },
    });
  });
}
