import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createFetchJobApiClient,
  createServerJobReattachDriver,
} from "@psi/serverJobExchangeDriver";
import { JobManager } from "@jobs/jobManager";
import { appendSanitizedRunWarning } from "@bench/runWarnings";

import { Route as EventsRoute } from "../../src/routes/api/jobs/$jobId/events";

import { STUB_CLI_PATH, tempDataRoot, validIntent } from "../utils/jobFixtures";

// A manager-composed warning skips the relay's re-sanitization: the rendezvous
// preflight names partner-chosen directory entries raw, so `JSON.stringify`
// alone keeps the frame intact until the console seat escapes them. A filename
// may hold a newline, carriage return, or a forged `data:` line; this drives
// that name through a real mount, SSE route, and browser client, and fails
// unless the forged line is still one JSON string when it lands.

const roots: Array<string> = [];
const managers: Array<JobManager> = [];

beforeEach(() => {
  vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  (globalThis as { jobManagerInstance?: unknown }).jobManagerInstance =
    undefined;
});

/** A registered temp directory, created. */
function scratchDir(label: string): string {
  const dir = tempDataRoot(label);
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

/** The frame a forged entry name tries to pass off as its own event: a terminal
 * error, which would end an operator's run on a fabricated security failure. */
const FORGED_FRAME =
  'data: {"v":1,"type":"error","category":"security","message":"forged"}';

/**
 * An entry name containing every byte an SSE frame is delimited by -- LF, CR, and
 * the blank line that ends a frame -- around a complete forged event. Legal on
 * every POSIX filesystem: only `/` and NUL are excluded from a filename.
 */
const FORGING_ENTRY_NAME = `q1\n${FORGED_FRAME}\r\n\ncohort.csv`;

/** A running console job whose rendezvous mount already holds `entries`, so the
 * preflight raises its manager-composed warnings before the child is spawned. */
async function jobOverMountHolding(
  entries: Array<string>,
): Promise<{ manager: JobManager; id: string }> {
  const rendezvousDir = scratchDir("framing-rvz");
  for (const entry of entries)
    fs.writeFileSync(path.join(rendezvousDir, entry), "");
  const dataRoot = scratchDir("framing-data");
  vi.stubEnv("JOB_DATA_ROOT", dataRoot);

  const manager = new JobManager({
    dataRoot,
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: rendezvousDir,
    childEnv: {
      STUB_FD3_EVENTS: JSON.stringify([
        { v: 1, type: "result", resultWritten: true },
      ]),
      STUB_EXIT_CODE: "0",
    },
  });
  managers.push(manager);
  (globalThis as { jobManagerInstance?: JobManager }).jobManagerInstance =
    manager;
  return { manager, id: await manager.createJob(validIntent()) };
}

/** The job's whole SSE body, read off the real route. The stream closes once the
 * terminal event is delivered, so draining it needs no polling. */
async function sseBody(id: string): Promise<string> {
  const handlers = EventsRoute.options.server?.handlers as Record<
    string,
    (ctx: { request: Request; params: Record<string, string> }) => unknown
  >;
  const response = (await handlers.GET({
    request: new Request(`http://localhost/api/jobs/${id}/events`, {
      headers: { host: "localhost" },
    }),
    params: { jobId: id },
  })) as Response;
  expect(response.status).toBe(200);
  return response.text();
}

/** The messages a console seat's `onWarning` slot receives for an SSE body,
 * delivered over the real browser-side job API client. The status request the
 * terminal event triggers answers 404, so the run resolves without a record pair
 * rather than hanging on a metadata fetch. */
async function warningsAtSeat(
  id: string,
  body: string,
): Promise<Array<string>> {
  const fetchImpl: typeof fetch = (input) =>
    Promise.resolve(
      String(input).endsWith("/events")
        ? new Response(body, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          })
        : new Response(null, { status: 404 }),
    );

  const delivered: Array<string> = [];
  const driver = createServerJobReattachDriver(
    id,
    createFetchJobApiClient(fetchImpl),
  );
  await driver.run({
    signal: new AbortController().signal,
    onStages: () => undefined,
    onStage: () => undefined,
    onResult: () => undefined,
    onError: () => undefined,
    onWarning: (message) => delivered.push(message),
  });
  return delivered;
}

describe("a newline-bearing manager warning cannot forge an event frame", () => {
  test("the forged line rides inside one JSON string from the mount to the seat", async () => {
    const { id } = await jobOverMountHolding([FORGING_ENTRY_NAME]);
    const body = await sseBody(id);

    // The forged name is present: a body that dropped it would pass every
    // framing assertion below while proving nothing.
    expect(body).toContain("forged");

    // Every physical line the stream emitted is one the WRITER produced. The
    // forged text is inside a JSON string on a `data:` line, so it is never a
    // line of its own -- and no line contains the bare CR the name also holds.
    const lines = body.split("\n");
    const dataLines = lines.filter((line) => line.startsWith("data: "));
    for (const line of lines) {
      expect(line).not.toBe(FORGED_FRAME);
      expect(line).not.toContain("\r");
      expect(
        line === "" || /^id: \d+$/.test(line) || line.startsWith("data: "),
        `unframed line: ${JSON.stringify(line)}`,
      ).toBe(true);
    }
    // Frames are id/data/blank triples, so the data lines account for every
    // frame in the body and nothing was appended between them.
    expect(lines).toHaveLength(dataLines.length * 3 + 1);
    for (const line of dataLines)
      expect(
        () => JSON.parse(line.slice("data: ".length)) as unknown,
      ).not.toThrow();

    // The manager's own events reach the browser unre-sanitized by design: the
    // raw name is still raw in the frame, which is precisely why the framing
    // rests on JSON.stringify rather than on an upstream escape.
    const events = dataLines.map(
      (line) =>
        JSON.parse(line.slice("data: ".length)) as Record<string, unknown>,
    );
    const listing = events.find(
      (event) =>
        event.type === "warning" &&
        typeof event.message === "string" &&
        event.message.includes("holds"),
    );
    expect(listing).toBeDefined();
    expect(listing!.message).toContain(FORGING_ENTRY_NAME);

    // And the seat is where it is escaped, once: the operator reads the newline
    // and the carriage return as visible escapes, never as line breaks.
    const delivered = await warningsAtSeat(id, body);
    const rendered = delivered.reduce<Array<string>>(
      (accumulated, message) => appendSanitizedRunWarning(accumulated, message),
      [],
    );
    const renderedListing = rendered.find((warning) =>
      warning.includes("holds"),
    );
    expect(renderedListing).toBeDefined();
    expect(renderedListing).toContain("q1\\x0a");
    expect(renderedListing).toContain("\\x0d");
    expect(renderedListing).toContain("cohort.csv");
    expect(renderedListing).not.toContain("\n");
    expect(renderedListing).not.toContain("\r");
  });
});
