import { describe, expect, test } from "vitest";

import {
  minimalExchangeResult,
  minimalPreparedExchange,
} from "@psilink/core/testing";
import { buildRunOutputs } from "@psi/runOutputs";
import { getDefaultLinkageTerms } from "@psilink/core";

import type { ExchangeResult } from "@psilink/core";
import type { ObjectUrls } from "@psi/runOutputs";

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
const prepared = minimalPreparedExchange({
  metadata: [
    {
      name: "client_id",
      type: "identifier",
      role: "identifier",
      isPayload: true,
    },
    { name: "program_code", type: "other", role: "payload", isPayload: true },
  ],
  linkageTerms: getDefaultLinkageTerms("Run-outputs fixture"),
  rawRows: [{ client_id: "17", program_code: "A" }],
  rowCount: 1,
});

const PARTNER_TERMS = getDefaultLinkageTerms("Run-outputs partner fixture");

const audit = {
  record: { createdAt: "2026-07-08T14:32:00.000Z" },
  keys: { salts: {} },
} as unknown as NonNullable<ExchangeResult["audit"]>;

function receivedResult(withAudit: boolean): ExchangeResult {
  return minimalExchangeResult({
    associationTable: [[0], [5]],
    partnerTerms: PARTNER_TERMS,
    partnerPayload: { columns: ["program"], rowIndices: [5], rows: [["B"]] },
    audit: withAudit ? audit : undefined,
  });
}

function withheldResult(): ExchangeResult {
  return minimalExchangeResult({
    partnerTerms: PARTNER_TERMS,
    resolvedRole: "sender",
    audit,
  });
}

// A count-only (psi-c) run: no matched pairing for anyone, and the intersection size
// as the party's whole result. The PSI seat decides whether the count was computed
// here (the receiver) or arrived as the partner's report (the sender).
function countOnlyResult(resolvedRole: "receiver" | "sender"): ExchangeResult {
  return minimalExchangeResult({
    intersectionCount: 4,
    partnerTerms: PARTNER_TERMS,
    resolvedRole,
    audit,
  });
}

describe("buildRunOutputs", () => {
  test("a received result yields the results url, count, and timestamped record pair", () => {
    const { urls, created, revoked } = recordingUrls();
    const outputs = buildRunOutputs(receivedResult(true), prepared, urls);

    expect(outputs.kind).toBe("matched");
    expect(outputs.kind === "matched" && outputs.resultsUrl).toBe(created[0]);
    expect(outputs.matchedRecordCount).toBe(1);
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
    const outputs = buildRunOutputs(withheldResult(), prepared, urls);

    expect(outputs.kind).toBe("withheld");
    expect(outputs.matchedRecordCount).toBeUndefined();
    expect(outputs.record?.recordUrl).toBe(created[0]);
    expect(created).toHaveLength(2);
  });

  test("a count-only result yields the counted shape with no results blob", () => {
    const { urls, created } = recordingUrls();
    const outputs = buildRunOutputs(
      countOnlyResult("receiver"),
      prepared,
      urls,
    );

    // The count-only receiver got exactly what its terms promised, so nothing was
    // withheld from it -- reporting it as withheld would state the opposite.
    expect(outputs.kind).toBe("counted");
    expect(outputs.kind === "counted" && outputs.intersectionCount).toBe(4);
    // The completion headline states the count off the counted shape's own field,
    // so restating it as a matched-row figure would print the same number twice.
    expect(outputs.matchedRecordCount).toBeUndefined();
    // No pairing exists to write, so no results blob is created at all: the two
    // urls handed out are the record pair.
    expect(created).toHaveLength(2);
    expect(outputs.record?.recordUrl).toBe(created[0]);
  });

  test("the counted shape marks a count that arrived as the partner's report", () => {
    // The seat that computed the count and the seat that was handed one must not
    // render alike: only the latter's number is the partner's word.
    const { urls } = recordingUrls();
    expect(
      buildRunOutputs(countOnlyResult("receiver"), prepared, urls),
    ).toMatchObject({ kind: "counted", countReportedByPartner: false });
    expect(
      buildRunOutputs(countOnlyResult("sender"), prepared, urls),
    ).toMatchObject({ kind: "counted", countReportedByPartner: true });
  });

  test("a throw after the results url was created revokes it before propagating", () => {
    const { urls, created, revoked } = recordingUrls({ failOnCall: 2 });

    expect(() => buildRunOutputs(receivedResult(true), prepared, urls)).toThrow(
      "createObjectURL refused",
    );
    expect(created).toHaveLength(1);
    expect(revoked).toEqual([created[0]]);
  });

  test("a result without an audit pair omits the record downloads", () => {
    const { urls, created, revoked } = recordingUrls();
    const outputs = buildRunOutputs(receivedResult(false), prepared, urls);

    expect(outputs.record).toBeUndefined();
    expect(outputs.kind === "matched" && outputs.resultsUrl).toBe(created[0]);
    expect(created).toHaveLength(1);
    expect(revoked).toEqual([]);
  });
});
