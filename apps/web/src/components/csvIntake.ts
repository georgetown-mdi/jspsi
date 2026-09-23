/**
 * Maximum size, in bytes, of a file the console intake dropzones accept -- 200 MiB.
 *
 * This is a browser-memory bound, not a parser bound: core's `loadCSVFile`
 * accumulates across PapaParse chunks, so the cap is set against what a browser
 * tab can read, parse, and hold for the exchange. The dominant cost is the parsed
 * row array, retained for the whole exchange: measured through this path in
 * headless Chromium, a 200 MiB file peaks at 2.0 to 3.3 GB resident in the
 * renderer depending on row shape, the many-short-cells shape costing most. What
 * sets the value is the 256 MiB WebRTC frame envelope: the narrowest measured row
 * shape reaches it near 245 MiB. Every bound derived from this one moves with it
 * -- the WebRTC per-string cap, the parked-result bound, the job-intent input
 * length and the job body cap. The measurements, the row shapes they bracket,
 * that chain, and why this intake budget is distinct from the comparison-step
 * memory: `docs/spec/PROTOCOL.md`.
 *
 * No-silent-truncation is the invariant that matters here, and it is
 * pinned directly by a multi-chunk correctness test
 * (`test/browser/loadCSVFile.test.ts`), not by holding the cap below the chunk
 * size. Each intake dropzone passes this constant through as `maxSize` rather
 * than a stale literal.
 */
export const MAX_CSV_FILE_BYTES = 200 * 1024 ** 2;

/**
 * A titled operator-facing alert -- a read failure, an unlinkable/unnameable
 * file, or a coverage advisory. The intake surfaces set this shape into their
 * error/warning state and render it through a shared alert slot; the helpers that
 * compose the messages ({@link unlinkableFileAlert}, {@link unnameableColumnsAlert})
 * return it. A structural `{ title, message }` with no component or role
 * coupling, so leaf helpers can depend on it without pulling in the component
 * layer.
 */
export interface AlertContent {
  title: string;
  message: string;
}
