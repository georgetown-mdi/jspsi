import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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
import { Route as ResultRoute } from "../../src/routes/api/jobs/$jobId/result";
import { Route as SftpRoute } from "../../src/routes/api/jobs/sftp";

import {
  STUB_CLI_PATH,
  TEST_HOST_KEY_FINGERPRINT,
  tempDataRoot,
  validInputFileIntent,
  validIntent,
  validSftpIntent,
} from "../utils/jobFixtures";

import type { JobInputFileReference } from "@jobs/intent";
import type { JobManager as JobManagerType } from "@jobs/jobManager";

const roots: Array<string> = [];

beforeEach(() => {
  // The server-side job API runs only in a console build, so every enabled case
  // here supplies the console profile. A disabled case still relies on an empty
  // JOB_DATA_ROOT, which the profile does not re-enable.
  vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
});

/** A created rendezvous directory a filedrop job needs, registered for cleanup. */
function rvzRoot(): string {
  const dir = tempDataRoot("routes-rvz");
  roots.push(dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  const seeded = (globalThis as { jobManagerInstance?: JobManagerType })
    .jobManagerInstance;
  seeded?.shutdown();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
  // Reset the memoized manager and sftp server so each test starts clean.
  (globalThis as { jobManagerInstance?: unknown }).jobManagerInstance =
    undefined;
  (globalThis as { jobSftpServer?: unknown }).jobSftpServer = undefined;
  (globalThis as { jobInputDirConfig?: unknown }).jobInputDirConfig = undefined;
  (globalThis as { jobRendezvousDirConfig?: unknown }).jobRendezvousDirConfig =
    undefined;
  (globalThis as { jobSecretsDirConfig?: unknown }).jobSecretsDirConfig =
    undefined;
  (
    globalThis as { jobSftpCredentialScratchDir?: unknown }
  ).jobSftpCredentialScratchDir = undefined;
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

function enableJobApi(): string {
  const rvz = rvzRoot();
  const root = tempDataRoot("routes");
  roots.push(root);
  vi.stubEnv("JOB_DATA_ROOT", root);
  vi.stubEnv("JOB_RENDEZVOUS_DIR", rvz);
  vi.stubEnv("JOB_CLI_BINARY", STUB_CLI_PATH);
  vi.stubEnv("STUB_FD3_EVENTS", JSON.stringify([]));
  vi.stubEnv("STUB_EXIT_CODE", "0");
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
  // Create the rendezvous dir first so the data root stays the last-pushed cleanup
  // entry.
  const rendezvousDir = rvzRoot();
  const root = tempDataRoot("routes-succeed");
  roots.push(root);
  vi.stubEnv("JOB_DATA_ROOT", root);
  const manager = new JobManager({
    dataRoot: root,
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: rendezvousDir,
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
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /api/jobs/:id/events guards an already-aborted request", () => {
  test("a pre-aborted signal closes the stream and leaks no listener", async () => {
    const root = tempDataRoot("routes-abort");
    roots.push(root);
    vi.stubEnv("JOB_DATA_ROOT", root);
    const manager = new JobManager({
      dataRoot: root,
      binaryPath: STUB_CLI_PATH,
      jobRendezvousDir: rvzRoot(),
      // A delayed stub keeps the job non-terminal, so the route reaches the
      // live-subscribe path rather than closing on an already-terminal replay.
      childEnv: { STUB_FD3_EVENTS: JSON.stringify([]), STUB_DELAY_MS: "5000" },
    });
    (globalThis as { jobManagerInstance?: JobManager }).jobManagerInstance =
      manager;
    const id = await manager.createJob(validIntent());
    const record = manager.getJob(id)!;

    const response = (await handlersOf(EventsRoute).GET({
      request: new Request(`http://localhost/api/jobs/${id}/events`, {
        signal: AbortSignal.abort(),
      }),
      params: { jobId: id },
    })) as Response;
    // Draining the body runs the stream's start callback, where the guard fires.
    await response.text();
    expect(record.listeners.size).toBe(0);

    manager.cancelJob(record);
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

  test("the status body carries no restored key", async () => {
    const id = await createSucceededJob({ STUB_OUTPUT_FILE: "id\n1\n" });
    const response = (await handlersOf(JobRoute).GET({
      request: new Request(`http://localhost/api/jobs/${id}`),
      params: { jobId: id },
    })) as Response;
    const body = (await response.json()) as Record<string, unknown>;
    expect("restored" in body).toBe(false);
  });
});

/** Write a secret outside the roots and author a file-reference SFTP connection on
 * the manager, returning the credential `@path`. */
function authorSftpOn(manager: JobManager, host = "sftp.example.org"): string {
  const dir = tempDataRoot("routes-secret");
  roots.push(dir);
  fs.mkdirSync(dir, { recursive: true });
  const secretPath = path.join(dir, "password");
  fs.writeFileSync(secretPath, "s3cret\n");
  manager.authorSftpServer({
    host,
    port: 2222,
    username: "linkage",
    path: "/exchange",
    hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
    credential: { kind: "ref", ref: `@${secretPath}`, credType: "password" },
  });
  return `@${secretPath}`;
}

/**
 * Enable the API and seed the global manager with an authored sftp connection,
 * pointed at the stub CLI. Returns the manager and the credential `@path`.
 */
function enableJobApiWithSftpServer(stubEnv: NodeJS.ProcessEnv = {}): {
  manager: JobManager;
  credentialRef: string;
} {
  const root = tempDataRoot("routes-sftp");
  roots.push(root);
  vi.stubEnv("JOB_DATA_ROOT", root);
  const manager = new JobManager({
    dataRoot: root,
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: rvzRoot(),
    childEnv: { STUB_FD3_EVENTS: JSON.stringify([]), ...stubEnv },
  });
  (globalThis as { jobManagerInstance?: JobManager }).jobManagerInstance =
    manager;
  const credentialRef = authorSftpOn(manager);
  return { manager, credentialRef };
}

/**
 * Enable the API and seed the global manager with a resolved work-input directory
 * (the production wiring passes it from {@link useJobInputDir}), pointed at the stub
 * CLI. Returns the input directory and a reference to the one CSV in it.
 */
function enableJobApiWithInputDir(stubEnv: NodeJS.ProcessEnv = {}): {
  dataRoot: string;
  ref: JobInputFileReference;
  content: string;
} {
  const dataRoot = tempDataRoot("routes-inputs-data");
  roots.push(dataRoot);
  const inputDir = tempDataRoot("routes-inputs-mount");
  roots.push(inputDir);
  fs.mkdirSync(inputDir, { recursive: true });
  const content = "ssn,last_name,date_of_birth\n111223333,smith,1990-01-01\n";
  const name = "mounted.csv";
  fs.writeFileSync(`${inputDir}/${name}`, content);
  const rendezvousDir = tempDataRoot("routes-inputs-rvz");
  roots.push(rendezvousDir);
  fs.mkdirSync(rendezvousDir, { recursive: true });

  vi.stubEnv("JOB_DATA_ROOT", dataRoot);
  const manager = new JobManager({
    dataRoot,
    binaryPath: STUB_CLI_PATH,
    jobInputDir: inputDir,
    jobRendezvousDir: rendezvousDir,
    childEnv: { STUB_FD3_EVENTS: JSON.stringify([]), ...stubEnv },
  });
  (globalThis as { jobManagerInstance?: JobManager }).jobManagerInstance =
    manager;
  return { dataRoot, ref: { name }, content };
}

describe("POST /api/jobs drives a job from a mounted work input", () => {
  test("a valid inputFile reference creates a job that reads the mount in place", async () => {
    const { dataRoot, ref } = enableJobApiWithInputDir();
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validInputFileIntent(ref)),
      params: {},
    })) as Response;
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    // Read in place: nothing is copied into the job workdir.
    expect(fs.existsSync(`${dataRoot}/${id}/input.csv`)).toBe(false);
  });

  test("an unknown mounted name is an empty-bodied 400", async () => {
    enableJobApiWithInputDir();
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validInputFileIntent({ name: "absent.csv" })),
      params: {},
    })) as Response;
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
  });
});

