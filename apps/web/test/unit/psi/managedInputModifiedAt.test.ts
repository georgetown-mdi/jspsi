import { describe, expect, test } from "vitest";

import { readInputFileModifiedAt } from "@psi/managed/managedInputHandle";

import type { HandlePermissionQuery } from "@psi/managed/managedInputHandle";

/**
 * The display read behind the schedule's unchanged-input note: when the file a
 * persisted pointer names was last changed. A real picker handle is not summonable
 * in Node, so the handle here is built to the one platform call the read makes and
 * the permission layer is injected for the states an ordinary handle cannot report.
 *
 * Every state that is not a readable file resolves to no instant rather than
 * rejecting: the note is a display reading beside a page running nothing, and the
 * run keeps its own benign input failure.
 */

/** A permission layer reporting a fixed state and recording whether it prompted --
 * which a page the operator is reading may never do. */
function fakePermission(state: "granted" | "denied" | "prompt") {
  const layer = {
    requested: false,
    query: () => Promise.resolve(state),
    request: () => {
      layer.requested = true;
      return Promise.resolve(state);
    },
  };
  return layer as typeof layer & HandlePermissionQuery;
}

/** A handle built to the one call the read makes. `lastModified` is what its file
 * reports; an `Error` makes the read of the entry fail, as a deleted or moved file
 * does. */
function fakeHandle(lastModified: number | Error) {
  return {
    name: "riverbend-2026-Q3.csv",
    getFile: () =>
      lastModified instanceof Error
        ? Promise.reject(lastModified)
        : Promise.resolve({ lastModified }),
  } as unknown as FileSystemFileHandle;
}

describe("reading the input file's last-changed instant", () => {
  test("a granted handle reports the file's own instant", async () => {
    const modifiedAt = Date.parse("2026-07-10T09:15:00.000Z");
    await expect(
      readInputFileModifiedAt(
        fakeHandle(modifiedAt),
        fakePermission("granted"),
      ),
    ).resolves.toBe(modifiedAt);
  });

  test("an entry that cannot be read reports no instant", async () => {
    await expect(
      readInputFileModifiedAt(
        fakeHandle(new Error("A requested file could not be found")),
        fakePermission("granted"),
      ),
    ).resolves.toBeUndefined();
  });

  test("a file reporting no usable instant reports none", async () => {
    await expect(
      readInputFileModifiedAt(
        fakeHandle(Number.NaN),
        fakePermission("granted"),
      ),
    ).resolves.toBeUndefined();
  });

  test("a grant that is not standing reports no instant and prompts for nothing", async () => {
    for (const state of ["prompt", "denied"] as const) {
      const permission = fakePermission(state);
      await expect(
        readInputFileModifiedAt(fakeHandle(0), permission),
      ).resolves.toBeUndefined();
      expect(permission.requested).toBe(false);
    }
  });
});
