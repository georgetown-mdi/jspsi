import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { JOB_FILE_NAMES, MAX_INPUT_CSV_LENGTH } from "@jobs/intentSchemas";
import {
  MAX_JOB_BODY_BYTES,
  MAX_SFTP_AUTHOR_BODY_BYTES,
  readJobRequestBody,
  validateJobIdParam,
} from "@jobs/routeSupport";
import { formatFirstIssue, formatIssues } from "@jobs/schemaIssueMessage";
import { JobManager } from "@jobs/jobManager";

import { Route as CancelRoute } from "../../../src/routes/api/jobs/$jobId/cancel";
import { Route as CreateRoute } from "../../../src/routes/api/jobs/index";
import { Route as EventsRoute } from "../../../src/routes/api/jobs/$jobId/events";
import { Route as JobRoute } from "../../../src/routes/api/jobs/$jobId/index";
import { Route as KeysRoute } from "../../../src/routes/api/jobs/$jobId/keys";
import { Route as LogRoute } from "../../../src/routes/api/jobs/$jobId/log";
import { Route as RecordRoute } from "../../../src/routes/api/jobs/$jobId/record";
import { Route as RendezvousRoute } from "../../../src/routes/api/jobs/rendezvous";
import { Route as ResultRoute } from "../../../src/routes/api/jobs/$jobId/result";
import { Route as SftpProbeRoute } from "../../../src/routes/api/jobs/sftp/probe";
import { Route as SftpRoute } from "../../../src/routes/api/jobs/sftp/index";
import { Route as SlotRoute } from "../../../src/routes/api/jobs/slot";

import {
  STUB_CLI_PATH,
  TEST_HOST_KEY_FINGERPRINT,
  composedServer,
  tempDataRoot,
  validInputFileIntent,
  validIntent,
  validSftpIntent,
} from "../../utils/jobFixtures";

import type {
  JobCreateIntent,
  JobInputFileReference,
} from "@jobs/intentSchemas";
import type { ExchangeRecordOutcome } from "@psilink/core";
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
  (
    globalThis as { jobRendezvousProvisioning?: unknown }
  ).jobRendezvousProvisioning = undefined;
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

/**
 * Construct a job-API Request that has a loopback `Host` by default. A
 * synthetic Request sets no `Host` (a real HTTP server always does), so without
 * this the gate's loopback Host-allowlist would 403 every route-driven test. An
 * explicit `host` header wins (the rebinding and mismatch cases), and passing
 * `defaultHost: null` omits it (the absent-Host case).
 */
function jobRequest(
  url: string,
  init: RequestInit = {},
  defaultHost: string | null = "localhost",
): Request {
  const headers = new Headers(init.headers);
  if (defaultHost !== null && !headers.has("host"))
    headers.set("host", defaultHost);
  return new Request(url, { ...init, headers });
}

function createRequest(body: unknown, headers: Record<string, string> = {}) {
  return jobRequest("http://localhost/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** A record body with the given createdAt and outcome, matching the shape the
 * status route reads. Every record has an outcome, so the default is the
 * completed run's and a terminated run's is stated at the call site. */
function recordJson(
  createdAt: string,
  outcome: ExchangeRecordOutcome = "completed",
): string {
  return JSON.stringify({ createdAt, outcome, summary: "test" });
}

/**
 * The status each half of the record pair's download answers for `id`, driven
 * through its own route under its own URL.
 *
 * The two downloads and the status body's `recordAvailable` stand on one gate, so
 * a test that pinned the status field alone would not see a change that split the
 * downloads off from it and started serving a record the status body calls
 * unavailable.
 */
async function recordPairStatuses(
  id: string,
): Promise<{ record: number; keys: number }> {
  const statusOf = async (
    route: Parameters<typeof handlersOf>[0],
    segment: string,
  ): Promise<number> =>
    (
      (await handlersOf(route).GET({
        request: jobRequest(`http://localhost/api/jobs/${id}/${segment}`),
        params: { jobId: id },
      })) as Response
    ).status;
  return {
    record: await statusOf(RecordRoute, "record"),
    keys: await statusOf(KeysRoute, "keys"),
  };
}

/**
 * Enable the API, seed the global manager with one pointed at the stub CLI
 * (passing its scenario through childEnv, since the route path's sanitized child
 * env drops ambient STUB_* vars), create a job, and resolve its id once it has
 * reached `target`. `stubEnv` scripts the stub: what output/record files it
 * writes, and what it exits with.
 */
async function createFinishedJob(
  target: "succeeded" | "failed",
  stubEnv: NodeJS.ProcessEnv,
  intent: JobCreateIntent = validIntent(),
): Promise<string> {
  // Create the rendezvous dir first so the data root stays the last-pushed cleanup
  // entry.
  const rendezvousDir = rvzRoot();
  const root = tempDataRoot(`routes-${target}`);
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
  const id = await manager.createJob(intent);
  const deadline = Date.now() + 5000;
  for (;;) {
    const record = manager.getJob(id);
    if (record !== undefined && record.status === target) return id;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for the job to reach ${target}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function createSucceededJob(
  stubEnv: NodeJS.ProcessEnv,
  intent: JobCreateIntent = validIntent(),
): Promise<string> {
  return createFinishedJob("succeeded", stubEnv, intent);
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
      request: jobRequest("http://localhost/api/jobs/x"),
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
        host: "localhost",
        origin: "http://localhost",
      }),
      params: {},
    })) as Response;
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("the browser-CSRF gate rejects a cross-origin browser request", () => {
  test("a same-origin Origin (matching Host) passes", async () => {
    enableJobApi();
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent(), {
        host: "localhost",
        origin: "http://localhost",
      }),
      params: {},
    })) as Response;
    expect(response.status).toBe(201);
  });

  test("a Sec-Fetch-Site: same-origin request passes", async () => {
    enableJobApi();
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent(), {
        "sec-fetch-site": "same-origin",
      }),
      params: {},
    })) as Response;
    expect(response.status).toBe(201);
  });

  test("a request with neither Origin nor Sec-Fetch-Site passes (non-browser client)", async () => {
    enableJobApi();
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent()),
      params: {},
    })) as Response;
    expect(response.status).toBe(201);
  });

  test("a Sec-Fetch-Site: cross-site request is 403", async () => {
    enableJobApi();
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent(), { "sec-fetch-site": "cross-site" }),
      params: {},
    })) as Response;
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("an Origin mismatching the Host is 403", async () => {
    enableJobApi();
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent(), {
        host: "localhost",
        origin: "https://evil.example",
      }),
      params: {},
    })) as Response;
    expect(response.status).toBe(403);
  });

  test("the gate runs on the probe route too (shared gate)", async () => {
    seedManagerWithProbe({ STUB_PROBE_STDOUT: okProbeLine() });
    const rejected = (await handlersOf(SftpProbeRoute).POST({
      request: jobRequest("http://localhost/api/jobs/sftp/probe", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({ host: "sftp.example.org" }),
      }),
      params: {},
    })) as Response;
    expect(rejected.status).toBe(403);
  });

  test("the disabled gate 404s before the CSRF 403 (feature gate first)", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent(), { "sec-fetch-site": "cross-site" }),
      params: {},
    })) as Response;
    // A disabled API stays a uniform 404 even for a cross-origin request: the
    // feature gate runs before the CSRF check, so presence is not observable.
    expect(response.status).toBe(404);
  });
});

