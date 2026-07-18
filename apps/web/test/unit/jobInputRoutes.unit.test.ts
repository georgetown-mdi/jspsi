import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { MAX_TRANSFORM_PATTERN_LENGTH } from "@psilink/core";

import {
  MAX_COVERAGE_BODY_BYTES,
  useJobInputParseGate,
} from "@jobs/workInputs";

import { Route as CoverageRoute } from "../../src/routes/api/jobs/inputs/coverage";
import { Route as InputsRoute } from "../../src/routes/api/jobs/inputs/index";
import { Route as ProfileRoute } from "../../src/routes/api/jobs/inputs/profile";

import { STUB_CLI_PATH } from "../utils/jobFixtures";

import type { JobManager } from "@jobs/jobManager";
import type { Standardization } from "@psilink/core";

const dirs: Array<string> = [];

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `psilink-${label}-`));
  dirs.push(dir);
  return dir;
}

const FIXTURE_CSV =
  "ssn,last_name,date_of_birth\n111223333,Public,1990-01-02\n222,Cole,1985-11-30\n";

function inputDirWithFixture(name = "input.csv"): {
  dir: string;
  name: string;
} {
  const dir = tempDir("inputs");
  fs.writeFileSync(path.join(dir, name), FIXTURE_CSV);
  return { dir, name };
}

const STANDARDIZATION: Standardization = [
  {
    output: "last_name",
    input: "last_name",
    steps: [{ function: "to_upper_case" }],
  },
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  const manager = (globalThis as { jobManagerInstance?: JobManager })
    .jobManagerInstance;
  manager?.shutdown();
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
  (globalThis as { jobManagerInstance?: unknown }).jobManagerInstance =
    undefined;
  (globalThis as { jobInputDirConfig?: unknown }).jobInputDirConfig = undefined;
  (globalThis as { jobInputParseGate?: unknown }).jobInputParseGate = undefined;
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

/** Enable the job API (a real data root) and, optionally, the input directory. */
function enable(options: { token?: string; inputDir?: string } = {}): void {
  const dataRoot = tempDir("data");
  vi.stubEnv("JOB_DATA_ROOT", dataRoot);
  vi.stubEnv("JOB_CLI_BINARY", STUB_CLI_PATH);
  if (options.token !== undefined) vi.stubEnv("JOB_API_TOKEN", options.token);
  if (options.inputDir !== undefined)
    vi.stubEnv("JOB_INPUT_DIR", options.inputDir);
}

function profileRequest(name: string): Request {
  return new Request(
    `http://localhost/api/jobs/inputs/profile?name=${encodeURIComponent(name)}`,
  );
}

function coverageRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/jobs/inputs/coverage", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function coverageBody(
  dir: string,
  name: string,
  standardization = STANDARDIZATION,
) {
  const stat = fs.statSync(path.join(dir, name));
  return {
    name,
    sizeBytes: stat.size,
    modifiedAt: Math.trunc(stat.mtimeMs),
    standardization,
  };
}

describe("gating parity: every new route is dark when disabled and gated on auth", () => {
  test("all three routes are 404 when JOB_DATA_ROOT is unset", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    const listing = (await handlersOf(InputsRoute).GET({
      request: new Request("http://localhost/api/jobs/inputs"),
      params: {},
    })) as Response;
    expect(listing.status).toBe(404);
    const profile = (await handlersOf(ProfileRoute).GET({
      request: profileRequest("input.csv"),
      params: {},
    })) as Response;
    expect(profile.status).toBe(404);
    const coverage = (await handlersOf(CoverageRoute).POST({
      request: coverageRequest(coverageBodyShape()),
      params: {},
    })) as Response;
    expect(coverage.status).toBe(404);
  });

  test("all three routes are 401 on a wrong bearer", async () => {
    enable({ token: "the-token" });
    const bad = { authorization: "Bearer wrong" };
    const listing = (await handlersOf(InputsRoute).GET({
      request: new Request("http://localhost/api/jobs/inputs", {
        headers: bad,
      }),
      params: {},
    })) as Response;
    expect(listing.status).toBe(401);
    const profile = (await handlersOf(ProfileRoute).GET({
      request: new Request(profileRequest("input.csv"), { headers: bad }),
      params: {},
    })) as Response;
    expect(profile.status).toBe(401);
    const coverage = (await handlersOf(CoverageRoute).POST({
      request: coverageRequest(coverageBodyShape(), bad),
      params: {},
    })) as Response;
    expect(coverage.status).toBe(401);
  });
});

/** A syntactically valid coverage body (no filesystem dependency), for gate tests
 * that must be rejected before the body is ever inspected. */
function coverageBodyShape() {
  return {
    name: "input.csv",
    sizeBytes: 1,
    modifiedAt: 1,
    standardization: STANDARDIZATION,
  };
}