describe("POST /api/jobs and the authored sftp connection", () => {
  test("a second concurrent sftp create is an empty-bodied 409", async () => {
    enableJobApiWithSftpServer({ STUB_DELAY_MS: "5000" });
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

  test("an sftp intent without an authored connection is an empty-bodied 400", async () => {
    enableJobApi();
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validSftpIntent()),
      params: {},
    })) as Response;
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
  });

  test("the create path composes the authored connection into the job config", async () => {
    // The connection material comes only from the authored entry: the composed
    // psilink.yaml carries its host and @path credential ref, and nothing
    // client-chosen.
    const root = tempDataRoot("routes-sftp-compose");
    roots.push(root);
    vi.stubEnv("JOB_DATA_ROOT", root);
    const manager = new JobManager({
      dataRoot: root,
      binaryPath: STUB_CLI_PATH,
      childEnv: { STUB_FD3_EVENTS: JSON.stringify([]), STUB_DELAY_MS: "5000" },
    });
    (globalThis as { jobManagerInstance?: JobManager }).jobManagerInstance =
      manager;
    const credentialRef = authorSftpOn(manager);

    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validSftpIntent()),
      params: {},
    })) as Response;
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const composed = fs.readFileSync(`${root}/${id}/psilink.yaml`, "utf8");
    expect(composed).toContain("sftp.example.org");
    expect(composed).toContain(credentialRef);
    expect(composed).not.toContain("s3cret");
  });
});

