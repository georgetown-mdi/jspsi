import Papa from 'papaparse';

import type { LocalFile } from 'papaparse';

/* function isFile(x: File | NodeJS.ReadableStream): x is File {
  return (x as File).name !== undefined;
} */
export function loadCSVFile(file: LocalFile): Promise<Papa.ParseResult<unknown>> {
  return new Promise((resolve, reject) => {
    Papa.parse(
      file,
      {
        header: true,
        complete: (results, _file) => {
          resolve(results);
        },
        error: (error, _file) => {
          reject(error);
        }
      }
    );
  });
}

