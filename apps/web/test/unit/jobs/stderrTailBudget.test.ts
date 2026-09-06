import fs from "node:fs";

import { afterEach, expect, test } from "vitest";

import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  sanitizeForDisplay,
} from "@psilink/core";

import {
  createFetchJobApiClient,
  createServerJobReattachDriver,
} from "@psi/jobClient/serverJobExchangeDriver";
import { ERROR_MESSAGE_CHAIN_FIELD } from "@psi/relayErrorChain";
import { JobManager } from "@jobs/jobManager";
import { failureFor } from "@exchange/useInviterExchange";
import { renderSseFrame } from "@jobs/sse";

import {
  STUB_CLI_PATH,
  tempDataRoot,
  validIntent,
} from "../../utils/jobFixtures";

import type { JobRecord } from "@jobs/jobManager";
import type { RelayEvent } from "@jobs/cliDriver";

// The stderr tail a synthesized terminal names is the child's own bytes, so it
// crosses RAW on a cause link of its own and the seat that renders the chain is
// the one altitude that escapes it. What that costs the operator is measured
// here rather than at the manager: one escape, not two, and one value's budget
// of the alert, whatever the child wrote.

const roots: Array<string> = [];
const managers: Array<JobManager> = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

/** A hostile tail: an ANSI screen clear, a bell, a bidi override, a CR LF, a
 * literal backslash, and the parenthesis that closed the interpolated form. */
const HOSTILE_TAIL =
  "\u001b[2J\u0007\u202eevil\r\nback\\slash) it is safe to run this again";

/** The exit code that reports a completed exchange whose local write was lost:
 * the one synthesized terminal whose category exposes the console's own cause
 * text to the operator (`failureFor`, the `output` arm). */
const PERSISTENCE_LOSS_EXIT = 73;

/** The exit code of an ordinary failure whose fd-3 stream said nothing. */
const STREAM_BROKE_EXIT = 64;

