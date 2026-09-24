import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import YAML from "yaml";
import {
  deriveAcceptedLinkageTerms,
  getDefaultLinkageTerms,
  inferMetadata,
  parseExchangeSpec,
} from "@alcove/core";
import type {
  ExchangeSpec,
  InvitationToken,
  LinkageTerms,
  Metadata,
} from "@alcove/core";

import {
  deriveAcceptedInvitationTerms,
  deriveOutboundConsentRecords,
  diffKeptLinkageTerms,
  receivedCommitmentRemovalWarning,
  refreshAcceptanceRecords,
  termsUpdateWrite,
  writeAcceptanceRecordReportingLoss,
  writeTermsRecord,
  type AcceptanceRecordWrite,
} from "../../src/acceptedTermsRecords";
import { persistTermsUpdate, saveConfig } from "../../src/config";
import {
  PERSISTENCE_LOSS_EXIT_CODE,
  type EventStreamEmitter,
} from "../../src/eventStream";

const LINKAGE_COLUMNS = ["first_name", "last_name", "dob", "ssn"];

function sampleTerms(identity: string): LinkageTerms {
  return getDefaultLinkageTerms(identity, inferMetadata(LINKAGE_COLUMNS, []));
}

function sampleToken(
  overrides: Partial<InvitationToken> = {},
): InvitationToken {
  return {
    version: "1",
    linkageTerms: sampleTerms("Inviter Org"),
    sharedSecret: "A".repeat(43),
    ...overrides,
  };
}

function recordingLog(): { warn: (message: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { warn: (message) => lines.push(message), lines };
}

let dir: string;
let configPath: string;
let exitCodeBeforeTest: typeof process.exitCode;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-accepted-terms-"));
  configPath = path.join(dir, "alcove.yaml");
  exitCodeBeforeTest = process.exitCode;
});

