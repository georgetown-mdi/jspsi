// Drives the real npm against a stub registry on 127.0.0.1, so every case here
// is npm's own behavior rather than a model of it (CLAUDE.md: an external
// tool's behavior is settled by driving the tool). No network is reached: the
// stub answers the bulk advisories endpoint and the one packument npm asks for
// when it has a fix to compute, and the fixture project is a temporary
// directory with a hand-written lockfile.

import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AUDIT_ARGS,
  AUDIT_COMMAND,
  RETRY_DELAYS_MS,
  auditWithRetry,
  isEndpointFailure,
} from "./npm-audit-retry.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(REPO_ROOT, relative), "utf8");

/** The fixture's one dependency, and the version the stub advisory covers. */
const FIXTURE_PACKAGE = "left-pad";
const FIXTURE_VERSION = "1.3.0";

/**
 * A stub npm registry. `bulkResponses` is consumed one entry per POST to the
 * advisories endpoint, so a run can be handed a 503 and then an answer; a
 * packument GET (npm fetches one only when it has a fix to compute) is always
 * served a minimal one for the fixture package.
 */
function startStubRegistry(bulkResponses) {
  const bulkRequests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (!req.url.includes("/security/advisories/bulk")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            name: FIXTURE_PACKAGE,
            "dist-tags": { latest: "2.0.0" },
            versions: {
              [FIXTURE_VERSION]: {
                name: FIXTURE_PACKAGE,
                version: FIXTURE_VERSION,
                dist: { tarball: "http://127.0.0.1/unused.tgz" },
              },
              "2.0.0": {
                name: FIXTURE_PACKAGE,
                version: "2.0.0",
                dist: { tarball: "http://127.0.0.1/unused.tgz" },
              },
            },
          }),
        );
        return;
      }
      let body = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") body = gunzipSync(body);
      bulkRequests.push(JSON.parse(body.toString("utf8")));
      const next =
        bulkResponses[
          Math.min(bulkRequests.length - 1, bulkResponses.length - 1)
        ];
      res.writeHead(next.status, { "content-type": "application/json" });
      res.end(JSON.stringify(next.body));
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      resolvePromise({
        url: `http://127.0.0.1:${server.address().port}`,
        bulkRequests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

const SERVICE_UNAVAILABLE = {
  status: 503,
  body: { error: "Service Unavailable" },
};
const NO_ADVISORIES = { status: 200, body: {} };
const ONE_ADVISORY = {
  status: 200,
  body: {
    [FIXTURE_PACKAGE]: [
      {
        id: 1234567,
        url: "https://example.invalid/advisory",
        title: "stub advisory",
        severity: "high",
        vulnerable_versions: `<=${FIXTURE_VERSION}`,
        cwe: [],
        cvss: { score: 7.5, vectorString: null },
      },
    ],
  },
};

let fixture;
let emptyProject;
let cache;

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "npm-audit-retry-"));
  fixture = join(root, "project");
  emptyProject = join(root, "empty");
  cache = join(root, "cache");
  mkdirSync(fixture);
  mkdirSync(emptyProject);
  writeFixture(fixture);
});

/** The fixture project: one pinned dependency, resolved from the lockfile alone. */
function writeFixture(dir) {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "audit-retry-fixture",
      version: "1.0.0",
      private: true,
      dependencies: { [FIXTURE_PACKAGE]: FIXTURE_VERSION },
    }),
  );
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify({
      name: "audit-retry-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "audit-retry-fixture",
          version: "1.0.0",
          dependencies: { [FIXTURE_PACKAGE]: FIXTURE_VERSION },
        },
        [`node_modules/${FIXTURE_PACKAGE}`]: { version: FIXTURE_VERSION },
      },
    }),
  );
}

/**
 * The environment for a fixture run. Every inherited `npm_config_*` is dropped
 * first: a suite run through `npm run` inherits npm's own `npm_config_local_prefix`
 * pointing at this repository, which would silently audit the repository rather
 * than the fixture. `fetch-retries=0` holds each attempt to one request on the
 * endpoint, so the counts asserted below are the wrapper's attempts (npm issues
 * one request per invocation on a 503 under its defaults too).
 */
