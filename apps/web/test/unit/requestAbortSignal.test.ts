import fs from "node:fs";
import http from "node:http";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createApp, fromWebHandler, toNodeListener } from "h3";

import { JobManager } from "@jobs/jobManager";

import { Route as EventsRoute } from "../../src/routes/api/jobs/$jobId/events";
import { attachRequestAbortSignal } from "../../server/requestAbortSignal";

import { STUB_CLI_PATH, tempDataRoot, validIntent } from "../utils/jobFixtures";

import type { AddressInfo } from "node:net";

// The built server reaches every app handler through h3's `fromWebHandler`, the
// bridge the nitro plugin's virtual entry wraps the app's fetch handler in. These
// cases serve that same bridge over a real socket, with the server's request
// hook in front, and disconnect the client.

const dirs: Array<string> = [];
const servers: Array<http.Server> = [];

beforeEach(() => {
  vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await globalThis.jobManagerInstance?.shutdown();
  globalThis.jobManagerInstance = undefined;
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

/** A created scratch directory, removed after the test. */
function scratchDir(label: string): string {
  const dir = tempDataRoot(label);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

/** Serve `handler` through the production bridge on a loopback port. */
async function serveThroughBridge(
  handler: (request: Request) => Promise<Response> | Response,
): Promise<number> {
  const app = createApp({ onRequest: attachRequestAbortSignal });
  app.use(fromWebHandler(handler));
  const server = http.createServer(toNodeListener(app));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** Open a GET; a destroyed request's socket error is expected and ignored. */
function openRequest(port: number, requestPath: string): http.ClientRequest {
  const request = http.get({ host: "127.0.0.1", port, path: requestPath });
  request.on("error", () => undefined);
  return request;
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("the request hook gives request.signal the client disconnect", () => {
  test("a client that disconnects mid-response aborts the handler's signal", async () => {
    let signal: AbortSignal | undefined;
    const port = await serveThroughBridge((request) => {
      signal = request.signal;
      return new Response(new ReadableStream({ start() {} }));
    });
    const request = openRequest(port, "/stream");
    await waitUntil(() => signal !== undefined);
    expect(signal?.aborted).toBe(false);
    request.destroy();
    await waitUntil(() => signal?.aborted === true);
  });

  test("a response that completes leaves the signal unaborted", async () => {
    let signal: AbortSignal | undefined;
    const port = await serveThroughBridge((request) => {
      signal = request.signal;
      return new Response("done");
    });
    const response = await new Promise<http.IncomingMessage>((resolve) =>
      openRequest(port, "/done").on("response", resolve),
    );
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => (body += chunk));
    await new Promise((resolve) => response.on("end", resolve));
    expect(body).toBe("done");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(signal?.aborted).toBe(false);
  });

  test("a request body still reaches the handler whole", async () => {
    const port = await serveThroughBridge(
      async (request) => new Response(await request.text()),
    );
    const sent = "x".repeat(200_000);
    const echoed = await new Promise<string>((resolve, reject) => {
      const request = http.request(
        { host: "127.0.0.1", port, path: "/echo", method: "POST" },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => (body += chunk));
          response.on("end", () => resolve(body));
        },
      );
      request.on("error", reject);
      request.end(sent);
    });
    expect(echoed).toBe(sent);
  });

  test("a closed event stream releases its job subscription", async () => {
    const dataRoot = scratchDir("abort-root");
    vi.stubEnv("JOB_DATA_ROOT", dataRoot);
    const manager = new JobManager({
      dataRoot,
      binaryPath: STUB_CLI_PATH,
      jobRendezvousDir: scratchDir("abort-rvz"),
      childEnv: { STUB_FD3_EVENTS: "[]", STUB_DELAY_MS: "30000" },
    });
    globalThis.jobManagerInstance = manager;
    const id = await manager.createJob(validIntent());
    const record = manager.getJob(id)!;

    const handlers = EventsRoute.options.server?.handlers as {
      GET: (ctx: {
        request: Request;
        params: Record<string, string>;
      }) => Response | Promise<Response>;
    };
    const port = await serveThroughBridge((request) =>
      handlers.GET({ request, params: { jobId: id } }),
    );

    const request = openRequest(port, `/api/jobs/${id}/events`);
    await waitUntil(() => record.listeners.size === 1);
    request.destroy();
    await waitUntil(() => record.listeners.size === 0);
  });
});
