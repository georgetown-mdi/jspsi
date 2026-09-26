import { expect, test, vi } from "vitest";

import {
  RoundSetLimitError,
  WebRtcFrameLimitError,
  isSetTooLargeError,
} from "../../src/errors";
import {
  assertFirstRoundFitsFileSyncFrame,
  assertFirstRoundFitsWebRtcFrame,
  prepareForExchange,
} from "../../src/exchange";

// The first-round checks count through the round's own deduplication, which
// refuses the distinct value past its bound; the round itself would refuse
// that set, so each check raises its own channel's refusal for it.
// The count is replaced here: reaching the real bound takes several GB.

const LOWERED_LIMIT = 4;

vi.mock("../../src/psi/link", async (importOriginal) => {
  const link = await importOriginal<typeof import("../../src/psi/link")>();
  return {
    ...link,
    sentRoundSetSize: () => {
      throw link.roundDistinctValueLimitRefusal(LOWERED_LIMIT);
    },
  };
});

function prepared() {
  return prepareForExchange(
    {
      linkageTerms: {
        version: "1.0.0",
        date: "2026-01-01",
        algorithm: "psi",
        deduplicate: false,
        linkageStrategy: "cascade",
        identity: "Tester",
        output: { expectsOutput: true, shareWithPartner: true },
        linkageFields: [{ name: "firstName", type: "first_name" }],
        linkageKeys: [
          { name: "firstName", elements: [{ field: "firstName" }] },
        ],
      },
    },
    "Tester",
    ["zqa", "zqb", "zqc", "zqd", "zqe"].map((name) => ({ first_name: name })),
    ["first_name"],
  );
}

function refusalOf(check: () => void): unknown {
  try {
    check();
  } catch (err) {
    return err;
  }
  return undefined;
}

test("the WebRTC check raises its own refusal, for this party's set", () => {
  const refusal = refusalOf(() =>
    assertFirstRoundFitsWebRtcFrame(prepared(), 1),
  );
  expect(refusal).toBeInstanceOf(WebRtcFrameLimitError);
  expect((refusal as WebRtcFrameLimitError).setOwner).toBe("local");
  expect((refusal as Error).message).toMatch(
    /more than 4 distinct values in one round.*Split the input/,
  );
});

test("the file-sync check names the bound the count stopped at", () => {
  const refusal = refusalOf(() =>
    assertFirstRoundFitsFileSyncFrame(prepared(), 1),
  );
  expect(refusal).toBeInstanceOf(RoundSetLimitError);
  expect((refusal as RoundSetLimitError).setOwner).toBe("local");
  expect((refusal as RoundSetLimitError).distinctValueLimit).toBe(4);
  expect((refusal as Error).message).toBe(
    "Too large for SFTP or a synced folder: the first linkage key gives " +
      "this party more than 4 distinct values, the most one round can hold. " +
      "Nothing was sent. Split the input into smaller files and run one " +
      "exchange for each.",
  );
});

test("both refusals are sets too large to send, and nothing else is", () => {
  expect(isSetTooLargeError(new RoundSetLimitError("too many"))).toBe(true);
  expect(
    isSetTooLargeError(new WebRtcFrameLimitError("too large", "partner")),
  ).toBe(true);
  expect(isSetTooLargeError(new Error("other"))).toBe(false);
  expect(isSetTooLargeError(undefined)).toBe(false);
});
