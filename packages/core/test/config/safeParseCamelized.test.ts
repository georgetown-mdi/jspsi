import { expect, test } from "vitest";
import type { z } from "zod";

import {
  MAX_NODE_COUNT,
  MAX_NESTING_DEPTH,
  NodeCountExceededError,
  NestingDepthExceededError,
} from "../../src/utils/camelizeKeys";
import {
  parseLinkageTerms,
  safeParseLinkageTerms,
} from "../../src/config/linkageTermsSchema";
import { safeParseExchangeSpec } from "../../src/config/exchangeSpec";
import {
  safeParseConnectionConfig,
  safeParseFileSyncOptions,
} from "../../src/config/connection";
import { safeParseSigningConfig } from "../../src/config/signing";
import { safeParseMetadata } from "../../src/config/metadata";

// Every safeParseX config helper runs camelizeKeys before Zod's safeParse, so
// a camelize structural bound (the depth bound or the node-count/width
// budget) must return a { success: false } result, not throw -- the contract
// the `safe` name promises for every caller. camelize runs on the raw value
// ahead of any schema, so one bound-tripping input exercises all six here,
// independent of which helper or schema is called.

// A flat array one past the node-count budget -- the cheapest node-count trip
// (the O(1) array-length check rejects before .map allocates). Mirrors
// camelizeKeys.test.ts.
function overWideInput(): unknown {
  return Array.from({ length: MAX_NODE_COUNT + 1 }, (_, i) => i);
}

// A chain nested one level past the depth bound (root at depth 0, so a value at
// depth MAX_NESTING_DEPTH is rejected).
function overDeepInput(): unknown {
  let v: unknown = {};
  for (let i = 0; i < MAX_NESTING_DEPTH; i++) v = { nested_key: v };
  return v;
}

type SafeHelper = (raw: unknown) => z.ZodSafeParseResult<unknown>;

const safeHelpers: ReadonlyArray<{ name: string; fn: SafeHelper }> = [
  { name: "safeParseLinkageTerms", fn: safeParseLinkageTerms },
  { name: "safeParseExchangeSpec", fn: safeParseExchangeSpec },
  { name: "safeParseConnectionConfig", fn: safeParseConnectionConfig },
  { name: "safeParseFileSyncOptions", fn: safeParseFileSyncOptions },
  { name: "safeParseSigningConfig", fn: safeParseSigningConfig },
  { name: "safeParseMetadata", fn: safeParseMetadata },
];

for (const { name, fn } of safeHelpers) {
  test(`${name} returns success:false on a node-count-tripping input, not a throw`, () => {
    let result: z.ZodSafeParseResult<unknown> | undefined;
    expect(() => {
      result = fn(overWideInput());
    }).not.toThrow();
    expect(result?.success).toBe(false);
    // The synthesized failure has the shape a Zod safeParse failure has -- one
    // issue at the root path -- so a caller reading result.error.issues handles
    // it identically to any other invalid input. The message is the bound's
    // fixed text: it holds no input bytes, satisfying the no-echo contract.
    expect(result?.success === false && result.error.issues).toEqual([
      {
        code: "custom",
        path: [],
        message: `input node count exceeds the maximum of ${MAX_NODE_COUNT}`,
      },
    ]);
  });

  test(`${name} returns success:false on a depth-tripping input, not a throw`, () => {
    let result: z.ZodSafeParseResult<unknown> | undefined;
    expect(() => {
      result = fn(overDeepInput());
    }).not.toThrow();
    expect(result?.success).toBe(false);
    expect(result?.success === false && result.error.issues).toEqual([
      {
        code: "custom",
        path: [],
        message: `input nesting exceeds the maximum depth of ${MAX_NESTING_DEPTH}`,
      },
    ]);
  });
}

const minimalLinkageTerms = {
  version: "1.0.0",
  identity: "Test Party",
  date: "2025-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

test("a legitimate config still parses through the safe helper", () => {
  const result = safeParseLinkageTerms(minimalLinkageTerms);
  expect(result.success).toBe(true);
});

// The throwing parseX siblings are left throwing by design -- their
// partner-wire call sites (protocolSetup.ts) catch the bound and report the
// same sanitized rejection. Only the `safe` helpers absorb it.
test("the throwing parseLinkageTerms still throws the camelize bound", () => {
  expect(() => parseLinkageTerms(overWideInput())).toThrow(
    NodeCountExceededError,
  );
  expect(() => parseLinkageTerms(overDeepInput())).toThrow(
    NestingDepthExceededError,
  );
});
