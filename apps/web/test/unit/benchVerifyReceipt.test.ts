import { describe, expect, test } from "vitest";

import {
  buildExchangeRecord,
  deriveOurIdColumn,
  reconstructCommittedData,
  serializeExchangeRecord,
  serializeVerificationKeys,
  toRetainedResult,
  verifyExchangeRecord,
} from "@psilink/core";

import {
  parseKeysDocument,
  parseRecordDocument,
  verdictViewModel,
} from "@bench/verifyReceiptModel";

import type {
  AssociationTable,
  CommittedPayload,
  ExchangeRecord,
  LinkageTerms,
  VerificationKeys,
} from "@psilink/core";

type ExchangeRecordInputs = Parameters<typeof buildExchangeRecord>[0];

// A small exchange keyed on an identifier column: two parties, one shared
// payload column each way, and an association table. The re-supply files below
// reproduce exactly these committed bytes.
const LOCAL_TERMS: LinkageTerms = {
  version: "1.0.0",
  identity: "Party A",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};
const PARTNER_TERMS: LinkageTerms = { ...LOCAL_TERMS, identity: "Party B" };

const localPayloadSent: CommittedPayload = {
  columns: ["dose"],
  rows: [["10mg"], ["20mg"]],
};
const partnerPayloadReceived: CommittedPayload = {
  columns: ["clinic"],
  rows: [["north"], ["south"]],
};
// This party matched its rows 0 and 1 to the partner's rows 1 and 0.
const associationTable: AssociationTable = [
  [0, 1],
  [1, 0],
];

const baseInputs: ExchangeRecordInputs = {
  localTerms: LOCAL_TERMS,
  partnerTerms: PARTNER_TERMS,
  recordsExposed: 2,
  localPayloadSent,
  partnerPayloadReceived,
  associationTable,
  createdAt: "2026-01-02T03:04:05.000Z",
};

// The retained input (keyed on `pid`, an identifier column) and result (its
// first column the identifier, then the partner index, then the received payload
// value) whose parsed forms reconstruct the committed data byte-exactly.

async function fixtures(): Promise<{
  record: ExchangeRecord;
  keys: VerificationKeys;
}> {
  return buildExchangeRecord(baseInputs);
}

// Parse a CSV the same way the browser page will: this test does not spin up the
// worker, so it uses core's own header-keyed shape directly.
function parseInputCsv(): Array<Record<string, string>> {
  return [
    { pid: "P0", dose: "10mg" },
    { pid: "P1", dose: "20mg" },
  ];
}
function parseResultCsv(): {
  meta: { fields: Array<string> };
  data: Array<Record<string, string>>;
} {
  return {
    meta: { fields: ["pid", "their_row_id", "clinic"] },
    data: [
      { pid: "P0", their_row_id: "1", clinic: "south" },
      { pid: "P1", their_row_id: "0", clinic: "north" },
    ],
  };
}

function reconstructForFixture(record: ExchangeRecord) {
  const inputRows = parseInputCsv();
  const resultParse = parseResultCsv();
  const result = toRetainedResult(resultParse);
  const ourIdColumn = deriveOurIdColumn(
    result.headers,
    new Set(resultParse.meta.fields.length > 0 ? ["pid", "dose"] : []),
  );
  return reconstructCommittedData({ record, inputRows, result, ourIdColumn });
}

describe("parseRecordDocument", () => {
  test("a valid record parses to the ok outcome", async () => {
    const { record } = await fixtures();
    const parsed = parseRecordDocument(serializeExchangeRecord(record));
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok")
      expect(parsed.record.version).toBe(record.version);
  });

  test("a syntactically broken document is malformed, sanitized", () => {
    const parsed = parseRecordDocument("{ not json");
    expect(parsed.kind).toBe("malformed");
  });

  test("an unrecognized version is its own named outcome", async () => {
    const { record } = await fixtures();
    const bumped = JSON.stringify({
      ...record,
      version: "psilink-exchange-record/v2",
    });
    const parsed = parseRecordDocument(bumped);
    expect(parsed.kind).toBe("unrecognized-version");
    if (parsed.kind === "unrecognized-version")
      expect(parsed.message).toContain("does not recognize");
  });

  test("a right-version wrong-shape document is malformed", async () => {
    const { record } = await fixtures();
    const broken = JSON.stringify({
      version: record.version,
      commitments: "not an object",
    });
    const parsed = parseRecordDocument(broken);
    expect(parsed.kind).toBe("malformed");
  });

  test("an error-bearing malformed input never echoes control bytes", () => {
    // A crafted syntax error carrying an ANSI/control sequence must be
    // neutralized at the display boundary, not surfaced raw.
    const esc = String.fromCharCode(0x1b);
    const bel = String.fromCharCode(0x07);
    const parsed = parseRecordDocument(`{"x": ${esc}[31m${bel}`);
    expect(parsed.kind).toBe("malformed");
    if (parsed.kind === "malformed") {
      expect(parsed.message).not.toContain(esc);
      expect(parsed.message).not.toContain(bel);
    }
  });
});

