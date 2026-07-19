import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { MAX_TRANSFORM_PATTERN_LENGTH } from "@psilink/core";

import { MAX_COVERAGE_BODY_BYTES } from "@jobs/workInputs";

import { Route as CoverageRoute } from "../../src/routes/api/jobs/inputs/coverage";
import { Route as InputsRoute } from "../../src/routes/api/jobs/inputs/index";
import { Route as ProfileRoute } from "../../src/routes/api/jobs/inputs/profile";

import { STUB_CLI_PATH } from "../utils/jobFixtures";

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
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
  (globalThis as { jobInputDirConfig?: unknown }).jobInputDirConfig = undefined;
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
function enable(options: { inputDir?: string } = {}): void {
  const dataRoot = tempDir("data");
  vi.stubEnv("JOB_DATA_ROOT", dataRoot);
  vi.stubEnv("JOB_CLI_BINARY", STUB_CLI_PATH);
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
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function coverageBody(name: string, standardization = STANDARDIZATION) {
  return { name, standardization };
}

async function listing(): Promise<Response> {
  return (await handlersOf(InputsRoute).GET({
    request: new Request("http://localhost/api/jobs/inputs"),
    params: {},
  })) as Response;
}

async function profile(name: string): Promise<Response> {
  return (await handlersOf(ProfileRoute).GET({
    request: profileRequest(name),
    params: {},
  })) as Response;
}

async function coverage(body: unknown): Promise<Response> {
  return (await handlersOf(CoverageRoute).POST({
    request: coverageRequest(body),
    params: {},
  })) as Response;
}

describe("gating parity: every route is dark when disabled", () => {
  test("all three routes are 404 when JOB_DATA_ROOT is unset", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    expect((await listing()).status).toBe(404);
    expect((await profile("input.csv")).status).toBe(404);
    expect((await coverage(coverageBody("input.csv"))).status).toBe(404);
  });
});

describe("GET /api/jobs/inputs", () => {
  test("reports the unconfigured state when JOB_INPUT_DIR is unset", async () => {
    enable();
    const response = await listing();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: false, files: [] });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  test("lists the mounted input files", async () => {
    const { dir } = inputDirWithFixture();
    enable({ inputDir: dir });
    const response = await listing();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      configured: boolean;
      files: Array<{ name: string }>;
    };
    expect(body.configured).toBe(true);
    expect(body.files.map((file) => file.name)).toEqual(["input.csv"]);
  });
});

describe("GET /api/jobs/inputs/profile", () => {
  test("404 when the input directory is unset", async () => {
    enable();
    expect((await profile("input.csv")).status).toBe(404);
  });

  test("profiles a mounted file", async () => {
    const { dir } = inputDirWithFixture();
    enable({ inputDir: dir });
    const response = await profile("input.csv");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rowCount: number };
    expect(body.rowCount).toBe(2);
  });

  test("404 for an unknown name", async () => {
    const { dir } = inputDirWithFixture();
    enable({ inputDir: dir });
    expect((await profile("missing.csv")).status).toBe(404);
  });

  test("404 for an inadmissible name", async () => {
    const { dir } = inputDirWithFixture();
    enable({ inputDir: dir });
    expect((await profile("../escape")).status).toBe(404);
  });
});

describe("POST /api/jobs/inputs/coverage", () => {
  test("404 when the input directory is unset", async () => {
    enable();
    expect((await coverage(coverageBody("input.csv"))).status).toBe(404);
  });

  test("computes coverage for a mounted file", async () => {
    const { dir } = inputDirWithFixture();
    enable({ inputDir: dir });
    const response = await coverage(coverageBody("input.csv"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rates: Array<unknown> };
    expect(Array.isArray(body.rates)).toBe(true);
  });

  test("404 for an unknown name", async () => {
    const { dir } = inputDirWithFixture();
    enable({ inputDir: dir });
    expect((await coverage(coverageBody("missing.csv"))).status).toBe(404);
  });

  test("400 on a malformed body", async () => {
    const { dir } = inputDirWithFixture();
    enable({ inputDir: dir });
    expect((await coverage("not json")).status).toBe(400);
  });

  test("400 on an unknown field (strict schema)", async () => {
    const { dir } = inputDirWithFixture();
    enable({ inputDir: dir });
    expect(
      (
        await coverage({
          name: "input.csv",
          standardization: STANDARDIZATION,
          sizeBytes: 42,
        })
      ).status,
    ).toBe(400);
  });

  test("400 on an over-length compiled pattern (RE2 compile bound)", async () => {
    const { dir } = inputDirWithFixture();
    enable({ inputDir: dir });
    const response = await coverage({
      name: "input.csv",
      standardization: [
        {
          input: "last_name",
          output: "last_name",
          steps: [
            {
              function: "replace_regex",
              params: {
                pattern: "a".repeat(MAX_TRANSFORM_PATTERN_LENGTH + 1),
                replacement: "",
              },
            },
          ],
        },
      ],
    });
    expect(response.status).toBe(400);
  });

  test("413 on an oversized body", async () => {
    const { dir } = inputDirWithFixture();
    enable({ inputDir: dir });
    const huge = "x".repeat(MAX_COVERAGE_BODY_BYTES + 1);
    const response = await coverage({
      name: "input.csv",
      standardization: [{ input: huge, output: "b", steps: [] }],
    });
    expect(response.status).toBe(413);
  });
});
