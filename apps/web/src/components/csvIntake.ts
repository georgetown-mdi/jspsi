/**
 * Maximum size, in bytes, of a file the intake dropzone ({@link FileSelect})
 * accepts -- 100 MB.
 *
 * This is a browser-memory bound, not a parser bound. Core's `loadCSVFile` now
 * accumulates across PapaParse chunks (it no longer truncates a file that spans
 * more than one `LocalChunkSize` chunk), so the cap is free of the former
 * single-chunk constraint and is set instead against what a browser tab can read,
 * parse, hash, and hold as a PSI payload without exhausting memory: 100 MB is
 * roughly one to two million identifier rows, comfortably inside the
 * tens-of-millions-of-rows / 1-2 GB browser envelope `docs/spec/PROTOCOL.md`
 * documents, while well above the prior 10 MB. The value is tunable against that
 * memory budget; the rationale lives in `docs/spec/PROTOCOL.md`.
 *
 * No-silent-truncation is the invariant that actually matters here, and it is
 * pinned directly by a multi-chunk correctness test in worker mode
 * (`test/browser/loadCSVFile.test.ts`), not by holding the cap below the chunk
 * size. The dropzone-wiring guard (`test/browser/fileSelect.test.ts`) separately
 * checks that {@link FileSelect} passes this constant through as `maxSize` rather
 * than a stale literal.
 */
export const MAX_CSV_FILE_BYTES = 100 * 1024 ** 2;
