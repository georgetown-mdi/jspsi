import { describe, expect, test } from "vitest";

import { DISPLAY_TRUNCATION_MARKER, MAX_NAME_LENGTH } from "@psilink/core";

import { isolatedColumnName } from "@components/ColumnName";

// Written as escapes, not raw bytes, so the source of a test about invisible
// characters stays readable; the isolate has to hold the override character
// verbatim.
const FSI = "\u2068";
const PDI = "\u2069";
const RLO = "\u202e";

describe("isolatedColumnName", () => {
  test("wraps the operator's header in the isolate and alters nothing in it", () => {
    // The override survives verbatim: this is the operator's own file's header, so
    // it is contained rather than escaped.
    const name = `notes${RLO}evil`;
    expect(isolatedColumnName(name)).toBe(`${FSI}${name}${PDI}`);
  });

  test("a name at core's own ceiling renders whole", () => {
    // The cut sits where a name stops being one an exchange would transmit -- the
    // partner's parse of the payload frame refuses a longer name, as does
    // ColumnMetadata.name wherever metadata is parsed rather than inferred -- so it
    // can never elide a name that transmits, which is what keeps two accepted
    // headers sharing a long prefix distinct in the grid.
    const name = "\u0444".repeat(MAX_NAME_LENGTH);
    expect(isolatedColumnName(name)).toBe(`${FSI}${name}${PDI}`);
  });

  test("a name past the ceiling is cut and marked, inside the isolate", () => {
    // Nothing bounds a CSV header at intake and isolation escapes nothing, so
    // without the cut an arbitrarily long header paints whole over the screen
    // holding the launch gate.
    const name = "a".repeat(MAX_NAME_LENGTH + 50);
    expect(isolatedColumnName(name)).toBe(
      `${FSI}${"a".repeat(MAX_NAME_LENGTH)}${DISPLAY_TRUNCATION_MARKER}${PDI}`,
    );
  });

  test("the cut counts code points, so it never splits a surrogate pair", () => {
    // A UTF-16 slice at this index would end on a lone surrogate, which paints as a
    // replacement character rather than as the operator's own header.
    const name = "\u{1F600}".repeat(MAX_NAME_LENGTH + 10);
    expect(isolatedColumnName(name)).toBe(
      `${FSI}${"\u{1F600}".repeat(MAX_NAME_LENGTH)}${DISPLAY_TRUNCATION_MARKER}${PDI}`,
    );
  });
});
