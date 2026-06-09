import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  EXCHANGE_OPENING_VERSION,
  EXCHANGE_RECORD_VERSION,
  SALT_BYTES,
  buildExchangeRecord,
  computeCommitment,
  computeTermsHash,
  parseExchangeRecord,
  parseOpeningData,
  serializeExchangeRecord,
  serializeOpeningData,
  verifyCommitmentOpening,
  verifyRecordCommitments,
} from "../src/exchangeRecord";
import { fromBase64Url, randomBytes, toBase64Url } from "../src/utils/crypto";

import type {
  CommittedPayload,
  ExchangeRecordInputs,
  ExchangeRecordRandomness,
} from "../src/exchangeRecord";
import type { CanonicalValue } from "../src/utils/canonical";
import type { LinkageTerms } from "../src/config/linkageTerms";

// --- Fixtures ----------------------------------------------------------------

const termsA: LinkageTerms = {
  version: "1.0.0",
  identity: "Party A",
  date: "2025-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

const termsB: LinkageTerms = { ...termsA, identity: "Party B" };

// A fixed-length salt of repeated byte `b`, so a record build is deterministic.
const salt = (b: number): Uint8Array<ArrayBuffer> =>
  new Uint8Array(SALT_BYTES).fill(b);

const fixedRandomness: ExchangeRecordRandomness = {
  bindingNonce: salt(0),
  salts: {
    localPayloadSent: salt(1),
    partnerPayloadReceived: salt(2),
    associationTable: salt(3),
  },
};

// Both payloads are in the record's canonical committed form (no transport
// `hasData` tag); a sender and receiver commit over byte-identical data for the
// same logical payload.
const localPayloadSent: CommittedPayload = {
  columns: ["dose"],
  rowIndices: [0, 2],
  rows: [["10mg"], ["20mg"]],
};
const partnerPayloadReceived: CommittedPayload = {
  columns: ["status"],
  rowIndices: [1, 0],
  rows: [["active"], [null]],
};

const baseInputs: ExchangeRecordInputs = {
  localTerms: termsA,
  partnerTerms: termsB,
  resultSize: 2,
  associationTable: [
    [0, 2],
    [1, 0],
  ],
  localPayloadSent,
  partnerPayloadReceived,
  createdAt: "2026-01-02T03:04:05.000Z",
};

// Terms carrying the optional governance inputs: a legal agreement, several
// linkage fields (out of name order, to exercise the matchingBasis sort) all
// referenced by one key, and payload columns with and without a description.
const termsWithGovernance: LinkageTerms = {
  ...termsA,
  algorithm: "psi",
  linkageFields: [
    { name: "ln", type: "lastName" },
    { name: "dob", type: "dateOfBirth" },
    { name: "ssn4", type: "ssn4" },
  ],
  linkageKeys: [
    {
      name: "NAME_DOB_SSN4",
      elements: [{ field: "ln" }, { field: "dob" }, { field: "ssn4" }],
    },
  ],
  legalAgreement: {
    reference: "MOU-2025-0042",
    purpose: "Care coordination for co-enrolled patients",
    expirationDate: "2030-06-30",
  },
  payload: {
    send: [{ name: "dose", description: "Administered dose in milligrams." }],
    receive: [{ name: "status" }],
  },
};

// --- Agreed-terms hash -------------------------------------------------------

describe("computeTermsHash", () => {
  test("is identical for both parties given the same agreed terms", async () => {
    // Each party orders the pair as (local, partner); the canonical-sorted
    // ordering inside computeTermsHash makes both derive the same hash.
    const fromA = await computeTermsHash(termsA, termsB);
    const fromB = await computeTermsHash(termsB, termsA);
    expect(fromA).toBe(fromB);
  });

  test("differs when either party's terms differ", async () => {
    const baseline = await computeTermsHash(termsA, termsB);
    const changedKey = await computeTermsHash(termsA, {
      ...termsB,
      linkageKeys: [{ name: "SSN4", elements: [{ field: "ssn4" }] }],
    });
    expect(changedKey).not.toBe(baseline);
  });
});

// --- Commitment correctness, tamper-resistance, binding ----------------------

describe("commitments", () => {
  test("every commitment verifies against its opened (salt, data) pair", async () => {
    const { record, opening } = await buildExchangeRecord(
      baseInputs,
      fixedRandomness,
    );
    const { verdicts, allValid } = await verifyRecordCommitments(
      record,
      opening,
    );
    expect(allValid).toBe(true);
    expect(verdicts).toEqual({
      localPayloadSent: true,
      partnerPayloadReceived: true,
      associationTable: true,
    });
  });

  test("a commitment fails to verify against tampered data", async () => {
    const { record, opening } = await buildExchangeRecord(
      baseInputs,
      fixedRandomness,
    );
    const tampered = {
      salt: opening.commitments.localPayloadSent.salt,
      data: { ...localPayloadSent, rows: [["99mg"], ["20mg"]] },
    };
    expect(
      await verifyCommitmentOpening(
        "localPayloadSent",
        tampered,
        record.commitments.localPayloadSent,
      ),
    ).toBe(false);
  });

  test("a commitment cannot be opened to a second dataset (binding)", async () => {
    const { record, opening } = await buildExchangeRecord(
      baseInputs,
      fixedRandomness,
    );
    // Reuse the real salt but a different data set: the committer cannot open
    // the same commitment to a second association table.
    const secondDataset = {
      salt: opening.commitments.associationTable!.salt,
      data: [
        [9, 9],
        [9, 9],
      ] as CanonicalValue,
    };
    expect(
      await verifyCommitmentOpening(
        "associationTable",
        secondDataset,
        record.commitments.associationTable!,
      ),
    ).toBe(false);
  });

  test("a commitment of one kind does not verify as another (domain separation)", async () => {
    const sharedSalt = salt(7);
    const data: CanonicalValue = { hasData: false };
    const sentValue = toBase64Url(
      await computeCommitment("localPayloadSent", sharedSalt, data),
    );
    // Same salt, same data, different domain -> different commitment.
    expect(
      await verifyCommitmentOpening(
        "partnerPayloadReceived",
        { salt: toBase64Url(sharedSalt), data },
        sentValue,
      ),
    ).toBe(false);
  });

  test("does not match a brute-force guess of low-entropy data without the salt", async () => {
    // A low-entropy committed value (one boolean-ish cell). An attacker who
    // guesses the data correctly still cannot reproduce the commitment without
    // the secret salt: recomputing under any other salt never matches.
    const lowEntropy: CanonicalValue = {
      hasData: true,
      columns: ["match"],
      rowIndices: [0],
      rows: [["yes"]],
    };
    const secretSalt = randomBytes(SALT_BYTES);
    const value = toBase64Url(
      await computeCommitment("localPayloadSent", secretSalt, lowEntropy),
    );
    for (let i = 0; i < 64; i++) {
      const guessSalt = randomBytes(SALT_BYTES);
      const guess = toBase64Url(
        await computeCommitment("localPayloadSent", guessSalt, lowEntropy),
      );
      expect(guess).not.toBe(value);
    }
  });
});

// --- Result-size gating (at the record-build boundary) -----------------------

describe("result size", () => {
  test("is present when supplied (both parties learn it)", async () => {
    const { record } = await buildExchangeRecord(
      { ...baseInputs, resultSize: 5 },
      fixedRandomness,
    );
    expect(record.resultSize).toBe(5);
  });

  test("is omitted entirely when not supplied", async () => {
    const { resultSize: _omit, ...withoutSize } = baseInputs;
    const { record } = await buildExchangeRecord(withoutSize, fixedRandomness);
    expect("resultSize" in record).toBe(false);
  });

  test("is rejected on build when negative or not a safe integer", async () => {
    // The builder validates with the same schema the parser uses, so it cannot
    // emit a record the parser would reject or that cannot canonically encode.
    await expect(
      buildExchangeRecord({ ...baseInputs, resultSize: -1 }, fixedRandomness),
    ).rejects.toThrow();
    await expect(
      buildExchangeRecord(
        { ...baseInputs, resultSize: Number.MAX_SAFE_INTEGER + 1 },
        fixedRandomness,
      ),
    ).rejects.toThrow();
  });
});

// --- Identity validation (at the record-build boundary) ----------------------

describe("identities", () => {
  test("an empty identity is rejected on build", async () => {
    // The builder validates the identities with the same schema the parser uses
    // (z.string().min(1)), so it cannot emit a record the parser would reject.
    await expect(
      buildExchangeRecord(
        { ...baseInputs, localTerms: { ...termsA, identity: "" } },
        fixedRandomness,
      ),
    ).rejects.toThrow();
    await expect(
      buildExchangeRecord(
        { ...baseInputs, partnerTerms: { ...termsB, identity: "" } },
        fixedRandomness,
      ),
    ).rejects.toThrow();
  });
});

// --- Association-table commitment presence -----------------------------------

describe("association-table commitment", () => {
  test("is present when this party holds the table", async () => {
    const { record, opening } = await buildExchangeRecord(
      baseInputs,
      fixedRandomness,
    );
    expect(record.commitments.associationTable).toBeDefined();
    expect(opening.commitments.associationTable).toBeDefined();
  });

  test("is absent when this party does not hold the table", async () => {
    const { associationTable: _omit, ...withoutTable } = baseInputs;
    const { record, opening } = await buildExchangeRecord(withoutTable, {
      bindingNonce: salt(0),
      salts: {
        localPayloadSent: salt(1),
        partnerPayloadReceived: salt(2),
      },
    });
    expect(record.commitments.associationTable).toBeUndefined();
    expect(opening.commitments.associationTable).toBeUndefined();
    // Payload commitments are still produced.
    expect(record.commitments.localPayloadSent).toBeDefined();
    expect(record.commitments.partnerPayloadReceived).toBeDefined();
  });
});

// --- Governance metadata -----------------------------------------------------

describe("governance metadata", () => {
  test("is populated from terms that carry a legal agreement", async () => {
    const { record } = await buildExchangeRecord(
      { ...baseInputs, localTerms: termsWithGovernance },
      fixedRandomness,
    );
    expect(record.governance).toEqual({
      algorithm: "psi",
      legalAgreement: {
        reference: "MOU-2025-0042",
        purpose: "Care coordination for co-enrolled patients",
        expirationDate: "2030-06-30",
      },
      // Standardized name + semantic type per field, sorted by name (dob < ln <
      // ssn4), regardless of the order they were declared in.
      matchingBasis: [
        { name: "dob", type: "dateOfBirth" },
        { name: "ln", type: "lastName" },
        { name: "ssn4", type: "ssn4" },
      ],
      payloadSent: [
        { name: "dose", description: "Administered dose in milligrams." },
      ],
      payloadReceived: [{ name: "status" }],
    });
  });

  test("omits the legal agreement when the terms have none", async () => {
    // baseInputs.localTerms (termsA) has no legalAgreement and no payload.
    const { record } = await buildExchangeRecord(baseInputs, fixedRandomness);
    expect("legalAgreement" in record.governance).toBe(false);
    expect(record.governance.algorithm).toBe("psi");
    expect(record.governance.matchingBasis).toEqual([
      { name: "ssn", type: "ssn" },
    ]);
    expect(record.governance.payloadSent).toEqual([]);
    expect(record.governance.payloadReceived).toEqual([]);
  });

  test("matching basis covers only the fields the linkage keys reference", async () => {
    // 'email' is a declared linkage field that no linkage key references, so it
    // was not matched on; it must not appear in the matching basis (recording it
    // would overstate the disclosure basis).
    const withUnusedField: LinkageTerms = {
      ...termsA,
      linkageFields: [
        { name: "ssn", type: "ssn" },
        { name: "email", type: "emailAddress" },
      ],
      linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
    };
    const { record } = await buildExchangeRecord(
      { ...baseInputs, localTerms: withUnusedField },
      fixedRandomness,
    );
    expect(record.governance.matchingBasis).toEqual([
      { name: "ssn", type: "ssn" },
    ]);
  });

  test("represents the no-payload count-only (psi-c) case explicitly", async () => {
    const countOnly: LinkageTerms = { ...termsA, algorithm: "psi-c" };
    const { record } = await buildExchangeRecord(
      { ...baseInputs, localTerms: countOnly },
      fixedRandomness,
    );
    expect(record.governance.algorithm).toBe("psi-c");
    // Empty arrays, not omission: the no-payload case is recorded explicitly.
    expect(record.governance.payloadSent).toEqual([]);
    expect(record.governance.payloadReceived).toEqual([]);
  });

  test("carries data-dictionary descriptions when present and bare names otherwise", async () => {
    const { record } = await buildExchangeRecord(
      { ...baseInputs, localTerms: termsWithGovernance },
      fixedRandomness,
    );
    expect(record.governance.payloadSent).toEqual([
      { name: "dose", description: "Administered dose in milligrams." },
    ]);
    // 'status' has no description -> the key is omitted, not set to undefined.
    expect(record.governance.payloadReceived).toEqual([{ name: "status" }]);
    expect("description" in record.governance.payloadReceived[0]).toBe(false);
  });

  test("contains no value-level data -- only names, categories, descriptions, references", async () => {
    const { record } = await buildExchangeRecord(
      {
        ...baseInputs,
        localTerms: termsWithGovernance,
        partnerTerms: { ...termsWithGovernance, identity: "Party B" },
      },
      fixedRandomness,
    );
    const serialized = serializeExchangeRecord(record);
    // The payload row values and the matched-identifier table are committed, not
    // embedded; they live only in the opening data, never in the record.
    for (const value of ["10mg", "20mg", "active"]) {
      expect(serialized).not.toContain(value);
    }
    // None of the value-bearing keys (committed rows, indices, salts, opened
    // data) appear in the record at all.
    for (const key of ['"rows"', '"rowIndices"', '"salt"', '"data"']) {
      expect(serialized).not.toContain(key);
    }
  });
});

// --- Per-exchange binding nonce ----------------------------------------------

describe("binding nonce", () => {
  test("makes two runs with identical terms produce distinct records", async () => {
    const first = await buildExchangeRecord(baseInputs);
    const second = await buildExchangeRecord(baseInputs);
    expect(first.record.bindingNonce).not.toBe(second.record.bindingNonce);
    // Same agreed terms still hash identically across the two runs.
    expect(first.record.termsHash).toBe(second.record.termsHash);
  });

  test("is distinct from the per-commitment salts", async () => {
    const { record, opening } = await buildExchangeRecord(baseInputs);
    const salts = [
      opening.commitments.localPayloadSent.salt,
      opening.commitments.partnerPayloadReceived.salt,
      opening.commitments.associationTable!.salt,
    ];
    expect(salts).not.toContain(record.bindingNonce);
    // And the per-commitment salts are independent of one another.
    expect(new Set(salts).size).toBe(salts.length);
  });
});

// --- Serialize / parse round-trip --------------------------------------------

describe("serialize / parse", () => {
  test("the record round-trips through serialize -> parse", async () => {
    const { record } = await buildExchangeRecord(baseInputs, fixedRandomness);
    const parsed = parseExchangeRecord(
      JSON.parse(serializeExchangeRecord(record)),
    );
    expect(parsed).toEqual(record);
    expect(parsed.version).toBe(EXCHANGE_RECORD_VERSION);
  });

  test("the opening data round-trips through serialize -> parse", async () => {
    const { opening } = await buildExchangeRecord(baseInputs, fixedRandomness);
    const parsed = parseOpeningData(JSON.parse(serializeOpeningData(opening)));
    expect(parsed).toEqual(opening);
    expect(parsed.version).toBe(EXCHANGE_OPENING_VERSION);
  });

  test("parseExchangeRecord rejects an unrecognized version", async () => {
    const { record } = await buildExchangeRecord(baseInputs, fixedRandomness);
    const bumped = { ...record, version: "psilink-exchange-record/v2" };
    expect(() => parseExchangeRecord(bumped)).toThrow();
  });
});

// --- Cross-implementation reproducibility vectors ----------------------------
//
// The checked-in vectors are the cross-implementation contract: any independent
// implementation (CLI, web, or a third party) that builds a record from the
// same `inputs` and `randomness` must reproduce the exact `record` and
// `opening`. The companion browser suite
// (apps/web/test/browser/exchangeRecord.test.ts) runs the same vectors so Node
// and the browser are proven to produce byte-identical output.

interface RecordVector {
  name: string;
  description: string;
  inputs: ExchangeRecordInputs;
  randomness: { bindingNonce: string; salts: Record<string, string> };
  record: unknown;
  opening: unknown;
}

const { vectors } = JSON.parse(
  readFileSync(
    new URL("./vectors/exchange-record-vectors.json", import.meta.url),
    { encoding: "utf8" },
  ),
) as { vectors: RecordVector[] };

function randomnessFromVector(v: RecordVector): ExchangeRecordRandomness {
  const salts: ExchangeRecordRandomness["salts"] = {};
  for (const [name, value] of Object.entries(v.randomness.salts))
    salts[name as keyof typeof salts] = fromBase64Url(value);
  return { bindingNonce: fromBase64Url(v.randomness.bindingNonce), salts };
}

describe("exchange-record-vectors.json", () => {
  test("the vector file is non-empty", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  test.each(vectors)(
    "$name: build reproduces the checked-in record and opening",
    async (vector) => {
      const { record, opening } = await buildExchangeRecord(
        vector.inputs,
        randomnessFromVector(vector),
      );
      expect(record).toEqual(vector.record);
      expect(opening).toEqual(vector.opening);
      const { allValid } = await verifyRecordCommitments(record, opening);
      expect(allValid).toBe(true);
    },
  );
});
