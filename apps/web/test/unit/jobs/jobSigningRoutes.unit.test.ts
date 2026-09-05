import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  JOB_FILE_NAMES,
  MAX_IDENTITY_LENGTH,
  jobZeroSetupIntentSchema,
} from "@jobs/intentSchemas";

import { JobManager, SigningFingerprintBusyError } from "@jobs/jobManager";
import {
  SIGNING_CERTIFICATE_FILE_NAME,
  SIGNING_IDENTITY_FILE_NAME,
} from "@jobs/signingIdentity";
import { MAX_SIGNING_FINGERPRINT_BODY_BYTES } from "@jobs/routeSupport";

import { Route as FingerprintRoute } from "../../../src/routes/api/jobs/signing/fingerprint";
import { Route as JobRoute } from "../../../src/routes/api/jobs/$jobId/index";
import { Route as ReceiptRoute } from "../../../src/routes/api/jobs/$jobId/receipt";

import {
  STUB_CLI_PATH,
  tempDataRoot,
  validIntent,
  validZeroSetupIntent,
} from "../../utils/jobFixtures";

import type { JobCreateIntent } from "@jobs/intentSchemas";

// The HTTP boundary of the console's signing surface: what the fingerprint route
// maps each condition to, what the receipt route will and will not serve, and
// what the status body says about a receipt at each of its three states. The
// route modules are exercised through their exported handlers, the way the rest
// of the job-route suite drives them, so the mappings the static job-route gate
// check cannot see are asserted here.

const roots: Array<string> = [];

