import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  declaredRoutePaths,
  matchesRoutePattern,
} from "../utils/declaredRoutes";

import {
  serviceWorkerAssetExtractor,
  serviceWorkerString,
  serviceWorkerStringArray,
} from "../utils/serviceWorkerHarness";

import {
  getFreePort,
  hasBuild,
  spawnProdServer,
  stopProdServer,
  waitForRoot,
} from "./prodServer.js";

import type { ChildProcess } from "node:child_process";

// The app-shell worker discovers what to cache by reading `/assets/...` paths
// out of the documents the server renders (`hashedAssetPathsIn`), not from a
// build-time manifest -- a coupling to how Vite and TanStack Start emit module
// preloads that no unit test can hold. This drives the real built server from
// `npm run build -w apps/web` against whatever `.output` currently holds --
// rebuild before re-running to validate a change; CI always rebuilds first.

const READY_TIMEOUT_MS = 30_000;

/** What an installed app asks the worker to warm, and where the shell's own
 * install-time graph comes from -- both read from the shipped worker. */
const shellRoutes = serviceWorkerStringArray("SHELL_ROUTES");
const shellPath = serviceWorkerString("SHELL_PATH");
const hashedAssetPathsIn = serviceWorkerAssetExtractor();

describe.skipIf(!hasBuild)(
  "the route warm's asset extraction, over the production build",
  () => {
    let child: ChildProcess | undefined;
    let base = "";
    /** What the worker's extraction reads out of each warmed route's served
     * document: the assets warming that route would store. */
    const chunksByRoute = new Map<string, Array<string>>();

    beforeAll(async () => {
      const port = await getFreePort();
      const { child: proc, getLaunchError } = await spawnProdServer(port);
      child = proc;
      base = `http://127.0.0.1:${port}`;
      await waitForRoot(`${base}/`, proc, getLaunchError);

      for (const route of shellRoutes) {
        const response = await fetch(`${base}${route}`);
        const served = await response.text();
        if (!response.ok)
          throw new Error(
            `the built server answered the warmed route ${route} with ` +
              `${response.status}; SHELL_ROUTES names a path this deployment ` +
              `does not serve`,
          );
        chunksByRoute.set(route, hashedAssetPathsIn(served));
      }
    }, READY_TIMEOUT_MS + 20_000);

    afterAll(async () => {
      await stopProdServer(child);
    });

    test("finds assets in every warmed route's document", () => {
      const empty = [...chunksByRoute]
        .filter(([, chunks]) => chunks.length === 0)
        .map(([route]) => route);

      expect(empty).toEqual([]);
    });

    test("names only assets this deployment serves", async () => {
      const named = [...new Set([...chunksByRoute.values()].flat())];
      expect(named.length).toBeGreaterThan(0);

      const unserved: Array<string> = [];
      for (const path of named) {
        const response = await fetch(`${base}${path}`);
        // Release the socket: only the status matters here.
        await response.body?.cancel();
        if (!response.ok) unserved.push(`${path} (${response.status})`);
      }

      expect(unserved).toEqual([]);
    });

    test("brings each declared route code the shell's own graph does not", () => {
      const shellGraph = new Set(chunksByRoute.get(shellPath) ?? []);
      const declared = declaredRoutePaths();
      // Neither the install graph nor the route list may be empty, or the
      // comparison below would pass by having nothing to compare.
      expect(shellGraph.size).toBeGreaterThan(0);
      expect(declared.length).toBeGreaterThan(1);

      const unwarmed = declared.filter((pattern) => {
        // The shell path is the install-time graph itself, so it has nothing to
        // add beyond it.
        if (pattern === shellPath) return false;
        const warmed = shellRoutes.filter((route) =>
          matchesRoutePattern(pattern, route),
        );
        return !warmed.some((route) =>
          (chunksByRoute.get(route) ?? []).some(
            (chunk) => !shellGraph.has(chunk),
          ),
        );
      });

      expect(unwarmed).toEqual([]);
    });
  },
);
