import { describe, expect, test } from "vitest";

import { workInputDrift } from "@bench/ServerFilePicker";

import type { JobInputsResult, WorkInputReference } from "@psi/workInputClient";

const COMMITTED: WorkInputReference = {
  name: "clients.csv",
  sizeBytes: 4096,
  modifiedAt: 1_700_000_000_000,
};

function listingOf(
  files: Array<{ name: string; sizeBytes: number; modifiedAt: number }>,
  truncated = false,
): JobInputsResult {
  return {
    kind: "listing",
    listing: {
      configured: true,
      totalEntries: files.length,
      truncated,
      files,
    },
  };
}

describe("workInputDrift", () => {
  test("an unchanged (size, mtime) entry is not drift", () => {
    expect(workInputDrift(COMMITTED, listingOf([COMMITTED]))).toBe("none");
  });

  test("a present entry with a changed (size, mtime) is drift", () => {
    expect(
      workInputDrift(COMMITTED, listingOf([{ ...COMMITTED, sizeBytes: 9000 }])),
    ).toBe("changed");
    expect(
      workInputDrift(
        COMMITTED,
        listingOf([{ ...COMMITTED, modifiedAt: 1_700_000_999_000 }]),
      ),
    ).toBe("changed");
  });

  test("absence from a COMPLETE listing is removal, not a false 'changed'", () => {
    expect(
      workInputDrift(
        COMMITTED,
        listingOf([{ name: "other.csv", sizeBytes: 1, modifiedAt: 1 }], false),
      ),
    ).toBe("removed");
  });

  test("absence from a TRUNCATED listing is not-listed, never removal or change", () => {
    // The file may sit beyond the 512-name window, so its absence there is no
    // evidence it changed or was removed; flagging drift would destroy an intact
    // draft.
    expect(
      workInputDrift(
        COMMITTED,
        listingOf([{ name: "other.csv", sizeBytes: 1, modifiedAt: 1 }], true),
      ),
    ).toBe("not-listed");
  });

  test("an unreadable listing (busy/error) reports no drift", () => {
    expect(workInputDrift(COMMITTED, { kind: "busy" })).toBe("none");
    expect(workInputDrift(COMMITTED, { kind: "error" })).toBe("none");
  });
});