describe("POST /api/jobs rejects a concurrent filedrop job", () => {
  test("a second concurrent filedrop create is an empty-bodied 409", async () => {
    const root = tempDataRoot("routes-filedrop");
    roots.push(root);
    vi.stubEnv("JOB_DATA_ROOT", root);
    const manager = new JobManager({
      dataRoot: root,
      binaryPath: STUB_CLI_PATH,
      jobRendezvousDir: rvzRoot(),
      childEnv: { STUB_FD3_EVENTS: JSON.stringify([]), STUB_DELAY_MS: "5000" },
    });
    (globalThis as { jobManagerInstance?: JobManager }).jobManagerInstance =
      manager;

    const first = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent()),
      params: {},
    })) as Response;
    expect(first.status).toBe(201);

    const second = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent()),
      params: {},
    })) as Response;
    expect(second.status).toBe(409);
    expect(await second.text()).toBe("");
  });
});

describe("DELETE frees the slot for a new POST", () => {
  test("a terminal exchange is 409 until DELETE, then a POST succeeds", async () => {
    const id = await createSucceededJob({ STUB_OUTPUT_FILE: "id\n1\n" });
    const manager = (globalThis as { jobManagerInstance?: JobManagerType })
      .jobManagerInstance!;
    await vi.waitFor(() => expect(manager.getJob(id)?.terminal).not.toBeNull());

    // Reject-until-DELETE: the settled exchange holds the slot.
    const busy = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent()),
      params: {},
    })) as Response;
    expect(busy.status).toBe(409);
    expect(await busy.text()).toBe("");

    const del = (await handlersOf(JobRoute).DELETE({
      request: new Request(`http://localhost/api/jobs/${id}`, {
        method: "DELETE",
      }),
      params: { jobId: id },
    })) as Response;
    expect(del.status).toBe(204);

    const created = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent()),
      params: {},
    })) as Response;
    expect(created.status).toBe(201);
  });
});

describe("GET /api/jobs/sftp", () => {
  test("is 404 when the API is disabled", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    const response = (await handlersOf(SftpRoute).GET({
      request: new Request("http://localhost/api/jobs/sftp"),
      params: {},
    })) as Response;
    expect(response.status).toBe(404);
  });

  test("reads configured:false when the API is enabled but no connection is authored", async () => {
    enableJobApi();
    const response = (await handlersOf(SftpRoute).GET({
      request: new Request("http://localhost/api/jobs/sftp"),
      params: {},
    })) as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      configured: false,
    });
  });

  test("the projection carries only {host, port, path} and no @ ref or fingerprint", async () => {
    enableJobApiWithSftpServer();
    const response = (await handlersOf(SftpRoute).GET({
      request: new Request("http://localhost/api/jobs/sftp"),
      params: {},
    })) as Response;
    expect(response.status).toBe(200);

    const body = await response.text();
    // No credential reference and no fingerprint survives serialization.
    expect(body).not.toContain("@");
    expect(body).not.toContain("SHA256");

    const item = JSON.parse(body) as Record<string, unknown>;
    for (const key of Object.keys(item))
      expect(["configured", "host", "port", "path"]).toContain(key);
    expect(item).toEqual({
      configured: true,
      host: "sftp.example.org",
      port: 2222,
      path: "/exchange",
    });
  });

  test("'sftp' can never be captured as a job id", async () => {
    // The traversal guard every $jobId route applies rejects the static
    // segment outright, so even a router that mis-ranked the routes could not
    // reach the filesystem with "sftp" as an id.
    expect(validateJobIdParam("sftp")).toBeNull();
    enableJobApi();
    const response = (await handlersOf(JobRoute).GET({
      request: new Request("http://localhost/api/jobs/sftp"),
      params: { jobId: "sftp" },
    })) as Response;
    expect(response.status).toBe(404);
  });
});

