import fs from "node:fs";
import http from "node:http";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { JobManager } from "@jobs/jobManager";
import { SSE_KEEPALIVE_FRAME } from "@jobs/sse";
import { createFetchJobApiClient } from "@psi/serverJobExchangeDriver";

import { Route as EventsRoute } from "../../src/routes/api/jobs/$jobId/events";

import { STUB_CLI_PATH, tempDataRoot, validIntent } from "../utils/jobFixtures";

import type { AddressInfo } from "node:net";
import type { BufferedEvent } from "@jobs/jobManager";
import type { RelayEvent } from "@jobs/cliDriver";

// This drives an ACTUAL cut -- a real loopback socket destroyed mid-body, in
// front of the real SSE route over the real job manager -- and fails unless
// the real browser-side client resumes the same run from where it stopped,
// delivering the manager's whole history exactly once and never re-creating
// the job.

const roots: Array<string> = [];
const managers: Array<JobManager> = [];
const servers: Array<http.Server> = [];

beforeEach(() => {
  vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
});

afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
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

/** A job whose stub CLI has emitted a three-event run, awaited to its terminal
 * so the manager's buffer holds the complete history the stream must deliver. */
async function completedJob(): Promise<{ manager: JobManager; id: string }> {
  const dataRoot = scratchDir("resume-data");
  vi.stubEnv("JOB_DATA_ROOT", dataRoot);
  const manager = new JobManager({
    dataRoot,
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: scratchDir("resume-rvz"),
    childEnv: {
      STUB_FD3_EVENTS: JSON.stringify([
        { v: 1, type: "stages", stages: [{ id: "one", label: "One" }] },
        { v: 1, type: "stage", id: "one" },
        { v: 1, type: "result", resultWritten: true },
      ]),
      STUB_EXIT_CODE: "0",
    },
  });
  managers.push(manager);
  (globalThis as { jobManagerInstance?: JobManager }).jobManagerInstance =
    manager;
  const id = await manager.createJob(validIntent());
  const record = manager.getJob(id)!;
  await new Promise<void>((resolve) => {
    const { unsubscribe } = manager.subscribe(record, 0, (entry) => {
      if (entry.event.type === "result" || entry.event.type === "error") {
        unsubscribe();
        resolve();
      }
    });
    if (record.terminalEmitted) {
      unsubscribe();
      resolve();
    }
  });
  return { manager, id };
}

/** What one bridged connection did to the response it was serving. */
interface ServedConnection {
  path: string;
  lastEventId: string | null;
}

/**
 * A loopback HTTP server in front of the real events route. The FIRST connection
 * forwards one frame and then destroys the socket -- the drop this test is
 * about -- and every later one prepends a keepalive comment (the frame an idle
 * stream writes) before forwarding the rest.
 */
function bridgeServer(jobId: string): Promise<{
  base: string;
  served: Array<ServedConnection>;
}> {
  const served: Array<ServedConnection> = [];
  const handlers = EventsRoute.options.server?.handlers as Record<
    string,
    (ctx: { request: Request; params: Record<string, string> }) => unknown
  >;

  const serve = async (
    request: http.IncomingMessage,
    reply: http.ServerResponse,
  ): Promise<void> => {
    const path = request.url ?? "/";
    const lastEventId = request.headers["last-event-id"];
    const cut = served.length === 0;
    served.push({
      path,
      lastEventId: typeof lastEventId === "string" ? lastEventId : null,
    });

    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers))
      if (typeof value === "string") headers.set(name, value);
    const response = (await handlers.GET({
      request: new Request(new URL(path, "http://127.0.0.1"), {
        method: "GET",
        headers,
      }),
      params: { jobId },
    })) as Response;

    reply.writeHead(response.status, {
      "Content-Type":
        response.headers.get("Content-Type") ?? "text/event-stream",
    });
    if (!cut) reply.write(SSE_KEEPALIVE_FRAME);

    const reader = response.body!.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const flushed = new Promise<void>((resolve) =>
        reply.write(Buffer.from(value), () => resolve()),
      );
      if (cut) {
        await flushed;
        await reader.cancel();
        reply.socket?.destroy();
        return;
      }
    }
    reply.end();
  };

  const server = http.createServer((request, reply) => {
    void serve(request, reply);
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, served });
    });
  });
}

/** The real browser-side client's fetch, rebased onto the loopback bridge so its
 * relative `/api/...` URLs reach it over a real socket. */
function bridgedFetch(base: string): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(new URL(String(input), base), init);
}

describe("a job stream cut mid-response resumes without losing events", () => {
  test("the client re-attaches from its last id and the run is never re-created", async () => {
    const { manager, id } = await completedJob();
    const buffered: Array<BufferedEvent> = manager.getJob(id)!.events;
    // The cut lands mid-history, so a resume that replayed from the start (or
    // from the wrong offset) would show up as a duplicate or a hole below.
    expect(buffered.length).toBeGreaterThan(1);

    const { base, served } = await bridgeServer(id);
    const client = createFetchJobApiClient(bridgedFetch(base));

    const received: Array<RelayEvent> = [];
    for await (const event of client.openEventStream(
      id,
      new AbortController().signal,
    ))
      received.push(event);

    // Every event the manager buffered reached the client, in order and once --
    // across a connection that died after the first frame. The resumed body was
    // led by a real keepalive comment, so this equality also pins that a
    // keepalive reaches the client as bytes and nothing more.
    expect(received).toEqual(buffered.map((entry) => entry.event));

    // The drop happened and the resume was a resume: a second connection,
    // holding the last id the first one delivered.
    expect(served).toHaveLength(2);
    expect(served[0].lastEventId).toBeNull();
    expect(served[1].lastEventId).toBe(String(buffered[0].id));

    // Re-attaching is all it did: no second POST /api/jobs, so the console's
    // exchange was never restarted.
    expect(
      served.every((connection) => connection.path.endsWith("/events")),
    ).toBe(true);
  });
});
