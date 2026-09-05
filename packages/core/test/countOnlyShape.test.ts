import { ZodError } from "zod";
import { expect, test } from "vitest";

import {
  COUNT_ONLY_SHAPE_REFUSALS,
  assertCountOnlyTermsShape,
  countOnlyShapeViolation,
  deriveAcceptedLinkageTerms,
  parseLinkageTerms,
  safeParseLinkageTerms,
} from "../src/config/linkageTerms";
import type { LinkageTerms } from "../src/config/linkageTerms";
import {
  assertCountOnlyTransmitsNoColumn,
  countOnlyTransmitsColumn,
} from "../src/config/metadata";
import type { Metadata } from "../src/config/metadata";
import { decodeInvitation, encodeInvitation } from "../src/config/invitation";
import { assertAlgorithmImplemented } from "../src/exchange";
import { UsageError } from "../src/errors";

// The count-only shape refusals (docs/spec/PROTOCOL.md, PSI-C) are enforced
// at two points core owns -- every PARSE path (a partner's invitation is
// refused as read) and the ACCEPT path (terms built or mutated without a
// parse are refused before the mirror is derived) -- each rule exercised at
// both. The algorithm gate is separate: it admits `psi-c` whatever the
// shape, so shape enforcement is these rules' job alone (last block below).

/** A count-only document in exactly the shape the specification admits: one
 * linkage key, cascade, no deduplication, and no payload in either direction. */
const inShapeCountOnly: LinkageTerms = {
  version: "1.0.0",
  identity: "Inviting Org",
  date: "2026-01-15",
  algorithm: "psi-c",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "ssn", type: "ssn" },
    { name: "dob", type: "date_of_birth" },
  ],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

/** The four rules the terms hold, each as the minimal edit that breaks it. */
const outOfShape: ReadonlyArray<{
  rule: "linkageKeys" | "linkageStrategy" | "deduplicate" | "payload";
  terms: LinkageTerms;
}> = [
  {
    rule: "linkageKeys",
    terms: {
      ...inShapeCountOnly,
      linkageKeys: [
        ...inShapeCountOnly.linkageKeys,
        { name: "DOB", elements: [{ field: "dob" }] },
      ],
    },
  },
  {
    rule: "linkageStrategy",
    terms: { ...inShapeCountOnly, linkageStrategy: "single-pass" },
  },
  { rule: "deduplicate", terms: { ...inShapeCountOnly, deduplicate: true } },
  {
    rule: "payload",
    terms: {
      ...inShapeCountOnly,
      payload: { send: [{ name: "risk_score" }] },
    },
  },
];

const VALID_SECRET = "A".repeat(43);

/** Every refusal message a thrown failure holds: a `ZodError` renders its
 * issues as an escaped JSON blob, so the messages are read off the issues rather
 * than matched against that rendering. */
function refusalMessages(thrown: unknown): Array<string> {
  if (thrown instanceof ZodError)
    return thrown.issues.map((issue) => issue.message);
  return [thrown instanceof Error ? thrown.message : String(thrown)];
}

/** Assert that `act` refuses with exactly the given message, wherever the
 * failure holds it. */
async function expectRefusal(
  act: () => unknown,
  message: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await act();
  } catch (err) {
    thrown = err;
  }
  expect(thrown, "expected a refusal, got none").toBeDefined();
  expect(refusalMessages(thrown)).toContain(message);
}

// --- Parse -------------------------------------------------------------------

test.each(outOfShape)(
  "parse refuses a count-only document declaring $rule, naming what to change",
  async ({ rule, terms }) => {
    await expectRefusal(
      () => parseLinkageTerms(terms),
      COUNT_ONLY_SHAPE_REFUSALS[rule],
    );
    // The message names the rule broken AND the two ways out, so the refusal is
    // actionable rather than a bare statement that the document is wrong.
    expect(COUNT_ONLY_SHAPE_REFUSALS[rule]).toContain('"psi-c"');
    expect(COUNT_ONLY_SHAPE_REFUSALS[rule]).toContain('"psi"');
  },
);

