import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { HOSTED_API_PREFIXES, withApiGuard } from "@utils/apiNamespace";
import { jobEmptyResponse } from "@jobs/gate";

// withApiGuard is what src/server.ts puts every request through ahead of the
// framework's handler. These cover the refusal in isolation, over the spellings
// of the /api prefix a router resolves to a route; whether this app's router
// still resolves them that way is what the integration matrix drives against
// the built server (apps/web/test/integration/apiNamespace.test.ts).

/** A route that records what reached it and answers the app document, which is
 * what the framework renders for a path no handler serves. */
function countingRoute(): {
  route: (request: Request) => Response;
  reached: Array<string>;
} {
  const reached: Array<string> = [];
  return {
    reached,
    route: (request) => {
      reached.push(new URL(request.url).pathname);
      return new Response("<!DOCTYPE html><html></html>", {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  };
}

function headerEntries(response: Response): Array<[string, string]> {
  return [...response.headers].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

/** The observable shape of a response: what a probe comparing two paths reads,
 * down to the whole header set, so a header added to the job gate's refusal and
 * not to this one fails here. */
async function shapeOf(response: Response) {
  return {
    status: response.status,
    headers: headerEntries(response),
    body: await response.text(),
  };
}

async function answer(
  method: string,
  path: string,
): Promise<{ response: Response; reached: Array<string> }> {
  const { route, reached } = countingRoute();
  const response = await withApiGuard(route)(
    new Request(`http://127.0.0.1:3000${path}`, { method }),
  );
  return { response, reached };
}

/** The hosted deployment: no console profile, no data root, so the job API is
 * not enabled and the refusal applies. */
function hostedProfile(): void {
  vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "");
  vi.stubEnv("JOB_DATA_ROOT", "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the /api refusal on a deployment without the job API", () => {
  beforeEach(hostedProfile);

  test("answers the job gate's own 404, header for header", async () => {
    const { response } = await answer("GET", "/api/jobs/slot");
    expect(await shapeOf(response)).toEqual(
      await shapeOf(jobEmptyResponse(404)),
    );
  });

  test("no job route runs for any spelling that reaches one", async () => {
    // The spellings measured to reach the job handler with no refusal ahead of
    // the router: the plain path, its trailing-slash form, and a case-varied
    // prefix. None may reach the route with the refusal in place.
    const reached: Array<string> = [];
    const { route } = countingRoute();
    const guarded = withApiGuard((request) => {
      reached.push(new URL(request.url).pathname);
      return route(request);
    });
    for (const path of [
      "/api/jobs/slot",
      "/api/nothing-here",
      "/api/jobs/slot/",
      "/API/jobs/slot",
    ]) {
      const response = await guarded(
        new Request(`http://127.0.0.1:3000${path}`),
      );
      expect(response.status).toBe(404);
    }
    expect(reached).toEqual([]);
  });

  test.each([
    ["GET", "/api"],
    ["GET", "/api/"],
    ["GET", "/api/nothing-here"],
    ["GET", "/api/nothing-here/"],
    ["GET", "/api//jobs/slot"],
    ["GET", "/api/jobs/inputs/coverage"],
    ["POST", "/api/nothing-here"],
    ["DELETE", "/api/jobs/slot"],
    ["HEAD", "/api/jobs/slot"],
    ["GET", "/API/jobs/slot"],
    ["GET", "/Api/jobs/slot"],
    ["GET", "/%61pi/jobs/slot"],
    ["GET", "/%41PI/jobs/slot"],
    ["GET", "/api/%6aobs/slot"],
    ["GET", "/api%2Fjobs/slot"],
    ["GET", "/api/%zz/%e0%a4%a5"],
    // The URL parser resolves this to /api/jobs/slot before the guard reads it,
    // so this row pins the resolved form. The target as written reaches the
    // entry only over a raw socket, which the integration matrix drives.
    ["GET", "/api/peerjs/%2e%2e/jobs/slot"],
    ["GET", "/api/%2570eerjs/id"],
    ["GET", "/api/PEERJS/id"],
    ["GET", "/api/%70eerjs/id"],
  ])("refuses %s %s before the router", async (method, path) => {
    const { response, reached } = await answer(method, path);
    expect(reached).toEqual([]);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  test.each([
    ["GET", "/api/peerjs/id"],
    ["GET", "/api/peerjs/id/"],
    ["GET", "/api/peerjs"],
    ["GET", "/API/peerjs/id"],
    ["GET", "/%61pi/peerjs/id"],
    ["POST", "/api/peerjs/id"],
  ])("routes %s %s, the broker's own subtree", async (method, path) => {
    const { reached } = await answer(method, path);
    expect(reached).toHaveLength(1);
  });

  test.each([
    ["GET", "/"],
    ["GET", "/nothing-here"],
    ["GET", "/apiary"],
    ["GET", "/ap%69x/jobs"],
    ["GET", "/saved/"],
  ])("routes %s %s, outside the namespace", async (method, path) => {
    const { reached } = await answer(method, path);
    expect(reached).toHaveLength(1);
  });
});

describe("the /api refusal on a deployment with the job API enabled", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
    vi.stubEnv("JOB_DATA_ROOT", "/var/lib/psilink-jobs");
  });

  test.each([
    ["GET", "/api/jobs/slot"],
    ["GET", "/api/nothing-here"],
    ["GET", "/API/jobs/slot"],
    ["GET", "/api/peerjs/id"],
  ])(
    "routes %s %s, leaving the per-route gate to answer",
    async (method, path) => {
      const { reached } = await answer(method, path);
      expect(reached).toHaveLength(1);
    },
  );
});

describe("the served-everywhere allowlist", () => {
  test("names the broker's subtree under /api", () => {
    // A rot guard: an emptied list would make the namespace refuse the broker
    // and stop signaling, and a list reaching past /api would refuse nothing.
    expect(HOSTED_API_PREFIXES.length).toBeGreaterThan(0);
    for (const prefix of HOSTED_API_PREFIXES)
      expect(prefix.startsWith("/api/")).toBe(true);
  });
});
