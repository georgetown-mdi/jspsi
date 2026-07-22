import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  HANDOFF_CREDENTIAL_PATH_PLACEHOLDER,
  HANDOFF_PASSPHRASE_PATH_PLACEHOLDER,
  HANDOFF_SHARED_DIRECTORY_PLACEHOLDER,
  HANDOFF_SHARED_DIRECTORY_URL_PLACEHOLDER,
  buildJobHandoff,
} from "@jobs/handoff";
import {
  parseHandoff,
  shellJoinCommand,
  windowsJoinCommand,
} from "@psi/recurringHandoff";
import { JobManager } from "@jobs/jobManager";

import { Route as CreateRoute } from "../../src/routes/api/jobs/index";
import { Route as HandoffRoute } from "../../src/routes/api/jobs/$jobId/handoff";

import {
  STUB_CLI_PATH,
  TEST_HOST_KEY_FINGERPRINT,
  tempDataRoot,
  testSftpServerEntry,
  validIntent,
  validSftpIntent,
  validZeroSetupIntent,
  validZeroSetupSftpIntent,
} from "../utils/jobFixtures";

import type { JobManager as JobManagerType } from "@jobs/jobManager";

type Handlers = Record<
  string,
  (ctx: { request: Request; params: Record<string, string> }) => unknown
>;

/** Extract a route's plain handlers object, mirroring the jobRoutes suite: the
 * generated route type does not expose the method keys directly. */
function handlersOf(route: {
  options: { server?: { handlers?: unknown } };
}): Handlers {
  const handlers = route.options.server?.handlers;
  if (typeof handlers !== "object" || handlers === null)
    throw new Error("route exposes no plain handlers object");
  return handlers as Handlers;
}

// A schema-valid shared secret (43 base64url chars, final char aligned to the
// 32-byte length) distinct from the all-`A` host-key fingerprint, so an
// "absent-from-the-template" assertion is not accidentally satisfied (or defeated)
// by the fingerprint's own base64 run.
const DISTINCT_SECRET = "b".repeat(42) + "A";
// The real container-internal credential @path the sample sftp entry carries; the
// hand-off must replace it with the placeholder, never emit it.
const CONTAINER_CREDENTIAL_PATH = "@/etc/psilink/prod-east-password";

describe("buildJobHandoff composes a portable, secret-free template", () => {
  test("an sftp exchange fills in the connection and pins, and placeholders the credential", () => {
    const handoff = buildJobHandoff(
      validSftpIntent({ sharedSecret: DISTINCT_SECRET }),
      testSftpServerEntry(),
      false,
    );
    expect(handoff.mode).toBe("exchange");
    expect(handoff.channel).toBe("sftp");
    expect(handoff.usedKeyFile).toBe(true);
    expect(handoff.credentialPasted).toBe(false);
    expect(handoff.template.kind).toBe("config");
    const yaml =
      handoff.template.kind === "config" ? handoff.template.yaml : "";
    // The portable identity, pin, and linkage terms are the values that ran.
    expect(yaml).toContain("sftp.example.org");
    expect(yaml).toContain("linkage");
    expect(yaml).toContain(TEST_HOST_KEY_FINGERPRINT);
    expect(yaml).toContain("test-org");
    // The credential path is the placeholder, never the container path.
    expect(yaml).toContain(HANDOFF_CREDENTIAL_PATH_PLACEHOLDER);
    expect(yaml).not.toContain(CONTAINER_CREDENTIAL_PATH);
    // No shared secret or key-file material rides the config template.
    expect(yaml).not.toContain(DISTINCT_SECRET);
    expect(yaml.toLowerCase()).not.toContain("secret");
  });

  test("an sftp exchange placeholders a private-key passphrase distinctly", () => {
    const handoff = buildJobHandoff(
      validSftpIntent(),
      {
        host: "sftp.example.org",
        hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
        privateKey: "@/etc/psilink/id_ed25519",
        privateKeyPassphrase: "@/etc/psilink/passphrase",
      },
      false,
    );
    const yaml =
      handoff.template.kind === "config" ? handoff.template.yaml : "";
    expect(yaml).toContain(HANDOFF_CREDENTIAL_PATH_PLACEHOLDER);
    expect(yaml).toContain(HANDOFF_PASSPHRASE_PATH_PLACEHOLDER);
    expect(yaml).not.toContain("id_ed25519");
    expect(yaml).not.toContain("/etc/psilink/passphrase");
  });

  test("a filedrop exchange placeholders the shared directory path", () => {
    const handoff = buildJobHandoff(validIntent(), undefined, false);
    expect(handoff.channel).toBe("filedrop");
    expect(handoff.usedKeyFile).toBe(true);
    const yaml =
      handoff.template.kind === "config" ? handoff.template.yaml : "";
    expect(yaml).toContain("filedrop");
    expect(yaml).toContain(HANDOFF_SHARED_DIRECTORY_PLACEHOLDER);
  });

  test("an sftp zero-setup run composes a command with placeholder credential", () => {
    const handoff = buildJobHandoff(
      validZeroSetupSftpIntent(),
      testSftpServerEntry(),
      false,
    );
    expect(handoff.mode).toBe("zeroSetup");
    expect(handoff.usedKeyFile).toBe(false);
    expect(handoff.template.kind).toBe("command");
    const argv =
      handoff.template.kind === "command" ? handoff.template.argv : [];
    const line = shellJoinCommand(argv);
    expect(argv[0]).toBe("psilink");
    expect(line).toContain("sftp://sftp.example.org");
    expect(line).toContain(
      `--server-host-key-fingerprint=${TEST_HOST_KEY_FINGERPRINT}`,
    );
    expect(line).toContain(
      `--server-password=${HANDOFF_CREDENTIAL_PATH_PLACEHOLDER}`,
    );
    expect(line).not.toContain(CONTAINER_CREDENTIAL_PATH);
    expect(argv.slice(-2)).toEqual(["input.csv", "results.csv"]);
  });

  test("a filedrop zero-setup run composes a placeholder file:// locator command", () => {
    const handoff = buildJobHandoff(validZeroSetupIntent(), undefined, false);
    expect(handoff.mode).toBe("zeroSetup");
    const argv =
      handoff.template.kind === "command" ? handoff.template.argv : [];
    expect(argv).toContain(HANDOFF_SHARED_DIRECTORY_URL_PLACEHOLDER);
    expect(argv.slice(-2)).toEqual(["input.csv", "results.csv"]);
  });

  test("credentialPasted is carried for an sftp run but forced false for filedrop", () => {
    expect(
      buildJobHandoff(validSftpIntent(), testSftpServerEntry(), true)
        .credentialPasted,
    ).toBe(true);
    // A filedrop run carries no credential, so a stray pasted flag never surfaces.
    expect(
      buildJobHandoff(validIntent(), undefined, true).credentialPasted,
    ).toBe(false);
  });
});

