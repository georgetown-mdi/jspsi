import { afterEach, describe, expect, test, vi } from "vitest";

import {
  clearAttachment,
  discardServerJob,
  readAttachment,
  writeAttachment,
} from "@psi/consoleJobAttachment";

import type {
  JobApiClient,
  JobStatusProbe,
} from "@psi/serverJobExchangeDriver";
import type { ConsoleJobAttachment } from "@psi/consoleJobAttachment";

const KEY = "psilink-console-last-job";

/** Install an in-memory localStorage over the node env (which has none) and hand
 * back its backing map so a test can assert what was persisted. */
function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  });
  return store;
}

/** A {@link JobApiClient} whose status calls follow a fixed script (a further poll
 * past the script reads as gone), recording the discard's cancel/delete/status
 * order so the sequence is asserted deterministically. */
function scriptedDiscardClient(statuses: Array<JobStatusProbe>) {
  const order: Array<string> = [];
  let call = 0;
  const client: JobApiClient = {
    createJob: () => Promise.reject(new Error("unused")),
    openEventStream: () => {
      throw new Error("unused");
    },
    cancelJob: (jobId) => {
      order.push(`cancel:${jobId}`);
      return Promise.resolve();
    },
    deleteJob: (jobId) => {
      order.push(`delete:${jobId}`);
      return Promise.resolve();
    },
    fetchJobStatus: (jobId) => {
      order.push(`status:${jobId}`);
      const status: JobStatusProbe =
        call < statuses.length ? statuses[call] : { kind: "gone" };
      call++;
      return Promise.resolve(status);
    },
    fetchRecordAvailability: () => Promise.resolve({ available: false }),
  };
  return { client, order };
}

const NO_DELAY = () => Promise.resolve();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("attachment storage", () => {
  test("round-trips a written record", () => {
    installStorage();
    const record: ConsoleJobAttachment = {
      jobId: "job-1",
      seat: "inviter",
      channel: "sftp",
    };
    writeAttachment(record);
    expect(readAttachment()).toEqual(record);
  });

  test("persists the version tag alongside the three fields", () => {
    const store = installStorage();
    writeAttachment({ jobId: "job-2", seat: "acceptor", channel: "filedrop" });
    expect(JSON.parse(store.get(KEY) ?? "null")).toEqual({
      v: 1,
      jobId: "job-2",
      seat: "acceptor",
      channel: "filedrop",
    });
  });

  test("reads an absent record as null", () => {
    installStorage();
    expect(readAttachment()).toBeNull();
  });

  test("reads unparseable JSON as null and clears it", () => {
    const store = installStorage();
    store.set(KEY, "{ not json");
    expect(readAttachment()).toBeNull();
    expect(store.has(KEY)).toBe(false);
  });

  test("reads a wrong-version or ill-typed record as null and clears it", () => {
    const store = installStorage();
    const malformed: Array<unknown> = [
      { v: 2, jobId: "j", seat: "inviter", channel: "sftp" },
      { v: 1, jobId: "", seat: "inviter", channel: "sftp" },
      { v: 1, jobId: "j", seat: "bogus", channel: "sftp" },
      { v: 1, jobId: "j", seat: "inviter", channel: "" },
      { v: 1, jobId: "j", seat: "inviter" },
      [1, 2, 3],
      null,
    ];
    for (const bad of malformed) {
      store.set(KEY, JSON.stringify(bad));
      expect(readAttachment()).toBeNull();
      expect(store.has(KEY)).toBe(false);
    }
  });

  test("clearAttachment removes the record", () => {
    const store = installStorage();
    writeAttachment({ jobId: "j", seat: "inviter", channel: "sftp" });
    clearAttachment();
    expect(store.has(KEY)).toBe(false);
  });
});

describe("discardServerJob", () => {
  test("a terminal job is DELETEd and cleared, without cancelling", async () => {
    const store = installStorage();
    writeAttachment({ jobId: "job-1", seat: "inviter", channel: "sftp" });
    const { client, order } = scriptedDiscardClient([
      { kind: "live", status: "succeeded" },
    ]);

    await discardServerJob(client, "job-1", NO_DELAY);

    // Already terminal: no cancel, straight to DELETE.
    expect(order).toEqual(["status:job-1", "delete:job-1"]);
    expect(store.has(KEY)).toBe(false);
  });

  test("a running job is cancelled, polled to terminal, then DELETEd and cleared", async () => {
    const store = installStorage();
    writeAttachment({ jobId: "job-9", seat: "acceptor", channel: "filedrop" });
    // probe: running -> cancel -> poll running -> poll cancelled -> DELETE.
    const { client, order } = scriptedDiscardClient([
      { kind: "live", status: "running" },
      { kind: "live", status: "running" },
      { kind: "live", status: "cancelled" },
    ]);

    await discardServerJob(client, "job-9", NO_DELAY);

    expect(order).toEqual([
      "status:job-9",
      "cancel:job-9",
      "status:job-9",
      "status:job-9",
      "delete:job-9",
    ]);
    expect(store.has(KEY)).toBe(false);
  });

  test("a poll that finds the job gone stops waiting and DELETEs", async () => {
    installStorage();
    const { client, order } = scriptedDiscardClient([
      { kind: "live", status: "running" },
      { kind: "gone" },
    ]);

    await discardServerJob(client, "job-3", NO_DELAY);

    expect(order).toEqual([
      "status:job-3",
      "cancel:job-3",
      "status:job-3",
      "delete:job-3",
    ]);
  });

  test("clears the recovery record even when DELETE fails", async () => {
    const store = installStorage();
    writeAttachment({ jobId: "job-x", seat: "inviter", channel: "sftp" });
    const client: JobApiClient = {
      createJob: () => Promise.reject(new Error("unused")),
      openEventStream: () => {
        throw new Error("unused");
      },
      cancelJob: () => Promise.resolve(),
      deleteJob: () => Promise.reject(new Error("delete failed")),
      fetchJobStatus: () =>
        Promise.resolve({ kind: "live", status: "succeeded" }),
      fetchRecordAvailability: () => Promise.resolve({ available: false }),
    };

    await discardServerJob(client, "job-x", NO_DELAY);

    expect(store.has(KEY)).toBe(false);
  });
});