describe("the loopback Host-allowlist closes DNS rebinding", () => {
  test.each([
    ["127.0.0.1:3000"],
    ["localhost:3000"],
    ["localhost"],
    ["[::1]:3000"],
  ])("a loopback Host (%s) passes, port-agnostic", async (host) => {
    enableJobApi();
    // No Origin or Sec-Fetch-Site, so only the Host rule is under test.
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent(), { host }),
      params: {},
    })) as Response;
    expect(response.status).toBe(201);
  });

  test("a rebound attacker Host is 403 though the request is same-origin", async () => {
    enableJobApi();
    // The DNS-rebinding shape: Host and Origin both name the attacker and
    // Sec-Fetch-Site is same-origin -- internally consistent, so the pre-existing
    // browser-CSRF check passes it (the next test proves this by admitting the
    // very same shape once the Host is allowlisted). The Host-allowlist is what
    // rejects it here.
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent(), {
        host: "attacker.example:3000",
        origin: "http://attacker.example:3000",
        "sec-fetch-site": "same-origin",
      }),
      params: {},
    })) as Response;
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("JOB_ALLOWED_HOSTS admits the same rebinding shape (so CSRF passed it)", async () => {
    enableJobApi();
    vi.stubEnv("JOB_ALLOWED_HOSTS", "attacker.example");
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent(), {
        host: "attacker.example:3000",
        origin: "http://attacker.example:3000",
        "sec-fetch-site": "same-origin",
      }),
      params: {},
    })) as Response;
    // Only the allowlist entry changed from the 403 above, so that 403 was the
    // Host-allowlist and not the CSRF check.
    expect(response.status).toBe(201);
  });

  test("a 0.0.0.0 Host is 403 (never allowlisted)", async () => {
    enableJobApi();
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent(), { host: "0.0.0.0:3000" }),
      params: {},
    })) as Response;
    expect(response.status).toBe(403);
  });

  test("an absent Host is 403 (fail closed)", async () => {
    enableJobApi();
    const response = (await handlersOf(CreateRoute).POST({
      request: jobRequest(
        "http://localhost/api/jobs",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(validIntent()),
        },
        null,
      ),
      params: {},
    })) as Response;
    expect(response.status).toBe(403);
  });

  test("JOB_ALLOWED_HOSTS admits a listed host", async () => {
    enableJobApi();
    vi.stubEnv("JOB_ALLOWED_HOSTS", "proxy.internal");
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent(), { host: "proxy.internal:3000" }),
      params: {},
    })) as Response;
    expect(response.status).toBe(201);
  });

  test("a host absent from JOB_ALLOWED_HOSTS is still 403", async () => {
    enableJobApi();
    vi.stubEnv("JOB_ALLOWED_HOSTS", "proxy.internal");
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent(), { host: "other.example:3000" }),
      params: {},
    })) as Response;
    expect(response.status).toBe(403);
  });

  test("the Host-allowlist runs on the probe route (shared gate)", async () => {
    seedManagerWithProbe({ STUB_PROBE_STDOUT: okProbeLine() });
    const rejected = (await handlersOf(SftpProbeRoute).POST({
      request: jobRequest("http://localhost/api/jobs/sftp/probe", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "attacker.example:3000",
          origin: "http://attacker.example:3000",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ host: "sftp.example.org" }),
      }),
      params: {},
    })) as Response;
    expect(rejected.status).toBe(403);
  });

  test("the Host-allowlist runs on a GET route (shared gate)", async () => {
    enableJobApiWithSftpServer();
    const response = (await handlersOf(SftpRoute).GET({
      request: jobRequest("http://localhost/api/jobs/sftp", {
        headers: { host: "attacker.example:3000" },
      }),
      params: {},
    })) as Response;
    expect(response.status).toBe(403);
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
      request: jobRequest(`http://localhost/api/jobs/${id}/events`, {
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
      request: jobRequest("http://localhost/api/jobs/x"),
      params: bad,
    })) as Response;
    expect(statusResp.status).toBe(404);
    const eventsResp = (await handlersOf(EventsRoute).GET({
      request: jobRequest("http://localhost/api/jobs/x/events"),
      params: bad,
    })) as Response;
    expect(eventsResp.status).toBe(404);
    const cancelResp = (await handlersOf(CancelRoute).POST({
      request: jobRequest("http://localhost/api/jobs/x/cancel", {
        method: "POST",
      }),
      params: bad,
    })) as Response;
    expect(cancelResp.status).toBe(404);
    const resultResp = (await handlersOf(ResultRoute).GET({
      request: jobRequest("http://localhost/api/jobs/x/result"),
      params: bad,
    })) as Response;
    expect(resultResp.status).toBe(404);
    const recordResp = (await handlersOf(RecordRoute).GET({
      request: jobRequest("http://localhost/api/jobs/x/record"),
      params: bad,
    })) as Response;
    expect(recordResp.status).toBe(404);
    const keysResp = (await handlersOf(KeysRoute).GET({
      request: jobRequest("http://localhost/api/jobs/x/keys"),
      params: bad,
    })) as Response;
    expect(keysResp.status).toBe(404);
    const deleteResp = (await handlersOf(JobRoute).DELETE({
      request: jobRequest("http://localhost/api/jobs/x", { method: "DELETE" }),
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
      request: jobRequest(`http://localhost/api/jobs/${id}/result`),
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
      request: jobRequest(`http://localhost/api/jobs/${id}/record`),
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
      request: jobRequest(`http://localhost/api/jobs/${id}/keys`),
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
      request: jobRequest(`http://localhost/api/jobs/${id}/record`),
      params: { jobId: id },
    })) as Response;
    expect(recordResp.status).toBe(404);
    const keysResp = (await handlersOf(KeysRoute).GET({
      request: jobRequest(`http://localhost/api/jobs/${id}/keys`),
      params: { jobId: id },
    })) as Response;
    expect(keysResp.status).toBe(404);
  });

  test("record and keys are 404 while the run is still going, pair on disk or not", async () => {
    // The CLI writes the pair near the end of a run, so a mid-run read could take
    // a half-written state for the run's answer. Planting a complete pair under a
    // live child does not open the routes: settling is what they gate on, and it
    // is a separate claim from the files being there.
    enableJobApi();
    vi.stubEnv("STUB_DELAY_MS", "5000");
    const created = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent()),
      params: {},
    })) as Response;
    const { id } = (await created.json()) as { id: string };
    for (const stage of ["nothing written", "pair planted"]) {
      if (stage === "pair planted") {
        const workdir = path.join(process.env.JOB_DATA_ROOT!, id);
        fs.writeFileSync(
          path.join(workdir, JOB_FILE_NAMES.record),
          recordJson(CREATED_AT),
        );
        fs.writeFileSync(
          path.join(workdir, JOB_FILE_NAMES.recordKeys),
          JSON.stringify({ salts: {} }),
        );
      }
      const recordResp = (await handlersOf(RecordRoute).GET({
        request: jobRequest(`http://localhost/api/jobs/${id}/record`),
        params: { jobId: id },
      })) as Response;
      expect(recordResp.status, stage).toBe(404);
      const keysResp = (await handlersOf(KeysRoute).GET({
        request: jobRequest(`http://localhost/api/jobs/${id}/keys`),
        params: { jobId: id },
      })) as Response;
      expect(keysResp.status, stage).toBe(404);
    }
  });

  test("record and keys are 404 when the API is disabled", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    const jobId = "00000000-0000-4000-8000-000000000000";
    const recordResp = (await handlersOf(RecordRoute).GET({
      request: jobRequest(`http://localhost/api/jobs/${jobId}/record`),
      params: { jobId },
    })) as Response;
    expect(recordResp.status).toBe(404);
    const keysResp = (await handlersOf(KeysRoute).GET({
      request: jobRequest(`http://localhost/api/jobs/${jobId}/keys`),
      params: { jobId },
    })) as Response;
    expect(keysResp.status).toBe(404);
  });
});

