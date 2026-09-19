import {
  assembleExchangeSpec,
  connectionFromLocator,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@psilink/core";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { acquireValidatedManagedInput } from "@psi/managed/managedInputHandle";

import type { ExchangeSpec, WebRTCExchangeLocator } from "@psilink/core";

// The stored field delimiter reaching the run-start re-read: a scheduled run has
// nobody present to choose one, so the document's own value is what the read
// splits on. The parse itself is mocked -- a real CSV read through a browser File
// is the platform half (test/browser/managedInputHandle.test.ts) -- so what is
// pinned here is which delimiter the read is given.

const parseCalls: Array<{ delimiter?: string }> = [];

vi.mock("@psi/workers/csvParseController", () => ({
  loadCSVFileOffMainThread: (
    _file: unknown,
    options: { delimiter?: string } = {},
  ) => {
    parseCalls.push(options);
    return Promise.resolve({
      data: [],
      errors: [],
      meta: { fields: standingColumns, sanitizedColumnPositions: [] },
    });
  },
}));

const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

const standingColumns = ["ssn", "first_name", "last_name", "date_of_birth"];

/** The stored document, with or without a chosen delimiter -- the second being
 * every record written before the field existed. */
function storedDocument(csvDelimiter?: string): ExchangeSpec {
  return assembleExchangeSpec({
    connection: connectionFromLocator(webrtcLocator),
    linkageTerms: getDefaultLinkageTerms(
      "County Health Dept",
      inferMetadata(standingColumns, []),
    ),
    ...(csvDelimiter !== undefined ? { csvDelimiter } : {}),
  });
}

/** A re-selected input file, the source a browser without persistent handles
 * takes; the handle path reaches the same read through the same argument. */
const reselected = {
  kind: "file" as const,
  file: new File(["ssn|first_name\n1|Ada\n"], "cohort.csv", {
    type: "text/csv",
  }),
};

beforeEach(() => {
  parseCalls.length = 0;
});

describe("the delimiter a managed run re-reads its input by", () => {
  test("the stored delimiter reaches the read, with nobody present to choose", async () => {
    await acquireValidatedManagedInput(storedDocument("|"), reselected);
    expect(parseCalls).toEqual([{ delimiter: "|" }]);
  });

  test("a document written before the field existed reads by detection", async () => {
    await acquireValidatedManagedInput(storedDocument(), reselected);
    expect(parseCalls).toEqual([{}]);
  });
});
