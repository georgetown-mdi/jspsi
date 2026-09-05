import { describe, expect, test } from "vitest";

import {
  declaredRoutePaths,
  matchesRoutePattern,
} from "../utils/declaredRoutes";
import { serviceWorkerStringArray } from "../utils/serviceWorkerHarness";

// SHELL_ROUTES is the worker's hand-written list of routes an installed app
// warms for offline use; a route added to src/routes/ without an entry here
// ships offline-broken, silently. This is that check, reading route paths
// from the route files themselves (../utils/declaredRoutes) rather than a
// separately hand-written list. What the entries actually pull out of the
// built deployment is test/integration/appShellWarm.test.ts.

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
