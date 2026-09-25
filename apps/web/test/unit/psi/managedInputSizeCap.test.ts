import { describe, expect, test, vi } from "vitest";

import { MAX_CSV_FILE_BYTES } from "@components/csvIntake";
import { ManagedInputError } from "@psi/managed/managedInputGuard";
import { acquireManagedInput } from "@psi/managed/managedInputHandle";

import type { HandlePermissionQuery } from "@psi/managed/managedInputHandle";

// The intake cap a recurring run's input is read under: the same bound every
// attended file selection applies, held before the parse so an oversized file
// is never read into memory.

const parse = vi.fn(() =>
  Promise.resolve({
    data: [],
    errors: [],
    meta: { fields: ["ssn"], sanitizedColumnPositions: [] },
  }),
);

vi.mock("@psi/workers/csvParseController", () => ({
  loadCSVFileOffMainThread: () => parse(),
}));

const granted: HandlePermissionQuery = {
  query: () => Promise.resolve("granted"),
  request: () => Promise.resolve("granted"),
};

/** A file of `size` bytes, which nothing under test reads the content of. */
function fileOfSize(size: number): File {
  return { size, name: "cohort.csv" } as File;
}

function handleTo(file: File): FileSystemFileHandle {
  return { getFile: () => Promise.resolve(file) } as FileSystemFileHandle;
}

describe("a managed run's input over the intake cap", () => {
  test("is refused through a persisted handle before it is parsed", async () => {
    parse.mockClear();
    const read = acquireManagedInput(
      {
        kind: "handle",
        handle: handleTo(fileOfSize(MAX_CSV_FILE_BYTES + 1)),
        attendance: "unattended",
      },
      granted,
    );

    await expect(read).rejects.toBeInstanceOf(ManagedInputError);
    await expect(read).rejects.toMatchObject({
      rejection: { reason: "acquire" },
    });
    expect(parse).not.toHaveBeenCalled();
  });

  test("is refused as a re-selected file too", async () => {
    parse.mockClear();
    await expect(
      acquireManagedInput({
        kind: "file",
        file: fileOfSize(MAX_CSV_FILE_BYTES + 1),
      }),
    ).rejects.toBeInstanceOf(ManagedInputError);
    expect(parse).not.toHaveBeenCalled();
  });

  test("a file exactly at the cap is read", async () => {
    parse.mockClear();
    const acquired = await acquireManagedInput({
      kind: "file",
      file: fileOfSize(MAX_CSV_FILE_BYTES),
    });
    expect(acquired.columns).toEqual(["ssn"]);
    expect(parse).toHaveBeenCalledTimes(1);
  });
});
