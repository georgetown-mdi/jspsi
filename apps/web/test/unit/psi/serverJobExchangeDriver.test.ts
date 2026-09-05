import { afterEach, describe, expect, test, vi } from "vitest";

import { ProcessState } from "@psilink/core";

import {
  JobApiRequestError,
  createFetchJobApiClient,
  createServerJobExchangeDriver,
  createServerJobReattachDriver,
  createServerJobZeroSetupDriver,
  fetchSftpConnection,
  fetchSlotOccupancy,
} from "@psi/jobClient/serverJobExchangeDriver";
import { buildRunOutputs } from "@psi/runOutputs";

import {
  VALID_SHARED_SECRET,
  validLinkageTerms,
} from "../../utils/jobFixtures";

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
  ServerJobZeroSetupDriverConfig,
} from "@psi/jobClient/serverJobExchangeDriver";
import type { ObjectUrls, RunOutputs } from "@psi/runOutputs";
import type { RelayEvent } from "@jobs/cliDriver";

/** The inline CSV content the reused config holds; the driver maps an `inline`
 * input source to the intent's `inputCsv` arm. */
const CONFIG_INPUT_CSV = "ssn\n111223333\n";

/** The construction-time config every test reuses (a filedrop transport unless
 * a test overrides it); the driver only passes it into the intent, so its
 * values are never validated here. */
function driverConfig(): ServerJobExchangeDriverConfig {
  return {
    transport: { channel: "filedrop" },
    side: "inviter",
    linkageTerms: validLinkageTerms(),
    sharedSecret: VALID_SHARED_SECRET,
    inputSource: { kind: "inline", csv: CONFIG_INPUT_CSV },
  };
}

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
  const deletedIds: Array<string> = [];
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
    deleteJob: (jobId) => {
      deletedIds.push(jobId);
      return Promise.resolve();
    },
    fetchJobStatus: () => Promise.resolve({ kind: "live", status: "running" }),
    fetchRecordAvailability: () =>
      typeof availability === "function"
        ? availability()
        : Promise.resolve(availability),
  };
  return { client, createdIntents, cancelledIds, deletedIds };
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

function stageEnd(id: string, durationMs: number): RelayEvent {
  return { v: 1, type: "stageEnd", id, durationMs };
}

function metrics(): RelayEvent {
  return {
    v: 1,
    type: "metrics",
    recordsProcessed: 1000,
    transportRetries: 0,
    reconnects: 1,
  };
}

function result(resultWritten: boolean): RelayEvent {
  return { v: 1, type: "result", resultWritten };
}

/** The count-only terminal event: no result file was written, and the count the
 * run reported rides the same event with the provenance that decides whether the
 * surface caveats it (docs/spec/CLI_EVENTS.md, `result`). */
function countOnlyResult(
  intersectionCount: number,
  countReportedByPartner = false,
): RelayEvent {
  return {
    v: 1,
    type: "result",
    resultWritten: false,
    intersectionCount,
    countReportedByPartner,
  };
}

/** The result download url a `matched` outputs shape has, and undefined for
 * the two shapes that have no result file at all -- so an assertion reads the field
 * it means without restating the narrowing at every call site. */
function resultsUrlOf(outputs: RunOutputs): string | undefined {
  return outputs.kind === "matched" ? outputs.resultsUrl : undefined;
}

