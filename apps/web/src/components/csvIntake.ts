/**
 * Maximum size, in bytes, of a file the intake dropzone ({@link FileSelect})
 * accepts -- 100 MB.
 *
 * This is a browser-memory bound, not a parser bound. Core's `loadCSVFile` now
 * accumulates across PapaParse chunks (it no longer truncates a file that spans
 * more than one `LocalChunkSize` chunk), so the cap is free of the former
 * single-chunk constraint and is set instead against what a browser tab can read,
 * parse, and hold for the exchange. The dominant cost is the parsed row array,
 * retained for the whole exchange, so 100 MB (roughly one to two million
 * identifier rows) resolves to a few hundred MB resident -- a profile sized for
 * the modern-workstation execution target, well above the prior 10 MB, and
 * tunable upward as that profile is measured. The rationale, and why this intake
 * budget is distinct from the comparison-step memory, lives in
 * `docs/spec/PROTOCOL.md`.
 *
 * No-silent-truncation is the invariant that actually matters here, and it is
 * pinned directly by a multi-chunk correctness test in worker mode
 * (`test/browser/loadCSVFile.test.ts`), not by holding the cap below the chunk
 * size. The dropzone-wiring guard (`test/browser/fileSelect.test.ts`) separately
 * checks that {@link FileSelect} passes this constant through as `maxSize` rather
 * than a stale literal.
 */
export const MAX_CSV_FILE_BYTES = 100 * 1024 ** 2;