describe("parseHandoff and shellJoinCommand (browser reader)", () => {
  test("a well-formed config hand-off round-trips", () => {
    const parsed = parseHandoff({
      mode: "exchange",
      channel: "sftp",
      usedKeyFile: true,
      credentialPasted: false,
      template: { kind: "config", yaml: "connection:\n  channel: sftp\n" },
    });
    expect(parsed?.template.kind).toBe("config");
  });

  test("a malformed hand-off is null (fail-safe)", () => {
    expect(parseHandoff(null)).toBeNull();
    expect(parseHandoff({ mode: "bogus" })).toBeNull();
    expect(
      parseHandoff({
        mode: "exchange",
        channel: "sftp",
        usedKeyFile: true,
        credentialPasted: false,
        template: { kind: "command", argv: [1, 2] },
      }),
    ).toBeNull();
  });

  test("shellJoinCommand quotes a token with spaces and leaves safe tokens bare", () => {
    expect(
      shellJoinCommand([
        "psilink",
        "--identity=Sample County Health",
        "input.csv",
      ]),
    ).toBe("psilink '--identity=Sample County Health' input.csv");
  });

  test("windowsJoinCommand double-quotes a spaced token for cmd and leaves safe tokens bare", () => {
    expect(
      windowsJoinCommand(["psilink", "--identity=Agency A", "input.csv"]),
    ).toBe('psilink "--identity=Agency A" input.csv');
    // A token bearing a literal double quote is wrapped with the inner quote doubled.
    expect(windowsJoinCommand(['a"b'])).toBe('"a""b"');
  });
});

// The endpoint tests below drive the real route handler against a seeded manager.
const roots: Array<string> = [];

beforeEach(() => {
  vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
});

afterEach(() => {
  vi.unstubAllEnvs();
  const seeded = (globalThis as { jobManagerInstance?: JobManagerType })
    .jobManagerInstance;
  seeded?.shutdown();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
  (globalThis as { jobManagerInstance?: unknown }).jobManagerInstance =
    undefined;
});

