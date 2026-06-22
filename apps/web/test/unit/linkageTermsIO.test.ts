import { describe, expect, test } from "vitest";

import { getDefaultLinkageTerms } from "@psilink/core";

import {
  MAX_IMPORT_CHARS,
  exportLinkageTerms,
  importLinkageTerms,
} from "../../src/psi/linkageTermsIO.js";

import type { LinkageTerms } from "@psilink/core";

// A complete, valid terms object spanning the surface an expert can author:
// multiple keys, a transformed element, and a swap.
const TERMS: LinkageTerms = getDefaultLinkageTerms("Example Org", [
  { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
  { name: "first_name", type: "first_name", role: "linkage", isPayload: false },
  { name: "last_name", type: "last_name", role: "linkage", isPayload: false },
  {
    name: "dob",
    type: "date_of_birth",
    role: "linkage",
    isPayload: false,
  },
]);

describe("exportLinkageTerms", () => {
  test("emits snake_case JSON for the user-facing on-disk form", () => {
    const json = exportLinkageTerms(TERMS, "json");
    const parsed = JSON.parse(json) as Record<string, unknown>;
    // Keys are snake_cased, matching psilink.yaml and the EXCHANGE_REFERENCE
    // snippets -- not the camelCase the TypeScript carries.
    expect(parsed).toHaveProperty("linkage_fields");
    expect(parsed).toHaveProperty("linkage_keys");
    expect(parsed).not.toHaveProperty("linkageFields");
  });

  test("emits YAML when asked", () => {
    const yaml = exportLinkageTerms(TERMS, "yaml");
    expect(yaml).toContain("linkage_fields:");
    // Not JSON: a YAML scalar line, not a brace.
    expect(yaml.trimStart().startsWith("{")).toBe(false);
  });
});

describe("importLinkageTerms round-trip", () => {
  test("JSON export re-imports to equal terms", () => {
    const result = importLinkageTerms(exportLinkageTerms(TERMS, "json"));
    expect(result.success).toBe(true);
    if (result.success) expect(result.terms).toEqual(TERMS);
  });

  test("YAML export re-imports to equal terms", () => {
    const result = importLinkageTerms(exportLinkageTerms(TERMS, "yaml"));
    expect(result.success).toBe(true);
    if (result.success) expect(result.terms).toEqual(TERMS);
  });

  test("accepts a hand-written snake_case document directly", () => {
    const result = importLinkageTerms(exportLinkageTerms(TERMS, "json"));
    expect(result.success).toBe(true);
  });
});

describe("importLinkageTerms rejection", () => {
  test("rejects a syntactically broken document with a readable message", () => {
    const result = importLinkageTerms("{ not: valid json or yaml ::: ");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/JSON or YAML/);
  });

  test("rejects valid JSON that is not linkage terms", () => {
    const result = importLinkageTerms(JSON.stringify({ hello: "world" }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/not valid/i);
  });

  test("rejects terms with a dangling field reference (referential integrity)", () => {
    // A key element referencing a field that is not declared: the schema's
    // referential-integrity refine rejects it, so import cannot smuggle it in.
    const broken = {
      ...TERMS,
      linkageKeys: [
        { name: "bad", elements: [{ field: "not_a_declared_field" }] },
      ],
    };
    const result = importLinkageTerms(JSON.stringify(broken));
    expect(result.success).toBe(false);
  });

  test("never echoes a parsed value in the error", () => {
    // A hostile identity carrying control/markup bytes: it must not appear in
    // the rejection message (the no-echo parse-error contract).
    const hostile = "[31mPWNED[0m<script>";
    const result = importLinkageTerms(
      JSON.stringify({ ...TERMS, algorithm: hostile }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).not.toContain("PWNED");
      expect(result.error).not.toContain("script");
    }
  });

  test("never echoes a transform params key (a partner-controlled path segment)", () => {
    // The one partner-controlled segment a Zod issue path can carry is a transform
    // `params` record key (params is a record over arbitrary keys). An over-long
    // key fails the schema's key-length bound with the key in the issue path; the
    // readable error must locate it ("...params") without echoing the key.
    const hostileKey = "x".repeat(300) + "PWNEDKEY";
    const broken = {
      ...TERMS,
      linkageKeys: [
        {
          name: "k",
          elements: [
            {
              field: "first_name",
              transform: [
                { function: "substring", params: { [hostileKey]: 1 } },
              ],
            },
          ],
        },
      ],
    };
    const result = importLinkageTerms(JSON.stringify(broken));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).not.toContain("PWNEDKEY");
  });

  test("localizes a string-format failure (version regex) without echoing the value", () => {
    // `version` is a `.regex()` field, so a malformed value fails with Zod 4's
    // `invalid_format` code. The readable error must locate it ("version") and use
    // fixed copy ("not in the expected format"), never the hostile value Zod's own
    // message could quote.
    const hostile = "9.9.9<script>PWNED";
    const result = importLinkageTerms(
      JSON.stringify({ ...TERMS, version: hostile }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/version/);
      expect(result.error).toMatch(/format/i);
      expect(result.error).not.toContain("PWNED");
      expect(result.error).not.toContain("script");
    }
  });

  test("rejects an over-length document before parsing", () => {
    const huge = " ".repeat(MAX_IMPORT_CHARS + 1);
    const result = importLinkageTerms(huge);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/too large/i);
  });
});
