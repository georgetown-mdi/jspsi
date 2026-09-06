import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  getFreePort,
  hasBuild,
  spawnProdServer,
  stopProdServer,
  waitForRoot,
} from "./prodServer.js";

import type { ChildProcess } from "node:child_process";

// On a deployment where the job API is not enabled, every path under /api
// outside the broker's subtree answers one response, whatever the request's
// spelling, method, or Accept header. Asserted against the real built server
// because what would otherwise answer is the router's decision, not any
// handler's: which spellings of the prefix it resolves to a route, which paths
// it answers with a canonicalizing redirect rather than matching as written,
// what it renders for a method a route declares no handler for, and what the
// SSR path returns to a request that excludes HTML are visible only on the
// wire.
//
// This matrix, rather than a unit assertion per shape, is what catches a
// framework version that adds a response shape: the shapes belong to the
// framework, so nothing here enumerates them -- every request below is required
// to answer the one refusal, whatever the framework would have answered.

/** The whole observable shape of a response. Date and the connection headers
 * are dropped: they vary per request rather than per path, and a probe reads
 * nothing from them. */
interface ResponseShape {
  status: number;
  headers: Array<[string, string]>;
  bodyLength: number;
}

const VOLATILE_HEADERS: ReadonlySet<string> = new Set([
  "date",
  "connection",
  "keep-alive",
]);

/** The two Accept headers a probe reads the namespace with: a browser's, and
 * one excluding HTML, which is what the SSR path refuses with a JSON 500 when
 * a request reaches it. */
const ACCEPT_VALUES: ReadonlyArray<[string, string]> = [
  ["html", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"],
  ["json", "application/json"],
];

/** Redirects are read, not followed: the router answers a path it will not
 * match as written with one, and following it would report the canonical
 * path's answer in its place. */
async function shapeOf(
  base: string,
  method: string,
  path: string,
  accept: string,
): Promise<ResponseShape> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Accept: accept },
    redirect: "manual",
  });
  const body = await response.arrayBuffer();
  return {
    status: response.status,
    headers: [...response.headers]
      .filter(([name]) => !VOLATILE_HEADERS.has(name))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    bodyLength: body.byteLength,
  };
}

/** The one refusal: the job gate's own empty 404 (jobEmptyResponse in
 * src/jobs/gate.ts) with the security headers the server entry applies to every
 * response. Written out rather than read from the app, so a change to either
 * side of the wire shows here. */
const REFUSAL: ResponseShape = {
  status: 404,
  headers: [
    ["cache-control", "no-store"],
    ["content-length", "0"],
    ["content-security-policy", "frame-ancestors 'none'"],
    ["referrer-policy", "no-referrer"],
    ["x-content-type-options", "nosniff"],
    ["x-frame-options", "DENY"],
  ],
  bodyLength: 0,
};

/** The refusal as `method` reads it. Node's HTTP server sends no
 * `Content-Length` on a bodiless HEAD response -- for every path alike, inside
 * the namespace and out -- so that one header is dropped from what a HEAD
 * request is held to rather than the request being left out of the matrix. */
function refusalFor(method: string): ResponseShape {
  if (method !== "HEAD") return REFUSAL;
  return {
    ...REFUSAL,
    headers: REFUSAL.headers.filter(([name]) => name !== "content-length"),
  };
}

/** Every request the refusal has to answer identically. Each row is a request
 * form a probe would use to tell a declared route from an unknown path:
 *
 * - a declared job route, and one reached by a method it declares no handler
 *   for (the coverage module declares POST only, the slot module GET only),
 * - a path with no route at all, under /api and under /api/jobs,
 * - the namespace root itself, with and without its trailing slash,
 * - a trailing and a doubled slash on a declared and an unknown path, which the
 *   router canonicalizes with a redirect rather than matching as written,
 * - the prefix case-varied and percent-encoded, and a segment after it
 *   percent-encoded, all of which the router resolves to the declared route,
 * - a percent-encoded separator and percent-encoded dot segments, which reach
 *   the namespace only once decoded,
 * - methods other than GET, HEAD and OPTIONS among them.
 */
