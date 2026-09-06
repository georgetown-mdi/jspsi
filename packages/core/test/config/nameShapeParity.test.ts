import { expect, test } from "vitest";

import {
  NAME_SHAPE_PATTERN,
  TEXT_CONTROL_CHAR_PATTERN,
} from "../../src/config/linkageTermsSchema";
import {
  BIDI_CONTROL_PATTERN,
  stripBidiControls,
} from "../../src/utils/bidiControls";

// NAME_SHAPE_PATTERN is one anchored literal rather than a composition of the
// two patterns it is the union of, so that union is measured here rather than
// read off the source. Both sweeps run every BMP code point, which is what makes
// them fail on a range added to one class and not the other, wherever it is
// added -- the alternative, a list of interesting characters, only ever pins the
// characters somebody thought of.

// The surrogate range is left out: a lone surrogate is not a character a name
// holds, and the well-formedness walk (loneSurrogateIndex) refuses one on its
// own terms, whatever any of these three patterns says about it.
function* bmpCharacters(): Generator<{ codePoint: number; character: string }> {
  for (let codePoint = 0; codePoint <= 0xffff; codePoint += 1) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    yield { codePoint, character: String.fromCodePoint(codePoint) };
  }
}

const label = (codePoint: number) =>
  `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;

test("the name shape refuses exactly the free-text control class and the bidi class", () => {
  const disagreements: Array<string> = [];
  for (const { codePoint, character } of bmpCharacters()) {
    const refusedElsewhere =
      TEXT_CONTROL_CHAR_PATTERN.test(character) ||
      BIDI_CONTROL_PATTERN.test(character);
    const admittedInAName = NAME_SHAPE_PATTERN.test(`a${character}b`);
    if (admittedInAName === refusedElsewhere)
      disagreements.push(label(codePoint));
  }
  expect(disagreements).toEqual([]);
});

test("no character the CSV read strips from a header is one a name may hold", () => {
  // The alignment between the two boundaries: a column name loses these
  // characters at ingestion (packages/core/src/file.ts), so a name they would
  // have reordered must not be one this schema accepts whole either. Driven
  // against the strip itself rather than its pattern, since the strip is what
  // the header actually goes through.
  const survivors: Array<string> = [];
  for (const { codePoint, character } of bmpCharacters()) {
    const strippedAtIngestion = stripBidiControls(character) !== character;
    if (strippedAtIngestion && NAME_SHAPE_PATTERN.test(`a${character}b`))
      survivors.push(label(codePoint));
  }
  expect(survivors).toEqual([]);
});