describe("the diagnostic log route serves only a workdir-contained log", () => {
  /** Stand in for the `--log-file` write the real CLI makes: the stub honours no
   * log flag, and whether the CLI opens the path it is given is settled against
   * the built binary in the zero-setup argv parser suite. What is under test here
   * is which path this route resolves and serves. */
  function seedLog(id: string, body: string): string {
    const manager = (globalThis as { jobManagerInstance?: JobManagerType })
      .jobManagerInstance!;
    const logPath = manager.getJobView(id)!.logPath!;
    fs.writeFileSync(logPath, body);
    return logPath;
  }

  test("a diagnostic run's log is served as a private attachment from inside the workdir", async () => {
    const id = await createSucceededJob(
      { STUB_OUTPUT_FILE: "id\n1\n" },
      { ...validIntent(), diagnosticRun: true },
    );
    const logPath = seedLog(id, "[2026-08-22] [DEBUG] rendezvous opened\n");
    // The served path is the workdir's own, not one derived from the request.
    expect(path.dirname(logPath)).toBe(
      path.join(process.env.JOB_DATA_ROOT!, id),
    );
    expect(path.basename(logPath)).toBe(JOB_FILE_NAMES.log);

    const response = (await handlersOf(LogRoute).GET({
      request: jobRequest(`http://localhost/api/jobs/${id}/log`),
      params: { jobId: id },
    })) as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(await response.text()).toContain("rendezvous opened");
  });

  /** The status body's two log fields, as a client watching for the log reads
   * them. */
  async function logStatusOf(
    id: string,
  ): Promise<{ logRequested: boolean; logAvailable: boolean }> {
    const response = (await handlersOf(JobRoute).GET({
      request: jobRequest(`http://localhost/api/jobs/${id}`),
      params: { jobId: id },
    })) as Response;
    return (await response.json()) as {
      logRequested: boolean;
      logAvailable: boolean;
    };
  }

  test("the status body reports the log only once it is on disk, and says all along that one is coming", async () => {
    const id = await createSucceededJob(
      { STUB_OUTPUT_FILE: "id\n1\n" },
      { ...validIntent(), diagnosticRun: true },
    );
    expect(await logStatusOf(id)).toMatchObject({
      logRequested: true,
      logAvailable: false,
    });
    seedLog(id, "x\n");
    expect(await logStatusOf(id)).toMatchObject({
      logRequested: true,
      logAvailable: true,
    });
  });

  test("an ordinary run's status body says outright that it captured no log", async () => {
    // Both fields answer from the log path the server set at creation from the
    // intent, so a client is told the log is never coming rather than left to
    // read a false availability as "not yet".
    const id = await createSucceededJob({ STUB_OUTPUT_FILE: "id\n1\n" });
    expect(await logStatusOf(id)).toMatchObject({
      logRequested: false,
      logAvailable: false,
    });
  });

  test("an ordinary run has no log path at all, so the route is 404 even with a file of that name in the workdir", async () => {
    const id = await createSucceededJob({ STUB_OUTPUT_FILE: "id\n1\n" });
    const manager = (globalThis as { jobManagerInstance?: JobManagerType })
      .jobManagerInstance!;
    const view = manager.getJobView(id)!;
    expect(view.logPath).toBeNull();
    // Even planting the file the diagnostic run would have written does not make
    // it servable: a run that captured no log has no log to serve.
    fs.writeFileSync(
      path.join(process.env.JOB_DATA_ROOT!, id, JOB_FILE_NAMES.log),
      "planted\n",
    );
    const response = (await handlersOf(LogRoute).GET({
      request: jobRequest(`http://localhost/api/jobs/${id}/log`),
      params: { jobId: id },
    })) as Response;
    expect(response.status).toBe(404);
  });

  test("a crafted job id is refused before any filesystem use", async () => {
    enableJobApi();
    for (const jobId of ["../../etc/passwd", "not-a-uuid", ""]) {
      const response = (await handlersOf(LogRoute).GET({
        request: jobRequest(`http://localhost/api/jobs/x/log`),
        params: { jobId },
      })) as Response;
      expect(response.status).toBe(404);
    }
  });

  test("the log route is 404 when the API is disabled", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    const jobId = "00000000-0000-4000-8000-000000000000";
    const response = (await handlersOf(LogRoute).GET({
      request: jobRequest(`http://localhost/api/jobs/${jobId}/log`),
      params: { jobId },
    })) as Response;
    expect(response.status).toBe(404);
  });
});

