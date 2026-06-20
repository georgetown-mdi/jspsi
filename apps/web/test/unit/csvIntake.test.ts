import { describe, expect, test } from "vitest";

import Papa from "papaparse";

import { MAX_CSV_FILE_BYTES } from "@components/csvIntake";

// Core's loadCSVFile parses dropped files in PapaParse worker mode
// (`worker: true`). Worker mode delivers only the FINAL chunk's rows to the
// completion callback -- it accumulates across chunks solely inside the worker,
// where `complete` is a boolean and never fires -- so a file larger than one
// `Papa.LocalChunkSize` chunk would resolve to a silently truncated parse: wrong
// rows, no error, a wrong intersection. The single thing keeping every accepted
// file to one chunk is the intake dropzone cap (MAX_CSV_FILE_BYTES) sitting at or
// below that chunk size. The two constants are set independently -- one in
// csvIntake.ts, one in a transitive dependency -- so a cap raised past the chunk
// size, or a PapaParse bump that lowers the chunk size, would reopen the
// truncation with no failing test. This is the executable form of that bound, so
// such a drift fails here instead of shipping silent data loss.
describe("CSV intake size bound", () => {
  test("dropzone cap does not exceed PapaParse's local chunk size", () => {
    expect(MAX_CSV_FILE_BYTES).toBeLessThanOrEqual(Papa.LocalChunkSize);
  });
});
