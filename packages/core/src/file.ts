import Papa from "papaparse";

import type { LocalFile } from "papaparse";

/* function isFile(x: File | NodeJS.ReadableStream): x is File {
  return (x as File).name !== undefined;
} */

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
      // Parse in a Web Worker so a multi-MB browser File does not block the main
      // thread (no input, no paint) for the duration of the parse. PapaParse only
      // honors this where it can spawn one -- internally gated on
      // `WORKERS_SUPPORTED` (`!!global.Worker`), which is false under Node -- so
      // the CLI's readable-stream inputs and the Node-environment tests keep
      // parsing inline exactly as before. The complete/error callback contract is
      // identical in both modes: a read/parse failure (including a FileReader
      // error inside the worker) posts back through `error` and rejects, and a
      // worker that fails to spawn throws synchronously inside this executor,
      // which also rejects. The one unhandled path is an uncaught exception in the
      // worker thread -- PapaParse attaches no `Worker.onerror` -- which would
      // leave the promise pending; an exceptional case not expected here. Worker
      // mode also keeps only ~one chunk of parsed rows alive at a time (the full
      // accumulated set lives only on this thread), so the worker's footprint does
      // not grow with the file.
      worker: true,
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
 * worker's setup cost and its final-chunk-only contract buy nothing here.
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