describe("status route reports record availability", () => {
  const CREATED_AT = "2026-07-08T14:32:00.000Z";

  /** The record fields the status route reports for `id`, driven through the
   * route. The withheld reason is read beside the boolean everywhere, since the
   * two together are the answer a client acts on: the boolean alone reports a
   * record the console holds and cannot describe exactly as it reports one that
   * was never written. */
  async function recordStatusOf(id: string): Promise<{
    status: string;
    resultAvailable: boolean;
    recordAvailable: boolean;
    recordCreatedAt?: string;
    recordOutcome?: string;
    recordUnavailableReason?: string;
  }> {
    const response = (await handlersOf(JobRoute).GET({
      request: jobRequest(`http://localhost/api/jobs/${id}`),
      params: { jobId: id },
    })) as Response;
    expect(response.status).toBe(200);
    return (await response.json()) as Awaited<
      ReturnType<typeof recordStatusOf>
    >;
  }

  test("recordAvailable true with the record's createdAt when the pair is on disk", async () => {
    const id = await createSucceededJob({
      STUB_OUTPUT_FILE: "id\n1\n",
      STUB_RECORD_JSON: recordJson(CREATED_AT),
    });
    const body = await recordStatusOf(id);
    expect(body.resultAvailable).toBe(true);
    expect(body.recordAvailable).toBe(true);
    expect(body.recordCreatedAt).toBe(CREATED_AT);
    // An offered pair is not withheld at all, so the field that says why one is
    // withheld is absent rather than holding a stale reason beside it.
    expect(body.recordUnavailableReason).toBeUndefined();
  });

  test("recordAvailable false and no createdAt when the record was never written", async () => {
    const id = await createSucceededJob({ STUB_OUTPUT_FILE: "id\n1\n" });
    const body = await recordStatusOf(id);
    expect(body.recordAvailable).toBe(false);
    expect(body.recordCreatedAt).toBeUndefined();
    // The definitive denial: nothing is at the record path, which is the one
    // answer a console control may destroy the workdir on without asking.
    expect(body.recordUnavailableReason).toBe("no-record");
  });

  test("a running job's pair is withheld as not settled, not as absent", async () => {
    // The CLI writes the pair near the end of a run, so a mid-run read says
    // nothing about whether this run will owe a record -- and reporting it as the
    // absence of one would be a claim the console cannot make yet.
    const root = tempDataRoot("routes-running-record");
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
    const id = await manager.createJob(validIntent());

    const body = await recordStatusOf(id);
    expect(body.status).toBe("running");
    expect(body.recordAvailable).toBe(false);
    expect(body.recordUnavailableReason).toBe("not-settled");
  });

  test("a run that disclosed and then terminated is offered its record", async () => {
    // A run that terminated after its payloads crossed writes the exchange record
    // of that disclosure and still exits non-zero, so the record pair is on disk
    // under a FAILED job. It is the disclosure-accounting artifact that run's
    // operator needs, and the console's own recovery controls DELETE the folder it
    // sits in, so the console offers it rather than holding it back on the run's
    // exit code.
    const id = await createFinishedJob("failed", {
      STUB_EXIT_CODE: "1",
      STUB_RECORD_JSON: recordJson(CREATED_AT, "receipt-swap-terminated"),
    });
    // The helper pushes the data root last, so the run's folder is under it.
    const dataRoot = roots[roots.length - 1];
    expect(fs.existsSync(path.join(dataRoot, id, JOB_FILE_NAMES.record))).toBe(
      true,
    );

    const body = await recordStatusOf(id);
    expect(body.status).toBe("failed");
    expect(body.recordAvailable).toBe(true);
    expect(body.recordCreatedAt).toBe(CREATED_AT);
    // The outcome travels with the availability: a terminated record's
    // commitments re-supply from a result file the run never wrote, so a surface
    // that could not tell the two apart would offer the pair as a completed run's.
    expect(body.recordOutcome).toBe("receipt-swap-terminated");

    const download = (await handlersOf(RecordRoute).GET({
      request: jobRequest(`http://localhost/api/jobs/${id}/record`),
      params: { jobId: id },
    })) as Response;
    expect(download.status).toBe(200);
    expect(JSON.parse(await download.text())).toMatchObject({
      createdAt: CREATED_AT,
      outcome: "receipt-swap-terminated",
    });

    // The keys are served under the same gate, so the pair is never split.
    const keys = (await handlersOf(KeysRoute).GET({
      request: jobRequest(`http://localhost/api/jobs/${id}/keys`),
      params: { jobId: id },
    })) as Response;
    expect(keys.status).toBe(200);
  });

  test("a run that failed before disclosing offers no record", async () => {
    // A failure before the payload exchange returns owes no record and writes
    // none, so nothing is on disk to offer -- the absence is the file's, not a
    // status test standing in for it.
    const id = await createFinishedJob("failed", { STUB_EXIT_CODE: "1" });
    const dataRoot = roots[roots.length - 1];
    expect(fs.existsSync(path.join(dataRoot, id, JOB_FILE_NAMES.record))).toBe(
      false,
    );

    const body = await recordStatusOf(id);
    expect(body.recordAvailable).toBe(false);
    expect(body.recordCreatedAt).toBeUndefined();
    expect(body.recordOutcome).toBeUndefined();
    expect(body.recordUnavailableReason).toBe("no-record");

    expect(await recordPairStatuses(id)).toEqual({ record: 404, keys: 404 });
  });

  test("a record with no recognized outcome is held back as undescribable", async () => {
    // Every record the console's own CLI writes states its outcome, so one that
    // does not -- a data root a differently-versioned CLI wrote -- is not a record
    // this console can describe. It is refused at the downloads rather than
    // offered under a completed run's framing, and the status body says the file
    // is nonetheless there, so a console control that removes the workdir asks
    // first instead of reading the denial as an absence.
    const id = await createSucceededJob({
      STUB_OUTPUT_FILE: "id\n1\n",
      STUB_RECORD_JSON: JSON.stringify({
        createdAt: CREATED_AT,
        outcome: "who-knows",
      }),
    });
    const dataRoot = roots[roots.length - 1];
    expect(fs.existsSync(path.join(dataRoot, id, JOB_FILE_NAMES.record))).toBe(
      true,
    );

    const body = await recordStatusOf(id);
    expect(body.recordAvailable).toBe(false);
    expect(body.recordUnavailableReason).toBe("undescribable-record");
    // Withheld, not offered: the console serves no pair it cannot read whole,
    // and the two routes stay on the status field's own gate.
    expect(await recordPairStatuses(id)).toEqual({ record: 404, keys: 404 });
  });

  test("a record whose keys half is missing is undescribable, not absent", async () => {
    // The pair is served all-or-nothing, so a record without its keys cannot be
    // offered -- but the record itself is on disk, and destroying the workdir
    // unasked over a half pair loses the same disclosure entry.
    const id = await createSucceededJob({
      STUB_OUTPUT_FILE: "id\n1\n",
      STUB_RECORD_JSON: recordJson(CREATED_AT),
    });
    const dataRoot = roots[roots.length - 1];
    fs.rmSync(path.join(dataRoot, id, JOB_FILE_NAMES.recordKeys));

    const body = await recordStatusOf(id);
    expect(body.recordAvailable).toBe(false);
    expect(body.recordCreatedAt).toBeUndefined();
    expect(body.recordUnavailableReason).toBe("undescribable-record");
    expect(await recordPairStatuses(id)).toEqual({ record: 404, keys: 404 });
  });

  test("a malformed record file is treated as undescribable (defensive parse)", async () => {
    // The record write landed a non-JSON body; the status route must not throw,
    // and must treat the record as unavailable rather than serving a bad stamp --
    // while still reporting the file it could not read as being there.
    const id = await createSucceededJob({
      STUB_OUTPUT_FILE: "id\n1\n",
      STUB_RECORD_JSON: "}{ not json",
    });
    const body = await recordStatusOf(id);
    expect(body.recordAvailable).toBe(false);
    expect(body.recordCreatedAt).toBeUndefined();
    expect(body.recordUnavailableReason).toBe("undescribable-record");
    expect(await recordPairStatuses(id)).toEqual({ record: 404, keys: 404 });
  });

  test("a record missing createdAt is treated as undescribable", async () => {
    const id = await createSucceededJob({
      STUB_OUTPUT_FILE: "id\n1\n",
      STUB_RECORD_JSON: JSON.stringify({ summary: "no timestamp" }),
    });
    const body = await recordStatusOf(id);
    expect(body.recordAvailable).toBe(false);
    expect(body.recordUnavailableReason).toBe("undescribable-record");
    expect(await recordPairStatuses(id)).toEqual({ record: 404, keys: 404 });
  });

  test("the status body has no restored key", async () => {
    const id = await createSucceededJob({ STUB_OUTPUT_FILE: "id\n1\n" });
    const response = (await handlersOf(JobRoute).GET({
      request: jobRequest(`http://localhost/api/jobs/${id}`),
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
  test("a second concurrent sftp create is a 409 with the occupying job id", async () => {
    enableJobApiWithSftpServer({ STUB_DELAY_MS: "5000" });
    const first = (await handlersOf(CreateRoute).POST({
      request: createRequest(validSftpIntent()),
      params: {},
    })) as Response;
    expect(first.status).toBe(201);
    const { id: firstId } = (await first.json()) as { id: string };

    const second = (await handlersOf(CreateRoute).POST({
      request: createRequest(validSftpIntent()),
      params: {},
    })) as Response;
    expect(second.status).toBe(409);
    // The busy body has only the occupying exchange's id so the browser can
    // re-attach to it -- nothing else about the running exchange.
    expect(await second.json()).toEqual({ id: firstId });
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
    // psilink.yaml has its host and @path credential ref, and nothing
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
    const server = composedServer(composed);
    expect(server.host).toBe("sftp.example.org");
    expect(server.password).toBe(credentialRef);
    expect(composed).not.toContain("s3cret");
  });
});

describe("POST /api/jobs rejects a concurrent filedrop job", () => {
  test("a second concurrent filedrop create is a 409 with the occupying job id", async () => {
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
    const { id: firstId } = (await first.json()) as { id: string };

    const second = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent()),
      params: {},
    })) as Response;
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ id: firstId });
  });
});