function rendezvousRoot(): string {
  const dir = tempDataRoot("handoff-rvz");
  roots.push(dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Enable the API and seed a manager pointed at the stub CLI (a long delay keeps
 * the child running so the record -- and its hand-off -- exists to query). */
function seedManager(): JobManager {
  const root = tempDataRoot("handoff-data");
  roots.push(root);
  vi.stubEnv("JOB_DATA_ROOT", root);
  const manager = new JobManager({
    dataRoot: root,
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: rendezvousRoot(),
    childEnv: { STUB_FD3_EVENTS: JSON.stringify([]), STUB_DELAY_MS: "5000" },
  });
  (globalThis as { jobManagerInstance?: JobManager }).jobManagerInstance =
    manager;
  return manager;
}

/** Author a real file-reference sftp connection outside the roots, returning the
 * credential `@path` the composed job config would carry. */
function armSftp(manager: JobManager): string {
  const dir = tempDataRoot("handoff-secret");
  roots.push(dir);
  fs.mkdirSync(dir, { recursive: true });
  const secretPath = path.join(dir, "password");
  fs.writeFileSync(secretPath, "s3cret\n");
  manager.authorSftpServer({
    host: "sftp.example.org",
    port: 2222,
    username: "linkage",
    path: "/exchange",
    hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
    credential: { kind: "ref", ref: `@${secretPath}`, credType: "password" },
  });
  return `@${secretPath}`;
}

async function getHandoff(jobId: string): Promise<Response> {
  return (await handlersOf(HandoffRoute).GET({
    request: new Request(`http://localhost/api/jobs/${jobId}/handoff`),
    params: { jobId },
  })) as Response;
}

async function createJob(body: unknown): Promise<string> {
  const created = (await handlersOf(CreateRoute).POST({
    request: new Request("http://localhost/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params: {},
  })) as Response;
  const { id } = (await created.json()) as { id: string };
  return id;
}

describe("GET /api/jobs/:jobId/handoff", () => {
  test("is 404 when the API is disabled", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    const response = await getHandoff("00000000-0000-4000-8000-000000000000");
    expect(response.status).toBe(404);
  });

  test("a malformed job id is 404 before any lookup", async () => {
    seedManager();
    const response = await getHandoff("../../etc/passwd");
    expect(response.status).toBe(404);
  });

  test("an unknown job id is a clean 404", async () => {
    seedManager();
    const response = await getHandoff("11111111-1111-4111-8111-111111111111");
    expect(response.status).toBe(404);
  });

  test("an sftp exchange job returns a placeholdered, secret-free config", async () => {
    const manager = seedManager();
    const credentialRef = armSftp(manager);
    const id = await createJob(
      validSftpIntent({ sharedSecret: DISTINCT_SECRET }),
    );

    const response = await getHandoff(id);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    // The wire body carries no credential path and no shared secret.
    expect(body).not.toContain(credentialRef);
    expect(body).not.toContain(DISTINCT_SECRET);
    const parsed = parseHandoff(JSON.parse(body));
    expect(parsed?.mode).toBe("exchange");
    expect(parsed?.channel).toBe("sftp");
    expect(parsed?.usedKeyFile).toBe(true);
    const yaml = parsed?.template.kind === "config" ? parsed.template.yaml : "";
    expect(yaml).toContain("sftp.example.org");
    expect(yaml).toContain(TEST_HOST_KEY_FINGERPRINT);
    expect(yaml).toContain(HANDOFF_CREDENTIAL_PATH_PLACEHOLDER);
  });

  test("a filedrop exchange job returns a placeholdered shared-directory config", async () => {
    const manager = seedManager();
    const id = await createJob(validIntent());
    // The composed run config points at the real rendezvous mount; the hand-off
    // must not echo it.
    const rendezvous = manager.getJob(id)!.workdir;
    const response = await getHandoff(id);
    const parsed = parseHandoff(await response.json());
    expect(parsed?.channel).toBe("filedrop");
    const yaml = parsed?.template.kind === "config" ? parsed.template.yaml : "";
    expect(yaml).toContain(HANDOFF_SHARED_DIRECTORY_PLACEHOLDER);
    expect(yaml).not.toContain(path.dirname(rendezvous));
  });

  test("a zero-setup sftp job returns a command with a placeholder credential", async () => {
    const manager = seedManager();
    const credentialRef = armSftp(manager);
    const id = await createJob(validZeroSetupSftpIntent());
    const response = await getHandoff(id);
    const body = await response.text();
    expect(body).not.toContain(credentialRef);
    const parsed = parseHandoff(JSON.parse(body));
    expect(parsed?.mode).toBe("zeroSetup");
    const argv =
      parsed?.template.kind === "command" ? parsed.template.argv : [];
    const line = shellJoinCommand(argv);
    expect(line).toContain("sftp://sftp.example.org");
    expect(line).toContain(
      `--server-password=${HANDOFF_CREDENTIAL_PATH_PLACEHOLDER}`,
    );
  });

  test("a zero-setup filedrop job returns a placeholder file:// command", async () => {
    seedManager();
    const id = await createJob(validZeroSetupIntent());
    const response = await getHandoff(id);
    const parsed = parseHandoff(await response.json());
    const argv =
      parsed?.template.kind === "command" ? parsed.template.argv : [];
    expect(argv).toContain(HANDOFF_SHARED_DIRECTORY_URL_PLACEHOLDER);
  });
});
