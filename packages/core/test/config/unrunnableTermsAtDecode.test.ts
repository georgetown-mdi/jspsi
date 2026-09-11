import { expect, test } from "vitest";
import { ZodError } from "zod";

import { decodeInvitation } from "../../src/config/invitation";
import { safeParseLinkageTerms } from "../../src/config/linkageTermsSchema";
import {
  CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY,
  COUNT_ONLY_SHAPE_REFUSALS,
} from "../../src/linkageTermsPolicy";
import {
  candidateSetUnderStrategyMessage,
  MAX_EFFECTIVE_KEY_COUNT,
  MAX_KEY_CANDIDATE_WIDTH,
} from "../../src/fanOutFunctions";

// The strings a partner authors in the document below. A refusal locates the
// offending key by its position and states a fixed literal, so none of these
// may reach the issue a decode raises: the accept route renders a decode error
// with no sanitizing pass of its own (describeDecodeError.ts).
const PARTNER_TEXT = [
  "Partner Authored Identity",
  "partner_given",
  "partner_family",
  "partner_identifier",
  "Partner Key Name",
  "partner-delimiter",
];

// A SHARED_SECRET_REGEX-valid placeholder (43 base64url characters).
const VALID_SECRET = "A".repeat(43);

const splitOn = [
  { function: "split_on", params: { delimiter: "partner-delimiter" } },
];

function partnerTerms(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: "1.0.0",
    identity: "Partner Authored Identity",
    date: "2025-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: false,
    linkageFields: [
      { name: "partner_given", type: "first_name" },
      { name: "partner_family", type: "last_name" },
      { name: "partner_identifier", type: "ssn" },
    ],
    linkageKeys: [
      {
        name: "Partner Key Name",
        elements: [{ field: "partner_given" }, { field: "partner_family" }],
      },
    ],
    ...overrides,
  };
}

// A key whose candidate set a count-only round has no resolution for.
const candidateSetKeys = [
  {
    name: "Partner Key Name",
    elements: [{ field: "partner_given", transform: splitOn }],
  },
];

// Each fan-out element contributes 20 candidates and the key's elements
// multiply, so three of them declare 8000 against the 1024 ceiling.
const overWideKeys = [
  {
    name: "Partner Key Name",
    elements: [
      { field: "partner_given", transform: splitOn },
      { field: "partner_family", transform: splitOn },
      { field: "partner_identifier", transform: splitOn },
    ],
  },
];

// 13 keys of width 400 sum to 5200, above the 5120 ceiling, with every key
// under the per-key one.
const overCountKeys = Array.from({ length: 13 }, (_, index) => ({
  name: `Partner Key Name ${index}`,
  elements: [
    { field: "partner_given", transform: splitOn },
    { field: "partner_family", transform: splitOn },
  ],
}));

function refusalsOf(raw: Record<string, unknown>): ReadonlyArray<string> {
  const result = safeParseLinkageTerms(raw);
  expect(result.success).toBe(false);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.message);
}

function expectNoPartnerText(messages: ReadonlyArray<string>): void {
  for (const message of messages)
    for (const authored of PARTNER_TEXT)
      expect(message).not.toContain(authored);
}

// Reproduces encodeInvitation's body-plus-checksum encoding without its schema
// validation, so a token the schema refuses can still be handed to the decode.
// The checksum detects a transcription error rather than authenticating the
// token, so a partner composes a valid one over any payload.
async function encodeRaw(token: unknown): Promise<string> {
  const toBase64Url = (bytes: Uint8Array): string =>
    Buffer.from(bytes).toString("base64url");
  const bytes = new TextEncoder().encode(JSON.stringify(token));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return toBase64Url(bytes) + toBase64Url(new Uint8Array(digest).slice(0, 4));
}

function invitationOver(terms: Record<string, unknown>): Promise<string> {
  return encodeRaw({
    version: "1",
    linkageTerms: terms,
    sharedSecret: VALID_SECRET,
  });
}

