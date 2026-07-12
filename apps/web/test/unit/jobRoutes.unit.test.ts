import fs from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  MAX_JOB_BODY_BYTES,
  readJobRequestBody,
  validateJobIdParam,
} from "@jobs/routeSupport";
import { JobManager } from "@jobs/jobManager";
import { MAX_INPUT_CSV_LENGTH } from "@jobs/intent";

import { Route as CancelRoute } from "../../src/routes/api/jobs/$jobId/cancel";
import { Route as CreateRoute } from "../../src/routes/api/jobs/index";
import { Route as EventsRoute } from "../../src/routes/api/jobs/$jobId/events";
import { Route as JobRoute } from "../../src/routes/api/jobs/$jobId/index";
import { Route as KeysRoute } from "../../src/routes/api/jobs/$jobId/keys";
import { Route as RecordRoute } from "../../src/routes/api/jobs/$jobId/record";
import { Route as RemotesRoute } from "../../src/routes/api/jobs/remotes";
import { Route as ResultRoute } from "../../src/routes/api/jobs/$jobId/result";

import {
  STUB_CLI_PATH,
  tempDataRoot,
  testSftpRemotesTable,
  validIntent,
  validSftpIntent,
} from "../utils/jobFixtures";

import type { JobManager as JobManagerType } from "@jobs/jobManager";

const roots: Array<string> = [];

afterEach(() => {
  vi.unstubAllEnvs();
  const seeded = (globalThis as { jobManagerInstance?: JobManagerType })
    .jobManagerInstance;
  seeded?.shutdown();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
  // Reset the memoized manager and remotes table so each test starts clean.
  (globalThis as { jobManagerInstance?: unknown }).jobManagerInstance =
    undefined;
  (globalThis as { jobSftpRemotesTable?: unknown }).jobSftpRemotesTable =
    undefined;
});

type Handlers = Record<
  string,
  (ctx: { request: Request; params: Record<string, string> }) => unknown
>;

function handlersOf(route: {
  options: { server?: { handlers?: unknown } };
}): Handlers {
  const handlers = route.options.server?.handlers;
  if (typeof handlers !== "object" || handlers === null)
    throw new Error("route exposes no plain handlers object");
  return handlers as Handlers;
}

function enableJobApi(options: { token?: string } = {}): string {
  const root = tempDataRoot("routes");
  roots.push(root);
  vi.stubEnv("JOB_DATA_ROOT", root);
  vi.stubEnv("JOB_CLI_BINARY", STUB_CLI_PATH);
  vi.stubEnv("STUB_FD3_EVENTS", JSON.stringify([]));
  vi.stubEnv("STUB_EXIT_CODE", "0");
  if (options.token !== undefined) vi.stubEnv("JOB_API_TOKEN", options.token);
  return root;
}

function createRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** A record body with the given createdAt, matching the shape the status route
 * reads. */
function recordJson(createdAt: string): string {
  return JSON.stringify({ createdAt, summary: "test" });
}

/**
 * Enable the API, seed the global manager with one pointed at the stub CLI
 * (carrying its scenario through childEnv, since the route path's sanitized child
 * env drops ambient STUB_* vars), create a job, and resolve its id once it has
 * succeeded. `stubEnv` scripts the stub: what output/record files it writes.
 */