function fixtureEnv(registryUrl) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toLowerCase().startsWith("npm_config_"),
    ),
  );
  return {
    ...env,
    npm_config_registry: registryUrl,
    npm_config_cache: cache,
    npm_config_fetch_retries: "0",
  };
}

/** Run the wrapper over the fixture, recording its transcript and its waits. */
async function runFixtureAudit(registryUrl) {
  const transcript = [];
  const waits = [];
  const code = await auditWithRetry({
    args: ["audit", "--package-lock-only"],
    cwd: fixture,
    env: fixtureEnv(registryUrl),
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    report: (text) => transcript.push(text),
  });
  return { code, waits, transcript: transcript.join("") };
}

describe("npm audit retry", () => {
  let registry;

  afterAll(async () => {
    await registry?.close();
  });

  it("retries an endpoint failure the bounded number of times, then fails", async () => {
    registry = await startStubRegistry([SERVICE_UNAVAILABLE]);
    const { code, waits, transcript } = await runFixtureAudit(registry.url);

    expect(code).not.toBe(0);
    expect(registry.bulkRequests).toHaveLength(RETRY_DELAYS_MS.length + 1);
    expect(waits).toEqual(RETRY_DELAYS_MS);
    expect(transcript).toContain("npm error audit endpoint returned an error");
    expect(transcript).toContain("failing the run");
    await registry.close();
  }, 60_000);

  it("passes once a transient endpoint failure clears", async () => {
    registry = await startStubRegistry([SERVICE_UNAVAILABLE, NO_ADVISORIES]);
    const { code, waits, transcript } = await runFixtureAudit(registry.url);

    expect(code).toBe(0);
    expect(registry.bulkRequests).toHaveLength(2);
    expect(waits).toEqual([RETRY_DELAYS_MS[0]]);
    expect(transcript).toContain("found 0 vulnerabilities");
    await registry.close();
  }, 60_000);

  it("fails an advisory finding on the first attempt, never retrying it", async () => {
    registry = await startStubRegistry([ONE_ADVISORY]);
    const { code, waits, transcript } = await runFixtureAudit(registry.url);

    expect(code).not.toBe(0);
    expect(registry.bulkRequests).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(transcript).toContain("1 high severity vulnerability");
    expect(transcript).not.toContain("retrying in");
    await registry.close();
  }, 60_000);

  it("fails a failure it cannot classify on the first attempt", async () => {
    const transcript = [];
    const waits = [];
    const code = await auditWithRetry({
      args: ["audit", "--package-lock-only"],
      cwd: emptyProject,
      env: fixtureEnv("http://127.0.0.1:1"),
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      report: (text) => transcript.push(text),
    });

    expect(code).not.toBe(0);
    expect(waits).toEqual([]);
    expect(transcript.join("")).toContain("ENOLOCK");
  }, 60_000);

  it("reads a failed run's stderr, not its report, to decide on a retry", () => {
    expect(
      isEndpointFailure({
        code: 1,
        stdout: "npm error audit endpoint returned an error",
        stderr: "",
      }),
    ).toBe(false);
    expect(
      isEndpointFailure({
        code: 0,
        stderr: "npm error audit endpoint returned an error\n",
      }),
    ).toBe(false);
  });

  it("bounds the retries and backs off between them", () => {
    expect(RETRY_DELAYS_MS.length).toBeGreaterThan(0);
    expect(RETRY_DELAYS_MS.length).toBeLessThanOrEqual(4);
    for (let i = 1; i < RETRY_DELAYS_MS.length; i++) {
      expect(RETRY_DELAYS_MS[i]).toBeGreaterThan(RETRY_DELAYS_MS[i - 1]);
    }
  });

  it("runs the command the documents and the merge gate name", () => {
    expect(AUDIT_COMMAND).toBe(`npm ${AUDIT_ARGS.join(" ")}`);
    expect(read("CONTRIBUTING.md")).toContain(AUDIT_COMMAND);
    expect(read("docs/RELEASES.md")).toContain(AUDIT_COMMAND);

    const workflow = read(".github/workflows/static_checks.yaml");
    expect(workflow).toContain("run: npm run audit:production");
    expect(workflow).not.toContain(`run: ${AUDIT_COMMAND}`);
    expect(JSON.parse(read("package.json")).scripts["audit:production"]).toBe(
      "node scripts/npm-audit-retry.mjs",
    );
  });
});