test.each(outOfShape)(
  "the safe parse the web import door reads reports $rule at its own path",
  ({ rule, terms }) => {
    const parsed = safeParseLinkageTerms(terms);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    // One issue, located at the field the operator edits: the import door
    // exposes a value-free `custom` refine message verbatim and locates it by
    // path, so both halves have to be right.
    expect(parsed.error.issues).toHaveLength(1);
    expect(parsed.error.issues[0].path).toEqual([rule]);
    expect(parsed.error.issues[0].message).toBe(
      COUNT_ONLY_SHAPE_REFUSALS[rule],
    );
  },
);

test.each(outOfShape)(
  "a partner's invitation declaring $rule is refused as it is decoded",
  async ({ rule, terms }) => {
    // Minting one is refused by the same schema, so the crafted token is encoded
    // around it: this is the document a partner can put on the wire, and the
    // decode is where this party meets it.
    await expectRefusal(
      () =>
        encodeInvitation({
          version: "1",
          linkageTerms: terms,
          sharedSecret: VALID_SECRET,
        }),
      COUNT_ONLY_SHAPE_REFUSALS[rule],
    );
    const crafted = await encodeRaw({
      version: "1",
      linkageTerms: terms,
      sharedSecret: VALID_SECRET,
    });
    await expectRefusal(
      () => decodeInvitation(crafted),
      COUNT_ONLY_SHAPE_REFUSALS[rule],
    );
  },
);

// --- Accept ------------------------------------------------------------------

test.each(outOfShape)(
  "accepting a count-only invitation declaring $rule is refused before the mirror",
  async ({ rule, terms }) => {
    // Hand-built terms, which is the shape that reaches this function without a
    // parse: an in-process caller, or a front end that assembled them itself.
    expect(() => deriveAcceptedLinkageTerms(terms, "Accepting Org")).toThrow(
      UsageError,
    );
    await expectRefusal(
      () => deriveAcceptedLinkageTerms(terms, "Accepting Org"),
      COUNT_ONLY_SHAPE_REFUSALS[rule],
    );
  },
);

test("the accept refusal is fail-closed: nothing is derived and nothing is narrowed", () => {
  const [multiKey] = outOfShape;
  const before = structuredClone(multiKey.terms);
  expect(() =>
    deriveAcceptedLinkageTerms(multiKey.terms, "Accepting Org"),
  ).toThrow(UsageError);
  // The refused document is returned to no caller in a narrowed form, and the
  // input it read stays untouched: refusing does not trim to the first key.
  expect(multiKey.terms).toEqual(before);
});

test("an inviter's payload REQUEST is refused too, not only what it sends", async () => {
  // The mirror turns the inviter's `receive` into the acceptor's `send`, so a
  // rule reading only one direction would let a count-only exchange move columns
  // the other way.
  const requesting: LinkageTerms = {
    ...inShapeCountOnly,
    payload: { receive: [{ name: "program_outcome" }] },
  };
  expect(countOnlyShapeViolation(requesting)).toBe("payload");
  expect(() => assertCountOnlyTermsShape(requesting)).toThrow(
    COUNT_ONLY_SHAPE_REFUSALS.payload,
  );
  await expectRefusal(
    () => parseLinkageTerms(requesting),
    COUNT_ONLY_SHAPE_REFUSALS.payload,
  );
});

test("an explicitly empty payload pair is in shape, in both directions", () => {
  const explicitlyEmpty: LinkageTerms = {
    ...inShapeCountOnly,
    payload: { send: [], receive: [] },
  };
  expect(countOnlyShapeViolation(explicitlyEmpty)).toBeUndefined();
  expect(() => parseLinkageTerms(explicitlyEmpty)).not.toThrow();
});

// --- Input metadata ----------------------------------------------------------

/** This party's own input metadata: a record identifier plus one further column
 * whose role and payload marking the case under test sets. */
function metadataWith(column: Metadata[number]): Metadata {
  return [
    {
      name: "record_id",
      type: "identifier",
      role: "identifier",
      isPayload: false,
    },
    column,
  ];
}

const transmitting = metadataWith({
  name: "risk_score",
  type: "other",
  role: "payload",
  isPayload: true,
});

