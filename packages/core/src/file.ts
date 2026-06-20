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
      // identical in both modes, and a worker that fails to spawn throws
      // synchronously inside this executor, which rejects the promise -- so a
      // parse failure still surfaces to the caller on every path.
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
