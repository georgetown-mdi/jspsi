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
      // leave the promise pending; an exceptional case not expected for a <=10MB
      // parse.
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