async function createSucceededJob(stubEnv: NodeJS.ProcessEnv): Promise<string> {
  const root = tempDataRoot("routes-succeed");
  roots.push(root);
  vi.stubEnv("JOB_DATA_ROOT", root);
  const manager = new JobManager({
    dataRoot: root,
    binaryPath: STUB_CLI_PATH,
    childEnv: { STUB_FD3_EVENTS: JSON.stringify([]), ...stubEnv },
  });
  (globalThis as { jobManagerInstance?: JobManager }).jobManagerInstance =
    manager;
  const id = await manager.createJob(validIntent());
  const deadline = Date.now() + 5000;
  for (;;) {
    const record = manager.getJob(id);
    if (record !== undefined && record.status === "succeeded") return id;
    if (Date.now() > deadline)
      throw new Error("timed out waiting for the job to succeed");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("the feature gate keeps the API dark when disabled", () => {
  test("POST /api/jobs is 404 when JOB_DATA_ROOT is unset", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent()),
      params: {},
    })) as Response;
    expect(response.status).toBe(404);
  });

  test("GET /api/jobs/:id is 404 when disabled", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    const response = (await handlersOf(JobRoute).GET({
      request: new Request("http://localhost/api/jobs/x"),
      params: { jobId: "00000000-0000-4000-8000-000000000000" },
    })) as Response;
    expect(response.status).toBe(404);
  });
});

describe("the auth gate enforces the bearer token", () => {
  test("POST without a bearer is 401 when a token is set", async () => {
    enableJobApi({ token: "the-token" });
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent()),
      params: {},
    })) as Response;
    expect(response.status).toBe(401);
  });

  test("POST with the wrong bearer is 401", async () => {
    enableJobApi({ token: "the-token" });
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent(), {
        authorization: "Bearer wrong",
      }),
      params: {},
    })) as Response;
    expect(response.status).toBe(401);
  });

  test("POST with the right bearer is accepted", async () => {
    enableJobApi({ token: "the-token" });
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent(), {
        authorization: "Bearer the-token",
      }),
      params: {},
    })) as Response;
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("create validates and never CORS", () => {
  test("an injection-shaped body is rejected 400", async () => {
    enableJobApi();
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest({
        ...validIntent(),
        channel: "sftp",
        server: { host: "evil", password: "@/etc/shadow" },
      }),
      params: {},
    })) as Response;
    expect(response.status).toBe(400);
  });

  test("no Access-Control-Allow-Origin header is emitted", async () => {
    enableJobApi();
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent(), {
        origin: "https://evil.example",
      }),
      params: {},
    })) as Response;
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.status).toBe(201);
  });
});

describe("routes validate the job id before filesystem use", () => {
  test("a malformed id is 404 on status, events, cancel, result, delete", async () => {
    enableJobApi();
    const bad = { jobId: "../../etc/passwd" };
    const statusResp = (await handlersOf(JobRoute).GET({
      request: new Request("http://localhost/api/jobs/x"),
      params: bad,
    })) as Response;
    expect(statusResp.status).toBe(404);
    const eventsResp = (await handlersOf(EventsRoute).GET({
      request: new Request("http://localhost/api/jobs/x/events"),
      params: bad,
    })) as Response;
    expect(eventsResp.status).toBe(404);
    const cancelResp = (await handlersOf(CancelRoute).POST({
      request: new Request("http://localhost/api/jobs/x/cancel", {
        method: "POST",
      }),
      params: bad,
    })) as Response;
    expect(cancelResp.status).toBe(404);
    const resultResp = (await handlersOf(ResultRoute).GET({
      request: new Request("http://localhost/api/jobs/x/result"),
      params: bad,
    })) as Response;
    expect(resultResp.status).toBe(404);
    const recordResp = (await handlersOf(RecordRoute).GET({
      request: new Request("http://localhost/api/jobs/x/record"),
      params: bad,
    })) as Response;
    expect(recordResp.status).toBe(404);
    const keysResp = (await handlersOf(KeysRoute).GET({
      request: new Request("http://localhost/api/jobs/x/keys"),
      params: bad,
    })) as Response;
    expect(keysResp.status).toBe(404);
    const deleteResp = (await handlersOf(JobRoute).DELETE({
      request: new Request("http://localhost/api/jobs/x", { method: "DELETE" }),
      params: bad,
    })) as Response;
    expect(deleteResp.status).toBe(404);
  });
});

