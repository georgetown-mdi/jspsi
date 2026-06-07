import { describe, expect, test } from "vitest";

import {
  parseSigningConfig,
  safeParseSigningConfig,
} from "../src/config/signing";
import { parseExchangeSpec } from "../src/config/exchangeSpec";

// A valid 43-character base64url SHA-256 fingerprint (from the checked-in
// signing-cert vectors).
const FINGERPRINT = "iWD-ZB69Oz6gOpaX_OoC7sD8ohIZj2lETC9qbl-IbPg";

describe("parseSigningConfig", () => {
  test("accepts each signing mode", () => {
    for (const mode of ["none", "session-derived", "certificate"] as const) {
      expect(parseSigningConfig({ mode }).mode).toBe(mode);
    }
  });

  test("camelizes snake_case keys from YAML/JSON", () => {
    const cfg = parseSigningConfig({
      mode: "certificate",
      identity_file: "/keys/id.json",
      partner_fingerprint: FINGERPRINT,
      receipt_output: "./receipts",
    });
    expect(cfg).toEqual({
      mode: "certificate",
      identityFile: "/keys/id.json",
      partnerFingerprint: FINGERPRINT,
      receiptOutput: "./receipts",
    });
  });

  test("rejects an unknown mode", () => {
    expect(safeParseSigningConfig({ mode: "x509" }).success).toBe(false);
  });

  test("rejects a missing mode", () => {
    expect(safeParseSigningConfig({ identity_file: "/k.json" }).success).toBe(
      false,
    );
  });

  test("rejects a fingerprint of the wrong length", () => {
    expect(
      safeParseSigningConfig({
        mode: "certificate",
        partner_fingerprint: FINGERPRINT.slice(0, 42),
      }).success,
    ).toBe(false);
  });

  test("rejects a fingerprint with non-base64url characters", () => {
    expect(
      safeParseSigningConfig({
        mode: "certificate",
        partner_fingerprint: "+".repeat(43),
      }).success,
    ).toBe(false);
  });
});

describe("ExchangeSpec signing block", () => {
  const baseSpec = {
    connection: {
      channel: "filedrop",
      path: "/tmp/drop",
    },
    linkage_terms: {
      version: "1.0.0",
      identity: "Party A",
      date: "2025-01-01",
      algorithm: "psi",
      output: { expects_output: true, share_with_partner: true },
      deduplicate: false,
      linkage_fields: [{ name: "ssn", type: "ssn" }],
      linkage_keys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
    },
  };

  test("parses a spec without a signing block", () => {
    const spec = parseExchangeSpec(baseSpec);
    expect(spec.signing).toBeUndefined();
  });

  test("parses and camelizes a spec with a signing block", () => {
    const spec = parseExchangeSpec({
      ...baseSpec,
      signing: {
        mode: "certificate",
        identity_file: "~/.psilink/signing-identity.json",
        partner_fingerprint: FINGERPRINT,
      },
    });
    expect(spec.signing).toEqual({
      mode: "certificate",
      identityFile: "~/.psilink/signing-identity.json",
      partnerFingerprint: FINGERPRINT,
    });
  });
});
