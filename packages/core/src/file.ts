import Papa from "papaparse";

import type { LocalFile } from "papaparse";

/* function isFile(x: File | NodeJS.ReadableStream): x is File {
  return (x as File).name !== undefined;
} */

export function loadCSVFile(
  file: LocalFile,
): Promise<Papa.ParseResult<unknown>> {
  return new Promise((resolve, reject) => {
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
      // leave the promise pending; an exceptional case not expected for a single-
      // chunk parse.
      //
      // Precondition: worker mode resolves with only the FINAL chunk's rows (it
      // accumulates across chunks only inside the worker, where `complete` never
      // fires), so a caller MUST keep the input within one `Papa.LocalChunkSize`
      // chunk or the result is silently truncated. Today's callers (the web
      // intake dropzone) enforce this with a byte cap; the bound is checked in
      // apps/web (`test/browser/fileSelect.test.ts`).
      worker: true,
      header: true,
      skipEmptyLines: true,
      complete: (results, _file) => {
        resolve(results);
      },
      error: (error, _file) => {
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