describe("result route serves only after success", () => {
  test("a running job's result is 404, and no path derives from client input", async () => {
    enableJobApi();
    // A job that never succeeds (long delay) has no result yet.
    vi.stubEnv("STUB_DELAY_MS", "5000");
    const created = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent()),
      params: {},
    })) as Response;
    const { id } = (await created.json()) as { id: string };
    const response = (await handlersOf(ResultRoute).GET({
      request: new Request(`http://localhost/api/jobs/${id}/result`),
      params: { jobId: id },
    })) as Response;
    expect(response.status).toBe(404);
  });
});

describe("record and keys routes serve the exchange-record pair after success", () => {
  const CREATED_AT = "2026-07-08T14:32:00.000Z";

  test("a succeeded job serves the record and keys as JSON attachments", async () => {
    const id = await createSucceededJob({
      STUB_OUTPUT_FILE: "id\n1\n",
      STUB_RECORD_JSON: recordJson(CREATED_AT),
    });

    const recordResp = (await handlersOf(RecordRoute).GET({
      request: new Request(`http://localhost/api/jobs/${id}/record`),
      params: { jobId: id },
    })) as Response;
    expect(recordResp.status).toBe(200);
    expect(recordResp.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(recordResp.headers.get("x-content-type-options")).toBe("nosniff");
    expect(recordResp.headers.get("cache-control")).toBe("no-store");
    expect(recordResp.headers.get("content-disposition")).toContain(
      "attachment",
    );
    expect(JSON.parse(await recordResp.text())).toMatchObject({
      createdAt: CREATED_AT,
    });

    const keysResp = (await handlersOf(KeysRoute).GET({
      request: new Request(`http://localhost/api/jobs/${id}/keys`),
      params: { jobId: id },
    })) as Response;
    expect(keysResp.status).toBe(200);
    expect(keysResp.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(keysResp.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(await keysResp.text())).toMatchObject({ salts: {} });
  });

  test("record and keys are 404 when the files were never written", async () => {
    // A succeeded job whose record write did not land (no STUB_RECORD_JSON):
    // the endpoints 404 rather than serving an absent file.
    const id = await createSucceededJob({ STUB_OUTPUT_FILE: "id\n1\n" });

    const recordResp = (await handlersOf(RecordRoute).GET({
      request: new Request(`http://localhost/api/jobs/${id}/record`),
      params: { jobId: id },
    })) as Response;
    expect(recordResp.status).toBe(404);
    const keysResp = (await handlersOf(KeysRoute).GET({
      request: new Request(`http://localhost/api/jobs/${id}/keys`),
      params: { jobId: id },
    })) as Response;
    expect(keysResp.status).toBe(404);
  });

  test("record and keys are 404 before the job succeeds", async () => {
    enableJobApi();
    vi.stubEnv("STUB_DELAY_MS", "5000");
    const created = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent()),
      params: {},
    })) as Response;
    const { id } = (await created.json()) as { id: string };
    const recordResp = (await handlersOf(RecordRoute).GET({
      request: new Request(`http://localhost/api/jobs/${id}/record`),
      params: { jobId: id },
    })) as Response;
    expect(recordResp.status).toBe(404);
    const keysResp = (await handlersOf(KeysRoute).GET({
      request: new Request(`http://localhost/api/jobs/${id}/keys`),
      params: { jobId: id },
    })) as Response;
    expect(keysResp.status).toBe(404);
  });

  test("record and keys are 404 when the API is disabled", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    const jobId = "00000000-0000-4000-8000-000000000000";
    const recordResp = (await handlersOf(RecordRoute).GET({
      request: new Request(`http://localhost/api/jobs/${jobId}/record`),
      params: { jobId },
    })) as Response;
    expect(recordResp.status).toBe(404);
    const keysResp = (await handlersOf(KeysRoute).GET({
      request: new Request(`http://localhost/api/jobs/${jobId}/keys`),
      params: { jobId },
    })) as Response;
    expect(keysResp.status).toBe(404);
  });

  test("the keys route is auth-gated identically to result", async () => {
    // The keys serve private material; a missing bearer must 401 exactly as any
    // other job route does, never leaking the file.
    enableJobApi({ token: "the-token" });
    const jobId = "00000000-0000-4000-8000-000000000000";
    const keysResp = (await handlersOf(KeysRoute).GET({
      request: new Request(`http://localhost/api/jobs/${jobId}/keys`),
      params: { jobId },
    })) as Response;
    expect(keysResp.status).toBe(401);
  });
});

