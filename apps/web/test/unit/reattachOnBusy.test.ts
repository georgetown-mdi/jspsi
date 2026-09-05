import { afterEach, describe, expect, test, vi } from "vitest";

import {
  JobApiRequestError,
  RelayedTerminalError,
} from "@psi/serverJobExchangeDriver";
import { isExchangeBusyError, reattachOnBusy } from "@bench/reattachOnBusy";
import { failureFor } from "@bench/useInviterExchange";
import { writeAttachment } from "@psi/consoleJobAttachment";

import type {
  JobApiClient,
  JobStatusProbe,
} from "@psi/serverJobExchangeDriver";
import type { ExchangeDriverEvents } from "@psi/exchangeDriver";
import type { ExchangeErrorCategory } from "@psi/exchangeLifecycle";
import type { RelayEvent } from "@jobs/cliDriver";
import type { RunOutputs } from "@bench/runOutputs";

const STORAGE_KEY = "psilink-console-last-job";

/** Install an in-memory localStorage over the node env, returning its backing map
 * so a test can assert what the re-attach persisted. */
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

/** Wrap a scripted event sequence as an async iterable, as the reattach driver
 * consumes a live stream. */
async function* scriptedStream(
  events: Array<RelayEvent>,
): AsyncIterable<RelayEvent> {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}

function result(resultWritten: boolean): RelayEvent {
  return { v: 1, type: "result", resultWritten };
}

/** A {@link JobApiClient} tailored to re-attach: a fixed status probe and a
 * scripted replay stream, recording the ids each was asked for. `createJob` is
 * never used -- the busy rejection is handed to {@link reattachOnBusy} directly. */
function reattachClient(args: {
  probe: JobStatusProbe;
  events?: Array<RelayEvent>;
}) {
  const statusIds: Array<string> = [];
  const streamedIds: Array<string> = [];
  const client: JobApiClient = {
    createJob: () => Promise.reject(new Error("re-attach never creates")),
    openEventStream: (jobId) => {
      streamedIds.push(jobId);
      return scriptedStream(args.events ?? [result(true)]);
    },
    cancelJob: () => Promise.resolve(),
    deleteJob: () => Promise.resolve(),
    fetchJobStatus: (jobId) => {
      statusIds.push(jobId);
      return Promise.resolve(args.probe);
    },
    fetchRecordAvailability: () => Promise.resolve({ available: false }),
  };
  return { client, statusIds, streamedIds };
}

