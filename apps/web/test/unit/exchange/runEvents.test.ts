import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ProcessState } from "@psilink/core";

import { JobApiRequestError } from "@psi/jobClient/serverJobExchangeDriver";
import { buildRunEvents } from "@exchange/runEvents";
import { initialRun } from "@exchange/exchangeRun";

import type {
  JobApiClient,
  JobRunStatus,
  JobStatusProbe,
} from "@psi/jobClient/serverJobExchangeDriver";
import type { RelayEvent } from "@jobs/cliDriver";
import type { RunOutputs } from "@psi/runOutputs";

/** Install an in-memory localStorage: the busy (409) re-attach reads and writes
 * the console's persisted attachment through it. */
function installStorage(): void {
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
}

async function* scriptedStream(
  events: Array<RelayEvent>,
): AsyncIterable<RelayEvent> {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}

/** A job API that answers the re-attach probe with `probe` and replays one
 * completed run, recording the ids its stream was opened for. */
function reattachClient(probe: JobStatusProbe) {
  const streamedIds: Array<string> = [];
  const client: JobApiClient = {
    createJob: () => Promise.reject(new Error("re-attach never creates")),
    openEventStream: (jobId) => {
      streamedIds.push(jobId);
      return scriptedStream([{ v: 1, type: "result", resultWritten: true }]);
    },
    cancelJob: () => Promise.resolve(),
    deleteJob: () => Promise.resolve(),
    fetchJobStatus: () => Promise.resolve(probe),
    fetchRecordAvailability: () => Promise.resolve({ available: false }),
  };
  return { client, streamedIds };
}

/** Apply a React `SetStateAction` the way `useState` would, so the callbacks'
 * updater form is exercised rather than restated. */
function applied<T>(current: T, update: T | ((current: T) => T)): T {
  return typeof update === "function"
    ? (update as (current: T) => T)(current)
    : update;
}

/** One console seat's run state behind the callbacks, backed by plain values.
 * `probe` is what the busy (409) re-attach finds when it looks for a live job. */
function seat(probe: JobStatusProbe = { kind: "gone" }) {
  const state = {
    run: initialRun(),
    outputs: undefined as RunOutputs | undefined,
    warnings: [] as Array<string>,
    reattached: undefined as JobRunStatus | undefined,
    reattaching: false,
    jobId: undefined as string | undefined,
  };
  const raiseFailure = vi.fn();
  const { client, streamedIds } = reattachClient(probe);
  const events = buildRunEvents({
    signal: new AbortController().signal,
    seat: "inviter",
    channel: "sftp",
    client,
    raiseFailure,
    setRun: (update) => {
      state.run = applied(state.run, update);
    },
    setOutputs: (update) => {
      state.outputs = applied(state.outputs, update);
    },
    setWarnings: (update) => {
      state.warnings = applied(state.warnings, update);
    },
    setReattached: (update) => {
      state.reattached = applied(state.reattached, update);
    },
    setReattaching: (update) => {
      state.reattaching = applied(state.reattaching, update);
    },
    setJobId: (id) => {
      state.jobId = id;
    },
  });
  return { state, events, raiseFailure, streamedIds };
}

/** The dev-gated devtools sink `onError` writes the raw error to. Held so the
 * suite's output stays clean and the gating itself is asserted rather than
 * silenced. */
let devtoolsSink: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  devtoolsSink = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("buildRunEvents", () => {
  test("advances the run model through the lifecycle's stage events", () => {
    const { state, events } = seat();

    events.onStages([
      { id: "one", label: "One", state: ProcessState.Working },
      { id: "two", label: "Two", state: ProcessState.Working },
    ]);
    events.onStage("two");

    expect(state.run.stages.map((stage) => stage.id)).toEqual(["one", "two"]);
    expect(state.run.stageId).toBe("two");
    expect(state.run.failed).toBe(false);
  });

  test("a result sets the outputs and finishes the run", () => {
    const { state, events } = seat();
    const outputs: RunOutputs = { kind: "withheld" };

    events.onResult(outputs);

    expect(state.outputs).toBe(outputs);
    expect(state.run.finishedAt).toBeInstanceOf(Date);
    expect(state.run.failed).toBe(false);
  });

  test("a warning is escaped once at the shared display boundary", () => {
    const { state, events } = seat();

    events.onWarning?.("a partner file called back\\slash[31m");

    expect(state.warnings).toEqual([
      "a partner file called back\\\\slash\\x1b[31m",
    ]);
  });

  test("a non-busy failure raises the seat's alert", () => {
    const { state, events, raiseFailure } = seat();
    const error = new Error("transport died");

    events.onError({ category: "exchange", error });

    expect(raiseFailure).toHaveBeenCalledWith("exchange", error);
    expect(state.reattaching).toBe(false);
    // The raw error object reaches devtools, where a developer can expand its
    // cause chain; the operator's alert is composed separately at the seat.
    expect(devtoolsSink).toHaveBeenCalledWith(error);
  });

  test("a production build with diagnostics off puts no raw error on the console", () => {
    // The suite otherwise runs under vitest's dev-true default, which is why
    // the test above sees the raw error at devtools; a deployed client with no
    // diagnostics toggle set is the disclosure property this pins; only the
    // diagnostics gate's own test (utils/diagnostics.test.ts) covered the
    // sink's off behavior before this, never a real onError call.
    vi.stubEnv("DEV", false);
    vi.stubGlobal("localStorage", { getItem: () => null });
    const { events, raiseFailure } = seat();
    const error = new Error("transport died, partner said: attacker payload");

    events.onError({ category: "exchange", error });

    expect(raiseFailure).toHaveBeenCalledWith("exchange", error);
    expect(devtoolsSink).not.toHaveBeenCalled();
  });

  test("a busy create re-attaches onto the same callbacks instead of alerting", async () => {
    installStorage();
    const { state, events, raiseFailure, streamedIds } = seat({
      kind: "live",
      status: "running",
    });

    events.onError({
      category: "exchange",
      error: new JobApiRequestError(409, "busy", "job-live"),
    });
    await vi.waitFor(() => expect(state.outputs).toBeDefined());

    expect(streamedIds).toEqual(["job-live"]);
    expect(state.jobId).toBe("job-live");
    expect(state.reattached).toBe("running");
    expect(state.reattaching).toBe(false);
    expect(raiseFailure).not.toHaveBeenCalled();
  });

  test("a busy create with no live job to re-attach to falls back to the alert", async () => {
    installStorage();
    const { state, events, raiseFailure, streamedIds } = seat({ kind: "gone" });
    const error = new JobApiRequestError(409, "busy", "job-dead");

    events.onError({ category: "exchange", error });
    await vi.waitFor(() => expect(raiseFailure).toHaveBeenCalled());

    expect(streamedIds).toEqual([]);
    expect(raiseFailure).toHaveBeenCalledWith("exchange", error);
    expect(state.reattaching).toBe(false);
    expect(state.jobId).toBeUndefined();
  });
});