describe("status route reports record availability", () => {
  const CREATED_AT = "2026-07-08T14:32:00.000Z";

  test("recordAvailable true with the record's createdAt when the pair is on disk", async () => {
    const id = await createSucceededJob({
      STUB_OUTPUT_FILE: "id\n1\n",
      STUB_RECORD_JSON: recordJson(CREATED_AT),
    });
    const response = (await handlersOf(JobRoute).GET({
      request: new Request(`http://localhost/api/jobs/${id}`),
      params: { jobId: id },
    })) as Response;
    const body = (await response.json()) as {
      resultAvailable: boolean;
      recordAvailable: boolean;
      recordCreatedAt?: string;
    };
    expect(body.resultAvailable).toBe(true);
    expect(body.recordAvailable).toBe(true);
    expect(body.recordCreatedAt).toBe(CREATED_AT);
  });

  test("recordAvailable false and no createdAt when the record was never written", async () => {
    const id = await createSucceededJob({ STUB_OUTPUT_FILE: "id\n1\n" });
    const response = (await handlersOf(JobRoute).GET({
      request: new Request(`http://localhost/api/jobs/${id}`),
      params: { jobId: id },
    })) as Response;
    const body = (await response.json()) as {
      recordAvailable: boolean;
      recordCreatedAt?: string;
    };
    expect(body.recordAvailable).toBe(false);
    expect(body.recordCreatedAt).toBeUndefined();
  });

  test("a malformed record file reads as unavailable (defensive parse)", async () => {
    // The record write landed a non-JSON body; the status route must not throw,
    // and must treat the record as unavailable rather than serving a bad stamp.
    const id = await createSucceededJob({
      STUB_OUTPUT_FILE: "id\n1\n",
      STUB_RECORD_JSON: "}{ not json",
    });
    const response = (await handlersOf(JobRoute).GET({
      request: new Request(`http://localhost/api/jobs/${id}`),
      params: { jobId: id },
    })) as Response;
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      recordAvailable: boolean;
      recordCreatedAt?: string;
    };
    expect(body.recordAvailable).toBe(false);
    expect(body.recordCreatedAt).toBeUndefined();
  });

  test("a record missing createdAt reads as unavailable", async () => {
    const id = await createSucceededJob({
      STUB_OUTPUT_FILE: "id\n1\n",
      STUB_RECORD_JSON: JSON.stringify({ summary: "no timestamp" }),
    });
    const response = (await handlersOf(JobRoute).GET({
      request: new Request(`http://localhost/api/jobs/${id}`),
      params: { jobId: id },
    })) as Response;
    const body = (await response.json()) as { recordAvailable: boolean };
    expect(body.recordAvailable).toBe(false);
  });
});

/**
 * Enable the API and seed the global manager with an sftp remotes table (the
 * startup-loaded table production wiring passes), pointed at the stub CLI.
 */
function enableJobApiWithRemotes(stubEnv: NodeJS.ProcessEnv = {}): JobManager {
  const root = tempDataRoot("routes-remotes");
  roots.push(root);
  vi.stubEnv("JOB_DATA_ROOT", root);
  const manager = new JobManager({
    dataRoot: root,
    binaryPath: STUB_CLI_PATH,
    sftpRemotes: testSftpRemotesTable(),
    childEnv: { STUB_FD3_EVENTS: JSON.stringify([]), ...stubEnv },
  });
  (globalThis as { jobManagerInstance?: JobManager }).jobManagerInstance =
    manager;
  return manager;
}

