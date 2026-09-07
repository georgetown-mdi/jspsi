import { expect, test } from "vitest";

import {
  NAME_SHAPE_PATTERN,
  TEXT_CONTROL_CHAR_PATTERN,
  safeParseLinkageTerms,
} from "../../src/config/linkageTermsSchema";
import { MetadataSchema } from "../../src/config/metadata";
import {
  BIDI_CONTROL_PATTERN,
  stripNameControlChars,
} from "../../src/utils/nameControls";

// NAME_SHAPE_PATTERN is one anchored literal rather than a composition of the
// two patterns it is the union of, so that union is measured here rather than
// read off the source. Both sweeps run every BMP code point, which is what makes
// them fail on a range added to one class and not the other, wherever it is
// added -- the alternative, a list of interesting characters, only ever pins the
// characters somebody thought of. The second sweep is an equality in both
// directions: a header the read leaves alone never meets the schema's refusal,
// and a header it changes never loses a character a name may keep.

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

test("the CSV read strips exactly the characters a name may not hold", () => {
  // The alignment between the two boundaries a name crosses: a column header
  // loses these characters at ingestion (packages/core/src/file.ts), so no name
  // derived from a header can be one the schema refuses, and nothing else is
  // taken out of a header either. Driven against the strip itself rather than
  // its pattern, since the strip is what the header actually goes through.
  const disagreements: Array<string> = [];
  for (const { codePoint, character } of bmpCharacters()) {
    const strippedAtIngestion = stripNameControlChars(character) !== character;
    const admittedInAName = NAME_SHAPE_PATTERN.test(`a${character}b`);
    if (strippedAtIngestion === admittedInAName)
      disagreements.push(label(codePoint));
  }
  expect(disagreements).toEqual([]);
});

test("the metadata block's column name admits exactly what the shape admits", () => {
  // The third boundary a declared column name crosses. The block is the
  // operator's own, but a disclosed column's name reaches the partner in the
  // invitation's payload column list, so it holds the same shape -- driven
  // through the schema rather than read off its source, since the schema is
  // what a config load runs.
  const disagreements: Array<string> = [];
  for (const { codePoint, character } of bmpCharacters()) {
    const admittedByTheSchema = MetadataSchema.safeParse([
      {
        name: `a${character}b`,
        type: "other",
        role: "payload",
        isPayload: true,
      },
    ]).success;
    const admittedInAName = NAME_SHAPE_PATTERN.test(`a${character}b`);
    if (admittedByTheSchema !== admittedInAName)
      disagreements.push(label(codePoint));
  }
  expect(disagreements).toEqual([]);
});

// The terms document a params key is swept inside. Minimal but complete: the
// sweep is about the key alone, so nothing else here may fail the parse.
const termsWithParamsKey = (key: string) => ({
  version: "1.0.0",
  identity: "Test Party",
  date: "2025-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [
    {
      name: "SSN",
      elements: [
        {
          field: "ssn",
          transform: [{ function: "trim", params: { [key]: 1 } }],
        },
      ],
    },
  ],
});

test("a transform params key admits exactly what the shape admits", () => {
  // The fourth boundary a name crosses, and the only one that is an object KEY
  // rather than a value: a parameter name a partner authors, which locates the
  // offending entry in a refusal's issue path. Driven through the schema a
  // parse runs rather than read off its source. `safeParseLinkageTerms` runs
  // the camelize pre-pass first, as every real parse path does, so a key that
  // reaches the record stage is the key the document holds.
  const disagreements: Array<string> = [];
  for (const { codePoint, character } of bmpCharacters()) {
    const admittedByTheSchema = safeParseLinkageTerms(
      termsWithParamsKey(`a${character}b`),
    ).success;
    const admittedInAName = NAME_SHAPE_PATTERN.test(`a${character}b`);
    if (admittedByTheSchema !== admittedInAName)
      disagreements.push(label(codePoint));
  }
  expect(disagreements).toEqual([]);
});
