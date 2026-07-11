import { afterEach, describe, expect, test, vi } from "vitest";

import { ProcessState } from "@psilink/core";

import {
  JobApiRequestError,
  createFetchJobApiClient,
  createServerJobExchangeDriver,
} from "@psi/serverJobExchangeDriver";

import { VALID_SHARED_SECRET, validLinkageTerms } from "../utils/jobFixtures";

import type {
  JobApiClient,
  ServerJobExchangeDriverConfig,
} from "@psi/serverJobExchangeDriver";
import type { RelayEvent } from "@jobs/cliDriver";
import type { RunOutputs } from "@bench/runOutputs";

/** The construction-time config every test reuses; the driver only carries it
 * into the intent, so its values are never validated here. */
function driverConfig(): ServerJobExchangeDriverConfig {
  return {
    linkageTerms: validLinkageTerms(),
    sharedSecret: VALID_SHARED_SECRET,
    inputCsv: "ssn\n111223333\n",
  };
}

/** The four lifecycle event mocks a run receives, plus a fresh signal. */
function driverEvents(signal: AbortSignal) {
  return {
    signal,
    onStages: vi.fn(),
    onStage: vi.fn(),
    onResult: vi.fn(),
    onError: vi.fn(),
  };
}

/** Wrap a scripted RelayEvent sequence in an async iterable so a run consumes it
 * exactly as it would a live stream. */
async function* scriptedStream(
  events: Array<RelayEvent>,
): AsyncIterable<RelayEvent> {
  for (const event of events) {
    // Yield on a microtask as a real network stream does, so a mid-stream abort
    // lands between events rather than all at once.
    await Promise.resolve();
    yield event;
  }
}

/** A {@link JobApiClient} whose event stream is a fixed script, capturing the
 * intent it was asked to create and each cancel it received. */
function scriptedClient(events: Array<RelayEvent>) {
  const createdIntents: Array<unknown> = [];
  const cancelledIds: Array<string> = [];
  const client: JobApiClient = {
    createJob: (intent) => {
      createdIntents.push(intent);
      return Promise.resolve("job-1");
    },
    openEventStream: () => scriptedStream(events),
    cancelJob: (jobId) => {
      cancelledIds.push(jobId);
      return Promise.resolve();
    },
  };
  return { client, createdIntents, cancelledIds };
}

function stages(...ids: Array<string>): RelayEvent {
  return {
    v: 1,
    type: "stages",
    stages: ids.map((id) => ({ id, label: id })),
  };
}

function stage(id: string): RelayEvent {
  return { v: 1, type: "stage", id, label: id };
}

function result(resultWritten: boolean): RelayEvent {
  return { v: 1, type: "result", resultWritten };
}