describe("POST /api/jobs maps the sftp remote rejections to empty bodies", () => {
  test("an unknown remote is an empty-bodied 400", async () => {
    enableJobApiWithRemotes();
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validSftpIntent({ remote: "not_provisioned" })),
      params: {},
    })) as Response;
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
  });

  test("a busy remote is an empty-bodied 409 that never echoes the name", async () => {
    enableJobApiWithRemotes({ STUB_DELAY_MS: "5000" });
    const first = (await handlersOf(CreateRoute).POST({
      request: createRequest(validSftpIntent()),
      params: {},
    })) as Response;
    expect(first.status).toBe(201);

    const second = (await handlersOf(CreateRoute).POST({
      request: createRequest(validSftpIntent()),
      params: {},
    })) as Response;
    expect(second.status).toBe(409);
    expect(await second.text()).toBe("");
  });

  test("an sftp intent without a configured table is an empty-bodied 400", async () => {
    enableJobApi();
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validSftpIntent()),
      params: {},
    })) as Response;
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
  });
});

describe("GET /api/jobs/remotes", () => {
  test("is 404 when the API is disabled", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    const response = (await handlersOf(RemotesRoute).GET({
      request: new Request("http://localhost/api/jobs/remotes"),
      params: {},
    })) as Response;
    expect(response.status).toBe(404);
  });

  test("is 401 on a wrong bearer", async () => {
    enableJobApi({ token: "the-token" });
    const response = (await handlersOf(RemotesRoute).GET({
      request: new Request("http://localhost/api/jobs/remotes", {
        headers: { authorization: "Bearer wrong" },
      }),
      params: {},
    })) as Response;
    expect(response.status).toBe(401);
  });

  test("serves [] when the API is enabled but no remotes are configured", async () => {
    enableJobApi();
    const response = (await handlersOf(RemotesRoute).GET({
      request: new Request("http://localhost/api/jobs/remotes"),
      params: {},
    })) as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual([]);
  });

  test("the projection carries only {name, host, port, path} and no @ ref", async () => {
    enableJobApiWithRemotes();
    const response = (await handlersOf(RemotesRoute).GET({
      request: new Request("http://localhost/api/jobs/remotes"),
      params: {},
    })) as Response;
    expect(response.status).toBe(200);

    const body = await response.text();
    // No credential reference and no fingerprint survives serialization.
    expect(body).not.toContain("@");
    expect(body).not.toContain("SHA256");

    const items = JSON.parse(body) as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    for (const item of items)
      for (const key of Object.keys(item))
        expect(["name", "host", "port", "path"]).toContain(key);
    expect(items[0]).toEqual({
      name: "prod_east",
      host: "sftp.example.org",
      port: 2222,
      path: "/exchange",
    });
  });

  test("'remotes' can never be captured as a job id", async () => {
    // The traversal guard every $jobId route applies rejects the static
    // segment outright, so even a router that mis-ranked the routes could not
    // reach the filesystem with "remotes" as an id.
    expect(validateJobIdParam("remotes")).toBeNull();
    enableJobApi();
    const response = (await handlersOf(JobRoute).GET({
      request: new Request("http://localhost/api/jobs/remotes"),
      params: { jobId: "remotes" },
    })) as Response;
    expect(response.status).toBe(404);
  });
});

describe("create failure is a clean 500", () => {
  test("a data root that is a regular file yields 500", async () => {
    const root = tempDataRoot("routes-file");
    roots.push(root);
    fs.writeFileSync(root, "");
    vi.stubEnv("JOB_DATA_ROOT", root);
    vi.stubEnv("JOB_CLI_BINARY", STUB_CLI_PATH);
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent()),
      params: {},
    })) as Response;
    expect(response.status).toBe(500);
  });
});

/**
 * A POST request whose body streams `chunkCount` chunks of `chunkBytes` each,
 * with the given headers applied verbatim. Streaming (not a fixed buffer) is what
 * lets a caller understate or omit `Content-Length` while the actual bytes exceed
 * a cap -- the case the boundary read must catch by measuring the READ, not the
 * declared length.
 */
