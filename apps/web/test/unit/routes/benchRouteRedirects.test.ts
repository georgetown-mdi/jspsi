import { describe, expect, test } from "vitest";

import { isRedirect } from "@tanstack/react-router";

import { Route as BenchAcceptRoute } from "../../../src/routes/bench/accept.tsx";
import { Route as BenchExchangeRoute } from "../../../src/routes/bench/exchange.tsx";
import { Route as BenchIndexRoute } from "../../../src/routes/bench/index.tsx";
import { Route as BenchVerifyRoute } from "../../../src/routes/bench/verify.tsx";

// Every /bench/* path is a redirect to its primary path, kept so links
// issued before the primary routes existed still resolve. The invitation token
// rides only in the URL fragment and never reaches the server, so the
// redirect must preserve it: `hash: true` is the router's
// preserve-current-hash sentinel (buildLocation reads currentLocation.hash
// for it). Asserting each redirect has `hash: true` makes that an executable
// check.

function redirectThrownBy(route: {
  options: { beforeLoad?: (ctx: unknown) => unknown };
}): unknown {
  const beforeLoad = route.options.beforeLoad;
  if (beforeLoad === undefined) throw new Error("route declares no beforeLoad");
  try {
    beforeLoad({});
  } catch (thrown) {
    return thrown;
  }
  throw new Error("beforeLoad did not throw a redirect");
}

describe("bench route redirects preserve the fragment", () => {
  const cases: Array<{ name: string; route: unknown; to: string }> = [
    { name: "/bench -> /", route: BenchIndexRoute, to: "/" },
    {
      name: "/bench/accept -> /accept",
      route: BenchAcceptRoute,
      to: "/accept",
    },
    {
      name: "/bench/exchange -> /exchange",
      route: BenchExchangeRoute,
      to: "/exchange",
    },
    {
      name: "/bench/verify -> /verify",
      route: BenchVerifyRoute,
      to: "/verify",
    },
  ];

  test.each(cases)("$name has hash: true", ({ route, to }) => {
    const thrown = redirectThrownBy(
      route as { options: { beforeLoad?: (ctx: unknown) => unknown } },
    );
    expect(isRedirect(thrown)).toBe(true);
    const options = (thrown as { options: { to?: string; hash?: unknown } })
      .options;
    expect(options.to).toBe(to);
    // The sentinel passes the current fragment through verbatim; no explicit
    // string hash (which would replace it, not preserve it) and never a
    // dropped hash.
    expect(options.hash).toBe(true);
  });

  test("the accept redirect must resolve client-side (ssr disabled)", () => {
    // beforeLoad runs in the browser where window.location.hash is populated; the
    // fragment must never reach the server, so the redirect route opts out of SSR.
    expect(BenchAcceptRoute.options.ssr).toBe(false);
  });
});