describe("parseKeysDocument", () => {
  test("a valid keys file parses to the ok outcome", async () => {
    const { keys } = await fixtures();
    const parsed = parseKeysDocument(serializeVerificationKeys(keys));
    expect(parsed.kind).toBe("ok");
  });

  test("an unrecognized keys version is its own named outcome", async () => {
    const { keys } = await fixtures();
    const bumped = JSON.stringify({
      ...keys,
      version: "psilink-exchange-keys/v2",
    });
    const parsed = parseKeysDocument(bumped);
    expect(parsed.kind).toBe("unrecognized-version");
  });

  test("a right-version wrong-shape keys file is malformed", async () => {
    const { keys } = await fixtures();
    const broken = JSON.stringify({ version: keys.version, salts: 5 });
    const parsed = parseKeysDocument(broken);
    expect(parsed.kind).toBe("malformed");
  });
});

describe("verdictViewModel: verified", () => {
  test("a record, keys, data, and both terms verify with the honest verified headline", async () => {
    const { record, keys } = await fixtures();
    const reconstructed = reconstructForFixture(record);
    const report = await verifyExchangeRecord(record, keys, {
      data: reconstructed.data,
      localTerms: LOCAL_TERMS,
      partnerTerms: PARTNER_TERMS,
    });
    expect(report.outcome).toBe("verified");
    const view = verdictViewModel(report, reconstructed.warnings);
    expect(view.headline.title).toBe("Verified");
    expect(view.headline.tone).toBe("verified");
    expect(view.commitments.every((row) => row.tone === "verified")).toBe(true);
    expect(view.termsHash.status).toBe("Re-derives and matches");
    expect(view.warnings).toEqual([]);
  });
});

describe("verdictViewModel: tampered record (honest ambiguity)", () => {
  test("an altered commitment fails with the altered-or-wrong-file headline, never tamper alone", async () => {
    const { record, keys } = await fixtures();
    const reconstructed = reconstructForFixture(record);
    // Alter a commitment so it no longer opens against the re-supplied data.
    const tampered: ExchangeRecord = {
      ...record,
      commitments: {
        ...record.commitments,
        localPayloadSent:
          record.commitments.localPayloadSent.slice(0, -2) + "AA",
      },
    };
    const report = await verifyExchangeRecord(tampered, keys, {
      data: reconstructed.data,
      localTerms: LOCAL_TERMS,
      partnerTerms: PARTNER_TERMS,
    });
    expect(report.outcome).toBe("failed");
    const view = verdictViewModel(report, reconstructed.warnings);
    expect(view.headline.title).toBe("Verification failed");
    // The board criterion: the failed headline states the ambiguity, and never
    // asserts tamper on its own.
    expect(view.headline.detail).toContain("the record was altered");
    expect(view.headline.detail).toContain("does not belong to this exchange");
    expect(view.headline.detail.toLowerCase()).not.toContain("tampered");
    const sent = view.commitments.find(
      (row) => row.label === "The payload you sent",
    );
    expect(sent?.status).toBe("Does not match");
    expect(sent?.tone).toBe("failed");
  });
});

describe("verdictViewModel: wrong keys (missing salt is distinct from tamper)", () => {
  test("a keys file missing a salt yields incomplete, cannot-be-opened, wrong-or-drifted copy", async () => {
    const { record, keys } = await fixtures();
    const reconstructed = reconstructForFixture(record);
    // Drop the salt for a present commitment: the distinct wrong-keys signal.
    // The association-table salt is optional in the schema, so a keys file
    // missing it still parses (the mandatory salts are schema-required), which
    // is the file-borne form of a drifted keys file.
    const wrongKeys: VerificationKeys = {
      ...keys,
      salts: { ...keys.salts, associationTable: undefined },
    };
    const report = await verifyExchangeRecord(record, wrongKeys, {
      data: reconstructed.data,
      localTerms: LOCAL_TERMS,
      partnerTerms: PARTNER_TERMS,
    });
    // Distinct from failed: nothing mismatched, but a commitment is unopenable.
    expect(report.outcome).toBe("incomplete");
    const view = verdictViewModel(report, reconstructed.warnings);
    expect(view.headline.title).toBe("Incomplete");
    const table = view.commitments.find(
      (row) => row.label === "The matched-pairs table",
    );
    expect(table?.status).toBe("Cannot be opened");
    expect(table?.tone).toBe("incomplete");
    expect(table?.explanation).toContain("wrong or drifted keys file");
  });
});

describe("verdictViewModel: no re-supply", () => {
  test("without data or terms, the honest incomplete with per-row supply-your-files copy", async () => {
    const { record, keys } = await fixtures();
    const report = await verifyExchangeRecord(record, keys, {});
    expect(report.outcome).toBe("incomplete");
    const view = verdictViewModel(report, []);
    expect(view.headline.title).toBe("Incomplete");
    // Every commitment is not-opened, framed as "supply your files", not failure.
    for (const row of view.commitments) {
      expect(row.status).toBe("Not opened");
      expect(row.tone).toBe("incomplete");
      expect(row.explanation).toContain("Supply your retained files");
    }
    expect(view.termsHash.status).toBe("Not checked");
    expect(view.termsHash.explanation).toContain("both parties' linkage terms");
    // The unsigned-record caveat is always stated.
    expect(view.signatureNote).toContain(
      "Partner receipt signatures are not checked",
    );
  });
});

describe("verdictViewModel: warnings are sanitized", () => {
  test("a reconstruction warning is passed through the display sanitizer", async () => {
    const { record, keys } = await fixtures();
    const esc = String.fromCharCode(0x1b);
    const report = await verifyExchangeRecord(record, keys, {});
    const view = verdictViewModel(report, [
      `the identifier column "a${esc}[31m" has duplicate values`,
    ]);
    expect(view.warnings).toHaveLength(1);
    expect(view.warnings[0]).not.toContain(esc);
  });
});