function errorEvent(category: string, message: string): RelayEvent {
  return { v: 1, type: "error", category, message };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("createServerJobExchangeDriver event mapping", () => {
  test("forwards stages then each stage id in order", async () => {
    const { client } = scriptedClient([
      stages("prepare", "exchange", "finish"),
      stage("prepare"),
      stage("exchange"),
      stage("finish"),
      result(true),
    ]);
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    expect(events.onStages).toHaveBeenCalledTimes(1);
    expect(events.onStages).toHaveBeenCalledWith([
      { id: "prepare", label: "prepare", state: ProcessState.BeforeStart },
      { id: "exchange", label: "exchange", state: ProcessState.BeforeStart },
      { id: "finish", label: "finish", state: ProcessState.BeforeStart },
    ]);
    expect(events.onStage.mock.calls.map((call) => call[0])).toEqual([
      "prepare",
      "exchange",
      "finish",
    ]);
    // onStage never fires after the terminal onResult.
    expect(events.onStage.mock.invocationCallOrder.at(-1)).toBeLessThan(
      events.onResult.mock.invocationCallOrder[0],
    );
  });

  test("a written result maps to onResult with the appliance result url", async () => {
    const { client } = scriptedClient([result(true)]);
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    expect(events.onError).not.toHaveBeenCalled();
    expect(events.onResult).toHaveBeenCalledTimes(1);
    const outputs = events.onResult.mock.calls[0][0] as RunOutputs;
    expect(outputs.resultWithheld).toBeUndefined();
    expect(outputs.resultsUrl).toBe("/api/jobs/job-1/result");
  });

  test("a withheld result maps to the withheld outputs variant", async () => {
    const { client } = scriptedClient([result(false)]);
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    expect(events.onError).not.toHaveBeenCalled();
    const outputs = events.onResult.mock.calls[0][0] as RunOutputs;
    expect(outputs.resultWithheld).toBe(true);
    expect(outputs.resultsUrl).toBeUndefined();
  });

  test("a security error passes its category through VERBATIM", async () => {
    // The single most important fidelity requirement: a CLI-classified security
    // terminal must never be downgraded to the retryable 'exchange'.
    const { client } = scriptedClient([
      errorEvent("security", "key exchange authentication failed"),
    ]);
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    expect(events.onResult).not.toHaveBeenCalled();
    expect(events.onError).toHaveBeenCalledTimes(1);
    const failure = events.onError.mock.calls[0][0] as {
      category: string;
      error: unknown;
    };
    expect(failure.category).toBe("security");
    expect(failure.error).toBeInstanceOf(Error);
    expect((failure.error as Error).message).toBe(
      "key exchange authentication failed",
    );
  });

  test("a non-security error category also passes through unchanged", async () => {
    const { client } = scriptedClient([
      errorEvent("output", "could not write result"),
    ]);
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    const failure = events.onError.mock.calls[0][0] as { category: string };
    expect(failure.category).toBe("output");
  });

  test("an unknown error category falls back to 'exchange'", async () => {
    const { client } = scriptedClient([errorEvent("bogus", "something odd")]);
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    const failure = events.onError.mock.calls[0][0] as { category: string };
    expect(failure.category).toBe("exchange");
  });

  test("fires exactly one terminal and stops at it", async () => {
    // A stray event after the terminal result must not be mapped.
    const { client } = scriptedClient([
      result(true),
      stage("after-terminal"),
      errorEvent("exchange", "should be ignored"),
    ]);
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    expect(events.onResult).toHaveBeenCalledTimes(1);
    expect(events.onError).not.toHaveBeenCalled();
    expect(events.onStage).not.toHaveBeenCalled();
  });

  test("a stream that ends without a terminal fails as 'exchange'", async () => {
    // The server reconciles a terminal for every job, so a stream that closes
    // after only progress events is a truncation; the driver must not leave the
    // run hung with no onResult/onError.
    const { client } = scriptedClient([stages("prepare"), stage("prepare")]);
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    expect(events.onResult).not.toHaveBeenCalled();
    expect(events.onError).toHaveBeenCalledTimes(1);
    const failure = events.onError.mock.calls[0][0] as { category: string };
    expect(failure.category).toBe("exchange");
  });

  test("a warning event is dropped, not surfaced as a terminal", async () => {
    const { client } = scriptedClient([
      { v: 1, type: "warning", message: "a non-fatal warning" },
      result(true),
    ]);
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    expect(events.onResult).toHaveBeenCalledTimes(1);
    expect(events.onError).not.toHaveBeenCalled();
  });
});

describe("createServerJobExchangeDriver intent and cancellation", () => {
  test("POSTs an intent with channel 'filedrop' and eventStream true", async () => {
    const { client, createdIntents } = scriptedClient([result(true)]);
    const config = driverConfig();
    const driver = createServerJobExchangeDriver(config, client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    expect(createdIntents).toHaveLength(1);
    expect(createdIntents[0]).toMatchObject({
      channel: "filedrop",
      eventStream: true,
      sharedSecret: config.sharedSecret,
      inputCsv: config.inputCsv,
    });
  });

  test("an already-aborted signal starts no job", async () => {
    const { client, createdIntents } = scriptedClient([result(true)]);
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const controller = new AbortController();
    controller.abort();
    const events = driverEvents(controller.signal);

    await driver.run(events);

    expect(createdIntents).toHaveLength(0);
    expect(events.onResult).not.toHaveBeenCalled();
    expect(events.onError).not.toHaveBeenCalled();
  });

  test("aborting mid-stream POSTs cancel and emits no spurious error", async () => {
    const controller = new AbortController();
    // The stream aborts itself after the first stage, standing in for the caller
    // pressing cancel while the job is still running.
    async function* abortingStream(): AsyncIterable<RelayEvent> {
      await Promise.resolve();
      yield stage("prepare");
      controller.abort();
      yield stage("exchange");
    }
    const cancelledIds: Array<string> = [];
    const client: JobApiClient = {
      createJob: () => Promise.resolve("job-42"),
      openEventStream: () => abortingStream(),
      cancelJob: (jobId) => {
        cancelledIds.push(jobId);
        return Promise.resolve();
      },
    };
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(controller.signal);

    await driver.run(events);

    expect(cancelledIds).toEqual(["job-42"]);
    // The abort is a deliberate user-leave: no error, and the post-abort stage
    // is never mapped.
    expect(events.onError).not.toHaveBeenCalled();
    expect(events.onResult).not.toHaveBeenCalled();
    expect(events.onStage.mock.calls.map((call) => call[0])).toEqual([
      "prepare",
    ]);
  });

  test("a rejected intent (HTTP 400) is category 'config'", async () => {
    const failingClient: JobApiClient = {
      createJob: () =>
        Promise.reject(new JobApiRequestError(400, "bad intent")),
      openEventStream: () => scriptedStream([]),
      cancelJob: () => Promise.resolve(),
    };
    const driver = createServerJobExchangeDriver(driverConfig(), failingClient);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    const failure = events.onError.mock.calls[0][0] as { category: string };
    expect(failure.category).toBe("config");
  });

  test("a server/network failure (HTTP 500) is category 'exchange'", async () => {
    const client: JobApiClient = {
      createJob: () =>
        Promise.reject(new JobApiRequestError(500, "server error")),
      openEventStream: () => scriptedStream([]),
      cancelJob: () => Promise.resolve(),
    };
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    const failure = events.onError.mock.calls[0][0] as { category: string };
    expect(failure.category).toBe("exchange");
  });
});

describe("createFetchJobApiClient over an injected fetch", () => {
  /** A Response whose body streams the given SSE text in one chunk. */
  function sseResponse(text: string): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  test("POSTs the intent and maps a streamed result frame end to end", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetchImpl = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        calls.push({
          url,
          method: init?.method ?? "GET",
          body: init?.body as string | undefined,
        });
        if (url === "/api/jobs")
          return Promise.resolve(
            new Response(JSON.stringify({ id: "job-9" }), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            }),
          );
        return Promise.resolve(
          sseResponse(
            'id: 1\ndata: {"v":1,"type":"result","resultWritten":true}\n\n',
          ),
        );
      },
    ) as unknown as typeof fetch;

    const client = createFetchJobApiClient(fetchImpl);
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    // The intent was POSTed to /api/jobs with channel filedrop.
    const post = calls.find((call) => call.url === "/api/jobs");
    expect(post?.method).toBe("POST");
    expect(JSON.parse(post?.body ?? "{}")).toMatchObject({
      channel: "filedrop",
      eventStream: true,
    });
    // The events stream was opened for the returned id.
    expect(calls.some((call) => call.url === "/api/jobs/job-9/events")).toBe(
      true,
    );
    // The streamed result frame reached onResult.
    const outputs = events.onResult.mock.calls[0][0] as RunOutputs;
    expect(outputs.resultsUrl).toBe("/api/jobs/job-9/result");
  });

  test("a streamed security error frame maps to category 'security'", async () => {
    const fetchImpl = (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url === "/api/jobs")
        return Promise.resolve(
          new Response(JSON.stringify({ id: "job-x" }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          }),
        );
      return Promise.resolve(
        sseResponse(
          'id: 1\ndata: {"v":1,"type":"error","category":"security","message":"tamper detected"}\n\n',
        ),
      );
    };

    const client = createFetchJobApiClient(fetchImpl);
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    const failure = events.onError.mock.calls[0][0] as { category: string };
    expect(failure.category).toBe("security");
  });

  test("a non-2xx create surfaces the status as a JobApiRequestError", async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response(null, { status: 400 }))) as typeof fetch;
    const client = createFetchJobApiClient(fetchImpl);

    await expect(
      client.createJob(
        {
          channel: "filedrop",
          linkageTerms: validLinkageTerms(),
          sharedSecret: VALID_SHARED_SECRET,
          inputCsv: "x\n",
          eventStream: true,
        },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(JobApiRequestError);
  });
});
