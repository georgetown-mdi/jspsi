import { readFileSync } from "node:fs";

import { expect, test } from "vitest";
import { z } from "zod";

import {
  LinkageTermsSchema,
  MAX_NAME_LENGTH,
  MAX_TEXT_LENGTH,
} from "../../src/config/linkageTermsSchema";
import {
  MAX_ENDPOINT_HOST_LENGTH,
  WebRTCEndpointSchema,
} from "../../src/config/invitation";
import {
  MetadataSchema,
  overlongDisclosedColumnPositions,
} from "../../src/config/metadata";
import { StandardizationSchema } from "../../src/config/standardizationSchema";
import { parseExchangeRecord } from "../../src/records/exchangeRecord";
import {
  SIGNING_CERTIFICATE_VERSION,
  boundedWireCertificateSchema,
} from "../../src/records/signingIdentity";
import { exchangePayloads } from "../../src/payloadExchange";
import { createMessagePipe } from "../../src/connection/messageConnection";

import type { ExchangeRecord } from "../../src/records/exchangeRecord";
import type { LinkageTerms } from "../../src/config/linkageTermsSchema";
import type { Metadata } from "../../src/config/metadata";

// Every bound on a length ceiling counts UTF-16 code units, so a schema and a
// hand-written predicate sharing a ceiling accept the same values. Zod's own
// `.max()` counts code points, so a value of astral characters is where the two
// spellings part: each bound below is driven against a corpus that straddles
// its ceiling in each unit, and each case's fixture varies only the field it
// names -- a refusal is attributed to the field's own path, so a sibling bound
// on the same document cannot stand in for the one under test.

// U+1F600: one code POINT, two UTF-16 code units.
const EMOJI = "\u{1F600}";

/**
 * Values straddling `ceiling` in each unit. The last two are what a bound left
 * on Zod's `.max()` accepts and every predicate on the same ceiling refuses:
 * astral characters, under the ceiling counted in code points and over it in
 * the code units that govern.
 */
function corpus(ceiling: number): Array<string> {
  return [
    "a".repeat(ceiling),
    "a".repeat(ceiling + 1),
    EMOJI.repeat(ceiling / 2),
    EMOJI.repeat(ceiling / 2) + "a",
    EMOJI.repeat(ceiling / 2 + 1),
    EMOJI.repeat(ceiling),
  ];
}

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

const recordVector = (
  JSON.parse(
    readFileSync(
      new URL("../vectors/exchange-record-vectors.json", import.meta.url),
      { encoding: "utf8" },
    ),
  ) as { vectors: Array<{ record: ExchangeRecord }> }
).vectors[0].record;

const issuesOf = (result: z.ZodSafeParseResult<unknown>) =>
  result.success ? [] : result.error.issues;

/** The issues a parse that throws its `ZodError` reports, rather than one that
 * returns it: the record parser is the read path an operator's file takes. */
function issuesThrownBy(parse: () => unknown) {
  try {
    parse();
    return [];
  } catch (error) {
    if (error instanceof z.ZodError) return error.issues;
    throw error;
  }
}

/** One length bound, the field it governs, and a document that varies only
 * that field: `issues` reports what the document's parse said about `value`,
 * and `valid` is a short value the field legitimately takes, so a fixture that
 * stopped being valid for an unrelated reason fails rather than going silent. */
type LengthBound = {
  what: string;
  ceiling: number;
  field: string;
  valid: string;
  issues: (value: string) => ReturnType<typeof issuesOf>;
};

