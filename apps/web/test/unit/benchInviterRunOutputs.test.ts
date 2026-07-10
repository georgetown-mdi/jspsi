import { describe, expect, test } from "vitest";

import { buildInviterRunOutputs } from "@bench/inviterRunOutputs";

import type { ExchangeResult, PreparedExchange } from "@psilink/core";
import type { ObjectUrls } from "@bench/inviterRunOutputs";

// A recording ObjectUrls fake: each create hands out a distinct url (or throws
// on the configured call), and both sides log what they were given, so the
// tests can assert the create/revoke pairing without a DOM.
function recordingUrls(options?: { failOnCall?: number }) {
  const created: Array<string> = [];
  const revoked: Array<string> = [];
  const urls: ObjectUrls = {
    create: (blob) => {
      if (created.length + 1 === options?.failOnCall)
        throw new Error("createObjectURL refused");
      const url = `blob:test-${created.length + 1}-${blob.type}`;
      created.push(url);
      return url;
    },
    revoke: (url) => {
      revoked.push(url);
    },
  };
  return { urls, created, revoked };
}

// The smallest inputs buildOutputTable accepts: one matched pair (our row 0 to
// the partner's row 5) with one payload column, and an identifier column so
// the CSV's first header is real.
const prepared = {
  rawRows: [{ client_id: "17", program_code: "A" }],
  metadata: [
    { name: "client_id", role: "identifier" },
    { name: "program_code", role: "payload" },
  ],
} as unknown as PreparedExchange;

const audit = {
  record: { createdAt: "2026-07-08T14:32:00.000Z" },
  keys: { salts: {} },
} as unknown as NonNullable<ExchangeResult["audit"]>;

function receivedResult(withAudit: boolean): ExchangeResult {
  return {
    associationTable: [[0], [5]],
    partnerPayload: { columns: ["program"], rowIndices: [5], rows: [["B"]] },
    audit: withAudit ? audit : undefined,
  } as unknown as ExchangeResult;
}

function withheldResult(): ExchangeResult {
  return {
    associationTable: undefined,
    partnerPayload: { columns: [], rowIndices: [], rows: [] },
    audit,
  } as unknown as ExchangeResult;
}

describe("buildInviterRunOutputs", () => {
  test("a received result yields the results url, count, and timestamped record pair", () => {
    const { urls, created, revoked } = recordingUrls();
    const outputs = buildInviterRunOutputs(
      receivedResult(true),
      prepared,
      urls,
    );

    expect(outputs.resultsUrl).toBe(created[0]);
    expect(outputs.matchedRecordCount).toBe(1);
    expect(outputs.resultWithheld).toBeUndefined();
    expect(outputs.record).toEqual({
      recordUrl: created[1],
      recordFileName: "psilink-record-2026-07-08T14-32-00-000Z.json",
      keysUrl: created[2],
      keysFileName: "psilink-record-2026-07-08T14-32-00-000Z.keys.json",
    });
    expect(created).toHaveLength(3);
    expect(revoked).toEqual([]);
  });

  test("a withheld result offers the record but no results url", () => {
    const { urls, created } = recordingUrls();
    const outputs = buildInviterRunOutputs(withheldResult(), prepared, urls);

    expect(outputs.resultWithheld).toBe(true);
    expect(outputs.resultsUrl).toBeUndefined();
    expect(outputs.matchedRecordCount).toBeUndefined();
    expect(outputs.record?.recordUrl).toBe(created[0]);
    expect(created).toHaveLength(2);
  });

  test("a throw after the results url was created revokes it before propagating", () => {
    const { urls, created, revoked } = recordingUrls({ failOnCall: 2 });

    expect(() =>
      buildInviterRunOutputs(receivedResult(true), prepared, urls),
    ).toThrow("createObjectURL refused");
    expect(created).toHaveLength(1);
    expect(revoked).toEqual([created[0]]);
  });

  test("a result without an audit pair omits the record downloads", () => {
    const { urls, created, revoked } = recordingUrls();
    const outputs = buildInviterRunOutputs(
      receivedResult(false),
      prepared,
      urls,
    );

    expect(outputs.record).toBeUndefined();
    expect(outputs.resultsUrl).toBe(created[0]);
    expect(created).toHaveLength(1);
    expect(revoked).toEqual([]);
  });
});
