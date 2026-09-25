import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NodeCountExceededError, UsageError } from "@alcove/core";

import { Route as CreateRoute } from "../../../src/routes/api/jobs/index";

import {
  STUB_CLI_PATH,
  tempDataRoot,
  validIntent,
} from "../../utils/jobFixtures";

import type * as HandoffModule from "@jobs/handoff";
import type { JobManager } from "@jobs/jobManager";

const composeFault = vi.hoisted(() => ({
  error: undefined as Error | undefined,
}));

vi.mock("@jobs/handoff", async (importOriginal) => {
  const actual = await importOriginal<typeof HandoffModule>();
  return {
    ...actual,
    buildJobHandoff: (...args: Parameters<typeof actual.buildJobHandoff>) => {
      if (composeFault.error !== undefined) throw composeFault.error;
      return actual.buildJobHandoff(...args);
    },
  };
});

const roots: Array<string> = [];

function freshRoot(label: string): string {
  const dir = tempDataRoot(label);
  roots.push(dir);
  return dir;
}

beforeEach(() => {
  const rendezvousDir = freshRoot("compose-refusal-rvz");
  fs.mkdirSync(rendezvousDir, { recursive: true });
  vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
  vi.stubEnv("JOB_DATA_ROOT", freshRoot("compose-refusal"));
  vi.stubEnv("JOB_RENDEZVOUS_DIR", rendezvousDir);
  vi.stubEnv("JOB_CLI_BINARY", STUB_CLI_PATH);
  vi.stubEnv("STUB_FD3_EVENTS", JSON.stringify([]));
  vi.stubEnv("STUB_EXIT_CODE", "0");
});

afterEach(async () => {
  composeFault.error = undefined;
  vi.unstubAllEnvs();
  const globals = globalThis as {
    jobManagerInstance?: JobManager;
    jobRendezvousProvisioning?: unknown;
  };
  await globals.jobManagerInstance?.shutdown();
  globals.jobManagerInstance = undefined;
  globals.jobRendezvousProvisioning = undefined;
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

async function postCreate(): Promise<Response> {
  const handlers = CreateRoute.options.server?.handlers as Record<
    string,
    (ctx: { request: Request; params: Record<string, string> }) => unknown
  >;
  return (await handlers.POST({
    request: new Request("http://localhost/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost" },
      body: JSON.stringify(validIntent()),
    }),
    params: {},
  })) as Response;
}

describe("a refusal thrown while the create composes", () => {
  test("a size-bound refusal is a 400 stating core's fixed message", async () => {
    composeFault.error = new NodeCountExceededError();
    const response = await postCreate();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: new NodeCountExceededError().message,
    });
  });

  test("a plain UsageError is an empty 500, its message kept off the body", async () => {
    composeFault.error = new UsageError("partner-supplied text");
    const response = await postCreate();
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
  });
});
