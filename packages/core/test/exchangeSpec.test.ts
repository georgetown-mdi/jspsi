import { ZodError } from "zod";
import { expect, test } from "vitest";

import {
  parseExchangeSpec,
  safeParseExchangeSpec,
} from "../src/config/exchangeSpec";
import { MAX_TEXT_LENGTH } from "../src/config/linkageTerms";

// Minimal valid components used as a base.
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

const minimalConnection = {
  channel: "webrtc",
  server: { host: "api.peerjs.com" },
};

const minimalSpec = {
  linkageTerms: minimalLinkageTerms,
  connection: minimalConnection,
};

// --- Happy path --------------------------------------------------------------

test("parses a minimal valid ExchangeSpec", () => {
  const result = parseExchangeSpec(minimalSpec);
  expect(result.linkageTerms.algorithm).toBe("psi");
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

test("expectedPayloadColumns: the local lock-in field round-trips, including the empty set", () => {
  // The offline-accept lock-in: a top-level, per-party field (camelCase parsed,
  // snake_case on disk). A non-empty list and the empty set are both valid -- the
  // empty set is the strict "receive nothing" lock-in -- while the field stays
  // optional (absent = lazy).
  expect(
    parseExchangeSpec({
      ...minimalSpec,
      expected_payload_columns: ["notes", "member_id"],
    }).expectedPayloadColumns,
  ).toEqual(["notes", "member_id"]);
  expect(
    parseExchangeSpec({ ...minimalSpec, expected_payload_columns: [] })
      .expectedPayloadColumns,
  ).toEqual([]);
  expect(parseExchangeSpec(minimalSpec).expectedPayloadColumns).toBeUndefined();
});

test("expectedPayloadColumns: an empty column name is rejected", () => {
  // Names are partner-controlled; the per-entry min(1) floor rejects an empty name,
  // matching the payload/metadata name floors.
  const result = safeParseExchangeSpec({
    ...minimalSpec,
    expected_payload_columns: [""],
  });
  expect(result.success).toBe(false);
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

// --- retentionDisposition (self-facing audit pointer) ------------------------

test("retentionDisposition: a note up to MAX_TEXT_LENGTH round-trips", () => {
  const note = "x".repeat(MAX_TEXT_LENGTH);
  const result = parseExchangeSpec({
    ...minimalSpec,
    retention_disposition: note,
  });
  expect(result.retentionDisposition).toBe(note);
});

test("retentionDisposition: a note over MAX_TEXT_LENGTH is rejected", () => {
  // The record schema caps this field at MAX_TEXT_LENGTH; the producer schema
  // matches so an over-long note is rejected here at config time rather than
  // passing config validation only to fail the record build and drop the audit
  // record.
  const result = safeParseExchangeSpec({
    ...minimalSpec,
    retention_disposition: "x".repeat(MAX_TEXT_LENGTH + 1),
  });
  expect(result.success).toBe(false);
});

test("retentionDisposition: an empty note is rejected (absence is the omitted key)", () => {
  const result = safeParseExchangeSpec({
    ...minimalSpec,
    retention_disposition: "",
  });
  expect(result.success).toBe(false);
});

// --- Required fields ---------------------------------------------------------

test("missing connection is rejected", () => {
  const result = safeParseExchangeSpec({ linkageTerms: minimalLinkageTerms });
  expect(result.success).toBe(false);
});

test("missing linkageTerms is rejected", () => {
  const result = safeParseExchangeSpec({ connection: minimalConnection });
  expect(result.success).toBe(false);
});

// --- parse vs safeParse ------------------------------------------------------

test("parseExchangeSpec throws ZodError on invalid input", () => {
  expect(() => parseExchangeSpec({})).toThrow(ZodError);
});

test("safeParseExchangeSpec returns success: false on invalid input", () => {
  const result = safeParseExchangeSpec({});
  expect(result.success).toBe(false);
});

// --- camelizeKeys integration ------------------------------------------------

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
      linkage_fields: [{ name: "ssn", type: "ssn" }],
      linkage_keys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
    },
    connection: {
      channel: "webrtc",
      server: { host: "api.peerjs.com" },
      role: "inviter",
    },
  });
  expect(result.linkageTerms.output.expectsOutput).toBe(false);
  expect(result.linkageTerms.linkageFields[0].type).toBe("ssn");
  if (result.connection.channel !== "webrtc") return;
  expect(result.connection.role).toBe("inviter");
});