beforeEach(() => {
  // The server-side job API runs only in a console build, so every enabled case
  // supplies the console profile; a disabled case relies on an empty
  // JOB_DATA_ROOT, which the profile does not re-enable.
  vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  const seeded = (globalThis as { jobManagerInstance?: JobManager })
    .jobManagerInstance;
  seeded?.shutdown();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
  (globalThis as { jobManagerInstance?: unknown }).jobManagerInstance =
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

/** A created directory registered for cleanup. */
function madeDir(label: string): string {
  const dir = tempDataRoot(label);
  roots.push(dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A job-API Request holding a loopback `Host`. A synthetic Request sets none,
 * and the gate's Host allowlist would 403 every route-driven case without it.
 */
function jobRequest(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("host")) headers.set("host", "localhost");
  return new Request(url, { ...init, headers });
}

/**
 * Seed the global manager pointed at the stub CLI, with the given scenario in its
 * childEnv (the route path's sanitized child env drops ambient STUB_* vars, so a
 * scenario must ride childEnv). Returns the manager and its data root.
 */
function seedManager(stubEnv: NodeJS.ProcessEnv = {}): {
  manager: JobManager;
  dataRoot: string;
} {
  const rendezvousDir = madeDir("signing-rvz");
  const dataRoot = madeDir("signing-data");
  vi.stubEnv("JOB_DATA_ROOT", dataRoot);
  vi.stubEnv("JOB_CLI_BINARY", STUB_CLI_PATH);
  const manager = new JobManager({
    dataRoot,
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: rendezvousDir,
    childEnv: { STUB_FD3_EVENTS: JSON.stringify([]), ...stubEnv },
  });
  (globalThis as { jobManagerInstance?: JobManager }).jobManagerInstance =
    manager;
  return { manager, dataRoot };
}

async function postFingerprint(
  body: unknown,
  init: RequestInit = {},
): Promise<Response> {
  return (await handlersOf(FingerprintRoute).POST({
    request: jobRequest("http://localhost/api/jobs/signing/fingerprint", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...init,
    }),
    params: {},
  })) as Response;
}

async function getReceipt(jobId: string): Promise<Response> {
  return (await handlersOf(ReceiptRoute).GET({
    request: jobRequest(`http://localhost/api/jobs/${jobId}/receipt`),
    params: { jobId },
  })) as Response;
}

describe("POST /api/jobs/signing/fingerprint maps each condition", () => {
  test("is 404 when the API is disabled, before any child could run", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    const response = await postFingerprint({ identity: "Agency A" });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  test("an oversized body is 413 (the tight cap, not the job-create one)", async () => {
    seedManager();
    const response = await postFingerprint({
      identity: "A".repeat(MAX_SIGNING_FINGERPRINT_BODY_BYTES + 1),
    });
    expect(response.status).toBe(413);
    expect(await response.text()).toBe("");
  });

  test("an unparseable body is an empty-bodied 400", async () => {
    seedManager();
    const response = (await handlersOf(FingerprintRoute).POST({
      request: jobRequest("http://localhost/api/jobs/signing/fingerprint", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "}{ not json",
      }),
      params: {},
    })) as Response;
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
  });

  test.each([
    { label: "an absent identity", body: {}, absent: [] },
    { label: "an empty identity", body: { identity: "" }, absent: [] },
    {
      label: "a leading-dash identity",
      body: { identity: "--force" },
      absent: ["--force"],
    },
    {
      label: "an unmodeled key",
      body: { identity: "Agency A", identityFile: "/etc/shadow" },
      absent: ["identityFile", "shadow"],
    },
    {
      label: "a path-shaped extra",
      body: {
        identity: "Agency A",
        exportPath: "/data/.psilink-signing-identity.json",
      },
      absent: ["exportPath", SIGNING_IDENTITY_FILE_NAME],
    },
    {
      label: "an export toggle that is not a boolean",
      body: { identity: "A", exportCertificate: "yes" },
      absent: ["yes"],
    },
  ])(
    "$label is a 400 naming a field and no value",
    async ({ body, absent }) => {
      seedManager();
      const response = await postFingerprint(body);
      expect(response.status).toBe(400);
      const text = await response.text();
      // The message is a field path and a shape reason. Neither a submitted value
      // nor a client-CHOSEN key name is echoed: an unrecognized key crosses as a
      // fixed reason, since the key name is the submitter's bytes as much as the
      // value is.
      for (const fragment of absent) expect(text).not.toContain(fragment);
      expect(JSON.parse(text)).toMatchObject({ error: expect.any(String) });
    },
  );

  test("a control character in the identity is a 400 before any child is spawned", async () => {
    // What this route binds the label into is a long-lived certificate the partner
    // pins and displays, and rebinding it costs a `--force` re-key and a re-pin by
    // every partner -- so a stray byte is caught on the way in. A NUL would
    // otherwise be refused only incidentally, where the child is spawned.
    for (const code of [0x00, 0x07, 0x09, 0x0a, 0x0d, 0x1b, 0x7f, 0x9b]) {
      const { dataRoot } = seedManager();
      const identity = `Agency${String.fromCharCode(code)}A`;
      const response = await postFingerprint({ identity });
      expect(response.status).toBe(400);
      // A field path and a shape reason: no part of the submitted label crosses.
      const text = await response.text();
      expect(text).not.toContain("Agency");
      expect(JSON.parse(text)).toMatchObject({ error: expect.any(String) });
      // The stub CLI creates the identity file, so its absence proves no child ran.
      expect(
        fs.existsSync(path.join(dataRoot, SIGNING_IDENTITY_FILE_NAME)),
      ).toBe(false);
    }
  });

  test("the zero-setup intent refuses exactly what this route refuses", async () => {
    // Both boundaries take the label rule from the one shared contract, so neither
    // can come to admit a label the other refuses -- which is the whole reason the
    // rule is not spelled twice.
    seedManager();
    for (const code of [0x00, 0x09, 0x1b, 0x7f, 0x9b]) {
      const identity = `Agency${String.fromCharCode(code)}A`;
      expect((await postFingerprint({ identity })).status).toBe(400);
      expect(
        jobZeroSetupIntentSchema.safeParse(validZeroSetupIntent({ identity }))
          .success,
      ).toBe(false);
    }
    for (const identity of ["Agency A", "Agencia Española"]) {
      expect((await postFingerprint({ identity })).status).toBe(200);
      expect(
        jobZeroSetupIntentSchema.safeParse(validZeroSetupIntent({ identity }))
          .success,
      ).toBe(true);
    }
  });

  test("an identity written in the operator's own script binds normally", async () => {
    // The rule bounds control characters, not the operator's alphabet. A party
    // name that cannot be spelled in ASCII reaches the child as one argv token.
    seedManager();
    const response = await postFingerprint({
      identity: "Agencia Española de Protección de Datos",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  test("an over-long identity is a 400 before any child is spawned", async () => {
    const { dataRoot } = seedManager();
    const identity = "A".repeat(MAX_IDENTITY_LENGTH + 1);
    // One character past the schema's cap and still well under the byte cap, so
    // the 400 is the schema's and could not be the 413 in disguise.
    expect(JSON.stringify({ identity }).length).toBeLessThan(
      MAX_SIGNING_FINGERPRINT_BODY_BYTES,
    );
    const response = await postFingerprint({ identity });
    expect(response.status).toBe(400);
    // The stub CLI creates the identity file, so its absence proves no child ran.
    expect(fs.existsSync(path.join(dataRoot, SIGNING_IDENTITY_FILE_NAME))).toBe(
      false,
    );
  });

  test("a completed attempt is a 200 whose envelope has names, never paths", async () => {
    const { dataRoot } = seedManager();
    const response = await postFingerprint({ identity: "Agency A" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    // No container location crosses: neither the mount nor the identity path.
    expect(text).not.toContain(dataRoot);
    const body = JSON.parse(text) as Record<string, unknown>;
    for (const key of Object.keys(body))
      expect([
        "status",
        "fingerprint",
        "created",
        "identityFileName",
      ]).toContain(key);
    expect(body).toMatchObject({
      status: "ok",
      created: true,
      identityFileName: SIGNING_IDENTITY_FILE_NAME,
    });
    expect(typeof body.fingerprint).toBe("string");
    // No export was asked for, so the envelope names no certificate file.
    expect("certificateFileName" in body).toBe(false);
  });

  test("a second attempt reports created:false, and an export adds one name", async () => {
    const { dataRoot } = seedManager();
    expect((await postFingerprint({ identity: "Agency A" })).status).toBe(200);
    const response = await postFingerprint({
      identity: "Agency A",
      exportCertificate: true,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      created: false,
      identityFileName: SIGNING_IDENTITY_FILE_NAME,
      certificateFileName: SIGNING_CERTIFICATE_FILE_NAME,
    });
    // The name the envelope gave is a file that is really there.
    expect(
      fs.existsSync(path.join(dataRoot, SIGNING_CERTIFICATE_FILE_NAME)),
    ).toBe(true);
  });

  test("the CLI's exit 64 is a 200 refused envelope, not an HTTP failure", async () => {
    // A refusal is an attempt that RAN, so the client reads it off the body the
    // way it reads a success -- and the envelope has the category alone.
    seedManager({ STUB_EXIT_CODE: "64" });
    const response = await postFingerprint({ identity: "Agency A" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "refused" });
  });

  test("any other non-zero exit is a 200 error envelope", async () => {
    seedManager({ STUB_EXIT_CODE: "69" });
    const response = await postFingerprint({ identity: "Agency A" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "error" });
  });

  test("a watchdog kill crosses as the timeout category and nothing else", async () => {
    // The driver's own watchdog is minutes-scale against this suite, so the
    // manager stands in for a child that outlived it; what is under test here is
    // that the route reports the category as a 200 body rather than a 504.
    const { manager } = seedManager();
    vi.spyOn(manager, "resolveSigningFingerprint").mockResolvedValue({
      kind: "timeout",
    });
    const response = await postFingerprint({ identity: "Agency A" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "timeout" });
  });

  test("a concurrent request is an empty-bodied 409", async () => {
    const { manager } = seedManager();
    vi.spyOn(manager, "resolveSigningFingerprint").mockRejectedValue(
      new SigningFingerprintBusyError(),
    );
    const response = await postFingerprint({ identity: "Agency A" });
    expect(response.status).toBe(409);
    expect(await response.text()).toBe("");
  });

  test("single-flight is the manager's, so a real concurrent pair is a 409", async () => {
    seedManager({ STUB_DELAY_MS: "500" });
    const first = postFingerprint({ identity: "Agency A" });
    // Let the first request claim the in-flight flag (spawn its child).
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = await postFingerprint({ identity: "Agency A" });
    expect(second.status).toBe(409);
    expect((await first).status).toBe(200);
  });

  test("an unexpected internal fault is an empty-bodied 500, with no detail", async () => {
    const { manager } = seedManager();
    vi.spyOn(manager, "resolveSigningFingerprint").mockRejectedValue(
      new Error("ENOENT: /srv/appliance/data/.psilink-signing-identity.json"),
    );
    const response = await postFingerprint({ identity: "Agency A" });
    expect(response.status).toBe(500);
    // Nothing about the fault crosses the boundary -- not the message, not the path.
    expect(await response.text()).toBe("");
  });
});

/** A canonical 43-character fingerprint (the final character drawn from the
 * aligned set the config schema requires), for the certificate-mode default
 * {@link createSettledJob} composes -- a pin is required to compose a
 * certificate-mode config at all, so a job this suite settles needs one on file
 * whether or not the test asserts anything about it. */
const PARTNER_FINGERPRINT = "C".repeat(42) + "A";

/**
 * Create a certificate-mode job on a freshly seeded manager and resolve its id
 * once the run has settled, so the receipt route sees a job whose child is done.
 */
async function createSettledJob(
  stubEnv: NodeJS.ProcessEnv = {},
  intent: JobCreateIntent = validIntent({
    signing: { mode: "certificate", partnerFingerprint: PARTNER_FINGERPRINT },
  }),
): Promise<{ manager: JobManager; id: string }> {
  const { manager } = seedManager({ STUB_OUTPUT_FILE: "id\n1\n", ...stubEnv });
  const id = await manager.createJob(intent);
  const deadline = Date.now() + 5000;
  for (;;) {
    const record = manager.getJob(id);
    if (record !== undefined && record.terminal !== null)
      return { manager, id };
    if (Date.now() > deadline)
      throw new Error("timed out waiting for the job to settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Write the receipt the CLI would have written for a certificate-mode run, at
 * the server-chosen path, and return that path. */
function seedReceipt(manager: JobManager, id: string, body: string): string {
  const receiptPath = manager.getJobView(id)!.receiptPath!;
  fs.writeFileSync(receiptPath, body);
  return receiptPath;
}

const RECEIPT_JSON = JSON.stringify({ version: 1, summary: "test" });

describe("GET /api/jobs/:jobId/receipt serves only a workdir-contained receipt", () => {
  test("is 404 when the API is disabled", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    const response = await getReceipt("00000000-0000-4000-8000-000000000000");
    expect(response.status).toBe(404);
  });

  test.each([["../../etc/passwd"], ["not-a-uuid"], [""], ["receipt"]])(
    "a crafted job id (%s) is 404 before any filesystem use",
    async (jobId) => {
      seedManager();
      expect((await getReceipt(jobId)).status).toBe(404);
    },
  );

  test("an unknown job id is 404", async () => {
    seedManager();
    expect(
      (await getReceipt("00000000-0000-4000-8000-000000000000")).status,
    ).toBe(404);
  });

  test("a run that signed nothing has no receipt path at all, so a planted file is still 404", async () => {
    const { manager, id } = await createSettledJob({}, validIntent());
    const view = manager.getJobView(id)!;
    expect(view.receiptPath).toBeNull();
    // Planting the file a signed run would have written does not make it
    // servable: a run that asked for no receipt has none to serve.
    fs.writeFileSync(
      path.join(process.env.JOB_DATA_ROOT!, id, JOB_FILE_NAMES.receipt),
      RECEIPT_JSON,
    );
    expect((await getReceipt(id)).status).toBe(404);
  });

  test("a signed run whose receipt never landed is 404, not an empty 200", async () => {
    const { manager, id } = await createSettledJob();
    expect(manager.getJobView(id)!.receiptPath).not.toBeNull();
    expect((await getReceipt(id)).status).toBe(404);
  });

  test("a written receipt is served as a private JSON attachment from inside the workdir", async () => {
    const { manager, id } = await createSettledJob();
    const receiptPath = seedReceipt(manager, id, RECEIPT_JSON);
    // The served path is the workdir's own, not one derived from the request.
    expect(path.dirname(receiptPath)).toBe(
      path.join(process.env.JOB_DATA_ROOT!, id),
    );
    expect(path.basename(receiptPath)).toBe(JOB_FILE_NAMES.receipt);

    const response = await getReceipt(id);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("content-disposition")).toContain(
      "psilink-receipt.json",
    );
    expect(JSON.parse(await response.text())).toEqual({
      version: 1,
      summary: "test",
    });
  });

  test("a run that did NOT succeed still serves its receipt", async () => {
    // The receipt is written from the mutually-verifiable facts once the
    // signature swap completes, so it survives an exit the local record build did
    // not -- a persistence-loss exit is exactly the run whose receipt matters
    // most. Gating on success would withhold it.
    const { manager, id } = await createSettledJob({ STUB_EXIT_CODE: "73" });
    expect(manager.getJob(id)?.status).not.toBe("succeeded");
    seedReceipt(manager, id, RECEIPT_JSON);
    expect((await getReceipt(id)).status).toBe(200);
  });
});

describe("the status body reports the receipt in three states", () => {
  /** The status body's two receipt fields, as a client watching for the receipt
   * reads them. */
  async function receiptStatusOf(
    id: string,
  ): Promise<{ receiptRequested: boolean; receiptAvailable: boolean }> {
    const response = (await handlersOf(JobRoute).GET({
      request: jobRequest(`http://localhost/api/jobs/${id}`),
      params: { jobId: id },
    })) as Response;
    return (await response.json()) as {
      receiptRequested: boolean;
      receiptAvailable: boolean;
    };
  }

  test("a signed run says all along that a receipt is coming, and reports it once it lands", async () => {
    const { manager, id } = await createSettledJob();
    expect(await receiptStatusOf(id)).toMatchObject({
      receiptRequested: true,
      receiptAvailable: false,
    });
    seedReceipt(manager, id, RECEIPT_JSON);
    expect(await receiptStatusOf(id)).toMatchObject({
      receiptRequested: true,
      receiptAvailable: true,
    });
  });

  test("an unsigned run says outright that no receipt is coming", async () => {
    // Both fields answer from the receipt path the server set at creation from
    // the intent, so a client is told the receipt never arrives rather than left
    // to read a false availability as "not yet".
    const { id } = await createSettledJob({}, validIntent());
    expect(await receiptStatusOf(id)).toMatchObject({
      receiptRequested: false,
      receiptAvailable: false,
    });
  });

  test("mode none is an unsigned run, not a signed one whose receipt is missing", async () => {
    const { id } = await createSettledJob(
      {},
      validIntent({ signing: { mode: "none" } }),
    );
    expect(await receiptStatusOf(id)).toMatchObject({
      receiptRequested: false,
      receiptAvailable: false,
    });
  });
});
