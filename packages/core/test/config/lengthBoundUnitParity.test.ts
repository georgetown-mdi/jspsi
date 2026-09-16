import { expect, test } from "vitest";

import {
  LinkageTermsSchema,
  MAX_NAME_LENGTH,
} from "../../src/config/linkageTermsSchema";
import {
  MetadataSchema,
  overlongDisclosedColumnPositions,
} from "../../src/config/metadata";
import { StandardizationSchema } from "../../src/config/standardizationSchema";
import { exchangePayloads } from "../../src/payloadExchange";
import { createMessagePipe } from "../../src/connection/messageConnection";

import type { LinkageTerms } from "../../src/config/linkageTermsSchema";
import type { Metadata } from "../../src/config/metadata";

// Every bound on a name ceiling counts UTF-16 code units, so a schema and a
// hand-written predicate sharing a ceiling accept the same names. Zod's own
// `.max()` counts code points, so a name of astral characters is where the two
// spellings part: the corpus below straddles the ceiling in each unit, and the
// bounds are all driven against the one code-unit answer.

// U+1F600: one code POINT, two UTF-16 code units.
const EMOJI = "\u{1F600}";

const NAMES = [
  "a".repeat(MAX_NAME_LENGTH),
  "a".repeat(MAX_NAME_LENGTH + 1),
  EMOJI.repeat(MAX_NAME_LENGTH / 2),
  EMOJI.repeat(MAX_NAME_LENGTH / 2) + "a",
  // Under the ceiling on a code-point count, over it on the one that governs:
  // what a bound left on Zod's `.max()` accepts and every predicate refuses.
  EMOJI.repeat(200),
  EMOJI.repeat(MAX_NAME_LENGTH),
];

const terms: LinkageTerms = {
  version: "1.0.0",
  identity: "Sender",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "first_name", type: "first_name" }],
  linkageKeys: [{ name: "FN", elements: [{ field: "first_name" }] }],
};

function metadataSending(name: string): Metadata {
  return [{ name, type: "other", role: "payload", isPayload: true }];
}

/** The bounds on {@link MAX_NAME_LENGTH}, each reporting whether it accepts a
 * name -- the schema-declared ones beside the hand-written predicates that
 * share the ceiling. */
const acceptsName: Array<[string, (name: string) => boolean]> = [
  [
    "the metadata column-name schema",
    (name) => MetadataSchema.safeParse(metadataSending(name)).success,
  ],
  [
    "the terms payload column-name schema",
    (name) =>
      LinkageTermsSchema.safeParse({
        ...terms,
        payload: { send: [{ name }] },
      }).success,
  ],
  [
    "the terms linkage-field-name schema",
    (name) =>
      LinkageTermsSchema.safeParse({
        ...terms,
        linkageFields: [{ name, type: "first_name" }],
        linkageKeys: [{ name: "K", elements: [{ field: name }] }],
      }).success,
  ],
  [
    "the terms name-constraint character class",
    (name) =>
      LinkageTermsSchema.safeParse({
        ...terms,
        linkageFields: [
          {
            name: "first_name",
            type: "first_name",
            constraints: { allowedCharacters: name },
          },
        ],
      }).success,
  ],
  [
    "the standardization output-name schema",
    (name) =>
      StandardizationSchema.safeParse([{ output: name, input: "col" }]).success,
  ],
  [
    "the disclosed-name gate",
    (name) =>
      overlongDisclosedColumnPositions(metadataSending(name)).length === 0,
  ],
];

test("every name bound accepts the same astral names", () => {
  for (const name of NAMES) {
    const carriable = name.length <= MAX_NAME_LENGTH;
    for (const [what, accepts] of acceptsName) {
      expect(
        accepts(name),
        `${what} on a name of ${name.length} code units (${[...name].length} code points)`,
      ).toBe(carriable);
    }
  }
});

test("the payload frame's column-name bound refuses the same astral names", async () => {
  // The wire predicate counts code units in the same pass that checks the
  // floor and well-formedness, so it is driven through a real frame rather
  // than read off a schema.
  for (const name of NAMES) {
    const [a, b] = createMessagePipe();
    const receiving = exchangePayloads(a, "initiator", { hasData: false });
    await b.receive();
    await b.send({
      hasData: true,
      columns: [name],
      rowIndices: [0],
      rows: [["v"]],
    });
    if (name.length <= MAX_NAME_LENGTH) {
      expect((await receiving).columns).toEqual([name]);
    } else {
      await expect(receiving).rejects.toThrow();
    }
  }
});
