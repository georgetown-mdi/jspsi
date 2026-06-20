/**
 * Maximum size, in bytes, of a file the intake dropzone ({@link FileSelect})
 * accepts -- 10 MB.
 *
 * Capped at or below PapaParse's `LocalChunkSize` deliberately. Core's
 * `loadCSVFile` parses in worker mode (`worker: true`), and worker mode hands the
 * completion callback only the FINAL chunk's rows: it accumulates across chunks
 * solely inside the worker, where the completion callback is a boolean and never
 * runs. A file spanning more than one chunk would therefore parse to a silently
 * truncated result -- wrong rows, no error -- which in a record-linkage tool
 * means a wrong intersection with no signal. Holding the cap within a single
 * chunk guarantees every accepted file parses whole.
 *
 * The two constants are set independently (this one here, `LocalChunkSize` in a
 * transitive dependency), so the relationship is enforced by an executable check
 * on the value the dropzone actually receives (`test/browser/fileSelect.test.ts`),
 * not trusted to this note.
 */
export const MAX_CSV_FILE_BYTES = 10 * 1024 ** 2;
