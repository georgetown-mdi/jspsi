import { describe, expect, test } from "vitest";

import {
  declaredRoutePaths,
  matchesRoutePattern,
} from "../utils/declaredRoutes";
import { serviceWorkerStringArray } from "../utils/serviceWorkerHarness";

// The worker's SHELL_ROUTES is what an installed app warms so every route opens
// with no network, and it is a hand-written list: a route added to src/routes/
// without an entry here ships offline-broken, and nothing about writing the route
// would say so. This is that check. The route paths come from the route files
// themselves (see ../utils/declaredRoutes), so a change to the file-naming
// convention cannot make it silently vacuous. What the entries here actually pull
// out of the built deployment is test/integration/appShellWarm.test.ts.

const shellRoutes = serviceWorkerStringArray("SHELL_ROUTES");

describe("the worker's warmed route list", () => {
  test("covers every route the app declares", () => {
    const uncovered = declaredRoutePaths().filter(
      (pattern) =>
        !shellRoutes.some((route) => matchesRoutePattern(pattern, route)),
    );

    expect(uncovered).toEqual([]);
  });

  test("names no route the app does not declare", () => {
    const patterns = declaredRoutePaths();
    const stale = shellRoutes.filter(
      (route) =>
        !patterns.some((pattern) => matchesRoutePattern(pattern, route)),
    );

    expect(stale).toEqual([]);
  });

  test("reads a real list, so neither check above is vacuous", () => {
    expect(shellRoutes.length).toBeGreaterThan(1);
    expect(declaredRoutePaths().length).toBeGreaterThan(1);
  });
});
