import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { getDefaultLinkageTerms, snakeizeKeys } from "@alcove/core";

import { Route as ConfigRoute } from "../../../src/routes/api/jobs/config";

import { STUB_CLI_PATH } from "../../utils/jobFixtures";

// The mount load's route: the shared gate, the absent-file answer, the refusal
// status, and that nothing it answers with holds a credential.

const dirs: Array<string> = [];

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `alcove-${label}-`));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  // The route reads through the memoized manager, which holds the data root it
  // was built with; each test enables its own.
  (
    globalThis as { jobManagerInstance?: { shutdown: () => void } }
  ).jobManagerInstance?.shutdown();
  (globalThis as { jobManagerInstance?: unknown }).jobManagerInstance =
    undefined;
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
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

/** Enable the job API (console build + data root). Returns the data root. */
function enable(): string {
  const dataRoot = tempDir("config-data");
  vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
  vi.stubEnv("JOB_DATA_ROOT", dataRoot);
  vi.stubEnv("JOB_CLI_BINARY", STUB_CLI_PATH);
  return dataRoot;
}

async function load(): Promise<Response> {
  return (await handlersOf(ConfigRoute).GET({
    // A synthetic Request sets no Host; the gate's loopback allowlist needs one.
    request: new Request("http://localhost/api/jobs/config", {
      headers: { host: "localhost" },
    }),
    params: {},
  })) as Response;
}

function writeConfiguration(dataRoot: string, document: unknown): void {
  fs.writeFileSync(
    path.join(dataRoot, "alcove.yaml"),
    stringifyYaml(document),
    "utf8",
  );
}

function savedSftpDocument(): unknown {
  return snakeizeKeys({
    connection: {
      channel: "sftp",
      server: {
        host: "sftp.partner.example",
        username: "county",
        password: "@/run/secrets/sftp-password",
        hostKeyFingerprint:
          "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA",
      },
    },
    linkageTerms: getDefaultLinkageTerms("County Health"),
  });
}

describe("GET /api/jobs/config", () => {
  test("is 404 when the API is disabled", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    expect((await load()).status).toBe(404);
  });

  test("a mount holding no configuration answers present: false", async () => {
    enable();
    const response = await load();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: true,
      present: false,
      carriedThrough: [],
      warnings: [],
    });
  });

  test("a mounted configuration answers its authoring fields", async () => {
    const dataRoot = enable();
    writeConfiguration(dataRoot, savedSftpDocument());
    const response = await load();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      present: boolean;
      warnings: Array<string>;
      document: { server: { host: string } };
    };
    expect(body.present).toBe(true);
    expect(body.document.server.host).toBe("sftp.partner.example");
    expect(body.warnings).toEqual(["connection.server.password"]);
  });

  test("no credential reference appears in the response body", async () => {
    const dataRoot = enable();
    writeConfiguration(dataRoot, savedSftpDocument());
    expect(await (await load()).text()).not.toContain("@/run/secrets");
  });

  test("a configuration the console cannot open is a 400 naming the setting", async () => {
    const dataRoot = enable();
    writeConfiguration(dataRoot, {
      connection: { channel: "filedrop", path: "/drop" },
      linkage_terms: snakeizeKeys(getDefaultLinkageTerms("County Health")),
      retian_disposition: "typo",
    });
    const response = await load();
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toEqual({
      error: expect.stringContaining("retian_disposition"),
    });
  });

  test("a document nested past the parse bounds is a 400, not a throw", async () => {
    // The bound is raised by the case conversion ahead of the schema, so the
    // handler answers it as the refusal it is rather than letting the
    // framework turn it into a 500.
    const dataRoot = enable();
    let nested: Record<string, unknown> = { host: "sftp.partner.example" };
    for (let depth = 0; depth < 300; depth += 1) nested = { server: nested };
    writeConfiguration(dataRoot, { connection: nested });
    const response = await load();
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("not an Alcove exchange configuration");
    expect(body.error).not.toContain("sftp.partner.example");
  });

  test("an over-large mounted file is a 400 naming no container path", async () => {
    const dataRoot = enable();
    fs.writeFileSync(path.join(dataRoot, "alcove.yaml"), "x".repeat(1_000_001));
    const response = await load();
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("too large");
    expect(body.error).not.toContain(dataRoot);
  });
});