describe("POST /api/jobs on a split-provisioned console", () => {
  /** The retain trio a split rendezvous requires, as the console's file-handling
   * card resolves it before it POSTs. */
  const RETAIN_OPTIONS = {
    retainFiles: true,
    timestampInFilename: true,
    locklessRendezvous: true,
  };

  /** Seed the global manager with both rendezvous legs mounted, so every filedrop
   * create it serves has the inbound/outbound pair. */
  function enableSplitRendezvous(): void {
    const root = tempDataRoot("routes-split");
    roots.push(root);
    vi.stubEnv("JOB_DATA_ROOT", root);
    const manager = new JobManager({
      dataRoot: root,
      binaryPath: STUB_CLI_PATH,
      jobRendezvousDir: rvzRoot(),
      jobRendezvousOutboundDir: rvzRoot(),
      childEnv: { STUB_FD3_EVENTS: JSON.stringify([]), STUB_DELAY_MS: "5000" },
    });
    (globalThis as { jobManagerInstance?: JobManager }).jobManagerInstance =
      manager;
  }

  test("a filedrop intent without retain mode is an empty-bodied 400", async () => {
    enableSplitRendezvous();
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent()),
      params: {},
    })) as Response;
    // The documented rejection for the precondition, not the generic 500 a
    // compose failure would be: the browser reads a 400 as an actionable
    // local-configuration fault and says which control to turn on.
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
  });

  test("the same intent with retain mode is created (so the 400 was the retain gate)", async () => {
    enableSplitRendezvous();
    const response = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent({ options: RETAIN_OPTIONS })),
      params: {},
    })) as Response;
    // Only the file-handling options differ from the 400 above, so that 400 was
    // the split rendezvous meeting a run that would not keep its files.
    expect(response.status).toBe(201);
  });
});

describe("DELETE frees the slot for a new POST", () => {
  test("a terminal exchange is 409 until DELETE, then a POST succeeds", async () => {
    const id = await createSucceededJob({ STUB_OUTPUT_FILE: "id\n1\n" });
    const manager = (globalThis as { jobManagerInstance?: JobManagerType })
      .jobManagerInstance!;
    await vi.waitFor(() => expect(manager.getJob(id)?.terminal).not.toBeNull());

    // Reject-until-DELETE: the settled exchange holds the slot, and the busy body
    // still names it so the browser can re-attach.
    const busy = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent()),
      params: {},
    })) as Response;
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ id });

    const del = (await handlersOf(JobRoute).DELETE({
      request: jobRequest(`http://localhost/api/jobs/${id}`, {
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
      request: jobRequest("http://localhost/api/jobs/sftp"),
      params: {},
    })) as Response;
    expect(response.status).toBe(404);
  });

  test("reads configured:false when the API is enabled but no connection is authored", async () => {
    enableJobApi();
    const response = (await handlersOf(SftpRoute).GET({
      request: jobRequest("http://localhost/api/jobs/sftp"),
      params: {},
    })) as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      configured: false,
    });
  });

  test("the projection has only {host, port, path} and no @ ref or fingerprint", async () => {
    enableJobApiWithSftpServer();
    const response = (await handlersOf(SftpRoute).GET({
      request: jobRequest("http://localhost/api/jobs/sftp"),
      params: {},
    })) as Response;
    expect(response.status).toBe(200);

    const body = await response.text();
    // No credential reference and no fingerprint survives serialization.
    expect(body).not.toContain("@");
    expect(body).not.toContain("SHA256");

    const item = JSON.parse(body) as Record<string, unknown>;
    for (const key of Object.keys(item))
      expect([
        "configured",
        "host",
        "port",
        "path",
        "credentialWarnings",
      ]).toContain(key);
    expect(item).toEqual({
      configured: true,
      host: "sftp.example.org",
      port: 2222,
      path: "/exchange",
      // The armed credential lives outside the data root, so no warning.
      credentialWarnings: [],
    });
  });

  test("'sftp' can never be captured as a job id", async () => {
    // The traversal guard every $jobId route applies rejects the static
    // segment outright, so even a router that mis-ranked the routes could not
    // reach the filesystem with "sftp" as an id.
    expect(validateJobIdParam("sftp")).toBeNull();
    enableJobApi();
    const response = (await handlersOf(JobRoute).GET({
      request: jobRequest("http://localhost/api/jobs/sftp"),
      params: { jobId: "sftp" },
    })) as Response;
    expect(response.status).toBe(404);
  });
});

/** GET /api/jobs/rendezvous with a loopback Host. */
async function getRendezvous(): Promise<Response> {
  return (await handlersOf(RendezvousRoute).GET({
    request: jobRequest("http://localhost/api/jobs/rendezvous"),
    params: {},
  })) as Response;
}