/** A scratch directory registered for cleanup. */
function scratchDir(label: string): string {
  const dir = tempDataRoot(label);
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

/**
 * The events the manager buffered for a stub CLI run that wrote `stderr` and
 * exited `exitCode` with no fd-3 terminal event -- the real child process, the
 * real stderr retention, and the manager's own synthesis.
 */
async function eventsFromRun(
  stderr: string,
  exitCode: number,
): Promise<Array<RelayEvent>> {
  const manager = new JobManager({
    dataRoot: scratchDir("stderr-tail"),
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: scratchDir("stderr-tail-rvz"),
    childEnv: {
      STUB_FD3_EVENTS: "[]",
      STUB_STDERR: stderr,
      STUB_EXIT_CODE: String(exitCode),
    },
  });
  managers.push(manager);
  const record: JobRecord = manager.getJob(
    await manager.createJob(validIntent()),
  )!;
  const deadline = Date.now() + 5000;
  while (!record.terminalEmitted) {
    if (Date.now() > deadline)
      throw new Error("timed out waiting for terminal");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return record.events.map((entry) => entry.event);
}

/**
 * The alert a console seat composes for a relayed event sequence, routed
 * through the real SSE frame encoder, the real browser-side job API client, and
 * the seat's own display pass. The status request answers 404, so the run
 * resolves without a record pair rather than hanging on a metadata fetch.
 */
async function alertAtSeat(events: Array<RelayEvent>): Promise<string> {
  const body = events
    .map((event, index) => renderSseFrame(index + 1, event))
    .join("");
  const fetchImpl: typeof fetch = (input) =>
    Promise.resolve(
      String(input).endsWith("/events")
        ? new Response(body, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          })
        : new Response(null, { status: 404 }),
    );

  const raised: Array<{ category: string; error: unknown }> = [];
  await createServerJobReattachDriver(
    "job-1",
    createFetchJobApiClient(fetchImpl),
  ).run({
    signal: new AbortController().signal,
    onStages: () => undefined,
    onStage: () => undefined,
    onResult: () => undefined,
    onError: (failure) => raised.push(failure),
  });
  expect(raised).toHaveLength(1);
  return failureFor(
    raised[0].category as Parameters<typeof failureFor>[0],
    raised[0].error,
  ).message;
}

test("a hostile stderr tail reaches the operator's alert escaped exactly once", async () => {
  const events = await eventsFromRun(HOSTILE_TAIL, PERSISTENCE_LOSS_EXIT);
  const terminal = events[events.length - 1];
  // The manager holds the child's bytes as they were written: escaping here as
  // well is what a second pass at the seat would be measured against.
  expect(terminal[ERROR_MESSAGE_CHAIN_FIELD]).toEqual([
    terminal.message,
    `the CLI last wrote on stderr: ${HOSTILE_TAIL}`,
  ]);

  const alert = await alertAtSeat(events);
  // One pass, read off the escape itself rather than restated: a second pass
  // doubles every backslash the first one wrote, so the two renderings differ
  // and only one of them can be present.
  expect(alert).toContain(sanitizeForDisplay(HOSTILE_TAIL));
  expect(alert).not.toContain(
    sanitizeForDisplay(sanitizeForDisplay(HOSTILE_TAIL)),
  );
  // The only raw control character left in the alert is the renderer's own
  // framing between links, which the seat lays out as a line break.
  for (const link of alert.split("\ncaused by: "))
    // eslint-disable-next-line no-control-regex -- asserting on control characters is the point
    expect(/[\u0000-\u001f\u007f\u202e]/.test(link)).toBe(false);
  // The do-not-repeat instruction leads the alert, ahead of the chain, so no
  // width or content of the tail can displace or close it.
  expect(alert.indexOf("do not run this exchange again")).toBeLessThan(
    alert.indexOf("it is safe to run this again"),
  );
});

test("a flooding stderr tail delivers its END within one value's budget", async () => {
  const events = await eventsFromRun(
    `HEADMARKER${"Z".repeat(20000)}TAILMARKER`,
    PERSISTENCE_LOSS_EXIT,
  );
  const alert = await alertAtSeat(events);
  expect(alert).toContain("TAILMARKER");
  expect(alert).not.toContain("HEADMARKER");
  // The marker sits at the FRONT of the tail, where the cut was taken.
  const link = alert.slice(alert.indexOf("the CLI last wrote on stderr: "));
  expect(link).toContain(`stderr: ${DISPLAY_TRUNCATION_MARKER}Z`);
  expect(link.length).toBeLessThanOrEqual(DEFAULT_MAX_DISPLAY_LENGTH);
});

test("a stream-broke terminal keeps the child's bytes out of its retryable alert", async () => {
  // The `exchange` category shows fixed copy and holds the relayed text in the
  // dev-gated console alone, so this alert names none of the tail however the
  // event carries it -- what the operator sees there is a retry affordance.
  const events = await eventsFromRun(HOSTILE_TAIL, STREAM_BROKE_EXIT);
  const terminal = events[events.length - 1];
  expect((terminal[ERROR_MESSAGE_CHAIN_FIELD] as Array<string>)[1]).toContain(
    "it is safe to run this again",
  );

  const alert = await alertAtSeat(events);
  expect(alert).not.toContain("it is safe to run this again");
  expect(alert).toContain("temporary");
});

test("the CLI's own cause framing arrives as the chain's links, each escaped once", async () => {
  // A rendered psilink chain is what the CLI writes to stderr, framing and all,
  // so the seat's split reads that framing as the links it is: the tail's own
  // bytes still take exactly one escape inside each link they land on.
  const tail = "config load failed\ncaused by: bad\\value at \u001b[2J line 3";
  const events = await eventsFromRun(tail, PERSISTENCE_LOSS_EXIT);
  const alert = await alertAtSeat(events);
  expect(alert).toContain(sanitizeForDisplay("bad\\value at \u001b[2J line 3"));
  expect(alert).toContain("the CLI last wrote on stderr: config load failed");
});