describe("GET /api/jobs/inputs listing", () => {
  test("configured:false with an empty list when JOB_INPUT_DIR is unset", async () => {
    enable();
    const response = (await handlersOf(InputsRoute).GET({
      request: new Request("http://localhost/api/jobs/inputs"),
      params: {},
    })) as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      configured: false,
      totalEntries: 0,
      truncated: false,
      files: [],
    });
  });

  test("lists the mounted files when configured", async () => {
    const { dir, name } = inputDirWithFixture();
    enable({ inputDir: dir });
    const response = (await handlersOf(InputsRoute).GET({
      request: new Request("http://localhost/api/jobs/inputs"),
      params: {},
    })) as Response;
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      configured: boolean;
      files: Array<{ name: string }>;
    };
    expect(body.configured).toBe(true);
    expect(body.files.map((f) => f.name)).toEqual([name]);
  });

  test("is 429 when the parse gate is already full", async () => {
    const { dir } = inputDirWithFixture();
    enable({ inputDir: dir });
    const gate = useJobInputParseGate();
    // Occupy the running slot and the depth-one queue: the listing scan shares the
    // same gate as profile/coverage, so the third concurrent request is refused.
    void gate.run(() => new Promise<void>(() => {}));
    void gate.run(() => new Promise<void>(() => {}));
    const response = (await handlersOf(InputsRoute).GET({
      request: new Request("http://localhost/api/jobs/inputs"),
      params: {},
    })) as Response;
    expect(response.status).toBe(429);
  });
});