/** A secret file outside every data/rendezvous root, plus the ref it feeds. */
function secretFileOutside(): string {
  const dir = tempDataRoot("routes-secret");
  roots.push(dir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = `${dir}/password`;
  fs.writeFileSync(filePath, "s3cret\n");
  return filePath;
}

function authoredBody(ref: string, overrides: Record<string, unknown> = {}) {
  return {
    host: "authored.partner.example",
    hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
    credential: { kind: "ref", ref: `@${ref}`, credType: "password" },
    ...overrides,
  };
}

async function putSftp(body: unknown): Promise<Response> {
  return (await handlersOf(SftpRoute).PUT({
    request: new Request("http://localhost/api/jobs/sftp", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params: {},
  })) as Response;
}

async function getSftp(): Promise<Response> {
  return (await handlersOf(SftpRoute).GET({
    request: new Request("http://localhost/api/jobs/sftp"),
    params: {},
  })) as Response;
}

async function deleteSftp(): Promise<Response> {
  return (await handlersOf(SftpRoute).DELETE({
    request: new Request("http://localhost/api/jobs/sftp", {
      method: "DELETE",
    }),
    params: {},
  })) as Response;
}

describe("PUT/DELETE /api/jobs/sftp (authoring the connection)", () => {
  test("is 404 when the API is disabled", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    const response = await putSftp(authoredBody("/tmp/pw"));
    expect(response.status).toBe(404);
  });

  test("authors a connection GET then reports, credential-free", async () => {
    enableJobApi();
    const ref = secretFileOutside();
    const put = await putSftp(authoredBody(ref, { port: 2022, path: "/drop" }));
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({
      configured: true,
      host: "authored.partner.example",
      port: 2022,
      path: "/drop",
    });

    const get = await getSftp();
    const body = await get.text();
    // No credential reference or fingerprint survives the projection.
    expect(body).not.toContain("@");
    expect(body).not.toContain("SHA256");
    expect(JSON.parse(body)).toEqual({
      configured: true,
      host: "authored.partner.example",
      port: 2022,
      path: "/drop",
    });
  });

  test("a credential ref under the data root is 400 and never echoes the ref", async () => {
    const dataRoot = enableJobApi();
    const ref = `${dataRoot}/planted/pw`;
    const response = await putSftp(authoredBody(ref));
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("data root");
    expect(text).not.toContain(ref);
  });

  test("a non-ref credential kind is a 400", async () => {
    enableJobApi();
    const response = await putSftp(
      authoredBody("/tmp/pw", {
        credential: { kind: "inline", ref: "hunter2", credType: "password" },
      }),
    );
    expect(response.status).toBe(400);
  });

  test("a mountRef locator resolves against JOB_SECRETS_DIR", async () => {
    enableJobApi();
    const secretsDir = tempDataRoot("routes-secrets");
    roots.push(secretsDir);
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.writeFileSync(`${secretsDir}/partner-password`, "s3cret\n");
    vi.stubEnv("JOB_SECRETS_DIR", secretsDir);
    const put = await putSftp({
      host: "authored.partner.example",
      hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
      credential: {
        kind: "mountRef",
        mount: "secrets",
        subPath: ["partner-password"],
        credType: "password",
      },
    });
    expect(put.status).toBe(200);
    // The projection is credential-free; the resolved absolute path never rides it.
    const body = await put.text();
    expect(body).not.toContain(secretsDir);
    expect(JSON.parse(body)).toEqual({
      configured: true,
      host: "authored.partner.example",
    });
  });

  test("a mountRef with no secrets mount configured is a 400 naming the field", async () => {
    enableJobApi();
    const response = await putSftp({
      host: "authored.partner.example",
      hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
      credential: {
        kind: "mountRef",
        mount: "secrets",
        subPath: ["partner-password"],
        credType: "password",
      },
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("connection.credential");
    expect(text).toContain("secrets mount");
  });

  test("re-authoring replaces the held connection", async () => {
    enableJobApiWithSftpServer();
    const ref = secretFileOutside();
    const response = await putSftp(authoredBody(ref, { port: 2099 }));
    expect(response.status).toBe(200);
    // The newly authored connection replaces the prior one.
    expect(await (await getSftp()).json()).toEqual({
      configured: true,
      host: "authored.partner.example",
      port: 2099,
    });
  });

  test("DELETE forgets the authored connection (idempotent 204)", async () => {
    enableJobApi();
    const ref = secretFileOutside();
    expect((await putSftp(authoredBody(ref))).status).toBe(200);
    const del = await deleteSftp();
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
    expect(await (await getSftp()).json()).toEqual({
      configured: false,
    });
    // Idempotent: a second DELETE is still 204.
    expect((await deleteSftp()).status).toBe(204);
  });

  test("the authored connection composes into an sftp job's config", async () => {
    const dataRoot = enableJobApi();
    const ref = secretFileOutside();
    expect((await putSftp(authoredBody(ref))).status).toBe(200);
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validSftpIntent()),
      params: {},
    })) as Response;
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const composed = fs.readFileSync(`${dataRoot}/${id}/psilink.yaml`, "utf8");
    expect(composed).toContain("host: authored.partner.example");
    expect(composed).toContain(`@${ref}`);
    expect(composed).not.toContain("s3cret");
  });

  /** Boot the pasted-credential scratch directory the enabled API materializes to,
   * registered for cleanup and reset by the suite afterEach. */
  function scratchDir(): string {
    const dir = tempDataRoot("routes-scratch");
    roots.push(dir);
    fs.mkdirSync(dir, { recursive: true });
    (
      globalThis as { jobSftpCredentialScratchDir?: string }
    ).jobSftpCredentialScratchDir = dir;
    return dir;
  }

  test("a pasted credential materializes and projects credential-free", async () => {
    enableJobApi();
    const scratch = scratchDir();
    const put = await putSftp({
      host: "authored.partner.example",
      hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
      credential: {
        kind: "raw",
        value: "s3cret-password",
        credType: "password",
      },
    });
    expect(put.status).toBe(200);
    const body = await put.text();
    // The pasted value never rides the response; the projection is locator-only.
    expect(body).not.toContain("s3cret-password");
    expect(body).not.toContain("@");
    expect(JSON.parse(body)).toEqual({
      configured: true,
      host: "authored.partner.example",
    });
    // The value exists at rest ONLY as the scratch file, owner-only.
    const files = fs.readdirSync(scratch);
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(path.join(scratch, files[0]), "utf8")).toBe(
      "s3cret-password",
    );
  });

  test("a malformed pasted credential is a 400 that never echoes the value", async () => {
    enableJobApi();
    scratchDir();
    const response = await putSftp({
      host: "authored.partner.example",
      hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
      credential: { kind: "raw", value: "", credType: "password" },
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("connection.credential");
  });

  test("DELETE of the connection sweeps the materialized pasted credential", async () => {
    enableJobApi();
    const scratch = scratchDir();
    expect(
      (
        await putSftp({
          host: "authored.partner.example",
          hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
          credential: {
            kind: "raw",
            value: "s3cret",
            credType: "password",
          },
        })
      ).status,
    ).toBe(200);
    expect(fs.readdirSync(scratch)).toHaveLength(1);
    expect((await deleteSftp()).status).toBe(204);
    expect(fs.readdirSync(scratch)).toEqual([]);
  });
});

