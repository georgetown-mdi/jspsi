import { describe, expect, test } from "vitest";

import {
  EXCHANGE_RECORD_VERSION,
  SIGNED_RECEIPT_VERSION,
  buildExchangeRecord,
  computeCertificateFingerprint,
  deriveOurIdColumn,
  generateSigningIdentity,
  reconstructCommittedData,
  serializeCertificate,
  serializeDualSignedRecord,
  serializeExchangeRecord,
  serializeSigningIdentity,
  serializeVerificationKeys,
  signReceiptContent,
  toRetainedResult,
  verifyExchangeRecord,
} from "@psilink/core";

import {
  parseCertificateDocument,
  parseKeysDocument,
  parseRecordDocument,
  parseSignedRecordDocument,
  pinnedFingerprintProblem,
  signedVerdictViewModel,
  verdictViewModel,
  verifySignedRecord,
} from "@bench/verifyReceiptModel";

import type {
  AssociationTable,
  CanonicalValue,
  CommittedPayload,
  DualSignedRecord,
  DualSignedRecordVerificationReport,
  ExchangeRecord,
  LinkageTerms,
  ReceiptContent,
  SignedReceiptPartyReport,
  SigningIdentity,
  VerificationKeys,
} from "@psilink/core";

type ExchangeRecordInputs = Parameters<typeof buildExchangeRecord>[0];

// A small exchange keyed on an identifier column: two parties, one shared
// payload column each way, and an association table. The re-supply files below
// reproduce exactly these committed bytes.
/** Each fixture party's own name, held apart from the terms: `identity` is
 * optional there, so reading it back would type as possibly absent where these
 * bind a certificate to a party this suite knows is named. */
const LOCAL_IDENTITY = "Party A";
const PARTNER_IDENTITY = "Party B";

const LOCAL_TERMS: LinkageTerms = {
  version: "1.0.0",
  identity: LOCAL_IDENTITY,
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};
const PARTNER_TERMS: LinkageTerms = {
  ...LOCAL_TERMS,
  identity: PARTNER_IDENTITY,
};

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

// The run binder the record fixture and the dual-signed record fixture below both
// carry, so the two artifacts pair as one run. One constant, so a fixture cannot
// drift into an accidental cross-run pair.
const RECEIPT_BINDER = "YmluZGVy";

