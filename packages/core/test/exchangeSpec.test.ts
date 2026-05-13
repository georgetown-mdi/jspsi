import { ZodError } from "zod";
import { expect, test } from "vitest";

import {
  parseExchangeSpec,
  safeParseExchangeSpec,
} from "../src/config/exchangeSpec";

// Minimal valid components used as a base.
const minimalLinkageTerms = {
  version: "1.0.0",
  identity: "Test Party",
  date: "2025-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [{ name: "ssn", semanticType: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

const minimalConnection = {
  channel: "webrtc",
  server: { host: "api.peerjs.com" },
};

const minimalSpec = {
  linkageTerms: minimalLinkageTerms,
  connection: minimalConnection,
};

// ─── Happy path ──────────────────────────────────────────────────────────────

test("parses a minimal valid ExchangeSpec", () => {
  const result = parseExchangeSpec(minimalSpec);
  expect(result.linkageTerms?.algorithm).toBe("psi");
  expect(result.connection.channel).toBe("webrtc");
  expect(result.metadata).toBeUndefined();
  expect(result.standardization).toBeUndefined();
});

test("metadata and standardization are optional", () => {
  const result = safeParseExchangeSpec({
    ...minimalSpec,
    metadata: [],
    standardization: [{ output: "last_name", input: "LAST_NAME", steps: [] }],
  });
  expect(result.success).toBe(true);
});

test("parses an ExchangeSpec with an SFTP connection", () => {
  const result = parseExchangeSpec({
    linkageTerms: minimalLinkageTerms,
    connection: {
      channel: "sftp",
      server: { host: "sftp.example.org", username: "psilink" },
    },
  });
  expect(result.connection.channel).toBe("sftp");
});

// ─── Required fields ─────────────────────────────────────────────────────────

test("missing connection is rejected", () => {
  const result = safeParseExchangeSpec({ linkageTerms: minimalLinkageTerms });
  expect(result.success).toBe(false);
});

test("missing linkageTerms with identity is accepted (defaults will be generated)", () => {
  const result = safeParseExchangeSpec({
    identity: "Jane Smith, Agency A",
    connection: minimalConnection,
  });
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.linkageTerms).toBeUndefined();
    expect(result.data.identity).toBe("Jane Smith, Agency A");
  }
});

test("missing both linkageTerms and identity is rejected", () => {
  const result = safeParseExchangeSpec({ connection: minimalConnection });
  expect(result.success).toBe(false);
});

// ─── parse vs safeParse ──────────────────────────────────────────────────────

test("parseExchangeSpec throws ZodError on invalid input", () => {
  expect(() => parseExchangeSpec({})).toThrow(ZodError);
});

test("safeParseExchangeSpec returns success: false on invalid input", () => {
  const result = safeParseExchangeSpec({});
  expect(result.success).toBe(false);
});

// ─── camelizeKeys integration ────────────────────────────────────────────────

test("parses snake_case top-level keys from disk", () => {
  // camelizeKeys is applied once at the ExchangeSpec level and propagates
  // to nested linkage_terms and connection fields.
  const result = parseExchangeSpec({
    linkage_terms: {
      version: "1.0.0",
      identity: "Test Party",
      date: "2025-01-01",
      algorithm: "psi",
      output: { expects_output: false, share_with_partner: false },
      deduplicate: false,
      linkage_fields: [{ name: "ssn", semantic_type: "ssn" }],
      linkage_keys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
    },
    connection: {
      channel: "webrtc",
      server: { host: "api.peerjs.com" },
      authentication: { pake_token: "tok123", role: "invitor" },
    },
  });
  expect(result.linkageTerms?.output.expectsOutput).toBe(false);
  expect(result.linkageTerms?.linkageFields[0].semanticType).toBe("ssn");
  if (result.connection.channel !== "webrtc") return;
  expect(result.connection.authentication?.pakeToken).toBe("tok123");
});