async function handBack(body: unknown): Promise<Response> {
  return (await handlersOf(ConfigRoute).PUT({
    request: new Request("http://localhost/api/jobs/config", {
      method: "PUT",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params: {},
  })) as Response;
}

/** Obviously fake credential values, one per place a webrtc connection holds
 * one, so a search of a response body can find any that leaked. */
const WEBRTC_CREDENTIALS = {
  brokerKey: "fake-broker-key-for-tests",
  turnCredential: "fake-turn-credential-for-tests",
  iceBearer: "fake-ice-bearer-for-tests",
  providerOptionPath: "@/run/secrets/fake-provider-option",
};

/** Two webrtc documents between them stating every credential a webrtc
 * connection holds: TURN credentials and ICE provisioning cannot share one. */
function webrtcDocuments(): Array<unknown> {
  const shared = {
    linkage_terms: snakeizeKeys(getDefaultLinkageTerms("County Health")),
    csv_delimiter: "|",
  };
  const server = {
    host: "broker.example",
    key: WEBRTC_CREDENTIALS.brokerKey,
  };
  return [
    {
      connection: {
        channel: "webrtc",
        role: "inviter",
        server,
        turn: [
          {
            url: "turn:turn.example.org:3478",
            username: "county",
            credential: WEBRTC_CREDENTIALS.turnCredential,
          },
        ],
        provider_options: {
          config_file: WEBRTC_CREDENTIALS.providerOptionPath,
        },
      },
      ...shared,
    },
    {
      connection: {
        channel: "webrtc",
        role: "inviter",
        server,
        ice_provision: {
          host: "ice.example",
          auth: { bearer: WEBRTC_CREDENTIALS.iceBearer },
        },
      },
      ...shared,
    },
  ];
}

function expectNoWebrtcCredential(text: string): void {
  for (const credential of Object.values(WEBRTC_CREDENTIALS))
    expect(text).not.toContain(credential);
}

describe("the webrtc connection's credentials never reach the browser", () => {
  test("the load answers none of them", async () => {
    for (const document of webrtcDocuments()) {
      const dataRoot = enable();
      writeConfiguration(dataRoot, document);
      const response = await load();
      expect(response.status).toBe(200);
      expectNoWebrtcCredential(await response.text());
    }
  });

  test("the hand-back answers none of them and writes every one back", async () => {
    for (const document of webrtcDocuments()) {
      const dataRoot = enable();
      writeConfiguration(dataRoot, document);
      const response = await handBack({
        linkageTerms: getDefaultLinkageTerms("County Health West"),
        csvDelimiter: ";",
        signing: { mode: "none" },
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ written: true });
      expectNoWebrtcCredential(text);
      const written = fs.readFileSync(
        path.join(dataRoot, "alcove.yaml"),
        "utf8",
      );
      expect(written).toContain("County Health West");
      for (const credential of Object.values(WEBRTC_CREDENTIALS))
        if (JSON.stringify(document).includes(credential))
          expect(written).toContain(credential);
    }
  });
});

describe("PUT /api/jobs/config", () => {
  const settings = {
    linkageTerms: getDefaultLinkageTerms("County Health"),
    signing: { mode: "none" },
  };

  test("is 404 when the API is disabled", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    expect((await handBack(settings)).status).toBe(404);
  });

  test("admits no connection from the browser", async () => {
    const dataRoot = enable();
    writeConfiguration(dataRoot, webrtcDocuments()[0]);
    const before = fs.readFileSync(path.join(dataRoot, "alcove.yaml"));
    const response = await handBack({
      ...settings,
      connection: { channel: "webrtc", server: { host: "elsewhere" } },
    });
    expect(response.status).toBe(400);
    expect(fs.readFileSync(path.join(dataRoot, "alcove.yaml"))).toEqual(before);
  });

  test("refuses a configuration the console runs itself", async () => {
    const dataRoot = enable();
    writeConfiguration(dataRoot, savedSftpDocument());
    const response = await handBack(settings);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      "runs over sftp",
    );
  });

  test("refuses a mount holding no configuration", async () => {
    enable();
    const response = await handBack(settings);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      "no longer holds an alcove.yaml",
    );
  });
});