function streamingPostRequest(
  chunkBytes: number,
  chunkCount: number,
  headers: Record<string, string> = {},
): Request {
  let emitted = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted >= chunkCount) {
        controller.close();
        return;
      }
      emitted += 1;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
  });
  return new Request("http://localhost/api/jobs", {
    method: "POST",
    headers,
    body: stream,
    // undici requires an explicit duplex for a streaming request body.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("readJobRequestBody caps the read, not Content-Length", () => {
  test("a body exceeding the cap is too-large, without a Content-Length header", async () => {
    // No Content-Length at all: the running byte total alone trips the cap.
    const request = streamingPostRequest(16, 4);
    const result = await readJobRequestBody(request, 32);
    expect(result.kind).toBe("too-large");
  });

  test("a body exceeding the cap is too-large even when Content-Length understates it", async () => {
    const request = streamingPostRequest(16, 8, { "content-length": "1" });
    const result = await readJobRequestBody(request, 32);
    expect(result.kind).toBe("too-large");
  });

  test("a body at the cap is read and parsed", async () => {
    const payload = JSON.stringify({ ok: true });
    const bytes = new TextEncoder().encode(payload);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const request = new Request("http://localhost/api/jobs", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const result = await readJobRequestBody(request, bytes.byteLength);
    expect(result).toEqual({ kind: "parsed", value: { ok: true } });
  });

  test("an unparseable body is invalid", async () => {
    const request = new Request("http://localhost/api/jobs", {
      method: "POST",
      body: "}{ not json",
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const result = await readJobRequestBody(request, 1024);
    expect(result.kind).toBe("invalid");
  });

  test("the shipped cap comfortably exceeds the JSON-encoded inputCsv cap", () => {
    // The boundary cap must exceed twice the char cap (worst-case JSON escaping)
    // plus headroom, so a schema-valid intent can never be rejected here.
    expect(MAX_JOB_BODY_BYTES).toBeGreaterThan(2 * MAX_INPUT_CSV_LENGTH);
  });
});

describe("POST /api/jobs bounds the body before schema parse", () => {
  test("an oversized body is rejected 413 by the route", async () => {
    enableJobApi();
    // A stream well past the shipped cap, driven cheaply by chunk count so no
    // multi-hundred-MiB buffer is allocated.
    const chunkBytes = 1024 * 1024;
    const chunkCount = MAX_JOB_BODY_BYTES / chunkBytes + 4;
    const response = (await handlersOf(CreateRoute).POST({
      request: streamingPostRequest(chunkBytes, chunkCount),
      params: {},
    })) as Response;
    expect(response.status).toBe(413);
    expect(await response.text()).toBe("");
  });

  test("an unparseable body is rejected 400 by the route", async () => {
    enableJobApi();
    const request = new Request("http://localhost/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "}{ not json",
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = (await handlersOf(CreateRoute).POST({
      request,
      params: {},
    })) as Response;
    expect(response.status).toBe(400);
  });

  test("the gate short-circuits before the body is read (disabled -> 404)", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    const chunkBytes = 1024 * 1024;
    const chunkCount = MAX_JOB_BODY_BYTES / chunkBytes + 4;
    const response = (await handlersOf(CreateRoute).POST({
      request: streamingPostRequest(chunkBytes, chunkCount),
      params: {},
    })) as Response;
    // A 404 (not 413) proves the oversized body was never read: the gate ran first.
    expect(response.status).toBe(404);
  });

  test("the gate short-circuits before the body is read (bad bearer -> 401)", async () => {
    enableJobApi({ token: "the-token" });
    const chunkBytes = 1024 * 1024;
    const chunkCount = MAX_JOB_BODY_BYTES / chunkBytes + 4;
    const response = (await handlersOf(CreateRoute).POST({
      request: streamingPostRequest(chunkBytes, chunkCount, {
        authorization: "Bearer wrong",
      }),
      params: {},
    })) as Response;
    expect(response.status).toBe(401);
  });
});
