/**
 * The two mounted CSVs whose header leaves a column unnamed, and the profiles
 * the console server's own parse returns for them.
 *
 * The console seats never read a file in the browser, so a browser test of their
 * unnamed-column refusal has to stub the profile body the server would return --
 * and a stub the server could not produce tests nothing. The seat tests stub
 * these fields, and `test/unit/psi/columnNameSanitation.test.ts` drives the real
 * `profileJobInput` over each CSV and asserts it returns exactly them, so an
 * invented body fails there.
 */

/** The parts of a profile these fixtures fix; the rest (name, size, mtime) is
 * the mounted file's own and varies per run. */
interface UnnamedColumnProfile {
  columns: Array<string>;
  bidiStrippedColumns: Array<number>;
  columnSamples: Array<{ column: string; values: Array<string> }>;
}

/**
 * A header whose middle column is nothing but text-direction characters --
 * U+202E (right-to-left override) then U+2069 (pop directional isolate), written
 * as escapes so a fixture about invisible characters is itself readable. The
 * strip leaves that column no name.
 */
export const CONTROLS_ONLY_HEADER_CSV =
  "id,\u202e\u2069,city\n1,x,Springfield\n2,y,Shelbyville\n";

/** The profile of {@link CONTROLS_ONLY_HEADER_CSV}: the emptied column keeps its
 * values under the empty name the strip left, and the position that emptied it
 * is reported, so the seat states the removal as the cause of the refusal. */
export const CONTROLS_ONLY_HEADER_PROFILE: UnnamedColumnProfile = {
  columns: ["id", "", "city"],
  bidiStrippedColumns: [2],
  columnSamples: [
    { column: "id", values: ["1", "2"] },
    { column: "", values: ["x", "y"] },
    { column: "city", values: ["Springfield", "Shelbyville"] },
  ],
};

/** A header with a blank cell, the other way a column arrives unnamed. */
export const BLANK_HEADER_CELL_CSV =
  "client_id,,dob\n1,x,01/02/1990\n2,y,03/04/1985\n";

/** The profile of {@link BLANK_HEADER_CELL_CSV}: an unnamed column with no
 * stripped position, which is the trailing-comma cause the seat states. */
export const BLANK_HEADER_CELL_PROFILE: UnnamedColumnProfile = {
  columns: ["client_id", "", "dob"],
  bidiStrippedColumns: [],
  columnSamples: [
    { column: "client_id", values: ["1", "2"] },
    { column: "", values: ["x", "y"] },
    { column: "dob", values: ["01/02/1990", "03/04/1985"] },
  ],
};