describe("POST /api/jobs stays injection-closed to connection material", () => {
  test("a connection field on the sftp intent is rejected (strict schema)", async () => {
    enableJobApiWithSftpServer();
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest({
        ...validSftpIntent(),
        connection: { channel: "sftp", host: "attacker.example" },
      }),
      params: {},
    })) as Response;
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
  });
});

describe("create failure is a clean 500", () => {
  test("a data root that is a regular file yields 500", async () => {
    const root = tempDataRoot("routes-file");
    roots.push(root);
    fs.writeFileSync(root, "");
    vi.stubEnv("JOB_DATA_ROOT", root);
    vi.stubEnv("JOB_RENDEZVOUS_DIR", rvzRoot());
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

  test("the boundary cap clears a realistic schema-valid intent", () => {
    // Real CSV text barely grows under JSON string escaping (only newlines and
    // the rare quote escape), so a max-length inputCsv plus the other capped
    // fields stays well under the boundary cap and gets a clean schema error,
    // never a spurious 413. A pathological control-character payload that
    // inflates ~6x under \uXXXX escaping is not valid CSV and is bounded here by
    // design, so the cap is deliberately not sized to clear it.
    const sample = "12345,Jane,Public,1990-01-01\n".repeat(4096);
    const jsonBytesPerChar =
      new TextEncoder().encode(JSON.stringify(sample)).length / sample.length;
    const realisticInputCsvBytes = jsonBytesPerChar * MAX_INPUT_CSV_LENGTH;
    // Generous allowance for the other capped fields at their worst realistic
    // encoded size.
    const otherCappedFieldsBytes = 64 * 1024 ** 2;
    expect(realisticInputCsvBytes + otherCappedFieldsBytes).toBeLessThan(
      MAX_JOB_BODY_BYTES,
    );
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
});