describe("GET /api/jobs/inputs/profile", () => {
  test("profiles a mounted file", async () => {
    const { dir, name } = inputDirWithFixture();
    enable({ inputDir: dir });
    const response = (await handlersOf(ProfileRoute).GET({
      request: profileRequest(name),
      params: {},
    })) as Response;
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      columns: Array<string>;
      rowCount: number;
      dateInputFormat?: string;
    };
    expect(body.columns).toEqual(["ssn", "last_name", "date_of_birth"]);
    expect(body.rowCount).toBe(2);
    expect(body.dateInputFormat).toBe("YYYY-MM-DD");
  });

  test("an unknown name is an empty-bodied 404 that never echoes the name", async () => {
    const { dir } = inputDirWithFixture();
    enable({ inputDir: dir });
    const response = (await handlersOf(ProfileRoute).GET({
      request: profileRequest("../secret"),
      params: {},
    })) as Response;
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  test("a symlink swapped in between admission and open is an empty-bodied 404", async () => {
    const { dir, name } = inputDirWithFixture();
    const secret = tempDir("route-open-race-secret");
    fs.writeFileSync(path.join(secret, "creds"), "ssn\n9\n");
    enable({ inputDir: dir });

    const realOpen = fs.openSync;
    // The genuine O_NOFOLLOW race: swap the admitted regular file for a symlink after
    // admission but before open, so the real open throws ELOOP -- mapped to a 404 that
    // never echoes the name, matching the profile route's documented posture.
    vi.spyOn(fs, "openSync").mockImplementationOnce(((
      filePath: fs.PathLike,
      flags: number,
    ) => {
      fs.rmSync(path.join(dir, name));
      fs.symlinkSync(path.join(secret, "creds"), path.join(dir, name));
      return realOpen(filePath, flags);
    }) as typeof fs.openSync);

    const response = (await handlersOf(ProfileRoute).GET({
      request: profileRequest(name),
      params: {},
    })) as Response;
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  test("a missing name parameter is 404", async () => {
    const { dir } = inputDirWithFixture();
    enable({ inputDir: dir });
    const response = (await handlersOf(ProfileRoute).GET({
      request: new Request("http://localhost/api/jobs/inputs/profile"),
      params: {},
    })) as Response;
    expect(response.status).toBe(404);
  });

  test("an unconfigured input directory is 404", async () => {
    enable();
    const response = (await handlersOf(ProfileRoute).GET({
      request: profileRequest("input.csv"),
      params: {},
    })) as Response;
    expect(response.status).toBe(404);
  });

  test("is 429 when the parse gate is already full", async () => {
    const { dir, name } = inputDirWithFixture();
    enable({ inputDir: dir });
    const gate = useJobInputParseGate();
    // Occupy the running slot and the depth-one queue with tasks that never settle.
    void gate.run(() => new Promise<void>(() => {}));
    void gate.run(() => new Promise<void>(() => {}));
    const response = (await handlersOf(ProfileRoute).GET({
      request: profileRequest(name),
      params: {},
    })) as Response;
    expect(response.status).toBe(429);
  });
});

describe("POST /api/jobs/inputs/coverage", () => {
  test("computes coverage rates for a mounted file", async () => {
    const { dir, name } = inputDirWithFixture();
    enable({ inputDir: dir });
    const response = (await handlersOf(CoverageRoute).POST({
      request: coverageRequest(coverageBody(dir, name)),
      params: {},
    })) as Response;
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      rates: Array<{ output: string; produced: number; total: number }>;
    };
    expect(body.rates).toHaveLength(1);
    expect(body.rates[0]).toMatchObject({
      output: "last_name",
      total: 2,
      produced: 2,
    });
  });

  test("a standardization that fails the schema is 400", async () => {
    const { dir, name } = inputDirWithFixture();
    enable({ inputDir: dir });
    const bad = coverageBody(dir, name, [
      // A duplicate output violates the standardization schema refine.
      { output: "x", input: "a", steps: [] },
      { output: "x", input: "b", steps: [] },
    ]);
    const response = (await handlersOf(CoverageRoute).POST({
      request: coverageRequest(bad),
      params: {},
    })) as Response;
    expect(response.status).toBe(400);
  });

  test("a step pattern past the length cap is 400", async () => {
    const { dir, name } = inputDirWithFixture();
    enable({ inputDir: dir });
    const oversized: Standardization = [
      {
        output: "last_name",
        input: "last_name",
        steps: [
          {
            function: "replace_regex",
            params: { pattern: "a".repeat(MAX_TRANSFORM_PATTERN_LENGTH + 1) },
          },
        ],
      },
    ];
    const response = (await handlersOf(CoverageRoute).POST({
      request: coverageRequest(coverageBody(dir, name, oversized)),
      params: {},
    })) as Response;
    expect(response.status).toBe(400);
  });

  test("an over-cap coalesce default is not capped (it is not a regex source)", async () => {
    const { dir, name } = inputDirWithFixture();
    enable({ inputDir: dir });
    // coalesce's default is a plain, uncompiled string, unbounded on every other
    // path (core schema, browser preview, job-create intent); the route pattern cap
    // must scope to compiled regex sources, so an over-length default still passes.
    const longDefault: Standardization = [
      {
        output: "last_name",
        input: "last_name",
        steps: [
          {
            function: "coalesce",
            params: { default: "x".repeat(MAX_TRANSFORM_PATTERN_LENGTH + 1) },
          },
        ],
      },
    ];
    const response = (await handlersOf(CoverageRoute).POST({
      request: coverageRequest(coverageBody(dir, name, longDefault)),
      params: {},
    })) as Response;
    expect(response.status).toBe(200);
  });

  test("a drifted (size, mtime) pair is an empty-bodied 400", async () => {
    const { dir, name } = inputDirWithFixture();
    enable({ inputDir: dir });
    const drifted = coverageBody(dir, name);
    drifted.sizeBytes += 1;
    const response = (await handlersOf(CoverageRoute).POST({
      request: coverageRequest(drifted),
      params: {},
    })) as Response;
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
  });

  test("an unknown name is 404", async () => {
    const { dir, name } = inputDirWithFixture();
    enable({ inputDir: dir });
    const body = coverageBody(dir, name);
    body.name = "absent.csv";
    const response = (await handlersOf(CoverageRoute).POST({
      request: coverageRequest(body),
      params: {},
    })) as Response;
    expect(response.status).toBe(404);
  });

  test("a body past the 1 MiB cap is 413", async () => {
    const { dir, name } = inputDirWithFixture();
    enable({ inputDir: dir });
    // A huge (but valid-shaped) standardization output name pushes the body past
    // the cap; the streamed read trips before the schema runs.
    const huge = coverageBody(dir, name, [
      {
        output: "x".repeat(MAX_COVERAGE_BODY_BYTES + 16),
        input: "last_name",
        steps: [],
      },
    ]);
    const response = (await handlersOf(CoverageRoute).POST({
      request: coverageRequest(huge),
      params: {},
    })) as Response;
    expect(response.status).toBe(413);
  });

  test("an unconfigured input directory is 404", async () => {
    enable();
    const response = (await handlersOf(CoverageRoute).POST({
      request: coverageRequest(coverageBodyShape()),
      params: {},
    })) as Response;
    expect(response.status).toBe(404);
  });

  test("is 429 when the parse gate is already full", async () => {
    const { dir, name } = inputDirWithFixture();
    enable({ inputDir: dir });
    const gate = useJobInputParseGate();
    void gate.run(() => new Promise<void>(() => {}));
    void gate.run(() => new Promise<void>(() => {}));
    const response = (await handlersOf(CoverageRoute).POST({
      request: coverageRequest(coverageBody(dir, name)),
      params: {},
    })) as Response;
    expect(response.status).toBe(429);
  });
});