async function decodeRefusalsOf(
  terms: Record<string, unknown>,
): Promise<ReadonlyArray<string>> {
  const encoded = await invitationOver(terms);
  const raised: unknown = await decodeInvitation(encoded).then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(raised).toBeInstanceOf(ZodError);
  return (raised as ZodError).issues.map((issue) => issue.message);
}

test("a candidate set under the count-only algorithm is refused at the parse", () => {
  const messages = refusalsOf(
    partnerTerms({ algorithm: "psi-c", linkageKeys: candidateSetKeys }),
  );
  expect(messages).toContain(COUNT_ONLY_SHAPE_REFUSALS.candidateSet);
  expectNoPartnerText(messages);
});

test("a candidate set under the count-only algorithm is refused at the decode", async () => {
  const messages = await decodeRefusalsOf(
    partnerTerms({ algorithm: "psi-c", linkageKeys: candidateSetKeys }),
  );
  expect(messages).toContain(COUNT_ONLY_SHAPE_REFUSALS.candidateSet);
  expectNoPartnerText(messages);
});

test("a candidate set under a strategy off the allowlist is refused at the parse", () => {
  // Both shipped strategies resolve a candidate set, so the allowlist half is
  // driven by standing one of them down, as the round's own gate is driven
  // (psiLink.test.ts). It is the entry a strategy added later starts from.
  const shipped = CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY.cascade;
  CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY.cascade = false;
  try {
    const messages = refusalsOf(
      partnerTerms({ linkageKeys: candidateSetKeys }),
    );
    expect(messages).toContain(candidateSetUnderStrategyMessage());
    expectNoPartnerText(messages);
  } finally {
    CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY.cascade = shipped;
  }
});

test("a candidate set under a strategy off the allowlist is refused at the decode", async () => {
  const shipped = CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY.cascade;
  CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY.cascade = false;
  try {
    const messages = await decodeRefusalsOf(
      partnerTerms({ linkageKeys: candidateSetKeys }),
    );
    expect(messages).toContain(candidateSetUnderStrategyMessage());
    expectNoPartnerText(messages);
  } finally {
    CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY.cascade = shipped;
  }
});

test("a key wider than the per-key candidate ceiling is refused at the parse", () => {
  const messages = refusalsOf(partnerTerms({ linkageKeys: overWideKeys }));
  expect(messages.join("\n")).toContain(
    `${MAX_KEY_CANDIDATE_WIDTH} candidate values one record may contribute`,
  );
  expect(messages.join("\n")).toContain("the linkage key at linkageKeys[0]");
  expectNoPartnerText(messages);
});

test("a key wider than the per-key candidate ceiling is refused at the decode", async () => {
  const messages = await decodeRefusalsOf(
    partnerTerms({ linkageKeys: overWideKeys }),
  );
  expect(messages.join("\n")).toContain(
    `${MAX_KEY_CANDIDATE_WIDTH} candidate values one record may contribute`,
  );
  expectNoPartnerText(messages);
});

test("terms above the effective key count ceiling are refused at the parse", () => {
  const messages = refusalsOf(partnerTerms({ linkageKeys: overCountKeys }));
  expect(messages.join("\n")).toContain(
    `above the ${MAX_EFFECTIVE_KEY_COUNT} an exchange derives`,
  );
  expectNoPartnerText(messages);
});

test("terms above the effective key count ceiling are refused at the decode", async () => {
  const messages = await decodeRefusalsOf(
    partnerTerms({ linkageKeys: overCountKeys }),
  );
  expect(messages.join("\n")).toContain(
    `above the ${MAX_EFFECTIVE_KEY_COUNT} an exchange derives`,
  );
  expectNoPartnerText(messages);
});

test("terms an exchange can run still parse and decode", async () => {
  // The same document with one fan-out element on a `psi` cascade: a candidate
  // set both shipped strategies resolve, at a width of 20 against both
  // ceilings.
  const runnable = partnerTerms({ linkageKeys: candidateSetKeys });
  expect(safeParseLinkageTerms(runnable).success).toBe(true);
  const token = await decodeInvitation(await invitationOver(runnable));
  expect(token.linkageTerms.linkageKeys).toHaveLength(1);
});