test("parses a top-level authentication block as a sibling of connection", () => {
  // authentication is a top-level ExchangeSpec block (channel-agnostic), not a
  // connection field. Its shared_secret is snake_case on disk and camelized.
  const SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const result = parseExchangeSpec({
    linkage_terms: {
      version: "1.0.0",
      identity: "Test Party",
      date: "2025-01-01",
      algorithm: "psi",
      output: { expects_output: false, share_with_partner: false },
      deduplicate: false,
      linkage_fields: [{ name: "ssn", type: "ssn" }],
      linkage_keys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
    },
    connection: { channel: "filedrop", path: "/mnt/share/drop" },
    authentication: {
      shared_secret: SECRET,
      expires: "2027-01-01T00:00:00Z",
    },
  });
  expect(result.authentication?.sharedSecret).toBe(SECRET);
  expect(result.authentication?.expires).toBe("2027-01-01T00:00:00Z");
});

test("rejects a malformed shared_secret in the top-level authentication block", () => {
  const result = safeParseExchangeSpec({
    linkage_terms: {
      version: "1.0.0",
      identity: "Test Party",
      date: "2025-01-01",
      algorithm: "psi",
      output: { expects_output: false, share_with_partner: false },
      deduplicate: false,
      linkage_fields: [{ name: "ssn", type: "ssn" }],
      linkage_keys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
    },
    connection: { channel: "filedrop", path: "/mnt/share/drop" },
    authentication: { shared_secret: "too-short" },
  });
  expect(result.success).toBe(false);
});

// --- authentication.token_max_age_days (operator policy) ---------------------

test("accepts a positive integer token_max_age_days and camelizes it", () => {
  const result = parseExchangeSpec({
    ...minimalSpec,
    authentication: { token_max_age_days: 30 },
  });
  expect(result.authentication?.tokenMaxAgeDays).toBe(30);
});

test("leaves token_max_age_days undefined when omitted", () => {
  const result = parseExchangeSpec({ ...minimalSpec, authentication: {} });
  expect(result.authentication?.tokenMaxAgeDays).toBeUndefined();
});

test("rejects a non-positive token_max_age_days", () => {
  for (const value of [0, -1]) {
    const result = safeParseExchangeSpec({
      ...minimalSpec,
      authentication: { token_max_age_days: value },
    });
    expect(result.success).toBe(false);
  }
});

test("rejects a non-integer token_max_age_days", () => {
  const result = safeParseExchangeSpec({
    ...minimalSpec,
    authentication: { token_max_age_days: 1.5 },
  });
  expect(result.success).toBe(false);
});

test("accepts token_max_age_days at the 36500-day maximum", () => {
  const result = parseExchangeSpec({
    ...minimalSpec,
    authentication: { token_max_age_days: 36500 },
  });
  expect(result.authentication?.tokenMaxAgeDays).toBe(36500);
});

test("rejects a token_max_age_days above the maximum", () => {
  // An upper bound keeps the rotation-time `now + N days` stamp inside the
  // representable Date range; a value large enough to overflow it must not reach
  // the rotation write path. Just past the ceiling and an overflow-scale value
  // are both rejected at parse.
  expect(
    safeParseExchangeSpec({
      ...minimalSpec,
      authentication: { token_max_age_days: 36501 },
    }).success,
  ).toBe(false);
  expect(
    safeParseExchangeSpec({
      ...minimalSpec,
      authentication: { token_max_age_days: 100_000_000 },
    }).success,
  ).toBe(false);
});

test("rejects an unrecognized key in the authentication block (strict)", () => {
  // The authentication block is strictObject: a misspelled policy key is rejected
  // at parse time rather than silently dropped, so a typo cannot disable the
  // max-age control with no signal to the operator.
  const result = safeParseExchangeSpec({
    ...minimalSpec,
    authentication: { token_max_age_dayss: 30 },
  });
  expect(result.success).toBe(false);
});