const BOUNDS: Array<LengthBound> = [
  {
    what: "the metadata column-name schema",
    ceiling: MAX_NAME_LENGTH,
    field: "0.name",
    valid: "dose",
    issues: (name) => issuesOf(MetadataSchema.safeParse(metadataSending(name))),
  },
  {
    what: "the terms payload column-name schema",
    ceiling: MAX_NAME_LENGTH,
    field: "payload.send.0.name",
    valid: "dose",
    issues: (name) =>
      issuesOf(
        LinkageTermsSchema.safeParse({
          ...terms,
          payload: { send: [{ name }] },
        }),
      ),
  },
  {
    what: "the terms linkage-field-name schema",
    ceiling: MAX_NAME_LENGTH,
    field: "linkageFields.0.name",
    valid: "last_name",
    issues: (name) =>
      issuesOf(
        LinkageTermsSchema.safeParse({
          ...terms,
          linkageFields: [
            { name, type: "last_name" },
            { name: "first_name", type: "first_name" },
          ],
        }),
      ),
  },
  {
    what: "the terms linkage-key-name schema",
    ceiling: MAX_NAME_LENGTH,
    field: "linkageKeys.0.name",
    valid: "FN",
    issues: (name) =>
      issuesOf(
        LinkageTermsSchema.safeParse({
          ...terms,
          linkageKeys: [{ name, elements: [{ field: "first_name" }] }],
        }),
      ),
  },
  {
    what: "the terms name-constraint character class",
    ceiling: MAX_NAME_LENGTH,
    field: "linkageFields.0.constraints.allowedCharacters",
    valid: "a-z",
    issues: (allowedCharacters) =>
      issuesOf(
        LinkageTermsSchema.safeParse({
          ...terms,
          linkageFields: [
            {
              name: "first_name",
              type: "first_name",
              constraints: { allowedCharacters },
            },
          ],
        }),
      ),
  },
  {
    what: "the terms legal-agreement reference",
    ceiling: MAX_NAME_LENGTH,
    field: "legalAgreement.reference",
    valid: "MOU-2025-0042",
    issues: (reference) =>
      issuesOf(
        LinkageTermsSchema.safeParse({
          ...terms,
          legalAgreement: {
            reference,
            purpose: "Care coordination for co-enrolled patients",
            expirationDate: "2030-06-30",
          },
        }),
      ),
  },
  {
    what: "the terms version schema",
    ceiling: MAX_NAME_LENGTH,
    field: "version",
    valid: "1.0.0",
    issues: (version) =>
      issuesOf(LinkageTermsSchema.safeParse({ ...terms, version })),
  },
  {
    what: "the standardization output-name schema",
    ceiling: MAX_NAME_LENGTH,
    field: "0.output",
    valid: "given_name",
    issues: (output) =>
      issuesOf(StandardizationSchema.safeParse([{ output, input: "col" }])),
  },
  {
    what: "the record payload column-name schema",
    ceiling: MAX_NAME_LENGTH,
    field: "governance.payloadReceived.0.name",
    valid: "status",
    issues: (name) =>
      issuesThrownBy(() =>
        parseExchangeRecord({
          ...recordVector,
          governance: {
            ...recordVector.governance,
            payloadReceived: [{ name }],
          },
        }),
      ),
  },
  {
    what: "the WebRTC endpoint host schema",
    ceiling: MAX_ENDPOINT_HOST_LENGTH,
    field: "host",
    valid: "signal.example.org",
    issues: (host) =>
      issuesOf(WebRTCEndpointSchema.safeParse({ channel: "webrtc", host })),
  },
  {
    what: "the wire certificate identity schema",
    ceiling: MAX_TEXT_LENGTH,
    field: "identity",
    valid: "Party A",
    issues: (identity) =>
      issuesOf(
        boundedWireCertificateSchema.safeParse({
          version: SIGNING_CERTIFICATE_VERSION,
          algorithm: "ecdsa-p256-sha256",
          identity,
          publicKey: {
            kty: "EC",
            crv: "P-256",
            x: "eC1jb29yZA",
            y: "eS1jb29yZA",
          },
          signature: "c2lnbmF0dXJl",
        }),
      ),
  },
];

test("each fixture is a valid document but for the field under test", () => {
  for (const bound of BOUNDS) {
    expect(bound.issues(bound.valid), bound.what).toEqual([]);
  }
});

test("every bound refuses at its ceiling counted in code units", () => {
  for (const bound of BOUNDS) {
    for (const value of corpus(bound.ceiling)) {
      const refusedByThisBound = bound
        .issues(value)
        .some(
          (issue) =>
            issue.code === "too_big" && issue.path.join(".") === bound.field,
        );
      expect(
        refusedByThisBound,
        `${bound.what} on a value of ${value.length} code units (${[...value].length} code points) against a ceiling of ${bound.ceiling}`,
      ).toBe(value.length > bound.ceiling);
    }
  }
});

test("the disclosed-name gate refuses the same names as the schema bounds", () => {
  // The send-side gate is a predicate rather than a schema, so it is driven
  // directly on the same corpus the metadata bound it shares a ceiling with is.
  for (const name of corpus(MAX_NAME_LENGTH)) {
    expect(
      overlongDisclosedColumnPositions(metadataSending(name)).length === 0,
      `the disclosed-name gate on a name of ${name.length} code units`,
    ).toBe(name.length <= MAX_NAME_LENGTH);
  }
});

test("the payload frame's column-name bound refuses the same astral names", async () => {
  // The wire predicate counts code units in the same pass that checks the
  // floor and well-formedness, so it is driven through a real frame rather
  // than read off a schema.
  for (const name of corpus(MAX_NAME_LENGTH)) {
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
