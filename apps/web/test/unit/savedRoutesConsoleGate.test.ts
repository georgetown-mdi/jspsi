import { describe, expect, test, vi } from "vitest";

import { isRedirect } from "@tanstack/react-router";

import { Route as SavedIdRoute } from "../../src/routes/saved.$id.tsx";
import { Route as SavedIndexRoute } from "../../src/routes/saved.index.tsx";

// The recurring surface (`/saved`, `/saved/$id`) belongs to the hosted browser
// build. A console build has no managed store, so both routes redirect to the
// lobby at `/` before rendering. `isConsoleBuild` is the only knob a test varies;
// the rest of the module (the ConfigManager the psi rendezvous seam imports at load)
// stays real so importing the route modules does not fault.
const clientConfig = vi.hoisted(() => ({ consoleBuild: false }));
vi.mock("@utils/clientConfig", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isConsoleBuild: () => clientConfig.consoleBuild };
});

/** Invoke a route's beforeLoad and return what it threw, or undefined if it
 * returned without redirecting. */
function beforeLoadResult(route: {
  options: { beforeLoad?: (ctx: unknown) => unknown };
}): { threw: true; value: unknown } | { threw: false; value: unknown } {
  const beforeLoad = route.options.beforeLoad;
  if (beforeLoad === undefined) throw new Error("route declares no beforeLoad");
  try {
    return { threw: false, value: beforeLoad({}) };
  } catch (thrown) {
    return { threw: true, value: thrown };
  }
}

const cases: Array<{ name: string; route: unknown }> = [
  { name: "/saved", route: SavedIndexRoute },
  { name: "/saved/$id", route: SavedIdRoute },
];

describe("recurring routes are console-gated", () => {
  test.each(cases)("$name redirects to / on a console build", ({ route }) => {
    clientConfig.consoleBuild = true;
    const result = beforeLoadResult(
      route as { options: { beforeLoad?: (ctx: unknown) => unknown } },
    );
    expect(result.threw).toBe(true);
    expect(isRedirect(result.value)).toBe(true);
    expect((result.value as { options: { to?: string } }).options.to).toBe("/");
  });

  test.each(cases)(
    "$name renders (no redirect) on a hosted build",
    ({ route }) => {
      clientConfig.consoleBuild = false;
      const result = beforeLoadResult(
        route as { options: { beforeLoad?: (ctx: unknown) => unknown } },
      );
      expect(result.threw).toBe(false);
      expect(result.value).toBeUndefined();
    },
  );
});