/** The run callbacks a re-attach drives, plus their mocks for assertion. */
function driverEvents(signal: AbortSignal) {
  const onStages = vi.fn();
  const onStage = vi.fn();
  const onResult = vi.fn();
  const onError = vi.fn();
  const events: ExchangeDriverEvents<RunOutputs> = {
    signal,
    onStages,
    onStage,
    onResult,
    onError,
  };
  return { events, onStages, onStage, onResult, onError };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("isExchangeBusyError", () => {
  test("is true only for a 409 JobApiRequestError", () => {
    expect(isExchangeBusyError(new JobApiRequestError(409, "busy"))).toBe(true);
    expect(isExchangeBusyError(new JobApiRequestError(500, "err"))).toBe(false);
    expect(isExchangeBusyError(new JobApiRequestError(400, "bad"))).toBe(false);
    expect(isExchangeBusyError(new Error("nope"))).toBe(false);
  });
});

describe("reattachOnBusy", () => {
  test("re-attaches on a 409 whose body holds a LIVE id, resuming the run callbacks", async () => {
    const store = installStorage();
    const { client, statusIds, streamedIds } = reattachClient({
      probe: { kind: "live", status: "running" },
      events: [result(true)],
    });
    const { events, onResult, onError } = driverEvents(
      new AbortController().signal,
    );
    const onReattaching = vi.fn();

    const didReattach = await reattachOnBusy({
      error: new JobApiRequestError(409, "busy", "job-body"),
      client,
      seat: "inviter",
      channel: "sftp",
      events,
      onReattaching,
    });

    expect(didReattach).toBe(true);
    // The body id is resolved, confirmed live, then re-attached.
    expect(statusIds).toEqual(["job-body"]);
    expect(streamedIds).toEqual(["job-body"]);
    expect(onReattaching).toHaveBeenCalledWith("job-body", "running");
    // The replay drives the SAME run callbacks to a result.
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    // The resolved id is recorded so a server-created orphan becomes recoverable.
    expect(JSON.parse(store.get(STORAGE_KEY) ?? "null")).toEqual({
      v: 1,
      jobId: "job-body",
      seat: "inviter",
      channel: "sftp",
    });
  });

  test("falls back to the persisted id when the 409 body has none", async () => {
    installStorage();
    writeAttachment({
      jobId: "job-persisted",
      seat: "acceptor",
      channel: "filedrop",
    });
    const { client, statusIds, streamedIds } = reattachClient({
      probe: { kind: "live", status: "running" },
    });
    const { events, onResult } = driverEvents(new AbortController().signal);
    const onReattaching = vi.fn();

    const didReattach = await reattachOnBusy({
      // No activeJobId on the busy error: an older/empty-bodied 409.
      error: new JobApiRequestError(409, "busy"),
      client,
      seat: "acceptor",
      channel: "filedrop",
      events,
      onReattaching,
    });

    expect(didReattach).toBe(true);
    expect(statusIds).toEqual(["job-persisted"]);
    expect(streamedIds).toEqual(["job-persisted"]);
    expect(onReattaching).toHaveBeenCalledWith("job-persisted", "running");
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  test("prefers the body id over the persisted id (recovers an orphan)", async () => {
    installStorage();
    // A stale persisted id sits beside the busy body's live orphan id; the body
    // wins, since the orphan is exactly the job with no recovery record yet.
    writeAttachment({ jobId: "job-stale", seat: "inviter", channel: "sftp" });
    const { client, statusIds, streamedIds } = reattachClient({
      probe: { kind: "live", status: "running" },
    });
    const { events } = driverEvents(new AbortController().signal);

    const didReattach = await reattachOnBusy({
      error: new JobApiRequestError(409, "busy", "job-orphan"),
      client,
      seat: "inviter",
      channel: "sftp",
      events,
      onReattaching: vi.fn(),
    });

    expect(didReattach).toBe(true);
    expect(statusIds).toEqual(["job-orphan"]);
    expect(streamedIds).toEqual(["job-orphan"]);
  });

  test("falls back to the alert when no id is discoverable", async () => {
    installStorage(); // empty: readAttachment resolves null
    const { client, statusIds, streamedIds } = reattachClient({
      probe: { kind: "live", status: "running" },
    });
    const { events, onResult } = driverEvents(new AbortController().signal);
    const onReattaching = vi.fn();

    const didReattach = await reattachOnBusy({
      error: new JobApiRequestError(409, "busy"), // no body id, none persisted
      client,
      seat: "inviter",
      channel: "sftp",
      events,
      onReattaching,
    });

    // No live id: no liveness probe, no re-attach, no recovery-copy flip -- the
    // caller raises today's alert.
    expect(didReattach).toBe(false);
    expect(statusIds).toEqual([]);
    expect(streamedIds).toEqual([]);
    expect(onReattaching).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });

  test("falls back to the alert when the resolved id is not a live job", async () => {
    installStorage();
    const { client, statusIds, streamedIds } = reattachClient({
      probe: { kind: "gone" },
    });
    const { events, onResult } = driverEvents(new AbortController().signal);
    const onReattaching = vi.fn();

    const didReattach = await reattachOnBusy({
      error: new JobApiRequestError(409, "busy", "job-gone"),
      client,
      seat: "inviter",
      channel: "sftp",
      events,
      onReattaching,
    });

    // The id probed as gone: no re-attach into a dead run, no recovery flip.
    expect(didReattach).toBe(false);
    expect(statusIds).toEqual(["job-gone"]);
    expect(streamedIds).toEqual([]);
    expect(onReattaching).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });

  test("does not handle a non-busy error", async () => {
    installStorage();
    const { client, statusIds } = reattachClient({
      probe: { kind: "live", status: "running" },
    });
    const { events } = driverEvents(new AbortController().signal);

    const didReattach = await reattachOnBusy({
      error: new JobApiRequestError(500, "server error", "job-x"),
      client,
      seat: "inviter",
      channel: "sftp",
      events,
      onReattaching: vi.fn(),
    });

    expect(didReattach).toBe(false);
    expect(statusIds).toEqual([]);
  });

  test("an already-aborted signal returns true without re-attaching (silent)", async () => {
    installStorage();
    const { client, statusIds, streamedIds } = reattachClient({
      probe: { kind: "live", status: "running" },
    });
    const controller = new AbortController();
    controller.abort();
    const { events, onResult, onError } = driverEvents(controller.signal);
    const onReattaching = vi.fn();

    const didReattach = await reattachOnBusy({
      error: new JobApiRequestError(409, "busy", "job-body"),
      client,
      seat: "inviter",
      channel: "sftp",
      events,
      onReattaching,
    });

    // Aborted mid-teardown: neither a re-attach nor an alert is wanted.
    expect(didReattach).toBe(true);
    expect(statusIds).toEqual([]);
    expect(streamedIds).toEqual([]);
    expect(onReattaching).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});

// A busy create leaves a seat showing a run it did not launch, whose terminal
// can hold text an untrusted party chose. This pins that the replay's failure
// reaches the operator through the same failureFor composition path any other
// run uses -- the re-attach adds nothing of its own. The class-kill pins in
// jobRunDiagnostics.unit.test.ts and scripts/bench-failure-passthrough.test.mjs
// hold the same invariant elsewhere.
describe("a re-attached run's terminal shows as it arrived", () => {
  /** A terminal the CLI never composed as a refusal: the CLI's own refusal
   * wording reaches the seat inside a filename an untrusted party chose, which
   * core's foreign-file terminal names verbatim and a partner-writable
   * rendezvous directory lets them plant. */
  const plantedTerminal =
    "the shared folder holds files this exchange does not own: " +
    "--sweep-exchange-files refuses to delete.csv";

  function errorEvent(message: string): RelayEvent {
    return { v: 1, type: "error", category: "exchange", message };
  }

  test("the relayed terminal's own title and message stand, planted fragment and all", async () => {
    installStorage();
    const { client } = reattachClient({
      probe: { kind: "live", status: "running" },
      events: [errorEvent(plantedTerminal)],
    });
    const { events, onError } = driverEvents(new AbortController().signal);

    const didReattach = await reattachOnBusy({
      error: new JobApiRequestError(409, "busy", "job-other"),
      client,
      seat: "inviter",
      channel: "filedrop",
      events,
      onReattaching: vi.fn(),
    });

    expect(didReattach).toBe(true);
    // The replay's terminal rides the seat's own failure path, the same one a
    // run it launched itself uses.
    expect(onError).toHaveBeenCalledTimes(1);
    const raised = onError.mock.calls[0]?.[0] as {
      category: ExchangeErrorCategory;
      error: unknown;
    };
    expect(raised.error).toBeInstanceOf(RelayedTerminalError);

    const surfaced = failureFor(
      raised.category,
      raised.error,
      undefined,
      "filedrop",
    );
    expect(surfaced).toEqual(
      failureFor(
        "exchange",
        new RelayedTerminalError(plantedTerminal),
        undefined,
        "filedrop",
      ),
    );
    expect(surfaced.message).not.toContain("--force-retain-sweep");
  });
});