/** The count a `counted` outputs shape has, and undefined for the other two. */
function countOf(outputs: RunOutputs): number | undefined {
  return outputs.kind === "counted" ? outputs.intersectionCount : undefined;
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
    expect(events.onStage.mock.invocationCallOrder.at(-1)).toBeLessThan(
      events.onResult.mock.invocationCallOrder[0],
    );
  });

  test("consumes stageEnd and metrics events, then still delivers the result", async () => {
    const { client } = scriptedClient([
      stages("prepare", "exchange"),
      stage("prepare"),
      stageEnd("prepare", 12),
      stage("exchange"),
      stageEnd("exchange", 34),
      metrics(),
      result(true),
    ]);
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    // stageEnd and metrics have no lifecycle mapping: they are neither dropped
    // as unknown nor treated as an error, so the run reaches its terminal result.
    expect(events.onError).not.toHaveBeenCalled();
    expect(events.onResult).toHaveBeenCalledTimes(1);
    expect(events.onStage.mock.calls.map((call) => call[0])).toEqual([
      "prepare",
      "exchange",
    ]);
  });

  test("a written result maps to onResult with the console result url", async () => {
    const { client } = scriptedClient([result(true)]);
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    expect(events.onError).not.toHaveBeenCalled();
    expect(events.onResult).toHaveBeenCalledTimes(1);
    const outputs = events.onResult.mock.calls[0][0] as RunOutputs;
    expect(outputs.kind).not.toBe("withheld");
    expect(resultsUrlOf(outputs)).toBe("/api/jobs/job-1/result");
  });

  test("a withheld result maps to the withheld outputs variant", async () => {
    const { client } = scriptedClient([result(false)]);
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    expect(events.onError).not.toHaveBeenCalled();
    const outputs = events.onResult.mock.calls[0][0] as RunOutputs;
    expect(outputs.kind).toBe("withheld");
    expect(resultsUrlOf(outputs)).toBeUndefined();
  });

  test("a count-only result maps to the counted outputs, not the withheld ones", async () => {
    const { client } = scriptedClient([countOnlyResult(42)]);
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    expect(events.onError).not.toHaveBeenCalled();
    const outputs = events.onResult.mock.calls[0][0] as RunOutputs;
    // The count is the run's whole result: nothing was withheld from this party,
    // and there is no result file on the console to point a download at.
    expect(outputs.kind).toBe("counted");
    expect(countOf(outputs)).toBe(42);
    expect(resultsUrlOf(outputs)).toBeUndefined();
    // The completion headline reads the counted shape's own field, so the count
    // must not also arrive as a matched-row figure.
    expect(outputs.matchedRecordCount).toBeUndefined();
  });

  test("the count's provenance rides the event onto the counted outputs", async () => {
    // The console operator reading a count it did not compute gets the same
    // trust-contingent caveat the CLI's own completion line has, so the seat
    // must survive the relay rather than being flattened to the local reading.
    const reported = scriptedClient([countOnlyResult(42, true)]);
    const reportedEvents = driverEvents(new AbortController().signal);
    await createServerJobExchangeDriver(driverConfig(), reported.client).run(
      reportedEvents,
    );
    expect(reportedEvents.onResult.mock.calls[0][0]).toMatchObject({
      kind: "counted",
      countReportedByPartner: true,
    });

    // A frame that omits the field renders the count as this party's own reading:
    // a caveat on a locally computed count would be a false statement about an
    // enforced outcome.
    const bare = scriptedClient([
      { v: 1, type: "result", resultWritten: false, intersectionCount: 42 },
    ]);
    const bareEvents = driverEvents(new AbortController().signal);
    await createServerJobExchangeDriver(driverConfig(), bare.client).run(
      bareEvents,
    );
    expect(bareEvents.onResult.mock.calls[0][0]).toMatchObject({
      kind: "counted",
      countReportedByPartner: false,
    });
  });

  test("a zero count is still a count, not a withheld result", async () => {
    // The field's presence is the discriminant, so an empty intersection reports
    // as the count-only outcome rather than falling into the withheld shape.
    const { client } = scriptedClient([countOnlyResult(0)]);
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    const outputs = events.onResult.mock.calls[0][0] as RunOutputs;
    expect(countOf(outputs)).toBe(0);
    expect(outputs.kind).not.toBe("withheld");
  });

  test("a malformed count falls back to the event's own resultWritten shape", async () => {
    // A frame outside the contract must not render a nonsense figure: the run is
    // reported by what resultWritten says, which here is a withheld result.
    const { client } = scriptedClient([
      { v: 1, type: "result", resultWritten: false, intersectionCount: -1 },
    ]);
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    const outputs = events.onResult.mock.calls[0][0] as RunOutputs;
    expect(countOf(outputs)).toBeUndefined();
    expect(outputs.kind).toBe("withheld");
  });

  test("a written result outranks a count the same event has", async () => {
    // An out-of-contract event: the contract states a count only on the
    // resultWritten:false arm (docs/spec/CLI_EVENTS.md, `result`). Reading the count
    // first would cost the operator the download link for a result the console did
    // write, so resultWritten stays the outer discriminant.
    const { client } = scriptedClient([
      { v: 1, type: "result", resultWritten: true, intersectionCount: 7 },
    ]);
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    const outputs = events.onResult.mock.calls[0][0] as RunOutputs;
    expect(resultsUrlOf(outputs)).toBe("/api/jobs/job-1/result");
    expect(countOf(outputs)).toBeUndefined();
    expect(outputs.kind).not.toBe("withheld");
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
    expect(resultsUrlOf(outputs)).toBe("/api/jobs/job-1/result");
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
    expect(outputs.kind).toBe("withheld");
    expect(resultsUrlOf(outputs)).toBeUndefined();
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
    expect(resultsUrlOf(outputs)).toBe("/api/jobs/job-1/result");
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
    expect(resultsUrlOf(outputs)).toBe("/api/jobs/job-1/result");
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
      inputCsv: CONFIG_INPUT_CSV,
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
        side: config.side,
        linkageTerms: config.linkageTerms,
        sharedSecret: config.sharedSecret,
        inputCsv: CONFIG_INPUT_CSV,
        eventStream: true,
      }),
    );
  });

  test("a workFile input source maps to the intent's inputFile arm, not inputCsv", async () => {
    const { client, createdIntents } = scriptedClient([result(true)]);
    const config: ServerJobExchangeDriverConfig = {
      ...driverConfig(),
      inputSource: {
        kind: "workFile",
        name: "clients.csv",
      },
    };
    await createServerJobExchangeDriver(config, client).run(
      driverEvents(new AbortController().signal),
    );

    const intent = createdIntents[0] as Record<string, unknown>;
    expect(intent.inputCsv).toBeUndefined();
    expect(intent.inputFile).toEqual({
      name: "clients.csv",
    });
  });

  test("an sftp transport POSTs the sftp arm holding NO connection field", async () => {
    const { client, createdIntents } = scriptedClient([result(true)]);
    const config: ServerJobExchangeDriverConfig = {
      ...driverConfig(),
      transport: { channel: "sftp" },
    };
    await createServerJobExchangeDriver(config, client).run(
      driverEvents(new AbortController().signal),
    );

    const intent = createdIntents[0] as Record<string, unknown>;
    expect(intent.channel).toBe("sftp");
    // Only the shared fields beyond the discriminant: no remote, host, port,
    // path, or any other connection material can ride the intent.
    expect(Object.keys(intent).sort()).toEqual([
      "channel",
      "eventStream",
      "inputCsv",
      "linkageTerms",
      "sharedSecret",
      "side",
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
        transport: { channel: "sftp" },
      },
      client,
    );
    const events = driverEvents(new AbortController().signal);

    await driver.run(events);

    expect(events.onStages).toHaveBeenCalledTimes(1);
    expect(events.onStage).toHaveBeenCalledWith("prepare");
    const outputs = events.onResult.mock.calls[0][0] as RunOutputs;
    expect(resultsUrlOf(outputs)).toBe("/api/jobs/job-1/result");
    expect(events.onError).not.toHaveBeenCalled();
  });

  test("forwards the config's metadata and standardization into the intent", async () => {
    // Both builders (acceptor and inviter) funnel their operator-authored data-prep
    // edits through this driver config; the driver must pass them into the intent
    // so the console's CLI honors them rather than inferring metadata.
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
    expect(intent.expectedPartnerDeduplicate).toBeUndefined();
  });

  test("forwards expectedPayloadColumns into the intent, empty array included", async () => {
    // The received-payload commitment must reach the intent as-is; an empty array is a
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

  test("forwards expectedPartnerDeduplicate into the intent, false included", async () => {
    // The terms-side commitment must reach the intent as-is: `false` is a real
    // declaration and must not be collapsed into the absent state, which binds
    // nothing at the run the console conducts.
    for (const declared of [false, true]) {
      const scripted = scriptedClient([result(true)]);
      await createServerJobExchangeDriver(
        { ...driverConfig(), expectedPartnerDeduplicate: declared },
        scripted.client,
      ).run(driverEvents(new AbortController().signal));
      expect(
        (scripted.createdIntents[0] as { expectedPartnerDeduplicate?: unknown })
          .expectedPartnerDeduplicate,
      ).toBe(declared);
    }
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

  test("onJobCreated fires with the created id before the stream opens", async () => {
    const order: Array<string> = [];
    const created: Array<string> = [];
    const client: JobApiClient = {
      createJob: () => {
        order.push("create");
        return Promise.resolve("job-77");
      },
      openEventStream: () => {
        order.push("stream");
        return scriptedStream([result(true)]);
      },
      cancelJob: () => Promise.resolve(),
      deleteJob: () => Promise.resolve(),
      fetchJobStatus: () =>
        Promise.resolve({ kind: "live", status: "running" }),
      fetchRecordAvailability: () => Promise.resolve({ available: false }),
    };
    const config: ServerJobExchangeDriverConfig = {
      ...driverConfig(),
      onJobCreated: (jobId) => {
        order.push("onJobCreated");
        created.push(jobId);
      },
    };

    await createServerJobExchangeDriver(config, client).run(
      driverEvents(new AbortController().signal),
    );

    expect(created).toEqual(["job-77"]);
    // onJobCreated fires after create resolves and before the event stream opens,
    // so the recovery record is persisted the instant the job exists on the console.
    expect(order).toEqual(["create", "onJobCreated", "stream"]);
  });

  test("aborting mid-stream does NOT POST cancel and emits no spurious error", async () => {
    const controller = new AbortController();
    // The stream aborts itself after the first stage, standing in for an unmount /
    // reload / tab close mid-run. An abort now has NO cancel intent: it only
    // stops consuming the stream silently, and the console's run keeps going.
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
      deleteJob: () => Promise.resolve(),
      fetchJobStatus: () =>
        Promise.resolve({ kind: "live", status: "running" }),
      fetchRecordAvailability: () => Promise.resolve({ available: false }),
    };
    const driver = createServerJobExchangeDriver(driverConfig(), client);
    const events = driverEvents(controller.signal);

    await driver.run(events);

    expect(cancelledIds).toEqual([]);
    // The abort is a silent user-leave: no error, and the post-abort stage is
    // never mapped.
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
      deleteJob: () => Promise.resolve(),
      fetchJobStatus: () => Promise.resolve({ kind: "gone" }),
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
      deleteJob: () => Promise.resolve(),
      fetchJobStatus: () => Promise.resolve({ kind: "gone" }),
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
    expect(resultsUrlOf(outputs)).toBe("/api/jobs/job-9/result");
    expect(outputs.record).toEqual({
      recordUrl: "/api/jobs/job-9/record",
      recordFileName: "psilink-record-2026-07-08T14-32-00-000Z.json",
      keysUrl: "/api/jobs/job-9/keys",
      keysFileName: "psilink-record-2026-07-08T14-32-00-000Z.keys.json",
    });
  });

  test("recognizes streamed stageEnd and metrics frames (relayed, not dropped)", async () => {
    const fetchImpl = ((input: RequestInfo | URL): Promise<Response> => {
      void input;
      return Promise.resolve(
        sseResponse(
          'id: 1\ndata: {"v":1,"type":"stageEnd","id":"stage 1 / 2","durationMs":1234}\n\n' +
            'id: 2\ndata: {"v":1,"type":"metrics","recordsProcessed":1000,"transportRetries":0,"reconnects":1}\n\n' +
            'id: 3\ndata: {"v":1,"type":"result","resultWritten":true}\n\n',
        ),
      );
    }) as typeof fetch;

    const client = createFetchJobApiClient(fetchImpl);
    const received: Array<RelayEvent> = [];
    for await (const event of client.openEventStream(
      "job-7",
      new AbortController().signal,
    ))
      received.push(event);

    // A recognized frame is yielded; an unknown one is silently dropped by
    // parseSseFrame, so all three surviving means the allowlist accepts them.
    expect(received.map((event) => event.type)).toEqual([
      "stageEnd",
      "metrics",
      "result",
    ]);
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

  test("a non-2xx create reports the status as a JobApiRequestError", async () => {
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

  test("a busy (409) create has the occupying job id on the error", async () => {
    // The single slot is occupied: the body names its occupant so the client can
    // re-attach to the running exchange rather than dead-end on the alert.
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: "job-busy" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
      )) as typeof fetch;
    const client = createFetchJobApiClient(fetchImpl);

    const error = (await client
      .createJob(
        {
          channel: "filedrop",
          linkageTerms: validLinkageTerms(),
          sharedSecret: VALID_SHARED_SECRET,
          inputCsv: "x\n",
          eventStream: true,
        },
        new AbortController().signal,
      )
      .catch((thrown: unknown) => thrown)) as JobApiRequestError;
    expect(error).toBeInstanceOf(JobApiRequestError);
    expect(error.status).toBe(409);
    expect(error.activeJobId).toBe("job-busy");
  });

  test("an empty-bodied 409 leaves activeJobId undefined (client falls back)", async () => {
    // A 409 with no `{ id }` body (an older server, or an empty response): the
    // client parses no id and falls back to its persisted attachment id.
    const fetchImpl = (() =>
      Promise.resolve(new Response(null, { status: 409 }))) as typeof fetch;
    const client = createFetchJobApiClient(fetchImpl);

    const error = (await client
      .createJob(
        {
          channel: "filedrop",
          linkageTerms: validLinkageTerms(),
          sharedSecret: VALID_SHARED_SECRET,
          inputCsv: "x\n",
          eventStream: true,
        },
        new AbortController().signal,
      )
      .catch((thrown: unknown) => thrown)) as JobApiRequestError;
    expect(error).toBeInstanceOf(JobApiRequestError);
    expect(error.status).toBe(409);
    expect(error.activeJobId).toBeUndefined();
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

    // recordAvailable false, a missing createdAt, and a non-2xx all resolve to
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

describe("createFetchJobApiClient event-stream reconnect limits", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fetch whose first `/events` call streams one non-terminal frame and then
   * closes, and whose later `/events` calls answer with `later`. */
  function droppingEventsFetch(later: () => Promise<Response>) {
    const calls: Array<RequestInit | undefined> = [];
    const fetchImpl = ((
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      if (!String(input).endsWith("/events"))
        return Promise.resolve(new Response(null, { status: 404 }));
      calls.push(init);
      if (calls.length > 1) return later();
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'id: 1\ndata: {"v":1,"type":"stage","id":"one"}\n\n',
                ),
              );
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  /** Drain the client's event stream, resolving the events it delivered or the
   * error it ended on. */
  async function drain(
    client: ReturnType<typeof createFetchJobApiClient>,
  ): Promise<{ events: Array<RelayEvent>; error: unknown }> {
    const events: Array<RelayEvent> = [];
    try {
      for await (const event of client.openEventStream(
        "job-1",
        new AbortController().signal,
      ))
        events.push(event);
      return { events, error: undefined };
    } catch (error) {
      return { events, error };
    }
  }

  test("an unrecoverable drop ends as a stream-lost state, not a failed run", async () => {
    // Every reconnect is refused, so the client runs out of attempts. The
    // console's exchange is not known to have failed -- only to be unobservable
    // from here -- so the operator is told to reload and re-attach.
    vi.useFakeTimers();
    const { fetchImpl, calls } = droppingEventsFetch(() =>
      Promise.reject(new TypeError("network error")),
    );
    const outcome = drain(createFetchJobApiClient(fetchImpl));
    await vi.advanceTimersByTimeAsync(60000);
    const { events, error } = await outcome;

    expect(events.map((event) => event.type)).toEqual(["stage"]);
    expect((error as Error).message).toContain("reload to re-attach");
    // Bounded, not forever: the connect plus one attempt per backoff step.
    expect(calls).toHaveLength(6);
  });

  test("each reconnect resumes from the last id delivered", async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = droppingEventsFetch(() =>
      Promise.reject(new TypeError("network error")),
    );
    const outcome = drain(createFetchJobApiClient(fetchImpl));
    await vi.advanceTimersByTimeAsync(60000);
    await outcome;

    const resumeHeaders = calls.map(
      (init) =>
        (init?.headers as Record<string, string> | undefined)?.[
          "Last-Event-ID"
        ],
    );
    // The first connect asks for the whole history; every later one resumes past
    // the frame already delivered.
    expect(resumeHeaders[0]).toBeUndefined();
    expect(resumeHeaders.slice(1).every((value) => value === "1")).toBe(true);
  });

  test("a 404 while resuming stops the retries: the job is gone", async () => {
    // The console no longer has the exchange (deleted, or forgotten by a
    // restart). Retrying cannot bring it back, so the client reports it at once.
    vi.useFakeTimers();
    const { fetchImpl, calls } = droppingEventsFetch(() =>
      Promise.resolve(new Response(null, { status: 404 })),
    );
    const outcome = drain(createFetchJobApiClient(fetchImpl));
    await vi.advanceTimersByTimeAsync(60000);
    const { error } = await outcome;

    expect(error).toBeInstanceOf(JobApiRequestError);
    expect((error as JobApiRequestError).status).toBe(404);
    expect(calls).toHaveLength(2);
  });

  test("the budget resets on progress, surviving drops that together exceed it", async () => {
    // Two progress points, each followed by three failed reconnects -- six
    // failures in all, over the five-attempt budget if it never reset, though no
    // single stretch reaches it. The run still completes: pinning that the
    // counter resets on a progressing reconnect rather than merely staying under
    // a never-reset ceiling.
    vi.useFakeTimers();
    const calls: Array<RequestInit | undefined> = [];
    const failingCalls = new Set([2, 3, 4, 6, 7, 8]);
    const frames = [
      'id: 1\ndata: {"v":1,"type":"stage","id":"one"}\n\n',
      'id: 2\ndata: {"v":1,"type":"stage","id":"two"}\n\n',
      'id: 3\ndata: {"v":1,"type":"result","resultWritten":true}\n\n',
    ];
    let nextFrame = 0;
    const fetchImpl = ((
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      if (!String(input).endsWith("/events"))
        return Promise.resolve(new Response(null, { status: 404 }));
      calls.push(init);
      if (failingCalls.has(calls.length))
        return Promise.reject(new TypeError("network error"));
      const frame = frames[nextFrame++];
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(frame));
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    }) as typeof fetch;

    const outcome = drain(createFetchJobApiClient(fetchImpl));
    await vi.advanceTimersByTimeAsync(60000);
    const { events, error } = await outcome;

    expect(events.map((event) => event.type)).toEqual([
      "stage",
      "stage",
      "result",
    ]);
    expect(error).toBeUndefined();
    expect(calls).toHaveLength(9);
  });
});

describe("createServerJobZeroSetupDriver intent", () => {
  /** A base zero-setup config (filedrop transport, inline input) tests override. */
  function zeroSetupConfig(): ServerJobZeroSetupDriverConfig {
    return {
      transport: { channel: "filedrop" },
      inputSource: { kind: "inline", csv: CONFIG_INPUT_CSV },
    };
  }

  test("POSTs a zero-setup intent: mode zeroSetup, filedrop, eventStream, no secret or terms", async () => {
    const { client, createdIntents } = scriptedClient([result(true)]);
    await createServerJobZeroSetupDriver(zeroSetupConfig(), client).run(
      driverEvents(new AbortController().signal),
    );

    expect(createdIntents).toHaveLength(1);
    const intent = createdIntents[0] as Record<string, unknown>;
    expect(intent.mode).toBe("zeroSetup");
    expect(intent.channel).toBe("filedrop");
    expect(intent.eventStream).toBe(true);
    expect(intent.inputCsv).toBe(CONFIG_INPUT_CSV);
    // The zero-setup mode has no exchange-mode credential or terms material.
    expect(intent.sharedSecret).toBeUndefined();
    expect(intent.linkageTerms).toBeUndefined();
    expect(intent.metadata).toBeUndefined();
  });

  test("an sftp zero-setup intent has NO connection field", async () => {
    const { client, createdIntents } = scriptedClient([result(true)]);
    await createServerJobZeroSetupDriver(
      { ...zeroSetupConfig(), transport: { channel: "sftp" } },
      client,
    ).run(driverEvents(new AbortController().signal));

    const intent = createdIntents[0] as Record<string, unknown>;
    expect(intent.channel).toBe("sftp");
    // Only the discriminants and the input source: no remote, host, port, path, or
    // any other connection material can ride the intent (the console composes the
    // connection from its own effective server).
    expect(Object.keys(intent).sort()).toEqual([
      "channel",
      "eventStream",
      "inputCsv",
      "mode",
    ]);
  });

  test("a workFile input source maps to the inputFile arm, not inputCsv", async () => {
    const { client, createdIntents } = scriptedClient([result(true)]);
    await createServerJobZeroSetupDriver(
      {
        ...zeroSetupConfig(),
        inputSource: { kind: "workFile", name: "clients.csv" },
      },
      client,
    ).run(driverEvents(new AbortController().signal));

    const intent = createdIntents[0] as Record<string, unknown>;
    expect(intent.inputCsv).toBeUndefined();
    expect(intent.inputFile).toEqual({ name: "clients.csv" });
  });

  test("forwards the optional identity and linkageStrategy", async () => {
    const { client, createdIntents } = scriptedClient([result(true)]);
    await createServerJobZeroSetupDriver(
      {
        ...zeroSetupConfig(),
        identity: "County Health",
        linkageStrategy: "single-pass",
      },
      client,
    ).run(driverEvents(new AbortController().signal));

    expect(createdIntents[0]).toMatchObject({
      identity: "County Health",
      linkageStrategy: "single-pass",
    });
  });

  test("omits identity and linkageStrategy when the config sets neither", async () => {
    const { client, createdIntents } = scriptedClient([result(true)]);
    await createServerJobZeroSetupDriver(zeroSetupConfig(), client).run(
      driverEvents(new AbortController().signal),
    );

    const intent = createdIntents[0] as Record<string, unknown>;
    expect(intent.identity).toBeUndefined();
    expect(intent.linkageStrategy).toBeUndefined();
  });

  test("maps the console event stream onto the lifecycle (shared run body)", async () => {
    const { client } = scriptedClient([
      stages("prepare"),
      stage("prepare"),
      result(true),
    ]);
    const events = driverEvents(new AbortController().signal);
    await createServerJobZeroSetupDriver(zeroSetupConfig(), client).run(events);

    expect(events.onStages).toHaveBeenCalledTimes(1);
    expect(events.onStage).toHaveBeenCalledWith("prepare");
    const outputs = events.onResult.mock.calls[0][0] as RunOutputs;
    expect(resultsUrlOf(outputs)).toBe("/api/jobs/job-1/result");
    expect(events.onError).not.toHaveBeenCalled();
  });

  test("onJobCreated fires with the created id", async () => {
    const created: Array<string> = [];
    const { client } = scriptedClient([result(true)]);
    await createServerJobZeroSetupDriver(
      { ...zeroSetupConfig(), onJobCreated: (jobId) => created.push(jobId) },
      client,
    ).run(driverEvents(new AbortController().signal));

    expect(created).toEqual(["job-1"]);
  });

  test("a terms-mismatch error (category config) passes through verbatim", async () => {
    // The zero-setup terms mismatch reaches the browser as a category-config error
    // event; the driver must preserve the category and message so the run surface
    // renders it clearly.
    const { client } = scriptedClient([
      errorEvent(
        "config",
        "linkage terms do not match the partner's inferred terms",
      ),
    ]);
    const events = driverEvents(new AbortController().signal);
    await createServerJobZeroSetupDriver(zeroSetupConfig(), client).run(events);

    const failure = events.onError.mock.calls[0][0] as {
      category: string;
      error: unknown;
    };
    expect(failure.category).toBe("config");
    expect((failure.error as Error).message).toBe(
      "linkage terms do not match the partner's inferred terms",
    );
  });
});

describe("createServerJobReattachDriver", () => {
  test("replays a finished job's full history to onResult, creating no job", async () => {
    const { client, createdIntents } = scriptedClient([
      stages("prepare", "exchange"),
      stage("prepare"),
      stage("exchange"),
      result(true),
    ]);
    const events = driverEvents(new AbortController().signal);

    await createServerJobReattachDriver("job-1", client).run(events);

    // Re-attach never creates a job; it only reads the id's stream.
    expect(createdIntents).toHaveLength(0);
    expect(events.onStages).toHaveBeenCalledTimes(1);
    expect(events.onStage.mock.calls.map((call) => call[0])).toEqual([
      "prepare",
      "exchange",
    ]);
    expect(events.onResult).toHaveBeenCalledTimes(1);
    const outputs = events.onResult.mock.calls[0][0] as RunOutputs;
    expect(resultsUrlOf(outputs)).toBe("/api/jobs/job-1/result");
    expect(events.onError).not.toHaveBeenCalled();
  });

  test("a stream 404 is reported as the onError the recovery panel maps to stale", async () => {
    const client: JobApiClient = {
      createJob: () => Promise.reject(new Error("re-attach never creates")),
      // Match the real stream: the non-ok status throws on the first pull.
      openEventStream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () =>
            Promise.reject(
              new JobApiRequestError(
                404,
                "GET /api/jobs/job-x/events failed with status 404",
              ),
            ),
        }),
      }),
      cancelJob: () => Promise.resolve(),
      deleteJob: () => Promise.resolve(),
      fetchJobStatus: () => Promise.resolve({ kind: "gone" }),
      fetchRecordAvailability: () => Promise.resolve({ available: false }),
    };
    const events = driverEvents(new AbortController().signal);

    await createServerJobReattachDriver("job-x", client).run(events);

    expect(events.onResult).not.toHaveBeenCalled();
    expect(events.onError).toHaveBeenCalledTimes(1);
    const failure = events.onError.mock.calls[0][0] as {
      category: string;
      error: unknown;
    };
    expect(failure.category).toBe("exchange");
    expect(failure.error).toBeInstanceOf(JobApiRequestError);
    expect((failure.error as JobApiRequestError).status).toBe(404);
  });

  test("an already-aborted signal reads nothing", async () => {
    const { client } = scriptedClient([result(true)]);
    const controller = new AbortController();
    controller.abort();
    const events = driverEvents(controller.signal);

    await createServerJobReattachDriver("job-1", client).run(events);

    expect(events.onResult).not.toHaveBeenCalled();
    expect(events.onError).not.toHaveBeenCalled();
  });
});

describe("createFetchJobApiClient deleteJob and fetchJobStatus", () => {
  function statusFetch(body: unknown, status = 200): typeof fetch {
    return () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
  }

  test("deleteJob issues a DELETE to the job endpoint", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;

    await createFetchJobApiClient(fetchImpl).deleteJob("job-5");

    expect(calls).toEqual([{ url: "/api/jobs/job-5", method: "DELETE" }]);
  });

  test("fetchJobStatus reads a terminal status off a 200 as live", async () => {
    const signal = new AbortController().signal;
    await expect(
      createFetchJobApiClient(
        statusFetch({ status: "succeeded" }),
      ).fetchJobStatus("job-1", signal),
    ).resolves.toEqual({ kind: "live", status: "succeeded" });
  });

  test("a 200 with no recognizable status is live, defaulting to running (never gone)", async () => {
    const signal = new AbortController().signal;
    // A live in-memory job the status route answered 200 for must never resolve
    // to gone, or the recovery panel would delete it; default to running.
    await expect(
      createFetchJobApiClient(statusFetch({})).fetchJobStatus("job-1", signal),
    ).resolves.toEqual({ kind: "live", status: "running" });
  });

  test("only a confirmed 404 is gone; a 500 or a network error is unreachable", async () => {
    const signal = new AbortController().signal;
    const notFound: typeof fetch = () =>
      Promise.resolve(new Response(null, { status: 404 }));
    // A confirmed 404 is the only outcome that authorizes a destructive reclaim.
    await expect(
      createFetchJobApiClient(notFound).fetchJobStatus("job-1", signal),
    ).resolves.toEqual({ kind: "gone" });
    // A non-404 fault and a network error are transient, NOT a removal: the caller
    // leaves the record intact rather than delete a live exchange over a blip.
    await expect(
      createFetchJobApiClient(statusFetch(null, 500)).fetchJobStatus(
        "job-1",
        signal,
      ),
    ).resolves.toEqual({ kind: "unreachable" });
    await expect(
      createFetchJobApiClient(() =>
        Promise.reject(new Error("offline")),
      ).fetchJobStatus("job-1", signal),
    ).resolves.toEqual({ kind: "unreachable" });
  });
});