test("a count-only exchange whose metadata would transmit a column is refused", () => {
  expect(countOnlyTransmitsColumn("psi-c", transmitting)).toBe(true);
  expect(() => assertCountOnlyTransmitsNoColumn("psi-c", transmitting)).toThrow(
    COUNT_ONLY_SHAPE_REFUSALS.transmittedColumns,
  );
  expect(() => assertCountOnlyTransmitsNoColumn("psi-c", transmitting)).toThrow(
    UsageError,
  );
  // The message names no column: this metadata is the operator's own, but the
  // same refusal is composed on the accept side beside a partner's document.
  expect(COUNT_ONLY_SHAPE_REFUSALS.transmittedColumns).not.toContain(
    "risk_score",
  );
});

test("the metadata rule reads the disclosure predicate, not the column role", () => {
  // `isPayload` on an `ignored` column transmits nothing, and a `role: identifier`
  // column left `isPayload: true` does -- so a rule reading `role` alone would
  // both over- and under-refuse.
  const ignored = metadataWith({
    name: "risk_score",
    type: "other",
    role: "ignored",
    isPayload: true,
  });
  expect(countOnlyTransmitsColumn("psi-c", ignored)).toBe(false);
  expect(() =>
    assertCountOnlyTransmitsNoColumn("psi-c", ignored),
  ).not.toThrow();

  const transmittingIdentifier = metadataWith({
    name: "record_key",
    type: "identifier",
    role: "identifier",
    isPayload: true,
  });
  expect(countOnlyTransmitsColumn("psi-c", transmittingIdentifier)).toBe(true);
});

test("the metadata rule is a no-op on psi and on an unresolved metadata block", () => {
  expect(countOnlyTransmitsColumn("psi", transmitting)).toBe(false);
  expect(() =>
    assertCountOnlyTransmitsNoColumn("psi", transmitting),
  ).not.toThrow();
  // Absent metadata is inferred from the exchange's input columns, which the
  // boundaries that ask do not hold; refusing there would refuse every count-only
  // arrangement rather than the transmitting ones.
  expect(countOnlyTransmitsColumn("psi-c", undefined)).toBe(false);
  expect(() =>
    assertCountOnlyTransmitsNoColumn("psi-c", undefined),
  ).not.toThrow();
});

// --- Scope -------------------------------------------------------------------

test("psi terms are untouched by every count-only rule", () => {
  for (const { terms } of outOfShape) {
    const asPsi: LinkageTerms = { ...terms, algorithm: "psi" };
    expect(countOnlyShapeViolation(asPsi)).toBeUndefined();
    expect(() => parseLinkageTerms(asPsi)).not.toThrow();
    // deriveAcceptedLinkageTerms applies no count-only rule to a psi document, so
    // every one of these derives cleanly. The deduplicate case derives cleanly for
    // a reason of its own -- the acceptor's own side is derived as false rather
    // than adopted -- which is asserted where that derivation is pinned.
    expect(() =>
      deriveAcceptedLinkageTerms(asPsi, "Accepting Org"),
    ).not.toThrow();
  }
  expect(countOnlyTransmitsColumn("psi", transmitting)).toBe(false);
});

test("a count-only document already in shape passes every rule and the algorithm gate", () => {
  expect(countOnlyShapeViolation(inShapeCountOnly)).toBeUndefined();
  expect(() => parseLinkageTerms(inShapeCountOnly)).not.toThrow();
  expect(() => assertCountOnlyTermsShape(inShapeCountOnly)).not.toThrow();
  expect(() =>
    deriveAcceptedLinkageTerms(inShapeCountOnly, "Accepting Org"),
  ).not.toThrow();
  // The division of labour these rules rest on: the algorithm gate answers only
  // whether a run path exists, so it admits `psi-c` whatever the document's shape,
  // and holding an out-of-shape document back is these rules' work alone.
  expect(() =>
    assertAlgorithmImplemented(inShapeCountOnly.algorithm),
  ).not.toThrow();
  for (const { terms } of outOfShape)
    expect(() => assertAlgorithmImplemented(terms.algorithm)).not.toThrow();
});

// Appends a valid 4-byte checksum over an arbitrary token object, reproducing
// encodeInvitation's encoding WITHOUT its schema validation -- the only way to
// put a document the schema refuses on the wire, which is what a crafted
// partner token is.
async function encodeRaw(obj: unknown): Promise<string> {
  const toBase64Url = (b: Uint8Array): string =>
    btoa(Array.from(b, (byte) => String.fromCharCode(byte)).join(""))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return toBase64Url(bytes) + toBase64Url(new Uint8Array(hash).slice(0, 4));
}