const REFUSED: ReadonlyArray<[string, string]> = [
  ["GET", "/api/jobs/slot"],
  ["GET", "/api/jobs"],
  ["GET", "/api/jobs/inputs/coverage"],
  ["GET", "/api/nothing-here"],
  ["GET", "/api/jobs/nothing-here"],
  ["GET", "/api"],
  ["GET", "/api/"],
  ["GET", "/api/jobs/slot/"],
  ["GET", "/api/nothing-here/"],
  ["GET", "/api//jobs/slot"],
  ["GET", "/api//nothing-here"],
  ["GET", "/API/jobs/slot"],
  ["GET", "/Api/jobs/slot"],
  ["GET", "/API/nothing-here"],
  ["GET", "/%61pi/jobs/slot"],
  ["GET", "/%41PI/jobs/slot"],
  ["GET", "/%61pi/nothing-here"],
  ["GET", "/api/%6aobs/slot"],
  ["GET", "/api/jobs/%73lot"],
  ["GET", "/api%2Fjobs/slot"],
  ["GET", "/api/peerjs/%2e%2e/jobs/slot"],
  ["POST", "/api/nothing-here"],
  ["POST", "/api/jobs/slot"],
  ["DELETE", "/api/jobs/slot"],
  ["PATCH", "/api/jobs/inputs/coverage"],
  ["OPTIONS", "/api/nothing-here"],
  ["HEAD", "/api/jobs/slot"],
];

/** The broker's own route, in the spellings a client writes it: the peer server
 * attaches its WebSocket upgrade listener on the first GET under this subtree
 * (src/peerServer.ts), so a refusal reaching it would stop public signaling
 * rather than harden anything. */
const BROKER_PATHS: ReadonlyArray<string> = [
  "/api/peerjs/id",
  "/api/peerjs/id/",
  "/API/peerjs/id",
  "/%61pi/peerjs/id",
];

describe.skipIf(!hasBuild)("the /api namespace's refusal", () => {
  let hosted: ChildProcess | undefined;
  let consoleServer: ChildProcess | undefined;
  const roots: Array<string> = [];
  let hostedBase = "";
  let consoleBase = "";

  beforeAll(async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "psilink-api-ns-data-"));
    // The built server runs as an ordinary user here, so relocate the
    // pasted-credential scratch dir off the root-owned default it boots on.
    const credentialDir = mkdtempSync(join(tmpdir(), "psilink-api-ns-cred-"));
    roots.push(dataRoot, credentialDir);

    const hostedPort = await getFreePort();
    const hostedServer = await spawnProdServer(hostedPort, {
      // The hosted build leaves the profile unset; a data root it never reads
      // would not enable the API, so none is supplied.
      VITE_DEPLOYMENT_PROFILE: "",
      JOB_DATA_ROOT: "",
    });
    hosted = hostedServer.child;
    hostedBase = `http://127.0.0.1:${hostedPort}`;
    await waitForRoot(`${hostedBase}/`, hosted, hostedServer.getLaunchError);

    const consolePort = await getFreePort();
    const spawned = await spawnProdServer(consolePort, {
      VITE_DEPLOYMENT_PROFILE: "console",
      JOB_DATA_ROOT: dataRoot,
      JOB_SFTP_CREDENTIAL_DIR: credentialDir,
    });
    consoleServer = spawned.child;
    consoleBase = `http://127.0.0.1:${consolePort}`;
    await waitForRoot(`${consoleBase}/`, consoleServer, spawned.getLaunchError);
  }, 90_000);

  afterAll(async () => {
    await stopProdServer(hosted);
    await stopProdServer(consoleServer);
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  describe.each(ACCEPT_VALUES)("under Accept: %s", (_name, accept) => {
    test.each(REFUSED)(
      "a hosted probe reads the one refusal for %s %s",
      async (method, path) => {
        expect(await shapeOf(hostedBase, method, path, accept)).toEqual(
          refusalFor(method),
        );
      },
    );

    test.each(BROKER_PATHS)(
      "the broker still answers GET %s on the hosted build",
      async (path) => {
        const answered = await shapeOf(hostedBase, "GET", path, accept);
        expect(answered.status).toBe(200);
        expect(answered.bodyLength).toBeGreaterThan(0);
      },
    );

    test("a page outside /api is untouched", async () => {
      const rendered = await shapeOf(
        hostedBase,
        "GET",
        "/nothing-here",
        accept,
      );
      expect(rendered).not.toEqual(REFUSAL);
      expect(rendered.bodyLength).toBeGreaterThan(0);
    });

    test("a path whose decoded form leaves /api is untouched", async () => {
      const rendered = await shapeOf(hostedBase, "GET", "/ap%69x", accept);
      expect(rendered).not.toEqual(REFUSAL);
      expect(rendered.bodyLength).toBeGreaterThan(0);
    });
  });

  test("the job API answers its own routes where it is enabled", async () => {
    // The refusal reads the same enablement the per-route gate reads, so a
    // mis-keyed one would dark the console's own API rather than fail silently.
    const live = await shapeOf(
      consoleBase,
      "GET",
      "/api/jobs/slot",
      ACCEPT_VALUES[1][1],
    );
    expect(live.status).toBe(200);
    expect(live.bodyLength).toBeGreaterThan(0);
    const broker = await shapeOf(
      consoleBase,
      "GET",
      "/api/peerjs/id",
      ACCEPT_VALUES[1][1],
    );
    expect(broker.status).toBe(200);
  });
});
