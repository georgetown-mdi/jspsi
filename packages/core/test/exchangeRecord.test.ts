import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  EXCHANGE_KEYS_VERSION,
  EXCHANGE_RECORD_VERSION,
  SALT_BYTES,
  buildExchangeRecord,
  computeCommitment,
  computeTermsHash,
  parseExchangeRecord,
  parseVerificationKeys,
  serializeExchangeRecord,
  serializeVerificationKeys,
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
import {
  MAX_LINKAGE_ENTRIES,
  MAX_NAME_LENGTH,
  MAX_PAYLOAD_ENTRIES,
  MAX_TEXT_LENGTH,
  deriveAcceptedLinkageTerms,
} from "../src/config/linkageTerms";
import {
  DEFAULT_LINKAGE_RULE_SET,
  getDefaultLinkageTerms,
} from "../src/defaults/linkageTerms";

// --- Fixtures ----------------------------------------------------------------

const termsA: LinkageTerms = {
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
  rows: [["10mg"], ["20mg"]],
};
const partnerPayloadReceived: CommittedPayload = {
  columns: ["status"],
  rows: [["active"], [null]],
};

const baseInputs: ExchangeRecordInputs = {
  localTerms: termsA,
  partnerTerms: termsB,
  outcome: "completed",
  recordsExposed: 5,
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
    { name: "ln", type: "last_name" },
    { name: "dob", type: "date_of_birth" },
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

// Inputs that populate every governance channel: a legal agreement, a multi-field
// matching basis, sent and received payload columns, and an association table.
const governanceInputs: ExchangeRecordInputs = {
  ...baseInputs,
  localTerms: termsWithGovernance,
  partnerTerms: { ...termsWithGovernance, identity: "Party B" },
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
  test("every commitment verifies against its salt and the re-supplied data", async () => {
    const { record, keys } = await buildExchangeRecord(
      baseInputs,
      fixedRandomness,
    );
    // The keys carry only salts; verification re-supplies the committed data.
    const { verdicts, allValid } = await verifyRecordCommitments(record, keys, {
      localPayloadSent,
      partnerPayloadReceived,
      associationTable: baseInputs.associationTable,
    });
    expect(allValid).toBe(true);
    expect(verdicts).toEqual({
      localPayloadSent: true,
      partnerPayloadReceived: true,
      associationTable: true,
    });
  });

  test("a present commitment whose data is not re-supplied is a mismatch, not a pass", async () => {
    // The salts-only keys cannot self-open, so a caller that fails to re-supply a
    // present commitment's data must get a mismatch -- never a silent pass. Guards
    // the verify branch that treats missing re-supplied data as invalid.
    const { record, keys } = await buildExchangeRecord(
      baseInputs,
      fixedRandomness,
    );
    const none = await verifyRecordCommitments(record, keys, {});
    expect(none.allValid).toBe(false);
    expect(none.verdicts).toEqual({
      localPayloadSent: false,
      partnerPayloadReceived: false,
      associationTable: false,
    });
    const partial = await verifyRecordCommitments(record, keys, {
      localPayloadSent,
      partnerPayloadReceived,
    });
    expect(partial.allValid).toBe(false);
    expect(partial.verdicts).toEqual({
      localPayloadSent: true,
      partnerPayloadReceived: true,
      associationTable: false,
    });
  });

  test("a commitment fails to verify against tampered data", async () => {
    const { record, keys } = await buildExchangeRecord(
      baseInputs,
      fixedRandomness,
    );
    expect(
      await verifyCommitmentOpening(
        "localPayloadSent",
        keys.salts.localPayloadSent,
        { ...localPayloadSent, rows: [["99mg"], ["20mg"]] },
        record.commitments.localPayloadSent,
      ),
    ).toBe(false);
  });

  test("a commitment cannot be opened to a second dataset (binding)", async () => {
    const { record, keys } = await buildExchangeRecord(
      baseInputs,
      fixedRandomness,
    );
    expect(
      await verifyCommitmentOpening(
        "associationTable",
        keys.salts.associationTable!,
        [
          [9, 9],
          [9, 9],
        ] as CanonicalValue,
        record.commitments.associationTable!,
      ),
    ).toBe(false);
  });

  test("returns false (never throws) for re-supplied data outside the canonical domain", async () => {
    // Fail-safe contract: a verifier fed hostile/garbage data must get a mismatch
    // verdict, not an exception. A bigint is outside the canonical encoding domain,
    // so computeCommitment's canonicalization would throw -- verifyCommitmentOpening
    // must map that to `false`.
    const { record, keys } = await buildExchangeRecord(
      baseInputs,
      fixedRandomness,
    );
    const outOfDomain = 10n as unknown as CanonicalValue;
    await expect(
      verifyCommitmentOpening(
        "localPayloadSent",
        keys.salts.localPayloadSent,
        outOfDomain,
        record.commitments.localPayloadSent,
      ),
    ).resolves.toBe(false);
  });

  test("a commitment of one kind does not verify as another (domain separation)", async () => {
    const sharedSalt = salt(7);
    const data: CanonicalValue = { hasData: false };
    const sentValue = toBase64Url(
      await computeCommitment("localPayloadSent", sharedSalt, data),
    );
    expect(
      await verifyCommitmentOpening(
        "partnerPayloadReceived",
        toBase64Url(sharedSalt),
        data,
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

// --- Records exposed (this party's own input row count) ----------------------

describe("records exposed", () => {
  test("carries this party's own input row count", async () => {
    const { record } = await buildExchangeRecord(
      { ...baseInputs, recordsExposed: 7 },
      fixedRandomness,
    );
    expect(record.recordsExposed).toBe(7);
  });

  test("accepts zero (a party that contributed no records)", async () => {
    // Zero is the lower bound of the valid range: an empty input still produces
    // a record, and its outbound exposure is zero rather than absent.
    const { record } = await buildExchangeRecord(
      { ...baseInputs, recordsExposed: 0 },
      fixedRandomness,
    );
    expect(record.recordsExposed).toBe(0);
  });

  test("is recorded even when the result size is omitted (single-output side)", async () => {
    // The records-exposed count is per-direction and known from this party's own
    // input, so it is present regardless of whether this party is entitled to the
    // intersection size. This is the single-output helper's case: no resultSize,
    // but its own exposure is still recorded.
    const { resultSize: _omit, ...withoutSize } = baseInputs;
    const { record } = await buildExchangeRecord(
      { ...withoutSize, recordsExposed: 4 },
      fixedRandomness,
    );
    expect("resultSize" in record).toBe(false);
    expect(record.recordsExposed).toBe(4);
  });

  test("is rejected on build when negative or not a safe integer", async () => {
    await expect(
      buildExchangeRecord(
        { ...baseInputs, recordsExposed: -1 },
        fixedRandomness,
      ),
    ).rejects.toThrow();
    await expect(
      buildExchangeRecord(
        { ...baseInputs, recordsExposed: Number.MAX_SAFE_INTEGER + 1 },
        fixedRandomness,
      ),
    ).rejects.toThrow();
  });

  test("a record missing it is rejected on parse", async () => {
    const { record } = await buildExchangeRecord(baseInputs, fixedRandomness);
    const { recordsExposed: _drop, ...withoutCount } = record;
    expect(() => parseExchangeRecord(withoutCount)).toThrow();
  });
});

// --- Retention/disposition pointer (self-facing, from local config) ----------

describe("retention/disposition pointer", () => {
  const note =
    "Result filed in Agency A association table links.prod; held 6 years.";

  test("is carried verbatim into the record when supplied", async () => {
    const { record } = await buildExchangeRecord(
      { ...baseInputs, retentionDisposition: note },
      fixedRandomness,
    );
    expect(record.retentionDisposition).toBe(note);
  });

  test("is omitted entirely when not supplied", async () => {
    // baseInputs has no retentionDisposition, so the key is absent (not an empty
    // string): absence is explicit, mirroring resultSize.
    const { record } = await buildExchangeRecord(baseInputs, fixedRandomness);
    expect("retentionDisposition" in record).toBe(false);
  });

  test("is rejected on build when an empty string", async () => {
    // The builder validates with the same schema the parser uses (min length 1),
    // so it cannot emit a record whose pointer is present-but-empty: an absent
    // pointer must be the omitted key.
    await expect(
      buildExchangeRecord(
        { ...baseInputs, retentionDisposition: "" },
        fixedRandomness,
      ),
    ).rejects.toThrow();
  });

  test("does not affect the termsHash or commitments (self-facing, not an agreed term)", async () => {
    // The pointer is sourced from local config, not the agreed terms, so adding it
    // leaves the agreed-terms hash and every commitment byte-identical -- the
    // record differs only by the pointer itself.
    const { record: without } = await buildExchangeRecord(
      baseInputs,
      fixedRandomness,
    );
    const { record: withPointer } = await buildExchangeRecord(
      { ...baseInputs, retentionDisposition: note },
      fixedRandomness,
    );
    expect(withPointer.termsHash).toBe(without.termsHash);
    expect(withPointer.commitments).toEqual(without.commitments);
  });

  test("round-trips through serialize -> parse, and parse rejects an empty pointer", async () => {
    const { record } = await buildExchangeRecord(
      { ...baseInputs, retentionDisposition: note },
      fixedRandomness,
    );
    const parsed = parseExchangeRecord(
      JSON.parse(serializeExchangeRecord(record)),
    );
    expect(parsed).toEqual(record);
    expect(parsed.retentionDisposition).toBe(note);
    // A present-but-empty pointer is invalid on parse, not just on build.
    expect(() =>
      parseExchangeRecord({ ...record, retentionDisposition: "" }),
    ).toThrow();
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
    const { record, keys } = await buildExchangeRecord(
      baseInputs,
      fixedRandomness,
    );
    expect(record.commitments.associationTable).toBeDefined();
    expect(keys.salts.associationTable).toBeDefined();
  });

  test("is absent when this party does not hold the table", async () => {
    const { associationTable: _omit, ...withoutTable } = baseInputs;
    const { record, keys } = await buildExchangeRecord(withoutTable, {
      bindingNonce: salt(0),
      salts: {
        localPayloadSent: salt(1),
        partnerPayloadReceived: salt(2),
      },
    });
    expect(record.commitments.associationTable).toBeUndefined();
    expect(keys.salts.associationTable).toBeUndefined();
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
        { name: "dob", type: "date_of_birth" },
        { name: "ln", type: "last_name" },
        { name: "ssn4", type: "ssn4" },
      ],
      payloadSent: [
        { name: "dose", description: "Administered dose in milligrams." },
      ],
      payloadReceived: [{ name: "status" }],
    });
    // A column the data dictionary does not describe omits the key rather than
    // carrying an undefined one -- a distinction the structural equality above
    // does not make, and one the canonical encoding does.
    expect("description" in record.governance.payloadReceived[0]).toBe(false);
  });

  test("omits the legal agreement when the terms have none", async () => {
    // baseInputs.localTerms (termsA) has no legalAgreement and no payload data
    // dictionary, yet the committed payloads carry columns: the payload categories
    // are read from the committed disclosure, not the (absent) dictionary, so they
    // report the committed columns -- here with bare names, since there is no
    // dictionary to attach descriptions from.
    const { record } = await buildExchangeRecord(baseInputs, fixedRandomness);
    expect("legalAgreement" in record.governance).toBe(false);
    expect(record.governance.algorithm).toBe("psi");
    expect(record.governance.matchingBasis).toEqual([
      { name: "ssn", type: "ssn" },
    ]);
    expect(record.governance.payloadSent).toEqual([{ name: "dose" }]);
    expect(record.governance.payloadReceived).toEqual([{ name: "status" }]);
  });

  test("matching basis covers only the fields the linkage keys reference", async () => {
    // 'email' is a declared linkage field that no linkage key references, so it
    // was not matched on; it must not appear in the matching basis (recording it
    // would overstate the disclosure basis).
    const withUnusedField: LinkageTerms = {
      ...termsA,
      linkageFields: [
        { name: "ssn", type: "ssn" },
        { name: "email", type: "email_address" },
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
    // A count-only exchange commits no payload, so the committed sets are the
    // empty no-data value -- the payload categories are read from those committed
    // sets, so they are empty too.
    const noPayload: CommittedPayload = {
      columns: [],
      rows: [],
    };
    const { record } = await buildExchangeRecord(
      {
        ...baseInputs,
        localTerms: countOnly,
        localPayloadSent: noPayload,
        partnerPayloadReceived: noPayload,
      },
      fixedRandomness,
    );
    expect(record.governance.algorithm).toBe("psi-c");
    expect(record.governance.payloadSent).toEqual([]);
    expect(record.governance.payloadReceived).toEqual([]);
  });

  test("payload categories reflect the committed columns when no data dictionary is authored (web regression)", async () => {
    // The web term builders never populate terms.payload, yet real columns flow
    // through the metadata disclosure gate and are committed. The record must
    // report the committed columns in both directions -- otherwise an accounting
    // of disclosures under-reports what was sent and received.
    const sent: CommittedPayload = {
      columns: ["dose", "visit_date"],
      rows: [["10mg", "2025-02-01"]],
    };
    const received: CommittedPayload = {
      columns: ["status"],
      rows: [["active"]],
    };
    const { record } = await buildExchangeRecord(
      {
        ...baseInputs,
        localTerms: termsA, // no payload dictionary, as the web path produces
        localPayloadSent: sent,
        partnerPayloadReceived: received,
      },
      fixedRandomness,
    );
    expect(record.governance.payloadSent).toEqual([
      { name: "dose" },
      { name: "visit_date" },
    ]);
    expect(record.governance.payloadReceived).toEqual([{ name: "status" }]);
  });

  test("payloadSent follows the committed set, not payload.send, when they differ", async () => {
    // The data dictionary may legitimately under-declare what the metadata gate
    // discloses (a declaration is validated only as a SUBSET of the gate). The
    // committed set is authoritative: a disclosed column absent from payload.send
    // still appears (bare), a declared column keeps its description, and the order
    // is the committed order.
    const sent: CommittedPayload = {
      columns: ["dose", "extra"],
      rows: [["10mg", "x"]],
    };
    const underDeclared: LinkageTerms = {
      ...termsA,
      payload: {
        send: [
          { name: "dose", description: "Administered dose in milligrams." },
        ],
      },
    };
    const { record } = await buildExchangeRecord(
      { ...baseInputs, localTerms: underDeclared, localPayloadSent: sent },
      fixedRandomness,
    );
    expect(record.governance.payloadSent).toEqual([
      { name: "dose", description: "Administered dose in milligrams." },
      { name: "extra" },
    ]);
  });

  test("rejects a committed column name the record schema forbids (empty partner-sent name)", async () => {
    // payloadReceived's names come from the partner's payload wire message, which
    // validates columns only as strings -- looser than the record's non-empty name
    // rule. Build-validating governance turns a malformed partner column name into a
    // throw (the non-fatal build guard in runExchange then skips the record) rather
    // than a silently unparseable audit artifact.
    const badReceived: CommittedPayload = {
      columns: [""],
      rows: [["x"]],
    };
    await expect(
      buildExchangeRecord(
        { ...baseInputs, partnerPayloadReceived: badReceived },
        fixedRandomness,
      ),
    ).rejects.toThrow();
  });

  test("rejects an over-long committed column name on build (partner-sent)", async () => {
    // Same provenance as the empty-name case: a partner-supplied column name is
    // bounded on the wire (payloadExchange.ts), and the record schema bounds it
    // independently so an over-long name cannot reach the on-disk record by any
    // path. A name one character over MAX_NAME_LENGTH is rejected on build.
    const longReceived: CommittedPayload = {
      columns: ["a".repeat(MAX_NAME_LENGTH + 1)],
      rows: [["x"]],
    };
    await expect(
      buildExchangeRecord(
        { ...baseInputs, partnerPayloadReceived: longReceived },
        fixedRandomness,
      ),
    ).rejects.toThrow();
  });

  test("rejects an over-long payload column name on parse (read path)", async () => {
    // The on-disk read safety check: a record whose payloadReceived name
    // exceeds the bound is rejected by parseExchangeRecord, so an over-long
    // name an older or hand-edited file might carry cannot be admitted. A
    // name at the bound parses.
    const { record } = await buildExchangeRecord(
      {
        ...baseInputs,
        partnerPayloadReceived: {
          columns: ["a".repeat(MAX_NAME_LENGTH)],
          rows: [["x"]],
        },
      },
      fixedRandomness,
    );
    expect(() => parseExchangeRecord(record)).not.toThrow();
    const overLong = {
      ...record,
      governance: {
        ...record.governance,
        payloadReceived: [{ name: "a".repeat(MAX_NAME_LENGTH + 1) }],
      },
    };
    expect(() => parseExchangeRecord(overLong)).toThrow();
  });

  // The privacy invariant on the record body: it carries only readable governance
  // metadata (names, types, descriptions, references) and never value-level data
  // (payload row values, linkage-field values, the matched-identifier table),
  // which are committed, never embedded. The next two tests guard that invariant
  // from opposite directions over `governanceInputs`, which populates every
  // governance channel.
  test("governance exposes only allow-listed metadata keys (a new value-bearing field would fail)", async () => {
    // Positive, structural guard: assert governance is a CLOSED allow-list of
    // keys at every level. The realistic regression -- governanceFromTerms
    // (and its schema) growing a field that carries a value -- fails here
    // because the new key is not permitted, without naming a forbidden
    // value. The allow-list is declared independently of the schema on
    // purpose, so adding a governance field forces a fresh judgement here.
    const { record } = await buildExchangeRecord(
      governanceInputs,
      fixedRandomness,
    );
    const onlyKeys = (obj: object, allowed: string[]): void => {
      expect(Object.keys(obj).filter((k) => !allowed.includes(k))).toEqual([]);
    };
    const g = record.governance;
    onlyKeys(g, [
      "algorithm",
      "legalAgreement",
      "matchingBasis",
      "payloadSent",
      "payloadReceived",
    ]);
    onlyKeys(g.legalAgreement!, ["reference", "purpose", "expirationDate"]);
    for (const field of g.matchingBasis) {
      onlyKeys(field, ["name", "type"]);
    }
    for (const col of [...g.payloadSent, ...g.payloadReceived]) {
      onlyKeys(col, ["name", "description"]);
    }
  });

  test("no committed value-level data appears anywhere in the serialized record", async () => {
    // Negative guard: the forbidden values are DERIVED from the committed inputs
    // (every string cell of both payloads), not hardcoded, so the check keeps
    // protecting the invariant as fixtures change. The matched-identifier table is
    // integer indices -- not substring-searchable -- so it is guarded structurally
    // by the absence of the committed-data keys below, not by value.
    const { record } = await buildExchangeRecord(
      governanceInputs,
      fixedRandomness,
    );
    const serialized = serializeExchangeRecord(record);
    const committedValues = [
      ...localPayloadSent.rows.flat(),
      ...partnerPayloadReceived.rows.flat(),
    ].filter((cell): cell is string => typeof cell === "string");
    // Fail loudly if the fixture ever stops carrying committed values, which would
    // turn the loop below into a silent no-op.
    expect(committedValues.length).toBeGreaterThan(0);
    for (const value of committedValues) {
      expect(serialized).not.toContain(value);
    }
    // The committed payloads, their salts, and the opened data must never be
    // embedded; these keys would appear only if a commitment's plaintext leaked
    // into the record body.
    for (const key of ['"rows"', '"rowIndices"', '"salt"', '"data"']) {
      expect(serialized).not.toContain(key);
    }
    // Out of reach by construction: legalAgreement.purpose is operator-supplied
    // free text, copied verbatim and not cross-validated, so a value an operator
    // smuggles into it cannot be detected here. Purpose-text hygiene is an operator
    // responsibility, outside this automated invariant -- named, not hidden.
  });
});

// --- Per-exchange binding nonce ----------------------------------------------

describe("binding nonce", () => {
  test("makes two runs with identical terms produce distinct records", async () => {
    const first = await buildExchangeRecord(baseInputs);
    const second = await buildExchangeRecord(baseInputs);
    expect(first.record.bindingNonce).not.toBe(second.record.bindingNonce);
    expect(first.record.termsHash).toBe(second.record.termsHash);
  });

  test("is distinct from the per-commitment salts", async () => {
    const { record, keys } = await buildExchangeRecord(baseInputs);
    const salts = [
      keys.salts.localPayloadSent,
      keys.salts.partnerPayloadReceived,
      keys.salts.associationTable!,
    ];
    expect(salts).not.toContain(record.bindingNonce);
    expect(new Set(salts).size).toBe(salts.length);
  });
});

// --- The signed receipt's run binder -----------------------------------------

describe("receipt binder", () => {
  const BINDER = toBase64Url(salt(9));

  test("is carried verbatim when the run produced a receipt", async () => {
    const { record } = await buildExchangeRecord(
      { ...baseInputs, receiptBinder: BINDER },
      fixedRandomness,
    );
    expect(record.receiptBinder).toBe(BINDER);
    expect(parseExchangeRecord(record).receiptBinder).toBe(BINDER);
  });

  test("is absent as an omitted key, never an undefined one", async () => {
    // An absent field and a null/undefined field are distinct in the canonical
    // encoding, and the absence is what states that no receipt belongs to this
    // record.
    const { record } = await buildExchangeRecord(baseInputs, fixedRandomness);
    expect("receiptBinder" in record).toBe(false);
    expect(JSON.parse(serializeExchangeRecord(record))).not.toHaveProperty(
      "receiptBinder",
    );
  });

  test("is distinct from the local binding nonce", async () => {
    // Two per-run values with different jobs: the nonce is this party's own and
    // differs between the two parties' records for one run; the receipt binder is
    // the shared value both parties derive, which is what pairs the artifacts.
    const { record } = await buildExchangeRecord(
      { ...baseInputs, receiptBinder: BINDER },
      fixedRandomness,
    );
    expect(record.receiptBinder).not.toBe(record.bindingNonce);
  });

  test("a value that is not base64url is refused at build", async () => {
    await expect(
      buildExchangeRecord(
        { ...baseInputs, receiptBinder: "not base64url" },
        fixedRandomness,
      ),
    ).rejects.toThrow();
  });
});

// --- Untrusted read-path bounds ----------------------------------------------

describe("parse input bounds (untrusted read path)", () => {
  // parseExchangeRecord's first production caller ingests a record supplied by
  // another party, so every partner-controlled string and array carries a
  // generous length / element-count cap. These reject an oversized hostile record
  // at parse -- a string field and an array field each pushed one past its cap --
  // without changing what a legitimate record parses to.
  test("rejects a record whose string field exceeds its length cap", async () => {
    const { record } = await buildExchangeRecord(
      governanceInputs,
      fixedRandomness,
    );
    expect(() => parseExchangeRecord(record)).not.toThrow();
    expect(() =>
      parseExchangeRecord({
        ...record,
        localIdentity: "a".repeat(MAX_TEXT_LENGTH + 1),
      }),
    ).toThrow();
    // A base64url crypto field (the terms hash) past its length cap is rejected
    // even though it is otherwise well-formed base64url. 257 is one past the
    // 256-char base64url cap (MAX_BASE64URL_LENGTH, not exported, so pinned here
    // by value).
    expect(() =>
      parseExchangeRecord({ ...record, termsHash: "a".repeat(257) }),
    ).toThrow();
  });

  test("rejects a record whose array field exceeds its element-count cap", async () => {
    const { record } = await buildExchangeRecord(
      governanceInputs,
      fixedRandomness,
    );
    // payloadSent padded one past MAX_PAYLOAD_ENTRIES is rejected before
    // per-element validation (boundedArray), so a hostile record cannot force
    // proportional allocation.
    const overCountPayload = Array.from(
      { length: MAX_PAYLOAD_ENTRIES + 1 },
      (_, i) => ({ name: `c${i}` }),
    );
    expect(() =>
      parseExchangeRecord({
        ...record,
        governance: { ...record.governance, payloadSent: overCountPayload },
      }),
    ).toThrow();
    const overCountBasis = Array.from(
      { length: MAX_LINKAGE_ENTRIES + 1 },
      (_, i) => ({ name: `f${i}`, type: "t" }),
    );
    expect(() =>
      parseExchangeRecord({
        ...record,
        governance: { ...record.governance, matchingBasis: overCountBasis },
      }),
    ).toThrow();
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

  test("a record carrying a legal-agreement purpose round-trips intact", async () => {
    // baseInputs.localTerms (termsA) has no legalAgreement, so the round-trip
    // above never exercises the parser against a record with a purpose. Build
    // from the governance-bearing terms so parseExchangeRecord validates the
    // mandatory purpose -- a regression dropping it from RecordLegalAgreementSchema
    // would appear here.
    const { record } = await buildExchangeRecord(
      { ...baseInputs, localTerms: termsWithGovernance },
      fixedRandomness,
    );
    const parsed = parseExchangeRecord(
      JSON.parse(serializeExchangeRecord(record)),
    );
    expect(parsed).toEqual(record);
    expect(parsed.governance.legalAgreement?.purpose).toBe(
      "Care coordination for co-enrolled patients",
    );
  });

  test("the verification keys round-trip through serialize -> parse", async () => {
    const { keys } = await buildExchangeRecord(baseInputs, fixedRandomness);
    const parsed = parseVerificationKeys(
      JSON.parse(serializeVerificationKeys(keys)),
    );
    expect(parsed).toEqual(keys);
    expect(parsed.version).toBe(EXCHANGE_KEYS_VERSION);
  });

  test("the verification keys carry only salts -- no committed data snapshot", async () => {
    // The core privacy property of this format: the keys hold per-commitment
    // salts and nothing else, so the matched data is never persisted here. Guard
    // it both structurally (only a version and a salts map) and by asserting no
    // committed value or data-bearing key survives in the serialized keys.
    const { keys } = await buildExchangeRecord(baseInputs, fixedRandomness);
    expect(Object.keys(keys).sort()).toEqual(["salts", "version"]);
    for (const salt of Object.values(keys.salts))
      expect(typeof salt).toBe("string");
    const serialized = serializeVerificationKeys(keys);
    const committedValues = [
      ...localPayloadSent.rows.flat(),
      ...partnerPayloadReceived.rows.flat(),
    ].filter((cell): cell is string => typeof cell === "string");
    expect(committedValues.length).toBeGreaterThan(0);
    for (const value of committedValues)
      expect(serialized).not.toContain(value);
    // The snapshot's data-bearing keys must not appear -- only salts remain.
    for (const key of ['"data"', '"rows"', '"rowIndices"', '"columns"'])
      expect(serialized).not.toContain(key);
  });

  test("parseExchangeRecord rejects an unrecognized version", async () => {
    const { record } = await buildExchangeRecord(baseInputs, fixedRandomness);
    const bumped = { ...record, version: "psilink-exchange-record/v7" };
    expect(() => parseExchangeRecord(bumped)).toThrow();
  });

  test("parseExchangeRecord refuses a record written before the run outcome", async () => {
    // The v5 shape: no outcome, which a reader of this version would take as a
    // record its writer never made a completion claim on. A v5 writer produced a
    // record only for a run that finished, so reading its silence either way
    // states something it did not -- refused on the version discriminant, like
    // the shapes above.
    const { record } = await buildExchangeRecord(baseInputs, fixedRandomness);
    const v5 = { ...record, version: "psilink-exchange-record/v5" };
    expect(() => parseExchangeRecord(v5)).toThrow();
  });

  test("a terminated run's record states its outcome and round-trips", async () => {
    // The record a swap failure leaves behind: it carries the run's binder (the
    // partner may hold a receipt bearing it) while stating that this party
    // exchanged no receipt, so a reader tells it from a completed run's without
    // consulting anything outside the artifact.
    const binder = toBase64Url(salt(11));
    const { record } = await buildExchangeRecord(
      {
        ...baseInputs,
        outcome: "receipt-swap-terminated",
        receiptBinder: binder,
      },
      fixedRandomness,
    );
    expect(record.outcome).toBe("receipt-swap-terminated");
    expect(record.receiptBinder).toBe(binder);
    const reparsed = parseExchangeRecord(
      JSON.parse(serializeExchangeRecord(record)),
    );
    expect(reparsed).toEqual(record);
    const completed = await buildExchangeRecord(baseInputs, fixedRandomness);
    expect(completed.record.outcome).toBe("completed");
  });

  test("buildExchangeRecord refuses an outcome the format does not carry", async () => {
    await expect(
      buildExchangeRecord(
        {
          ...baseInputs,
          outcome: "finished" as ExchangeRecordInputs["outcome"],
        },
        fixedRandomness,
      ),
    ).rejects.toThrow();
  });

  test("parseExchangeRecord refuses a record written before the run binder", async () => {
    // The v1 shape: no receiptBinder, which a reader cannot tell from an exchange
    // that produced no signed receipt. Refused on the version discriminant rather
    // than read as unpaired, so a pre-change artifact is a version refusal and not
    // a pairing failure. Pre-release, no migration is offered.
    const { record } = await buildExchangeRecord(baseInputs, fixedRandomness);
    const v1 = { ...record, version: "psilink-exchange-record/v1" };
    expect(() => parseExchangeRecord(v1)).toThrow();
  });

  test("parseExchangeRecord refuses a record written before the rule-set citation", async () => {
    // The v2 shape: a governance block with no linkageRuleSet, which a reader of
    // this version would take as "the agreed terms cited no named rule set" --
    // not what a writer that could not cite one meant. Refused on the version
    // discriminant for the same reason the run binder above is.
    const { record } = await buildExchangeRecord(baseInputs, fixedRandomness);
    const v2 = { ...record, version: "psilink-exchange-record/v2" };
    expect(() => parseExchangeRecord(v2)).toThrow();
  });

  test("parseExchangeRecord refuses a record written before the citation verdict", async () => {
    // The v3 shape: a governance block that could carry a citation but never a
    // verdict on it. A reader of this version takes a citation with no verdict
    // beside it as a writer that checked and reached nothing, where a v3 writer
    // ran no check at all -- so it is refused on the version discriminant, like
    // the two shapes above.
    const { record } = await buildExchangeRecord(baseInputs, fixedRandomness);
    const v3 = { ...record, version: "psilink-exchange-record/v3" };
    expect(() => parseExchangeRecord(v3)).toThrow();
  });

  test("a record carries the agreed terms' rule-set citation, and omits it when the terms cite none", async () => {
    const cited = await buildExchangeRecord(
      {
        ...baseInputs,
        localTerms: {
          ...baseInputs.localTerms,
          linkageRuleSet: {
            fieldSet: { name: "baseline-pii", version: "1.0.0" },
            keySet: { name: "hmis-keys", version: "1.0.0" },
          },
        },
      },
      fixedRandomness,
    );
    expect(cited.record.governance.linkageRuleSet).toEqual({
      fieldSet: { name: "baseline-pii", version: "1.0.0" },
      keySet: { name: "hmis-keys", version: "1.0.0" },
    });
    // Round-trips through the on-disk form rather than only the built object.
    expect(
      parseExchangeRecord(JSON.parse(serializeExchangeRecord(cited.record)))
        .governance.linkageRuleSet,
    ).toEqual(cited.record.governance.linkageRuleSet);

    // Absent by omission, not by an explicit null: an absent key and a null key
    // are distinct in the canonical encoding a record is hashed over.
    const uncited = await buildExchangeRecord(baseInputs, fixedRandomness);
    expect("linkageRuleSet" in uncited.record.governance).toBe(false);
    expect("linkageRuleSetVerdict" in uncited.record.governance).toBe(false);
  });

  test("a citation this build disproves is recorded verbatim, with a contradicted verdict beside it", async () => {
    // termsA declares one field and one key of its own, and cites both built-in
    // sets over them: the citation this build ships those sets and can therefore
    // resolve, and disprove.
    const { record } = await buildExchangeRecord(
      {
        ...baseInputs,
        localTerms: {
          ...baseInputs.localTerms,
          linkageRuleSet: {
            fieldSet: { name: "baseline-pii", version: "1.0.0" },
            keySet: { name: "hmis-keys", version: "1.0.0" },
          },
        },
      },
      fixedRandomness,
    );
    // Verbatim: the refuted claim is annotated, never dropped or rewritten, so
    // the record still states what the declaring party claimed.
    expect(record.governance.linkageRuleSet).toEqual({
      fieldSet: { name: "baseline-pii", version: "1.0.0" },
      keySet: { name: "hmis-keys", version: "1.0.0" },
    });
    expect(record.governance.linkageRuleSetVerdict).toEqual({
      fieldSet: "contradicted",
      keySet: "contradicted",
    });
    expect(
      parseExchangeRecord(JSON.parse(serializeExchangeRecord(record)))
        .governance.linkageRuleSetVerdict,
    ).toEqual({ fieldSet: "contradicted", keySet: "contradicted" });
  });

  test("a truthful citation is recorded consistent, and an unresolvable one unchecked", async () => {
    const drawnFromDefaults = getDefaultLinkageTerms("Party A");
    const truthful = await buildExchangeRecord(
      {
        ...baseInputs,
        localTerms: drawnFromDefaults,
        partnerTerms: { ...drawnFromDefaults, identity: "Party B" },
      },
      fixedRandomness,
    );
    expect(truthful.record.governance.linkageRuleSet).toEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
    expect(truthful.record.governance.linkageRuleSetVerdict).toEqual({
      fieldSet: "consistent",
      keySet: "consistent",
    });

    // A set name this build does not ship resolves to nothing, so nothing is
    // compared: the citation is carried exactly as before and reported unchecked,
    // never contradicted. Nothing here resolves a partner's set name.
    const foreign = await buildExchangeRecord(
      {
        ...baseInputs,
        localTerms: {
          ...drawnFromDefaults,
          linkageRuleSet: {
            fieldSet: { name: "county-pii", version: "3.1.0" },
            keySet: { name: "county-keys", version: "3.1.0" },
          },
        },
      },
      fixedRandomness,
    );
    expect(foreign.record.governance.linkageRuleSet).toEqual({
      fieldSet: { name: "county-pii", version: "3.1.0" },
      keySet: { name: "county-keys", version: "3.1.0" },
    });
    expect(foreign.record.governance.linkageRuleSetVerdict).toEqual({
      fieldSet: "unchecked",
      keySet: "unchecked",
    });
  });

  test("the acceptor's record verdict is reached on the same rule as the inviter's", async () => {
    // Both parties' record writes read this party's OWN agreed terms, so the
    // acceptor -- whose terms carry the inviter's citation as adopted -- reaches
    // the verdict the inviter's own record carries for the same document.
    const inviterTerms: LinkageTerms = {
      ...baseInputs.localTerms,
      linkageRuleSet: {
        fieldSet: { name: "baseline-pii", version: "1.0.0" },
        keySet: { name: "hmis-keys", version: "1.0.0" },
      },
    };
    const accepted = deriveAcceptedLinkageTerms(inviterTerms, "Party B");
    expect(accepted.linkageRuleSet).toEqual(inviterTerms.linkageRuleSet);
    const inviterRecord = await buildExchangeRecord(
      { ...baseInputs, localTerms: inviterTerms, partnerTerms: accepted },
      fixedRandomness,
    );
    const acceptorRecord = await buildExchangeRecord(
      { ...baseInputs, localTerms: accepted, partnerTerms: inviterTerms },
      fixedRandomness,
    );
    expect(acceptorRecord.record.governance.linkageRuleSetVerdict).toEqual(
      inviterRecord.record.governance.linkageRuleSetVerdict,
    );
    expect(acceptorRecord.record.governance.linkageRuleSetVerdict).toEqual({
      fieldSet: "contradicted",
      keySet: "contradicted",
    });
  });

  test("a citation and its verdict are refused apart", async () => {
    const { record } = await buildExchangeRecord(
      {
        ...baseInputs,
        localTerms: getDefaultLinkageTerms("Party A"),
      },
      fixedRandomness,
    );
    const { linkageRuleSetVerdict, ...withoutVerdict } = record.governance;
    expect(linkageRuleSetVerdict).toBeDefined();
    expect(() =>
      parseExchangeRecord({ ...record, governance: withoutVerdict }),
    ).toThrow();
    const { linkageRuleSet, ...withoutCitation } = record.governance;
    expect(linkageRuleSet).toBeDefined();
    expect(() =>
      parseExchangeRecord({ ...record, governance: withoutCitation }),
    ).toThrow();
  });

  test("a verdict outside the recognized three is refused", async () => {
    const { record } = await buildExchangeRecord(
      {
        ...baseInputs,
        localTerms: getDefaultLinkageTerms("Party A"),
      },
      fixedRandomness,
    );
    expect(() =>
      parseExchangeRecord({
        ...record,
        governance: {
          ...record.governance,
          linkageRuleSetVerdict: { fieldSet: "verified", keySet: "consistent" },
        },
      }),
    ).toThrow();
  });
});

// --- Cross-implementation reproducibility vectors ----------------------------
//
// The checked-in vectors are the cross-implementation contract: any independent
// implementation (CLI, web, or a third party) that builds a record from the
// same `inputs` and `randomness` must reproduce the exact `record` and
// `keys`. The companion browser suite
// (apps/web/test/browser/exchangeRecord.test.ts) runs the same vectors so Node
// and the browser are proven to produce byte-identical output.

interface RecordVector {
  name: string;
  description: string;
  inputs: ExchangeRecordInputs;
  randomness: { bindingNonce: string; salts: Record<string, string> };
  record: unknown;
  keys: unknown;
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
    "$name: build reproduces the checked-in record and keys",
    async (vector) => {
      const { record, keys } = await buildExchangeRecord(
        vector.inputs,
        randomnessFromVector(vector),
      );
      expect(record).toEqual(vector.record);
      expect(keys).toEqual(vector.keys);
      const { allValid } = await verifyRecordCommitments(record, keys, {
        localPayloadSent: vector.inputs.localPayloadSent,
        partnerPayloadReceived: vector.inputs.partnerPayloadReceived,
        associationTable: vector.inputs.associationTable,
      });
      expect(allValid).toBe(true);
    },
  );
});