describe("GET /api/jobs/rendezvous names the shared folder", () => {
  test("is 404 when the API is disabled", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    expect((await getRendezvous()).status).toBe(404);
  });

  test("has the launcher-passed folder name as both locator and name", async () => {
    enableJobApi();
    vi.stubEnv("JOB_RENDEZVOUS_NAME", "agency-a-agency-b");
    const response = await getRendezvous();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: true,
      sharesDataRoot: false,
      sharesDataRootUncertain: false,
      locator: "agency-a-agency-b",
      folderName: "agency-a-agency-b",
    });
  });

  test("names an operator-authored mount by its own last segment", async () => {
    const root = enableJobApi();
    const mount = path.join(root, "agency-drop");
    fs.mkdirSync(mount, { recursive: true });
    vi.stubEnv("JOB_RENDEZVOUS_DIR", mount);
    expect(await (await getRendezvous()).json()).toEqual({
      configured: true,
      // Nested INSIDE the data root rather than holding it: a partner's sync
      // reaches this folder, not the signing key in the folder above it.
      sharesDataRoot: false,
      sharesDataRootUncertain: false,
      locator: "agency-drop",
      folderName: "agency-drop",
    });
  });

  test("reports the shared layout when the rendezvous falls back to the data root", async () => {
    // The single-folder console: only JOB_DATA_ROOT is mounted, so the folder the
    // partner syncs IS the folder holding this party's signing key. The one fact
    // the console needs to tell that layout from a provisioned rendezvous.
    const root = enableJobApi();
    vi.stubEnv("JOB_RENDEZVOUS_DIR", "");
    const body = (await (await getRendezvous()).json()) as Record<
      string,
      unknown
    >;
    expect(body.configured).toBe(true);
    expect(body.sharesDataRoot).toBe(true);
    // The data-root fallback IS the leg, a lexical match rather than a default.
    expect(body.sharesDataRootUncertain).toBe(false);
    expect(JSON.stringify(body)).not.toContain(root);
  });

  test("reports the shared layout for a rendezvous mounted ABOVE the data root", async () => {
    // Not only the fallback: a rendezvous the operator pointed at a folder holding
    // the data root syncs the key just as the fallback does, so the fact follows
    // the containment rather than which variable resolved the mount.
    const root = enableJobApi();
    vi.stubEnv("JOB_DATA_ROOT", path.join(root, "work"));
    vi.stubEnv("JOB_RENDEZVOUS_DIR", root);
    const body = (await (await getRendezvous()).json()) as Record<
      string,
      unknown
    >;
    expect(body.configured).toBe(true);
    expect(body.sharesDataRoot).toBe(true);
    // A lexical containment match, not a default.
    expect(body.sharesDataRootUncertain).toBe(false);
  });

  test("reports a locator with no name where it cannot name the folder", async () => {
    enableJobApi();
    vi.stubEnv("JOB_RENDEZVOUS_NAME", "..");
    const body = (await (await getRendezvous()).json()) as Record<
      string,
      unknown
    >;
    expect(body.configured).toBe(true);
    expect(body.folderName).toBeUndefined();
    expect(typeof body.locator).toBe("string");
  });

  test("never includes the resolved mount path", async () => {
    const root = enableJobApi();
    const mount = path.join(root, "agency-drop");
    fs.mkdirSync(mount, { recursive: true });
    vi.stubEnv("JOB_RENDEZVOUS_DIR", mount);
    vi.stubEnv("JOB_RENDEZVOUS_NAME", "agency-a-agency-b");
    const body = await (await getRendezvous()).text();
    expect(body).not.toContain(mount);
    expect(body).not.toContain(root);
    // Not merely absent by value: no field has a path at all.
    expect(Object.keys(JSON.parse(body) as object)).toEqual([
      "configured",
      "sharesDataRoot",
      "sharesDataRootUncertain",
      "locator",
      "folderName",
    ]);
  });

  test("a split console reports both legs' names, and never either path", async () => {
    const root = enableJobApi();
    const inbound = path.join(root, "from-partner");
    const outbound = path.join(root, "to-partner");
    fs.mkdirSync(inbound, { recursive: true });
    fs.mkdirSync(outbound, { recursive: true });
    vi.stubEnv("JOB_RENDEZVOUS_DIR", inbound);
    vi.stubEnv("JOB_RENDEZVOUS_OUTBOUND_DIR", outbound);
    const body = await (await getRendezvous()).text();
    expect(JSON.parse(body)).toEqual({
      configured: true,
      sharesDataRoot: false,
      sharesDataRootUncertain: false,
      split: true,
      locator: "from-partner",
      folderName: "from-partner",
      outboundLocator: "to-partner",
      outboundFolderName: "to-partner",
    });
    expect(body).not.toContain(root);
  });

  test("a single-mount console names no outbound leg, whatever the name variable says", async () => {
    // A split body always has an outboundLocator, so a body that had one
    // without a second mount would announce a split this console cannot run. The
    // mount decides the shape; the name variable only names a leg that exists.
    const root = enableJobApi();
    const mount = path.join(root, "agency-drop");
    fs.mkdirSync(mount, { recursive: true });
    vi.stubEnv("JOB_RENDEZVOUS_DIR", mount);
    vi.stubEnv("JOB_RENDEZVOUS_OUTBOUND_NAME", "to-partner");
    expect(await (await getRendezvous()).json()).toEqual({
      configured: true,
      sharesDataRoot: false,
      sharesDataRootUncertain: false,
      locator: "agency-drop",
      folderName: "agency-drop",
    });
  });

  test("an incoherent pair reports unavailable WITH the remedy", async () => {
    const root = enableJobApi();
    const mount = path.join(root, "share");
    fs.mkdirSync(path.join(mount, "out"), { recursive: true });
    vi.stubEnv("JOB_RENDEZVOUS_DIR", mount);
    vi.stubEnv("JOB_RENDEZVOUS_OUTBOUND_DIR", path.join(mount, "out"));
    const body = (await (await getRendezvous()).json()) as Record<
      string,
      unknown
    >;
    expect(body.configured).toBe(false);
    expect(body.problem).toContain("JOB_RENDEZVOUS_OUTBOUND_DIR");
    // The reason names variables, never the console's own paths.
    expect(JSON.stringify(body)).not.toContain(root);
  });

  test("a pair that is one directory THROUGH A SYMLINK reports it too", async () => {
    // The mint side of the containment refusal: the client reads this body to
    // decide whether a filedrop invitation can be minted at all, so a symlinked
    // pair has to arrive here as unavailable exactly as a nested one does.
    const root = enableJobApi();
    const inbound = path.join(root, "from-partner");
    const outbound = path.join(root, "to-partner");
    fs.mkdirSync(inbound, { recursive: true });
    fs.symlinkSync(inbound, outbound, "dir");
    vi.stubEnv("JOB_RENDEZVOUS_DIR", inbound);
    vi.stubEnv("JOB_RENDEZVOUS_OUTBOUND_DIR", outbound);
    const body = (await (await getRendezvous()).json()) as Record<
      string,
      unknown
    >;
    expect(body.configured).toBe(false);
    expect(body.problem).toContain("read its own writes");
  });
});

/** GET /api/jobs/slot with a loopback Host, plus any extra headers. */
async function getSlot(
  headers: Record<string, string> = {},
): Promise<Response> {
  return (await handlersOf(SlotRoute).GET({
    request: jobRequest("http://localhost/api/jobs/slot", { headers }),
    params: {},
  })) as Response;
}