afterEach(() => {
  process.exitCode = exitCodeBeforeTest;
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeKeptConfig(terms: LinkageTerms = sampleTerms("Acceptor Org")) {
  saveConfig(configPath, {
    connection: { channel: "filedrop", path: "/mnt/share" },
    linkageTerms: terms,
  });
}

function readKeptConfig(): Record<string, unknown> {
  return YAML.parse(fs.readFileSync(configPath, "utf8")) as Record<
    string,
    unknown
  >;
}

// --- deriveAcceptedInvitationTerms -------------------------------------------

test("deriveAcceptedInvitationTerms takes each record from the token", () => {
  const token = sampleToken({
    disclosedPayloadColumns: ["zip"],
    connectionEndpoint: {
      channel: "webrtc",
      host: "peer.example.org",
      path: "/psi",
      relay: { stun: ["stun:stun.example.org:3478"] },
    },
  });
  token.linkageTerms.deduplicate = true;

  const accepted = deriveAcceptedInvitationTerms(token, "Acceptor Org");

  expect(accepted.linkageTerms).toEqual(
    deriveAcceptedLinkageTerms(token.linkageTerms, "Acceptor Org"),
  );
  expect(accepted.linkageTerms.identity).toBe("Acceptor Org");
  expect(accepted.expectedPayloadColumns).toEqual(["zip"]);
  expect(accepted.expectedPartnerDeduplicate).toBe(true);
  expect(accepted.invitationRelay).toEqual({
    stun: ["stun:stun.example.org:3478"],
  });
});

test("deriveAcceptedInvitationTerms leaves absent records undefined", () => {
  const accepted = deriveAcceptedInvitationTerms(
    sampleToken({
      connectionEndpoint: { channel: "filedrop", path: "/mnt/share" },
    }),
    "Acceptor Org",
  );
  expect(accepted.expectedPayloadColumns).toBeUndefined();
  expect(accepted.expectedPartnerDeduplicate).toBe(false);
  expect(accepted.invitationRelay).toBeUndefined();
});

// --- diffKeptLinkageTerms ----------------------------------------------------

function keptSpec(terms: LinkageTerms): ExchangeSpec {
  return {
    connection: { channel: "filedrop", path: "/mnt/share" },
    linkageTerms: terms,
  };
}

test("diffKeptLinkageTerms returns no conflict for terms that agree", () => {
  const log = recordingLog();
  const conflicts = diffKeptLinkageTerms({
    configPath,
    existing: keptSpec(sampleTerms("Acceptor Org")),
    accepted: sampleTerms("Acceptor Org"),
    citationDriftAlternative: "decline-to-reuse",
    log,
  });
  expect(conflicts).toEqual([]);
  expect(log.lines).toEqual([]);
});

test("diffKeptLinkageTerms returns a conflict for a disagreeing agreement field", () => {
  const accepted = sampleTerms("Acceptor Org");
  const conflicts = diffKeptLinkageTerms({
    configPath,
    existing: keptSpec({
      ...sampleTerms("Acceptor Org"),
      linkageKeys: accepted.linkageKeys.slice(1),
    }),
    accepted,
    citationDriftAlternative: "decline-to-reuse",
    log: recordingLog(),
  });
  expect(conflicts.length).toBeGreaterThan(0);
});

test("diffKeptLinkageTerms warns on a soft mismatch without a conflict", () => {
  const log = recordingLog();
  const conflicts = diffKeptLinkageTerms({
    configPath,
    existing: keptSpec({ ...sampleTerms("Acceptor Org"), date: "2020-01-01" }),
    accepted: { ...sampleTerms("Acceptor Org"), date: "2021-01-01" },
    citationDriftAlternative: "decline-to-reuse",
    log,
  });
  expect(conflicts).toEqual([]);
  expect(log.lines.length).toBeGreaterThan(0);
});

// --- receivedCommitmentRemovalWarning ----------------------------------------

test("receivedCommitmentRemovalWarning warns only where a recorded set is cleared", () => {
  expect(
    receivedCommitmentRemovalWarning({
      configPath,
      recorded: undefined,
      consented: undefined,
    }),
  ).toBeUndefined();
  expect(
    receivedCommitmentRemovalWarning({
      configPath,
      recorded: ["zip"],
      consented: ["zip"],
    }),
  ).toBeUndefined();
  expect(
    receivedCommitmentRemovalWarning({
      configPath,
      recorded: [],
      consented: undefined,
    }),
  ).toContain("no columns at all");
  expect(
    receivedCommitmentRemovalWarning({
      configPath,
      recorded: ["zip", "county"],
      consented: undefined,
    }),
  ).toContain("exactly these columns:\n  - zip\n  - county");
});

// --- deriveOutboundConsentRecords --------------------------------------------

const OWN_METADATA: Metadata = inferMetadata(LINKAGE_COLUMNS, []);

test("deriveOutboundConsentRecords records nothing where nothing is shared", () => {
  expect(
    deriveOutboundConsentRecords({
      acceptedOutput: { expectsOutput: true, shareWithPartner: false },
      ownMetadata: OWN_METADATA,
      keptConfigurationShares: undefined,
    }),
  ).toEqual({ fresh: undefined, kept: undefined });
});

test("deriveOutboundConsentRecords records pending on a kept config that shares", () => {
  expect(
    deriveOutboundConsentRecords({
      acceptedOutput: { expectsOutput: true, shareWithPartner: false },
      ownMetadata: OWN_METADATA,
      keptConfigurationShares: true,
    }),
  ).toEqual({ fresh: undefined, kept: { status: "pending" } });
});

test("deriveOutboundConsentRecords records the same consent fresh and kept where shared", () => {
  const records = deriveOutboundConsentRecords({
    acceptedOutput: { expectsOutput: false, shareWithPartner: true },
    ownMetadata: undefined,
    keptConfigurationShares: false,
  });
  expect(records.fresh).toEqual({ status: "pending" });
  expect(records.kept).toBe(records.fresh);
});

// --- writeTermsRecord and refreshAcceptanceRecords ----------------------------

test("writeTermsRecord writes and removes each record in place", () => {
  writeKeptConfig();
  writeTermsRecord(configPath, {
    record: "expected_payload_columns",
    columns: ["zip"],
  });
  writeTermsRecord(configPath, {
    record: "expected_partner_deduplicate",
    declared: true,
  });
  writeTermsRecord(configPath, {
    record: "outbound_payload_consent",
    consent: { status: "confirmed", columns: ["dob"] },
  });
  writeTermsRecord(configPath, {
    record: "disclosed_payload_columns",
    columns: [],
  });
  expect(readKeptConfig()).toMatchObject({
    expected_payload_columns: ["zip"],
    expected_partner_deduplicate: true,
    outbound_payload_consent: { status: "confirmed", columns: ["dob"] },
    disclosed_payload_columns: [],
  });

  writeTermsRecord(configPath, {
    record: "expected_payload_columns",
    columns: undefined,
  });
  writeTermsRecord(configPath, {
    record: "outbound_payload_consent",
    consent: undefined,
  });
  writeTermsRecord(configPath, {
    record: "disclosed_payload_columns",
    columns: undefined,
  });
  const cleared = readKeptConfig();
  expect(cleared).not.toHaveProperty("expected_payload_columns");
  expect(cleared).not.toHaveProperty("outbound_payload_consent");
  expect(cleared).not.toHaveProperty("disclosed_payload_columns");
  expect(cleared.expected_partner_deduplicate).toBe(true);
});

test("writeTermsRecord throws where the configuration cannot be read", () => {
  expect(() =>
    writeTermsRecord(configPath, {
      record: "expected_partner_deduplicate",
      declared: false,
    }),
  ).toThrow();
  expect(fs.existsSync(configPath)).toBe(false);
});

test("refreshAcceptanceRecords writes all three records a config parses back", () => {
  writeKeptConfig();
  writeTermsRecord(configPath, {
    record: "outbound_payload_consent",
    consent: { status: "confirmed", columns: ["dob"] },
  });
  refreshAcceptanceRecords(configPath, {
    expectedPayloadColumns: ["zip"],
    expectedPartnerDeduplicate: false,
    outboundPayloadConsent: undefined,
  });
  const spec = parseExchangeSpec(readKeptConfig());
  expect(spec.expectedPayloadColumns).toEqual(["zip"]);
  expect(spec.expectedPartnerDeduplicate).toBe(false);
  expect(spec.outboundPayloadConsent).toBeUndefined();
});

test("refreshAcceptanceRecords throws where the configuration cannot be read", () => {
  expect(() =>
    refreshAcceptanceRecords(configPath, {
      expectedPayloadColumns: undefined,
      expectedPartnerDeduplicate: false,
      outboundPayloadConsent: undefined,
    }),
  ).toThrow();
});

// --- writeAcceptanceRecordReportingLoss --------------------------------------

test("writeAcceptanceRecordReportingLoss writes without reporting a loss", () => {
  writeKeptConfig();
  const log = recordingLog();
  const warning = vi.fn();
  const written = writeAcceptanceRecordReportingLoss(
    configPath,
    { record: "expected_partner_deduplicate", declared: true },
    { log, eventStream: { warning } as unknown as EventStreamEmitter },
  );
  expect(written).toBe(true);
  expect(readKeptConfig().expected_partner_deduplicate).toBe(true);
  expect(log.lines).toEqual([]);
  expect(warning).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(exitCodeBeforeTest);
});

const LOST_WRITE_CASES: Array<{
  write: AcceptanceRecordWrite;
  clause: string;
}> = [
  {
    write: { record: "expected_payload_columns", columns: ["zip"] },
    clause: "recording the columns you consented to receive",
  },
  {
    write: {
      record: "outbound_payload_consent",
      consent: { status: "pending" },
    },
    clause: "recording your outbound-column confirmation",
  },
  {
    write: { record: "expected_partner_deduplicate", declared: false },
    clause: "recording the duplicate matching your partner declared",
  },
];

test.each(LOST_WRITE_CASES)(
  "writeAcceptanceRecordReportingLoss reports a lost $write.record write",
  ({ write, clause }) => {
    const log = recordingLog();
    const warning = vi.fn();
    const written = writeAcceptanceRecordReportingLoss(configPath, write, {
      log,
      eventStream: { warning } as unknown as EventStreamEmitter,
    });
    expect(written).toBe(false);
    expect(process.exitCode).toBe(PERSISTENCE_LOSS_EXIT_CODE);
    expect(warning).toHaveBeenCalledTimes(1);
    const [source, notice] = warning.mock.calls[0] as [string, string];
    expect(source).toBe("persistenceLoss");
    expect(notice).toContain(clause);
    expect(notice).not.toContain("ENOENT");
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toContain(`${notice}: `);
    expect(log.lines[0]).toContain("ENOENT");
  },
);

// --- termsUpdateWrite and persistTermsUpdate ---------------------------------

test("deriveAcceptedInvitationTerms keeps this party's own deduplicate where given", () => {
  const accepted = deriveAcceptedInvitationTerms(
    sampleToken(),
    "Acceptor Org",
    true,
  );
  expect(accepted.linkageTerms.deduplicate).toBe(true);
  expect(accepted.expectedPartnerDeduplicate).toBe(false);
});

test("termsUpdateWrite restates a recorded send-side commitment from the metadata", () => {
  const metadata = inferMetadata([...LINKAGE_COLUMNS, "program"], []);
  const accepted = deriveAcceptedInvitationTerms(
    sampleToken({ disclosedPayloadColumns: ["notes"] }),
    "Acceptor Org",
  );
  const write = termsUpdateWrite(accepted, {
    metadata,
    disclosedPayloadColumns: ["stale"],
  });
  expect(write.disclosedPayloadColumns).toEqual({ columns: ["program"] });
  expect(write.expectedPayloadColumns).toEqual(["notes"]);
  expect(write.outboundPayloadConsent).toEqual(
    deriveOutboundConsentRecords({
      acceptedOutput: accepted.linkageTerms.output,
      ownMetadata: metadata,
      keptConfigurationShares: true,
    }).kept,
  );
});

test("termsUpdateWrite leaves an absent commitment absent and removes one no metadata backs", () => {
  const accepted = deriveAcceptedInvitationTerms(sampleToken(), "Acceptor Org");
  expect(termsUpdateWrite(accepted, {}).disclosedPayloadColumns).toBe(
    "unchanged",
  );
  expect(
    termsUpdateWrite(accepted, { disclosedPayloadColumns: ["stale"] })
      .disclosedPayloadColumns,
  ).toEqual({ columns: undefined });
});

test("termsUpdateWrite records a pending outbound consent where the metadata cannot state it", () => {
  const accepted = deriveAcceptedInvitationTerms(sampleToken(), "Acceptor Org");
  expect(accepted.linkageTerms.output.shareWithPartner).toBe(true);
  expect(termsUpdateWrite(accepted, {}).outboundPayloadConsent).toEqual({
    status: "pending",
  });
});

test("persistTermsUpdate writes the terms and every record, keeping the rest of the file", () => {
  writeKeptConfig();
  const before = readKeptConfig();
  const terms: LinkageTerms = {
    ...sampleTerms("Acceptor Org"),
    algorithm: "psi",
  };
  persistTermsUpdate(configPath, {
    linkageTerms: terms,
    expectedPayloadColumns: ["notes"],
    expectedPartnerDeduplicate: true,
    outboundPayloadConsent: { status: "pending" },
    disclosedPayloadColumns: { columns: ["program"] },
  });
  const after = readKeptConfig();
  expect(after["connection"]).toEqual(before["connection"]);
  expect(after["expected_payload_columns"]).toEqual(["notes"]);
  expect(after["expected_partner_deduplicate"]).toBe(true);
  expect(after["outbound_payload_consent"]).toEqual({ status: "pending" });
  expect(after["disclosed_payload_columns"]).toEqual(["program"]);
  expect(parseExchangeSpec(after).linkageTerms).toEqual(terms);
});

test("persistTermsUpdate refuses a document that would not load and leaves the file unchanged", () => {
  writeKeptConfig();
  const before = fs.readFileSync(configPath, "utf8");
  expect(() =>
    persistTermsUpdate(configPath, {
      linkageTerms: { ...sampleTerms("Acceptor Org"), linkageKeys: [] },
      expectedPayloadColumns: undefined,
      expectedPartnerDeduplicate: false,
      outboundPayloadConsent: undefined,
      disclosedPayloadColumns: "unchanged",
    }),
  ).toThrow("was left unchanged");
  expect(fs.readFileSync(configPath, "utf8")).toBe(before);
});