const baseInputs: ExchangeRecordInputs = {
  outcome: "completed",
  localTerms: LOCAL_TERMS,
  partnerTerms: PARTNER_TERMS,
  recordsExposed: 2,
  localPayloadSent,
  partnerPayloadReceived,
  associationTable,
  createdAt: "2026-01-02T03:04:05.000Z",
  receiptBinder: RECEIPT_BINDER,
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
    // The version a record written before the run binder carries: refused as its
    // own outcome, naming the version this build recognizes, rather than read as a
    // record whose absent binder leaves a receipt unpaired.
    const { record } = await fixtures();
    const bumped = JSON.stringify({
      ...record,
      version: "psilink-exchange-record/v1",
    });
    const parsed = parseRecordDocument(bumped);
    expect(parsed.kind).toBe("unrecognized-version");
    if (parsed.kind === "unrecognized-version") {
      expect(parsed.message).toContain("does not recognize");
      expect(parsed.message).toContain(EXCHANGE_RECORD_VERSION);
    }
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
    const original = record.commitments.localPayloadSent;
    const altered = (original[0] === "A" ? "B" : "A") + original.slice(1);
    const tampered: ExchangeRecord = {
      ...record,
      commitments: {
        ...record.commitments,
        localPayloadSent: altered,
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

// The result size is the one disclosure figure no commitment covers, so the page
// has to show what verification recounted about it -- and show nothing where the
// record states no figure at all.
describe("verdictViewModel: the recorded result size", () => {
  // The fixture exchange's two pairs, recorded: a both-output exchange states
  // the figure, and this one's pairing reconstructs from the re-supply files.
  const SIZED_INPUTS: ExchangeRecordInputs = { ...baseInputs, resultSize: 2 };

  test("a record stating no size shows no row for it", async () => {
    const { record, keys } = await fixtures();
    const reconstructed = reconstructForFixture(record);
    const report = await verifyExchangeRecord(record, keys, {
      data: reconstructed.data,
      localTerms: LOCAL_TERMS,
      partnerTerms: PARTNER_TERMS,
    });
    const view = verdictViewModel(report, reconstructed.warnings);
    expect(view.resultSize).toBeUndefined();
    expect(view.headline.title).toBe("Verified");
  });

  test("a matching size is its own verified row", async () => {
    const { record, keys } = await buildExchangeRecord(SIZED_INPUTS);
    const reconstructed = reconstructForFixture(record);
    const report = await verifyExchangeRecord(record, keys, {
      data: reconstructed.data,
      localTerms: LOCAL_TERMS,
      partnerTerms: PARTNER_TERMS,
    });
    const view = verdictViewModel(report, reconstructed.warnings);
    expect(view.resultSize?.label).toBe("The recorded result size");
    expect(view.resultSize?.status).toBe("Matches the matched pairs");
    expect(view.resultSize?.tone).toBe("verified");
    expect(view.headline.title).toBe("Verified");
    // The verified headline enumerates what was checked, so it names the
    // recount beside the openings and the terms hash.
    expect(view.headline.detail).toContain(
      "the recorded result size recounts from the opened pairing",
    );
  });

  test("an altered size fails on its own row, not on the pairing's", async () => {
    const { record, keys } = await buildExchangeRecord(SIZED_INPUTS);
    const reconstructed = reconstructForFixture(record);
    const report = await verifyExchangeRecord(
      { ...record, resultSize: 9 },
      keys,
      {
        data: reconstructed.data,
        localTerms: LOCAL_TERMS,
        partnerTerms: PARTNER_TERMS,
      },
    );
    const view = verdictViewModel(report, reconstructed.warnings);
    expect(view.headline.title).toBe("Verification failed");
    expect(view.resultSize?.status).toBe("Does not match");
    expect(view.resultSize?.tone).toBe("failed");
    // The reader is told the record's figure disagrees, not that the files they
    // supplied might be the wrong ones -- the pairing's own row passed.
    expect(view.resultSize?.explanation).toContain(
      "not the files you supplied",
    );
    const table = view.commitments.find(
      (row) => row.label === "The matched-pairs table",
    );
    expect(table?.status).toBe("Opened and matches");
    // Nothing else is at fault, so the headline states what happened rather
    // than offering the reader two causes it cannot choose between.
    expect(view.headline.detail).toContain("The record was altered");
    expect(view.headline.detail).toContain("the files you supplied check out");
    expect(view.headline.detail).not.toContain("cannot be told apart");
  });

  test("a commitment failing alongside the size keeps the two-cause headline", async () => {
    const { record, keys } = await buildExchangeRecord(SIZED_INPUTS);
    const reconstructed = reconstructForFixture(record);
    const report = await verifyExchangeRecord(
      { ...record, resultSize: 9 },
      keys,
      {
        data: {
          ...reconstructed.data,
          partnerPayloadReceived: {
            columns: ["clinic"],
            rows: [["north"], ["east"]],
          },
        },
        localTerms: LOCAL_TERMS,
        partnerTerms: PARTNER_TERMS,
      },
    );
    const view = verdictViewModel(report, reconstructed.warnings);
    expect(view.headline.title).toBe("Verification failed");
    expect(view.headline.detail).toContain("the record was altered, or a file");
    expect(view.headline.detail).toContain("cannot be told apart");
  });

  test("an unchecked terms hash keeps the two-cause headline", async () => {
    // The unhedged headline asserts the rest of the record checked out, so it
    // is not reached while an element is merely unchecked rather than verified:
    // supplying no terms leaves the agreed-terms hash open beside the figure.
    const { record, keys } = await buildExchangeRecord(SIZED_INPUTS);
    const reconstructed = reconstructForFixture(record);
    const report = await verifyExchangeRecord(
      { ...record, resultSize: 9 },
      keys,
      { data: reconstructed.data },
    );
    expect(report.termsHash).toBe("not-checked");
    expect(report.resultSize).toBe("mismatch");
    const view = verdictViewModel(report, reconstructed.warnings);
    expect(view.headline.title).toBe("Verification failed");
    expect(view.headline.detail).toContain("the record was altered, or a file");
    expect(view.headline.detail).toContain("cannot be told apart");
  });

  test("a pairing that opened but is not a pairing carries no count to recount", async () => {
    // The fifth state behind a not-checked figure: the committed value opened,
    // so no row above it names a cause, and it is not shaped as a pairing, so
    // there is no pair count to compare. Reaching it takes a hand-built record.
    const notAPairing = [
      [0, 1],
      [1, 0],
      [9, 9],
    ] as unknown as AssociationTable;
    const { record, keys } = await buildExchangeRecord({
      ...SIZED_INPUTS,
      associationTable: notAPairing,
    });
    const data: Record<string, CanonicalValue> = {
      localPayloadSent,
      partnerPayloadReceived,
      associationTable: notAPairing,
    };
    const report = await verifyExchangeRecord(record, keys, {
      data,
      localTerms: LOCAL_TERMS,
      partnerTerms: PARTNER_TERMS,
    });
    const view = verdictViewModel(report, []);
    expect(view.headline.title).toBe("Incomplete");
    expect(view.resultSize?.status).toBe("Not checked");
    expect(view.resultSize?.explanation).toContain(
      "is not shaped as a pairing carries no count to recount",
    );
    const table = view.commitments.find(
      (row) => row.label === "The matched-pairs table",
    );
    expect(table?.status).toBe("Opened and matches");
  });

  test("with no files re-supplied the size row is not checked, never verified", async () => {
    const { record, keys } = await buildExchangeRecord(SIZED_INPUTS);
    const report = await verifyExchangeRecord(record, keys, {});
    const view = verdictViewModel(report, []);
    expect(view.headline.title).toBe("Incomplete");
    expect(view.resultSize?.status).toBe("Not checked");
    expect(view.resultSize?.tone).toBe("incomplete");
    expect(view.resultSize?.explanation).toContain(
      "Supply your retained result",
    );
  });
});

// --- The signed leg ----------------------------------------------------------

// A dual-signed record over the same exchange the fixtures above describe: the
// receipt content carries that record's agreed-terms hash and each certificate
// carries the identity the record names, so a run supplying the record reaches
// every check rather than stalling on an expectation it cannot state. Keys are
// generated per fixture: nothing asserted here turns on a particular key.
async function signedFixture(record: ExchangeRecord): Promise<{
  us: SigningIdentity;
  partner: SigningIdentity;
  signed: DualSignedRecord;
  ourFingerprint: string;
  partnerFingerprint: string;
}> {
  const us = await generateSigningIdentity(LOCAL_IDENTITY);
  const partner = await generateSigningIdentity(PARTNER_IDENTITY);
  const content: ReceiptContent = {
    termsHash: record.termsHash,
    initiatorToResponderPayload: "aTJyUGF5bG9hZA",
    responderToInitiatorPayload: "cjJpUGF5bG9hZA",
    binder: RECEIPT_BINDER,
  };
  return {
    us,
    partner,
    signed: {
      version: SIGNED_RECEIPT_VERSION,
      content,
      // We hold the initiator's slot; the partner holds the responder's.
      initiator: {
        certificate: us.certificate,
        signature: await signReceiptContent(us, content, "initiator"),
      },
      responder: {
        certificate: partner.certificate,
        signature: await signReceiptContent(partner, content, "responder"),
      },
    },
    ourFingerprint: await computeCertificateFingerprint(us.certificate),
    partnerFingerprint: await computeCertificateFingerprint(
      partner.certificate,
    ),
  };
}

describe("parseSignedRecordDocument", () => {
  test("a valid dual-signed record parses to the ok outcome", async () => {
    const { record } = await fixtures();
    const { signed } = await signedFixture(record);
    const parsed = parseSignedRecordDocument(serializeDualSignedRecord(signed));
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok")
      expect(parsed.record.content.binder).toBe(signed.content.binder);
  });

  test("the exchange record loaded here is an unrecognized version, not a shape error", async () => {
    const { record } = await fixtures();
    const parsed = parseSignedRecordDocument(serializeExchangeRecord(record));
    expect(parsed.kind).toBe("unrecognized-version");
    if (parsed.kind === "unrecognized-version")
      expect(parsed.message).toContain("does not recognize");
  });

  test("a right-version wrong-shape document is malformed", () => {
    const parsed = parseSignedRecordDocument(
      JSON.stringify({ version: SIGNED_RECEIPT_VERSION, content: "nope" }),
    );
    expect(parsed.kind).toBe("malformed");
    if (parsed.kind === "malformed")
      expect(parsed.message).toContain("psilink-receipt-<stamp>.json");
  });

  test("an error-bearing malformed input never echoes control bytes", () => {
    const esc = String.fromCharCode(0x1b);
    const bel = String.fromCharCode(0x07);
    const parsed = parseSignedRecordDocument(`{"x": ${esc}[31m${bel}`);
    expect(parsed.kind).toBe("malformed");
    if (parsed.kind === "malformed") {
      expect(parsed.message).not.toContain(esc);
      expect(parsed.message).not.toContain(bel);
    }
  });
});

describe("parseCertificateDocument", () => {
  test("an exported certificate parses, with the fingerprint recomputed from it", async () => {
    const identity = await generateSigningIdentity("Party A");
    const parsed = await parseCertificateDocument(
      serializeCertificate(identity.certificate),
    );
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok")
      expect(parsed.fingerprint).toBe(
        await computeCertificateFingerprint(identity.certificate),
      );
  });

  test("a signing identity file is refused, and points at the certificate export", async () => {
    // The private-key-bearing file is refused on its version alone rather than
    // mined for the certificate beside the key: no private key is accepted,
    // required, imported, or used on any path this page runs.
    const identity = await generateSigningIdentity("Party A");
    const parsed = await parseCertificateDocument(
      serializeSigningIdentity(identity),
    );
    expect(parsed.kind).toBe("signing-identity");
    if (parsed.kind === "signing-identity") {
      expect(parsed.message).toContain("private signing key");
      expect(parsed.message).toContain(
        "psilink fingerprint --export-certificate",
      );
      expect(parsed.message).not.toContain(identity.privateKey.d);
    }
  });

  test("private key material in a supplied document does not survive the parse", async () => {
    // The certificate schema keeps only the public coordinates, so a document
    // carrying a private scalar beside them yields a certificate that does not:
    // the model-level half of "no private key is used here", pinned as a check
    // rather than asserted in prose.
    const identity = await generateSigningIdentity("Party A");
    const parsed = await parseCertificateDocument(
      JSON.stringify({
        ...identity.certificate,
        publicKey: {
          ...identity.certificate.publicKey,
          d: identity.privateKey.d,
        },
      }),
    );
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(JSON.stringify(parsed.certificate)).not.toContain(
        identity.privateKey.d,
      );
      expect(parsed.certificate.publicKey).not.toHaveProperty("d");
    }
  });

  test("a document that is not a certificate at all is an unrecognized version", async () => {
    const { record } = await fixtures();
    const parsed = await parseCertificateDocument(
      serializeExchangeRecord(record),
    );
    expect(parsed.kind).toBe("unrecognized-version");
    if (parsed.kind === "unrecognized-version")
      expect(parsed.message).toContain("psilink-signing-cert/v2");
  });

  test("a certificate whose self-signature does not verify is malformed", async () => {
    // An edited identity: the body no longer matches the signature over it, so
    // the certificate binds nothing and is refused before it can anchor a slot.
    const identity = await generateSigningIdentity("Party A");
    const parsed = await parseCertificateDocument(
      JSON.stringify({ ...identity.certificate, identity: "Party Z" }),
    );
    expect(parsed.kind).toBe("malformed");
    if (parsed.kind === "malformed")
      expect(parsed.message).toContain("self-signature must verify");
  });

  test("a syntactically broken document never echoes control bytes", async () => {
    const esc = String.fromCharCode(0x1b);
    const parsed = await parseCertificateDocument(`{"x": ${esc}[31m`);
    expect(parsed.kind).toBe("malformed");
    if (parsed.kind === "malformed") expect(parsed.message).not.toContain(esc);
  });
});

describe("pinnedFingerprintProblem", () => {
  test("an empty value is simply not supplied", () => {
    expect(pinnedFingerprintProblem("")).toBeUndefined();
    expect(pinnedFingerprintProblem("   ")).toBeUndefined();
  });

  test("a fingerprint is accepted", async () => {
    const identity = await generateSigningIdentity("Party A");
    const fingerprint = await computeCertificateFingerprint(
      identity.certificate,
    );
    expect(pinnedFingerprintProblem(fingerprint)).toBeUndefined();
    expect(pinnedFingerprintProblem(` ${fingerprint} `)).toBeUndefined();
  });

  test("a malformed pin is its own error, not a certificate that does not match", () => {
    const problem = pinnedFingerprintProblem("not-a-fingerprint");
    expect(problem).toContain("43 characters");
    expect(problem).toContain("psilink fingerprint");
  });
});

describe("verifySignedRecord: both certificates anchored", () => {
  test("a pinned partner and our own certificate reach the verified verdict, naming both anchors", async () => {
    const { record } = await fixtures();
    const { signed, ourFingerprint, partnerFingerprint } =
      await signedFixture(record);
    const report = await verifySignedRecord(
      signed,
      {
        pinnedFingerprint: partnerFingerprint,
        ownCertificateFingerprint: ourFingerprint,
      },
      { record },
    );
    expect(report.outcome).toBe("verified");

    const view = signedVerdictViewModel(report);
    expect(view.headline.title).toBe("Signed receipt verified");
    // The verdict speaks for both slots, so it states what anchored each.
    expect(view.headline.detail).toContain(
      "the initiator's by the certificate you supplied as your own",
    );
    expect(view.headline.detail).toContain(
      "the responder's by a fingerprint you pinned out-of-band",
    );
    expect(view.guidance).toEqual([]);
    for (const party of view.parties)
      for (const row of party.rows) expect(row.tone).toBe("verified");
    expect(view.termsHash.status).toBe(
      "Matches the terms this exchange agreed",
    );
    // The record loaded beside the receipt carries the same run's binder, so the
    // pairing is part of what this verdict rests on.
    expect(view.runBinding.status).toBe(
      "This receipt and this record are the same run",
    );
    // The binder is reported, never recomputed: only the two parties held the
    // session key it derives from.
    expect(view.binderNote).toContain("never recomputed here");
  });

  test("both parties' linkage terms stand in for the record, but pair nothing", async () => {
    // The auditor's route to the identities and the agreed-terms hash: no exchange
    // record, both parties' terms restated instead. Terms belong to a partnership
    // and repeat across every run of it, so they supply no pairing -- which holds
    // the verdict short of verified without failing it.
    const { record } = await fixtures();
    const { signed, ourFingerprint, partnerFingerprint } =
      await signedFixture(record);
    const report = await verifySignedRecord(
      signed,
      {
        pinnedFingerprint: partnerFingerprint,
        ownCertificateFingerprint: ourFingerprint,
      },
      { localTerms: LOCAL_TERMS, partnerTerms: PARTNER_TERMS },
    );
    expect(report.termsHash).toBe("verified");
    expect(report.runBinding).toBe("not-checked");
    expect(report.outcome).toBe("incomplete");
    const view = signedVerdictViewModel(report);
    expect(view.runBinding.status).toBe("Not checked");
    expect(view.runBinding.explanation).toContain(
      "Load the exchange record for this run",
    );
    // Nothing was supplied to pair against, so there is no pairing to advise on.
    expect(view.runBinding.explanation).not.toContain(
      "pair them by that stamp",
    );
  });

  test("a record from another run of this partnership fails the pairing", async () => {
    // Both artifacts are genuine and the agreed terms are the same, so the run
    // binder is the only thing that separates them.
    const { record } = await fixtures();
    const { signed, ourFingerprint, partnerFingerprint } =
      await signedFixture(record);
    const report = await verifySignedRecord(
      signed,
      {
        pinnedFingerprint: partnerFingerprint,
        ownCertificateFingerprint: ourFingerprint,
      },
      { record: { ...record, receiptBinder: "b3RoZXJSdW5CaW5kZXI" } },
    );
    expect(report.runBinding).toBe("mismatch");
    expect(report.outcome).toBe("failed");
    const view = signedVerdictViewModel(report);
    expect(view.runBinding.status).toBe(
      "Does not match the record's run binder",
    );
    expect(view.runBinding.tone).toBe("failed");
    expect(view.runBinding.explanation).toContain("from different runs");
    // A pairing the record contradicts is answered by finding the record written
    // beside this receipt, so the verdict earns the stamp advice.
    expect(view.runBinding.explanation).toContain("pair them by that stamp");
    // Distinguishable from the other failure classes: every signature, identity,
    // and anchor row still reads as verified.
    for (const party of view.parties)
      for (const row of party.rows) expect(row.tone).toBe("verified");
    expect(view.termsHash.tone).toBe("verified");
  });

  test("a record of an exchange that produced no receipt is reported as unpaired", async () => {
    const { record } = await fixtures();
    const { signed, ourFingerprint, partnerFingerprint } =
      await signedFixture(record);
    const report = await verifySignedRecord(
      signed,
      {
        pinnedFingerprint: partnerFingerprint,
        ownCertificateFingerprint: ourFingerprint,
      },
      { record: { ...record, receiptBinder: undefined } },
    );
    expect(report.runBinding).toBe("unpaired");
    expect(report.outcome).toBe("failed");
    const view = signedVerdictViewModel(report);
    expect(view.runBinding.status).toBe("The record carries no run binder");
    expect(view.runBinding.explanation).toContain("no signed receipt");
    // Earned here as much as by a cross-run pairing: both are answered by the
    // record written beside this receipt.
    expect(view.runBinding.explanation).toContain("pair them by that stamp");
  });
});

describe("verifySignedRecord: one certificate anchored", () => {
  test("a pinned partner alone is incomplete, and the wording names the unanchored slot", async () => {
    const { record } = await fixtures();
    const { signed, partnerFingerprint } = await signedFixture(record);
    const report = await verifySignedRecord(
      signed,
      { pinnedFingerprint: partnerFingerprint },
      { record },
    );
    expect(report.outcome).toBe("incomplete");

    const view = signedVerdictViewModel(report);
    expect(view.headline.title).toBe("Signed receipt incomplete");
    expect(view.headline.detail).toContain(
      "Nothing outside the record anchors the initiator's certificate.",
    );
    expect(view.headline.detail).not.toContain("responder's certificate");

    const [initiator, responder] = view.parties;
    const anchorRow = initiator.rows[0];
    expect(anchorRow.label).toBe("What anchors this certificate");
    expect(anchorRow.status).toBe("Not anchored");
    expect(anchorRow.tone).toBe("incomplete");
    // A pin was supplied and matched the other certificate, so the report does
    // support saying no pinned value matches this one -- and says nothing about
    // an own-certificate check that never ran.
    expect(anchorRow.explanation).toContain(
      "no fingerprint you pinned matches it",
    );
    expect(anchorRow.explanation).not.toContain(
      "the certificate you supplied as your own",
    );
    expect(responder.rows[0].status).toBe(
      "Matches the fingerprint you pinned out-of-band",
    );

    expect(view.guidance).toHaveLength(1);
    expect(view.guidance[0]).toContain(
      "The initiator's certificate is anchored by nothing outside this record",
    );
    expect(view.guidance[0]).toContain("holds the verdict short of verified");
  });
});

describe("verifySignedRecord: neither certificate anchored", () => {
  test("signatures alone are incomplete, and no unanchored slot is narrated as a check it failed", async () => {
    const { record } = await fixtures();
    const { signed } = await signedFixture(record);
    const report = await verifySignedRecord(signed, {}, { record });
    expect(report.outcome).toBe("incomplete");

    const view = signedVerdictViewModel(report);
    expect(view.headline.title).toBe("Signed receipt incomplete");
    expect(view.headline.detail).toContain(
      "Nothing outside the record anchors the initiator's certificate.",
    );
    expect(view.headline.detail).toContain(
      "Nothing outside the record anchors the responder's certificate.",
    );
    for (const party of view.parties) {
      const anchorRow = party.rows[0];
      expect(anchorRow.status).toBe("Not anchored");
      // Nothing was supplied, so neither clause is supported: an unanchored
      // slot must not read as a check this certificate was put to and failed.
      expect(anchorRow.explanation).not.toContain("pinned");
      expect(anchorRow.explanation).not.toContain("your own");
      expect(anchorRow.explanation).toContain("could have minted");
      // Everything the record can attest to itself still passes.
      expect(party.rows[1].tone).toBe("verified");
      expect(party.rows[2].tone).toBe("verified");
    }
    expect(view.guidance).toHaveLength(1);
    expect(view.guidance[0]).toContain(
      "Certificate fingerprint trust is not established",
    );
  });
});

describe("verifySignedRecord: an anchoring value matching neither certificate", () => {
  test("a pinned fingerprint that reaches neither certificate fails, attributed to the pin", async () => {
    const { record } = await fixtures();
    const { signed, ourFingerprint } = await signedFixture(record);
    const stranger = await generateSigningIdentity("Party Z");
    const report = await verifySignedRecord(
      signed,
      {
        pinnedFingerprint: await computeCertificateFingerprint(
          stranger.certificate,
        ),
        ownCertificateFingerprint: ourFingerprint,
      },
      { record },
    );
    expect(report.outcome).toBe("failed");

    const view = signedVerdictViewModel(report);
    expect(view.headline.title).toBe("Signed receipt verification failed");
    expect(view.guidance[0]).toBe(
      "The fingerprint you pinned matches neither certificate in this record: " +
        "this is not the record of the party you pinned.",
    );
  });

  test("a rotated own certificate fails without recasting the correctly anchored partner slot", async () => {
    const { record } = await fixtures();
    const { signed, partnerFingerprint } = await signedFixture(record);
    // The same party, re-keyed since the exchange: the certificate it holds
    // today is neither certificate in this record.
    const rotated = await generateSigningIdentity(LOCAL_IDENTITY);
    const report = await verifySignedRecord(
      signed,
      {
        pinnedFingerprint: partnerFingerprint,
        ownCertificateFingerprint: await computeCertificateFingerprint(
          rotated.certificate,
        ),
      },
      { record },
    );
    expect(report.outcome).toBe("failed");
    // The pin still anchored the partner: what failed is the claim that this
    // record is one we signed, and it is attributed there.
    expect(report.responder.certificateAnchor).toBe("partner-pin");

    const view = signedVerdictViewModel(report);
    expect(view.parties[1]?.rows[0]?.status).toBe(
      "Matches the fingerprint you pinned out-of-band",
    );
    expect(view.guidance).toEqual([
      "The certificate you supplied as your own is neither certificate in " +
        "this record: this is not a receipt you signed.",
    ]);
  });

  test("a pin that is not a fingerprint is refused rather than verified with", async () => {
    // core compares a malformed pin as a non-match, which would be reported as
    // a partner certificate that does not match -- a diagnosis of the record
    // for a fault in the typed value. The surface gates it; this refuses it.
    const { record } = await fixtures();
    const { signed } = await signedFixture(record);
    await expect(
      verifySignedRecord(signed, { pinnedFingerprint: "nope" }, { record }),
    ).rejects.toThrow(/not a fingerprint/);
  });
});

describe("verifySignedRecord: what the record cannot attest to itself", () => {
  test("without the record or both terms, the identities and terms hash are not checked", async () => {
    const { record } = await fixtures();
    const { signed, ourFingerprint, partnerFingerprint } =
      await signedFixture(record);
    const report = await verifySignedRecord(
      signed,
      {
        pinnedFingerprint: partnerFingerprint,
        ownCertificateFingerprint: ourFingerprint,
      },
      {},
    );
    // Both slots anchored, both signatures good -- and still not verified: the
    // record states who it is between only through the certificates in it.
    expect(report.outcome).toBe("incomplete");

    const view = signedVerdictViewModel(report);
    expect(view.termsHash.status).toBe("Not checked");
    expect(view.termsHash.explanation).toContain("Load the exchange record");
    for (const party of view.parties) {
      expect(party.rows[3]?.status).toBe("Not checked");
      expect(party.rows[3]?.explanation).toContain(
        "paste both parties' linkage terms",
      );
    }
    expect(view.guidance).toEqual([]);
  });

  test("a pair naming only one party leaves BOTH identity checks unperformed", async () => {
    // `linkage_terms.identity` is optional, and this screen takes whatever files
    // the operator loads -- an exchange record from an unnamed run, or a terms
    // document with the field left out. A half-supplied pair is the shape that
    // must not half-check: expected identities are unordered and matched onto the
    // two certificates as a bijection, so anchoring one name would leave the
    // other's check reading as performed against a name nobody supplied. Neither
    // source may reach a verdict on identity at all.
    const { identity: _unnamedTerms, ...unnamedPartnerTerms } = PARTNER_TERMS;
    // Built over the half-named pair, so the record, its terms hash, and the
    // terms below all agree: identity is then the only thing left unchecked.
    const { record } = await buildExchangeRecord({
      ...baseInputs,
      partnerTerms: unnamedPartnerTerms,
    });
    expect(record.partnerIdentity).toBeUndefined();
    expect(record.localIdentity).toBe(LOCAL_IDENTITY);
    const { signed, ourFingerprint, partnerFingerprint } =
      await signedFixture(record);
    for (const sources of [
      { record },
      { localTerms: LOCAL_TERMS, partnerTerms: unnamedPartnerTerms },
    ]) {
      const report = await verifySignedRecord(
        signed,
        {
          pinnedFingerprint: partnerFingerprint,
          ownCertificateFingerprint: ourFingerprint,
        },
        sources,
      );
      expect(report.initiator.assertedIdentity).toBe("not-checked");
      expect(report.responder.assertedIdentity).toBe("not-checked");
      // Neither a spurious pass nor a spurious failure: an unperformed check
      // holds the verdict short of verified and accuses nobody.
      expect(report.outcome).toBe("incomplete");
      const view = signedVerdictViewModel(report);
      for (const party of view.parties) {
        expect(party.rows[3]?.status).toBe("Not checked");
        // The row names this cause too: the operator here loaded exactly what
        // the remediation asks for, so a sentence naming only the missing-input
        // cause would send them back after files they already have.
        expect(party.rows[3]?.explanation).toContain(
          "named fewer than two parties",
        );
      }
    }
  });

  test("an altered receipt content fails the signature it no longer matches", async () => {
    const { record } = await fixtures();
    const { signed, ourFingerprint, partnerFingerprint } =
      await signedFixture(record);
    const altered: DualSignedRecord = {
      ...signed,
      content: { ...signed.content, binder: "YmluZGVyMg" },
    };
    const report = await verifySignedRecord(
      altered,
      {
        pinnedFingerprint: partnerFingerprint,
        ownCertificateFingerprint: ourFingerprint,
      },
      { record },
    );
    expect(report.outcome).toBe("failed");

    const view = signedVerdictViewModel(report);
    // The failed headline states the ambiguity: an altered record and the wrong
    // exchange or partner cannot be told apart here.
    expect(view.headline.detail).toContain("was altered");
    expect(view.headline.detail).toContain(
      "not the exchange or the partner you are checking it against",
    );
    for (const party of view.parties) {
      expect(party.rows[2]?.status).toBe("Does not verify");
      expect(party.rows[2]?.tone).toBe("failed");
    }
  });
});

// A hand-built report, for the states a signable record cannot be made to
// produce on demand: a certificate whose canonical bytes do not encode, and a
// verified verdict that leaves a slot unanchored.
function signedParty(
  role: SignedReceiptPartyReport["role"],
  overrides: Partial<SignedReceiptPartyReport> = {},
): SignedReceiptPartyReport {
  return {
    role,
    identity: role === "initiator" ? "Party A" : "Party B",
    fingerprint:
      role === "initiator" ? "Zm9vZmluZ2VycHJpbnQ" : "YmFyZmluZ2VycHJpbnQ",
    certificateBinding: "verified",
    signature: "verified",
    certificateAnchor: role === "initiator" ? "local-identity" : "partner-pin",
    assertedIdentity: "verified",
    ...overrides,
  };
}

function signedReport(
  overrides: Partial<DualSignedRecordVerificationReport> = {},
): DualSignedRecordVerificationReport {
  return {
    outcome: "verified",
    initiator: signedParty("initiator"),
    responder: signedParty("responder"),
    pinnedFingerprints: "matched",
    localIdentity: "matched",
    termsHash: "verified",
    runBinding: "verified",
    binder: "YmluZGVy",
    ...overrides,
  };
}

describe("signedVerdictViewModel: over a report built by hand", () => {
  test("a certificate with no computable fingerprint says so rather than showing a blank", () => {
    const view = signedVerdictViewModel(
      signedReport({
        outcome: "failed",
        initiator: signedParty("initiator", {
          fingerprint: "",
          certificateBinding: "failed",
        }),
      }),
    );
    expect(view.parties[0]?.fingerprint).toBe("could not be computed");
  });

  test("a verified verdict with an unanchored slot is refused rather than phrased", () => {
    // The sentence would claim both certificates were anchored when one was not.
    // The verdict decides that once for every surface and refuses the report, so
    // the page renders no overstatement rather than each page guarding its own.
    expect(() =>
      signedVerdictViewModel(
        signedReport({
          responder: signedParty("responder", {
            certificateAnchor: "unanchored",
          }),
        }),
      ),
    ).toThrow(/unanchored/);
  });

  test("the identity a certificate carries is escaped at this display sink", () => {
    const esc = String.fromCharCode(0x1b);
    const view = signedVerdictViewModel(
      signedReport({
        initiator: signedParty("initiator", { identity: `Party A${esc}[31m` }),
      }),
    );
    expect(view.parties[0]?.identity).not.toContain(esc);
  });
});

describe("verdictViewModel: the unsigned record's standing caveat", () => {
  test("a run that also verified a dual-signed record points at that verdict", async () => {
    const { record, keys } = await fixtures();
    const report = await verifyExchangeRecord(record, keys, {});
    // The note names the loaded document: whether the two artifacts are one run
    // is the signed verdict's pairing row, which may equally report that they are
    // not, so this sentence may not presume the answer.
    expect(verdictViewModel(report, [], true).signatureNote).toBe(
      "Partner receipt signatures are checked separately below, against the " +
        "dual-signed record you loaded.",
    );
    // Unchanged for the record-only run: the default is today's copy.
    expect(verdictViewModel(report, []).signatureNote).toContain(
      "Partner receipt signatures are not checked",
    );
  });
});