describe("GET /api/jobs/slot reports single-slot occupancy", () => {
  test("is 404 when the API is disabled", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    expect((await getSlot()).status).toBe(404);
  });

  test("a cross-origin browser request is 403 (shared gate)", async () => {
    enableJobApi();
    const response = await getSlot({ "sec-fetch-site": "cross-site" });
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("reports occupied:false when the slot is free", async () => {
    enableJobApi();
    const response = await getSlot();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ occupied: false });
  });

  test("reports occupied and the occupant id, and nothing else, while occupied", async () => {
    enableJobApi();
    const created = (await handlersOf(CreateRoute).POST({
      request: createRequest(validIntent()),
      params: {},
    })) as Response;
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const response = await getSlot();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    // Exactly `{ occupied, id }` crosses the boundary -- no run detail, no list.
    for (const key of Object.keys(body))
      expect(["occupied", "id"]).toContain(key);
    expect(body).toEqual({ occupied: true, id });
  });

  test("'slot' can never be captured as a job id", async () => {
    // The traversal guard every $jobId route applies rejects the static segment,
    // so even a mis-ranked router could not reach the filesystem with "slot".
    expect(validateJobIdParam("slot")).toBeNull();
    enableJobApi();
    const response = (await handlersOf(JobRoute).GET({
      request: jobRequest("http://localhost/api/jobs/slot"),
      params: { jobId: "slot" },
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
    request: jobRequest("http://localhost/api/jobs/sftp", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params: {},
  })) as Response;
}

async function getSftp(): Promise<Response> {
  return (await handlersOf(SftpRoute).GET({
    request: jobRequest("http://localhost/api/jobs/sftp"),
    params: {},
  })) as Response;
}

async function deleteSftp(): Promise<Response> {
  return (await handlersOf(SftpRoute).DELETE({
    request: jobRequest("http://localhost/api/jobs/sftp", {
      method: "DELETE",
    }),
    params: {},
  })) as Response;
}

/** A key no schema models, spelled with the control bytes that make echoing a
 * caller-chosen name a display hazard, and the value the caller sent beside it. */
const HOSTILE_KEY = "\u001b[31mremote_host\u0007";
const HOSTILE_VALUE = "prod_east";

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
      credentialWarnings: [],
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
      credentialWarnings: [],
    });
  });

  test("a credential ref inside the data root warns but authors, never echoing the ref", async () => {
    const dataRoot = enableJobApi();
    const ref = `${dataRoot}/planted/pw`;
    fs.mkdirSync(`${dataRoot}/planted`, { recursive: true });
    fs.writeFileSync(ref, "s3cret\n");
    const response = await putSftp(authoredBody(ref));
    expect(response.status).toBe(200);
    const body = await response.text();
    // The warning names the field and the directory only, never the reference.
    expect(body).not.toContain("@");
    expect(body).not.toContain(ref);
    const parsed = JSON.parse(body) as { credentialWarnings?: Array<string> };
    expect(parsed.credentialWarnings).toHaveLength(1);
    expect(parsed.credentialWarnings?.[0]).toContain("data root");
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
      credentialWarnings: [],
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

  test.each([
    {
      label: "an unmodeled connection key",
      overrides: (_ref: string) => ({ [HOSTILE_KEY]: HOSTILE_VALUE }),
      error: "connection: unrecognized key",
    },
    {
      label: "an unmodeled credential key",
      overrides: (ref: string) => ({
        credential: {
          kind: "ref",
          ref: `@${ref}`,
          credType: "password",
          [HOSTILE_KEY]: HOSTILE_VALUE,
        },
      }),
      error: "connection.credential: unrecognized key",
    },
  ])(
    "$label crosses the 400 as a fixed reason, never its own spelling",
    async ({ overrides, error }) => {
      // The schema's own unrecognized-key message quotes the submitted spelling,
      // which is how a key name with control bytes would reach the operator's
      // screen. This route takes the substitution from the same shared formatter
      // the probe and fingerprint routes do, so a fixed reason crosses instead.
      enableJobApi();
      const ref = secretFileOutside();
      const response = await putSftp(authoredBody(ref, overrides(ref)));
      expect(response.status).toBe(400);
      const text = await response.text();
      // Neither the key's spelling, its value, nor any other submitted byte.
      for (const fragment of [
        "remote_host",
        HOSTILE_VALUE,
        "authored.partner.example",
        TEST_HOST_KEY_FINGERPRINT,
        ref,
        "\u001b",
        "\u0007",
        "\\u001b",
        "\\u0007",
      ])
        expect(text).not.toContain(fragment);
      expect(JSON.parse(text)).toEqual({ error });
    },
  );

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
      credentialWarnings: [],
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
    const server = composedServer(composed);
    expect(server.host).toBe("authored.partner.example");
    expect(server.password).toBe(`@${ref}`);
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
      credentialWarnings: [],
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

/** One valid probe stdout line for the stub CLI's `probe-host-key` branch. */
function okProbeLine(keyType = "ssh-ed25519"): string {
  return (
    JSON.stringify({
      fingerprint: TEST_HOST_KEY_FINGERPRINT,
      key_type: keyType,
    }) + "\n"
  );
}

/** Seed the global manager with the stub CLI and a probe scenario in its childEnv
 * (the route's sanitized child env drops ambient STUB_* vars, so the scenario must
 * ride childEnv). Returns the manager. */
function seedManagerWithProbe(stubEnv: NodeJS.ProcessEnv): JobManager {
  const root = tempDataRoot("routes-probe");
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
  return manager;
}

async function postProbe(body: unknown): Promise<Response> {
  return (await handlersOf(SftpProbeRoute).POST({
    request: jobRequest("http://localhost/api/jobs/sftp/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params: {},
  })) as Response;
}

describe("POST /api/jobs/sftp/probe reads a host key without authoring", () => {
  test("is 404 when the API is disabled", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    const response = await postProbe({ host: "sftp.example.org" });
    expect(response.status).toBe(404);
  });

  test("a successful probe returns exactly the ok envelope", async () => {
    seedManagerWithProbe({ STUB_PROBE_STDOUT: okProbeLine() });
    const response = await postProbe({ host: "sftp.example.org", port: 2222 });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    // Only the fingerprint and key type cross the boundary -- no banner, latency,
    // or host list.
    for (const key of Object.keys(body))
      expect(["status", "fingerprint", "keyType"]).toContain(key);
    expect(body).toEqual({
      status: "ok",
      fingerprint: TEST_HOST_KEY_FINGERPRINT,
      keyType: "ssh-ed25519",
    });
  });

  test("exit 69 is a 200 unreachable envelope (a probe that ran but read no key)", async () => {
    seedManagerWithProbe({ STUB_EXIT_CODE: "69" });
    const response = await postProbe({ host: "sftp.example.org" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "unreachable" });
  });

  test("a diagnosed exit 69 has the peer answer and a bounded escaped excerpt", async () => {
    seedManagerWithProbe({
      STUB_EXIT_CODE: "69",
      STUB_PROBE_STDOUT:
        JSON.stringify({
          diagnosis: "non_ssh",
          shape: "http",
          excerpt: "HTTP/1.1 403 Forbidden\r\n",
        }) + "\n",
    });
    const response = await postProbe({ host: "sftp.example.org" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    // The widened envelope stays closed: these four keys and nothing else -- no
    // stderr, no latency, no host list.
    for (const key of Object.keys(body))
      expect([
        "status",
        "peerAnswer",
        "peerAnswerShape",
        "peerAnswerExcerpt",
      ]).toContain(key);
    expect(body.status).toBe("unreachable");
    expect(body.peerAnswer).toBe("nonSsh");
    expect(body.peerAnswerShape).toBe("http");
    // The peer's own bytes cross escaped: the CR/LF it sent is not a raw control
    // character in the response.
    expect(body.peerAnswerExcerpt).toBe("HTTP/1.1 403 Forbidden\\x0d\\x0a");
  });

  test("a peer that closed without identifying itself is reported as that, not as a bare unreachable", async () => {
    seedManagerWithProbe({
      STUB_EXIT_CODE: "69",
      STUB_PROBE_STDOUT: JSON.stringify({ diagnosis: "closed_unanswered" }),
    });
    const response = await postProbe({ host: "sftp.example.org" });
    expect(await response.json()).toEqual({
      status: "unreachable",
      peerAnswer: "closedUnanswered",
    });
  });

  test("a body with a credential-shaped field is a 400 (strict, no such field)", async () => {
    seedManagerWithProbe({ STUB_PROBE_STDOUT: okProbeLine() });
    const response = await postProbe({
      host: "sftp.example.org",
      username: "linkage",
      password: "@/etc/shadow",
    });
    expect(response.status).toBe(400);
    // Neither the value nor the key name is echoed: a key the submitter chose is
    // their bytes as much as a value is, so the message names a field shape only.
    const text = await response.text();
    for (const fragment of ["shadow", "username", "password"])
      expect(text).not.toContain(fragment);
  });

  test("an unmodeled key's own spelling never crosses the 400", async () => {
    // The schema's own unrecognized-key message quotes the submitted spelling,
    // which is how a key name with control bytes would reach the operator's
    // screen. What the caller has to know is that a key they sent is not modeled,
    // so a fixed reason crosses instead.
    seedManagerWithProbe({ STUB_PROBE_STDOUT: okProbeLine() });
    const response = await postProbe({
      host: "sftp.example.org",
      "\u001b[31mprivate_key\u0007": "x",
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain("private_key");
    // Neither the raw control bytes nor their JSON-escaped spelling.
    for (const fragment of ["\u001b", "\u0007", "\\u001b", "\\u0007"])
      expect(text).not.toContain(fragment);
    expect(JSON.parse(text)).toEqual({ error: "body: unrecognized key" });
  });

  test("a non-bare host is a 400 naming the field", async () => {
    seedManagerWithProbe({ STUB_PROBE_STDOUT: okProbeLine() });
    const response = await postProbe({ host: "sftp://user@evil/path" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("host");
  });

  test("a concurrent probe is a 409 (single-flight)", async () => {
    // A slow first probe holds the single slot; the concurrent second is refused.
    seedManagerWithProbe({
      STUB_PROBE_STDOUT: okProbeLine(),
      STUB_DELAY_MS: "500",
    });
    const first = postProbe({ host: "sftp.example.org" });
    // Give the first request time to claim the in-flight flag (spawn the child).
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = await postProbe({ host: "sftp.example.org" });
    expect(second.status).toBe(409);
    expect(await second.text()).toBe("");
    // Drain the first so no child outlives the test.
    expect((await first).status).toBe(200);
  });

  test("a probe never authors: GET /api/jobs/sftp is unchanged after it (invariant)", async () => {
    const manager = seedManagerWithProbe({ STUB_PROBE_STDOUT: okProbeLine() });
    authorSftpOn(manager);
    const before = await (await getSftp()).json();
    // A successful probe of a DIFFERENT host must not touch the authored entry.
    const probe = await postProbe({ host: "other.example" });
    expect((await probe.json()) as { status: string }).toMatchObject({
      status: "ok",
    });
    expect(await (await getSftp()).json()).toEqual(before);
  });

  test("a probe with no connection authored leaves GET at configured:false", async () => {
    seedManagerWithProbe({ STUB_EXIT_CODE: "69" });
    expect((await postProbe({ host: "sftp.example.org" })).status).toBe(200);
    expect(await (await getSftp()).json()).toEqual({ configured: false });
  });
});

describe("the shared rejected-body formatter", () => {
  test("an empty issue list is refused, never read through", () => {
    // A failed parse reports at least one issue. The guard is what keeps that
    // assumption correct: were it ever false, the formatter says so rather than
    // reading a property off nothing, so the message -- not a TypeError from the
    // read -- is what this asserts.
    expect(() => formatFirstIssue([])).toThrow(/no schema issue/);
  });

  test("an empty issue list is refused by formatIssues too, never read through", () => {
    expect(() => formatIssues([], "server")).toThrow(/no schema issue/);
  });
});

describe("PUT /api/jobs/sftp keeps the mandatory-pin safety check (invariant)", () => {
  test.each([
    ["an empty string", ""],
    ["an @-file reference", "@/x"],
    ["an empty list", [] as Array<string>],
  ])("a %s fingerprint is a 400", async (_label, value) => {
    enableJobApi();
    const ref = secretFileOutside();
    const response = await putSftp(
      authoredBody(ref, { hostKeyFingerprint: value }),
    );
    expect(response.status).toBe(400);
  });

  test("a missing fingerprint is a 400", async () => {
    enableJobApi();
    const ref = secretFileOutside();
    const body = authoredBody(ref) as Record<string, unknown>;
    delete body.hostKeyFingerprint;
    const response = await putSftp(body);
    expect(response.status).toBe(400);
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
  return jobRequest("http://localhost/api/jobs", {
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
    const request = jobRequest("http://localhost/api/jobs", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const result = await readJobRequestBody(request, bytes.byteLength);
    expect(result).toEqual({ kind: "parsed", value: { ok: true } });
  });

  test("an unparseable body is invalid", async () => {
    const request = jobRequest("http://localhost/api/jobs", {
      method: "POST",
      body: "}{ not json",
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const result = await readJobRequestBody(request, 1024);
    expect(result.kind).toBe("invalid");
  });

  test("a body holding an invalid UTF-8 byte is invalid, never parsed with U+FFFD substituted", async () => {
    // The bytes reach the bounded parse undecoded, so its UTF-8-fatal decode
    // rejects the body instead of a lenient decode handing the schema a name
    // the operator never sent.
    const bytes = Uint8Array.from([
      ...new TextEncoder().encode('{"host":"a'),
      0xff,
      ...new TextEncoder().encode('b"}'),
    ]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const request = jobRequest("http://localhost/api/jobs", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const result = await readJobRequestBody(request, 1024);
    expect(result.kind).toBe("invalid");
  });

  test("a body filling the authoring cap parses", async () => {
    // A body filling the authoring route's byte cap exactly: no realistic
    // authored body reaches the structural bounds the bounded parse also
    // enforces (object width, array length, nesting) within that byte cap. This
    // pins that the largest realistic body the cap admits still parses rather
    // than turning into a 400 -- the structural bound is documented on
    // JobRequestBodyResult in routeSupport.ts, and exercised directly next.
    const overhead = '{"field":""}'.length;
    const filled = "a".repeat(MAX_SFTP_AUTHOR_BODY_BYTES - overhead);
    const body = `{"field":"${filled}"}`;
    expect(new TextEncoder().encode(body).byteLength).toBe(
      MAX_SFTP_AUTHOR_BODY_BYTES,
    );
    const request = jobRequest("http://localhost/api/jobs", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const result = await readJobRequestBody(
      request,
      MAX_SFTP_AUTHOR_BODY_BYTES,
    );
    expect(result).toEqual({ kind: "parsed", value: { field: filled } });
  });

  test("a body under the byte cap but past the structural bound is invalid", async () => {
    // Nesting far deeper than any authored body, well inside the byte cap: the
    // structural rejection reaches the caller as `invalid` (400), never as a
    // thrown error escaping the route.
    const depth = 100_000;
    const request = jobRequest("http://localhost/api/jobs", {
      method: "POST",
      body: "[".repeat(depth) + "]".repeat(depth),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const result = await readJobRequestBody(request, MAX_JOB_BODY_BYTES);
    expect(result.kind).toBe("invalid");
  });

  test("the boundary cap clears a realistic schema-valid intent", () => {
    // Real CSV text barely grows under JSON string escaping (only newlines and
    // the rare quote escape), so a max-length inputCsv plus the other capped
    // fields stays well under the boundary cap and gets a clean schema error,
    // never a spurious 413. A pathological control-character payload that
    // inflates ~6x under \uXXXX escaping is not valid CSV and is bounded here by
    // design, so the cap is not sized to clear it.
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
    const request = jobRequest("http://localhost/api/jobs", {
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