describe("fetchSftpConnection", () => {
  function jsonResponse(body: unknown, status = 200): typeof fetch {
    return () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
  }

  const none = { connection: null };

  test("returns the validated projection, optional fields preserved", async () => {
    await expect(
      fetchSftpConnection(
        jsonResponse({
          configured: true,
          host: "sftp.example.gov",
          port: 2222,
          path: "/x",
        }),
      ),
    ).resolves.toEqual({
      connection: {
        host: "sftp.example.gov",
        port: 2222,
        path: "/x",
        credentialWarnings: [],
      },
    });
    await expect(
      fetchSftpConnection(
        jsonResponse({ configured: true, host: "dr.example.gov" }),
      ),
    ).resolves.toEqual({
      connection: { host: "dr.example.gov", credentialWarnings: [] },
    });
  });

  test("returns a whole split-directory pair", async () => {
    await expect(
      fetchSftpConnection(
        jsonResponse({
          configured: true,
          host: "sftp.example.gov",
          inboundPath: "/exchange/in",
          outboundPath: "/exchange/out",
        }),
      ),
    ).resolves.toEqual({
      connection: {
        host: "sftp.example.gov",
        inboundPath: "/exchange/in",
        outboundPath: "/exchange/out",
        credentialWarnings: [],
      },
    });
  });

  test("a half pair, or a pair beside a shared path, resolves to none configured", async () => {
    // Neither is a shape the console can author. Dropping the connection is
    // what keeps a run -- and the invitation minted from the same projection --
    // from naming a directory layout the browser only half read.
    const incoherent: Array<unknown> = [
      { configured: true, host: "h", inboundPath: "/in" },
      { configured: true, host: "h", outboundPath: "/out" },
      { configured: true, host: "h", inboundPath: "/in", outboundPath: "" },
      {
        configured: true,
        host: "h",
        path: "/x",
        inboundPath: "/in",
        outboundPath: "/out",
      },
    ];
    for (const body of incoherent)
      await expect(fetchSftpConnection(jsonResponse(body))).resolves.toEqual(
        none,
      );
  });

  test("parses credentialWarnings, dropping non-string entries", async () => {
    await expect(
      fetchSftpConnection(
        jsonResponse({
          configured: true,
          host: "sftp.example.gov",
          credentialWarnings: [
            "a credential is in the mounted folder",
            7,
            null,
          ],
        }),
      ),
    ).resolves.toEqual({
      connection: {
        host: "sftp.example.gov",
        credentialWarnings: ["a credential is in the mounted folder"],
      },
    });
  });

  test("GETs the sftp route", async () => {
    const urls: Array<string> = [];
    await fetchSftpConnection((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ configured: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    expect(urls).toEqual(["/api/jobs/sftp"]);
  });

  test("an enabled API with no server resolves to none configured", async () => {
    await expect(
      fetchSftpConnection(jsonResponse({ configured: false })),
    ).resolves.toEqual(none);
  });

  test("a non-2xx resolves to none configured (fail toward authoring)", async () => {
    // 404 is also the gate's disabled-API response; any non-2xx means "no
    // server-job run can start here".
    for (const status of [404, 500])
      await expect(
        fetchSftpConnection(
          jsonResponse({ configured: true, host: "h" }, status),
        ),
      ).resolves.toEqual(none);
  });

  test("a malformed body resolves to none configured, never a partial connection", async () => {
    const malformed: Array<unknown> = [
      [],
      "prod_east",
      null,
      { configured: true },
      { configured: true, host: "" },
      { host: "h" },
      { configured: false, host: "h" },
      { configured: true, host: "h", port: "2222" },
      { configured: true, host: "h", port: 0 },
      { configured: true, host: "h", port: 65536 },
      { configured: true, host: "h", path: "" },
    ];
    for (const body of malformed)
      await expect(fetchSftpConnection(jsonResponse(body))).resolves.toEqual(
        none,
      );
  });

  test("a network error and a non-JSON body resolve to none configured", async () => {
    await expect(
      fetchSftpConnection(() => Promise.reject(new Error("offline"))),
    ).resolves.toEqual(none);
    const htmlResponse: typeof fetch = () =>
      Promise.resolve(
        new Response("<html>gateway error</html>", { status: 200 }),
      );
    await expect(fetchSftpConnection(htmlResponse)).resolves.toEqual(none);
  });
});

describe("fetchSlotOccupancy", () => {
  const signal = new AbortController().signal;

  function jsonResponse(body: unknown, status = 200): typeof fetch {
    return () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
  }

  const free = { occupied: false };

  test("reads occupied plus the occupant id off an occupied slot", async () => {
    await expect(
      fetchSlotOccupancy(
        signal,
        jsonResponse({
          occupied: true,
          id: "11111111-2222-4333-8444-555555555555",
        }),
      ),
    ).resolves.toEqual({
      occupied: true,
      id: "11111111-2222-4333-8444-555555555555",
    });
  });

  test("reads occupied:false off a free slot", async () => {
    await expect(
      fetchSlotOccupancy(signal, jsonResponse({ occupied: false })),
    ).resolves.toEqual(free);
  });

  test("GETs the slot route", async () => {
    const urls: Array<string> = [];
    await fetchSlotOccupancy(signal, (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ occupied: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    expect(urls).toEqual(["/api/jobs/slot"]);
  });

  test("a non-2xx resolves to free (a disabled API's 404 among them)", async () => {
    for (const status of [404, 500])
      await expect(
        fetchSlotOccupancy(
          signal,
          jsonResponse({ occupied: true, id: "x" }, status),
        ),
      ).resolves.toEqual(free);
  });

  test("a malformed body resolves to free, never a partial occupancy", async () => {
    const malformed: Array<unknown> = [
      [],
      "occupied",
      null,
      { occupied: true },
      { occupied: true, id: "" },
      { occupied: true, id: 7 },
      { occupied: "true", id: "x" },
      { id: "x" },
    ];
    for (const body of malformed)
      await expect(
        fetchSlotOccupancy(signal, jsonResponse(body)),
      ).resolves.toEqual(free);
  });

  test("a network error and a non-JSON body resolve to free", async () => {
    await expect(
      fetchSlotOccupancy(signal, () => Promise.reject(new Error("offline"))),
    ).resolves.toEqual(free);
    const htmlResponse: typeof fetch = () =>
      Promise.resolve(
        new Response("<html>gateway error</html>", { status: 200 }),
      );
    await expect(fetchSlotOccupancy(signal, htmlResponse)).resolves.toEqual(
      free,
    );
  });
});
