import { afterEach, describe, expect, test, vi } from "vitest";

import { ProcessState } from "@psilink/core";

import {
  JobApiRequestError,
  createFetchJobApiClient,
  createServerJobExchangeDriver,
  fetchSftpRemotes,
} from "@psi/serverJobExchangeDriver";
import { buildRunOutputs } from "@bench/runOutputs";

import { VALID_SHARED_SECRET, validLinkageTerms } from "../utils/jobFixtures";

import type {
  ExchangeResult,
  Metadata,
  PreparedExchange,
  Standardization,
} from "@psilink/core";
import type {
  JobApiClient,
  RecordAvailability,
  ServerJobExchangeDriverConfig,
} from "@psi/serverJobExchangeDriver";
import type { ObjectUrls, RunOutputs } from "@bench/runOutputs";
import type { RelayEvent } from "@jobs/cliDriver";

/** The construction-time config every test reuses (a filedrop transport unless
 * a test overrides it); the driver only carries it into the intent, so its
 * values are never validated here. */
function driverConfig(): ServerJobExchangeDriverConfig {
  return {
    transport: { channel: "filedrop" },
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
 * intent it was asked to create and each cancel it received. The record
 * availability defaults to unavailable; a test that exercises the record set
 * passes an availability (or a function that throws to script a failed query). */
function scriptedClient(
  events: Array<RelayEvent>,
  availability: RecordAvailability | (() => Promise<RecordAvailability>) = {
    available: false,
  },
) {
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
    fetchRecordAvailability: () =>
      typeof availability === "function"
        ? availability()
        : Promise.resolve(availability),
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

  test("a warning event is dropped when no onWarning is provided", async () => {
    // Not a terminal, and with the optional slot absent the message goes
    // nowhere.
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

  test("a warning event forwards its message to onWarning, then the run continues", async () => {
    // The operator-visibility requirement: the CLI's structured warning (e.g.
    // the cross-party host-key divergence notice) must reach the consumer's
    // optional slot, without becoming a terminal.
    const { client } = scriptedClient([
      { v: 1, type: "warning", message: "host key fingerprints diverge" },
      { v: 1, type: "warning", message: "second notice" },
      result(true),
    ]);
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const onWarning = vi.fn();
    const events = {
      ...driverEvents(new AbortController().signal),
      onWarning,
    };

    await driver.run(events);

    expect(onWarning.mock.calls.map((call) => call[0])).toEqual([
      "host key fingerprints diverge",
      "second notice",
    ]);
    expect(events.onResult).toHaveBeenCalledTimes(1);
    expect(events.onError).not.toHaveBeenCalled();
  });

  test("a warning with a missing or empty message never reaches onWarning", async () => {
    const { client } = scriptedClient([
      { v: 1, type: "warning" },
      { v: 1, type: "warning", message: "" },
      { v: 1, type: "warning", message: 7 },
      result(true),
    ]);
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const onWarning = vi.fn();
    const events = {
      ...driverEvents(new AbortController().signal),
      onWarning,
    };

    await driver.run(events);

    expect(onWarning).not.toHaveBeenCalled();
    expect(events.onResult).toHaveBeenCalledTimes(1);
  });
});

describe("createServerJobExchangeDriver record downloads", () => {
  const CREATED_AT = "2026-07-08T14:32:00.000Z";
  const RECORD_NAME = "psilink-record-2026-07-08T14-32-00-000Z.json";
  const KEYS_NAME = "psilink-record-2026-07-08T14-32-00-000Z.keys.json";

  test("a completed job with an available record yields the full result set", async () => {
    const { client } = scriptedClient([result(true)], {
      available: true,
      createdAt: CREATED_AT,
    });
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    expect(events.onError).not.toHaveBeenCalled();
    const outputs = events.onResult.mock.calls[0][0] as RunOutputs;
    expect(outputs.resultsUrl).toBe("/api/jobs/job-1/result");
    expect(outputs.record).toEqual({
      recordUrl: "/api/jobs/job-1/record",
      recordFileName: RECORD_NAME,
      keysUrl: "/api/jobs/job-1/keys",
      keysFileName: KEYS_NAME,
    });
  });

  test("a withheld result still offers the record when available", async () => {
    const { client } = scriptedClient([result(false)], {
      available: true,
      createdAt: CREATED_AT,
    });
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    const outputs = events.onResult.mock.calls[0][0] as RunOutputs;
    expect(outputs.resultWithheld).toBe(true);
    expect(outputs.resultsUrl).toBeUndefined();
    expect(outputs.record?.recordUrl).toBe("/api/jobs/job-1/record");
    expect(outputs.record?.keysUrl).toBe("/api/jobs/job-1/keys");
  });

  test("a not-yet-available record omits the record but still delivers the result", async () => {
    const { client } = scriptedClient([result(true)], { available: false });
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    expect(events.onError).not.toHaveBeenCalled();
    const outputs = events.onResult.mock.calls[0][0] as RunOutputs;
    expect(outputs.resultsUrl).toBe("/api/jobs/job-1/result");
    expect(outputs.record).toBeUndefined();
  });

  test("a failed availability query degrades gracefully to no record", async () => {
    // The result CSV is the primary artifact; a metadata-fetch failure must not
    // fail the run or block the download.
    const { client } = scriptedClient([result(true)], () =>
      Promise.reject(new Error("status fetch failed")),
    );
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    expect(events.onError).not.toHaveBeenCalled();
    const outputs = events.onResult.mock.calls[0][0] as RunOutputs;
    expect(outputs.resultsUrl).toBe("/api/jobs/job-1/result");
    expect(outputs.record).toBeUndefined();
  });

  test("an abort during the availability query stays silent", async () => {
    const controller = new AbortController();
    const { client } = scriptedClient([result(true)], () => {
      controller.abort();
      return Promise.resolve({ available: true, createdAt: CREATED_AT });
    });
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(controller.signal);

    await driver.run(events);

    // A caller-initiated abort mid-query is silent: neither terminal fires.
    expect(events.onResult).not.toHaveBeenCalled();
    expect(events.onError).not.toHaveBeenCalled();
  });

  test("the record filenames are byte-identical to the in-browser path's", () => {
    // buildRunOutputs is the in-browser parity reference: for the same createdAt
    // the console driver must produce the same record/keys filenames.
    const created: Array<string> = [];
    const urls: ObjectUrls = {
      create: (blob) => {
        const url = `blob:${created.length}-${blob.type}`;
        created.push(url);
        return url;
      },
      revoke: () => {},
    };
    const inBrowser = buildRunOutputs(
      {
        associationTable: undefined,
        partnerPayload: { columns: [], rowIndices: [], rows: [] },
        audit: { record: { createdAt: CREATED_AT }, keys: { salts: {} } },
      } as unknown as ExchangeResult,
      {} as unknown as PreparedExchange,
      urls,
    );

    expect(inBrowser.record?.recordFileName).toBe(RECORD_NAME);
    expect(inBrowser.record?.keysFileName).toBe(KEYS_NAME);
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

  test("a filedrop transport serializes to exactly the bare filedrop intent", async () => {
    // The transport discriminator must be invisible on the wire for filedrop:
    // the serialized intent -- field set AND order -- is the intent arm's own
    // fields, with no transport artifact riding along.
    const { client, createdIntents } = scriptedClient([result(true)]);
    const config = driverConfig();
    await createServerJobExchangeDriver(config, client).run(
      driverEvents(new AbortController().signal),
    );

    expect(JSON.stringify(createdIntents[0])).toBe(
      JSON.stringify({
        channel: "filedrop",
        linkageTerms: config.linkageTerms,
        sharedSecret: config.sharedSecret,
        inputCsv: config.inputCsv,
        eventStream: true,
      }),
    );
  });

  test("an sftp transport POSTs the sftp arm carrying ONLY the remote name", async () => {
    const { client, createdIntents } = scriptedClient([result(true)]);
    const config: ServerJobExchangeDriverConfig = {
      ...driverConfig(),
      transport: { channel: "sftp", remote: "prod_east" },
    };
    await createServerJobExchangeDriver(config, client).run(
      driverEvents(new AbortController().signal),
    );

    const intent = createdIntents[0] as Record<string, unknown>;
    expect(intent.channel).toBe("sftp");
    expect(intent.remote).toBe("prod_east");
    // Exactly one field beyond the filedrop shape: no host, port, path, or any
    // other connection material can ride the intent.
    expect(Object.keys(intent).sort()).toEqual([
      "channel",
      "eventStream",
      "inputCsv",
      "linkageTerms",
      "remote",
      "sharedSecret",
    ]);
  });

  test("the event mapping is channel-independent: an sftp run maps a result identically", async () => {
    const { client } = scriptedClient([
      stages("prepare", "exchange"),
      stage("prepare"),
      result(true),
    ]);
    const driver = createServerJobExchangeDriver(
      {
        ...driverConfig(),
        transport: { channel: "sftp", remote: "prod_east" },
      },
      client,
    );
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    expect(events.onStages).toHaveBeenCalledTimes(1);
    expect(events.onStage).toHaveBeenCalledWith("prepare");
    const outputs = events.onResult.mock.calls[0][0] as RunOutputs;
    expect(outputs.resultsUrl).toBe("/api/jobs/job-1/result");
    expect(events.onError).not.toHaveBeenCalled();
  });

  test("forwards the config's metadata and standardization into the intent", async () => {
    // Both builders (acceptor and inviter) funnel their operator-authored data-prep
    // edits through this driver config; the driver must carry them into the intent
    // so the appliance's CLI honors them rather than inferring metadata.
    const metadata: Metadata = [
      { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
      { name: "secret", type: "other", role: "ignored", isPayload: true },
    ];
    const standardization: Standardization = [
      { output: "ssn", input: "ssn", steps: [{ function: "trim" }] },
    ];
    const { client, createdIntents } = scriptedClient([result(true)]);
    const driver = createServerJobExchangeDriver(
      { ...driverConfig(), metadata, standardization },
      client,
    );
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    expect(createdIntents[0]).toMatchObject({ metadata, standardization });
  });

  test("omits metadata and standardization when the config sets neither", async () => {
    const { client, createdIntents } = scriptedClient([result(true)]);
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    const intent = createdIntents[0] as Record<string, unknown>;
    expect(intent.metadata).toBeUndefined();
    expect(intent.standardization).toBeUndefined();
    expect(intent.expectedPayloadColumns).toBeUndefined();
  });

  test("forwards expectedPayloadColumns into the intent, empty array included", async () => {
    // The received-payload lock-in must reach the intent as-is; an empty array is a
    // strict "receive nothing" and must not be collapsed to undefined.
    const nonEmpty = scriptedClient([result(true)]);
    await createServerJobExchangeDriver(
      { ...driverConfig(), expectedPayloadColumns: ["program_code"] },
      nonEmpty.client,
    ).run(driverEvents(new AbortController().signal));
    expect(nonEmpty.createdIntents[0]).toMatchObject({
      expectedPayloadColumns: ["program_code"],
    });

    const empty = scriptedClient([result(true)]);
    await createServerJobExchangeDriver(
      { ...driverConfig(), expectedPayloadColumns: [] },
      empty.client,
    ).run(driverEvents(new AbortController().signal));
    expect(
      (empty.createdIntents[0] as { expectedPayloadColumns?: unknown })
        .expectedPayloadColumns,
    ).toEqual([]);
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
      fetchRecordAvailability: () => Promise.resolve({ available: false }),
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
      fetchRecordAvailability: () => Promise.resolve({ available: false }),
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
      fetchRecordAvailability: () => Promise.resolve({ available: false }),
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
        if (url === "/api/jobs/job-9")
          return Promise.resolve(
            new Response(
              JSON.stringify({
                recordAvailable: true,
                recordCreatedAt: "2026-07-08T14:32:00.000Z",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
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
    // The streamed result frame reached onResult, with the record pair fetched
    // off the status endpoint.
    const outputs = events.onResult.mock.calls[0][0] as RunOutputs;
    expect(outputs.resultsUrl).toBe("/api/jobs/job-9/result");
    expect(outputs.record).toEqual({
      recordUrl: "/api/jobs/job-9/record",
      recordFileName: "psilink-record-2026-07-08T14-32-00-000Z.json",
      keysUrl: "/api/jobs/job-9/keys",
      keysFileName: "psilink-record-2026-07-08T14-32-00-000Z.keys.json",
    });
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

  test("fetchRecordAvailability reads recordAvailable and recordCreatedAt", async () => {
    const statusResponse =
      (body: unknown): typeof fetch =>
      () =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
    const signal = new AbortController().signal;

    await expect(
      createFetchJobApiClient(
        statusResponse({
          recordAvailable: true,
          recordCreatedAt: "2026-07-08T14:32:00.000Z",
        }),
      ).fetchRecordAvailability("job-1", signal),
    ).resolves.toEqual({
      available: true,
      createdAt: "2026-07-08T14:32:00.000Z",
    });

    // recordAvailable false, a missing createdAt, and a non-2xx all read as
    // unavailable.
    await expect(
      createFetchJobApiClient(
        statusResponse({ recordAvailable: false }),
      ).fetchRecordAvailability("job-1", signal),
    ).resolves.toEqual({ available: false });
    await expect(
      createFetchJobApiClient(
        statusResponse({ recordAvailable: true }),
      ).fetchRecordAvailability("job-1", signal),
    ).resolves.toEqual({ available: false });
    const notFound: typeof fetch = () =>
      Promise.resolve(new Response(null, { status: 404 }));
    await expect(
      createFetchJobApiClient(notFound).fetchRecordAvailability(
        "job-1",
        signal,
      ),
    ).resolves.toEqual({ available: false });
  });
});

describe("fetchSftpRemotes", () => {
  function jsonResponse(body: unknown, status = 200): typeof fetch {
    return () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
  }

  test("returns the validated projection array, optional fields preserved", async () => {
    const remotes = await fetchSftpRemotes(
      jsonResponse([
        { name: "prod_east", host: "sftp.example.gov", port: 2222, path: "/x" },
        { name: "dr-west", host: "dr.example.gov" },
      ]),
    );
    expect(remotes).toEqual([
      { name: "prod_east", host: "sftp.example.gov", port: 2222, path: "/x" },
      { name: "dr-west", host: "dr.example.gov" },
    ]);
  });

  test("GETs the remotes route", async () => {
    const urls: Array<string> = [];
    await fetchSftpRemotes((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(
        new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    expect(urls).toEqual(["/api/jobs/remotes"]);
  });

  test("an enabled API with no remotes reads as none configured", async () => {
    await expect(fetchSftpRemotes(jsonResponse([]))).resolves.toEqual([]);
  });

  test("a non-2xx reads as none configured (fail toward save-file)", async () => {
    // 404 is also the gate's disabled-API response, and 401 its bad-bearer
    // response; both mean "no server-job run can start here".
    for (const status of [401, 404, 500])
      await expect(
        fetchSftpRemotes(jsonResponse([{ name: "a", host: "h" }], status)),
      ).resolves.toEqual([]);
  });

  test("a malformed body reads as none configured, never a partial table", async () => {
    const malformed: Array<unknown> = [
      { remotes: [] },
      "prod_east",
      [null],
      ["prod_east"],
      [{ host: "no-name.example.gov" }],
      [{ name: "no_host" }],
      [{ name: "", host: "h" }],
      [{ name: "a", host: "" }],
      [{ name: "a", host: "h", port: "2222" }],
      [{ name: "a", host: "h", port: 0 }],
      [{ name: "a", host: "h", port: 65536 }],
      [{ name: "a", host: "h", path: "" }],
      // One bad entry beside a good one fails the WHOLE listing closed.
      [{ name: "good", host: "h" }, { name: "bad" }],
    ];
    for (const body of malformed)
      await expect(fetchSftpRemotes(jsonResponse(body))).resolves.toEqual([]);
  });

  test("a network error and a non-JSON body read as none configured", async () => {
    await expect(
      fetchSftpRemotes(() => Promise.reject(new Error("offline"))),
    ).resolves.toEqual([]);
    const htmlResponse: typeof fetch = () =>
      Promise.resolve(
        new Response("<html>gateway error</html>", { status: 200 }),
      );
    await expect(fetchSftpRemotes(htmlResponse)).resolves.toEqual([]);
  });
});
