import { describe, expect, test } from "vitest";

import { isRedirect } from "@tanstack/react-router";

import { Route as BenchAcceptRoute } from "../../src/routes/bench/accept.tsx";
import { Route as BenchExchangeRoute } from "../../src/routes/bench/exchange.tsx";
import { Route as BenchIndexRoute } from "../../src/routes/bench/index.tsx";
import { Route as BenchVerifyRoute } from "../../src/routes/bench/verify.tsx";

// The cutover moved the bench onto the primary routes and turned every /bench/*
// path into a redirect to its primary path. The redirect must PRESERVE the URL
// fragment: the invitation token rides only in the fragment (it never reaches the
// server), so a dropped hash breaks the deep link and a server-visible hash leaks
// it. `hash: true` is the router's carry-current-hash sentinel (buildLocation reads
// currentLocation.hash for it), so asserting each redirect carries `hash: true`
// pins the fragment-preservation mechanism as an executable check -- a redirect
// that dropped the hash, or targeted the wrong primary path, fails here.

/** Invoke a redirect route's beforeLoad and return the redirect it throws. */
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

  test.each(cases)("$name carries hash: true", ({ route, to }) => {
    const thrown = redirectThrownBy(
      route as { options: { beforeLoad?: (ctx: unknown) => unknown } },
    );
    expect(isRedirect(thrown)).toBe(true);
    const options = (thrown as { options: { to?: string; hash?: unknown } })
      .options;
    expect(options.to).toBe(to);
    // The current fragment is carried verbatim by the sentinel; no explicit string
    // hash (which would replace, not preserve) and never a dropped hash.
    expect(options.hash).toBe(true);
  });

  test("the accept redirect must resolve client-side (ssr disabled)", () => {
    // beforeLoad runs in the browser where window.location.hash is populated; the
    // fragment must never reach the server, so the redirect route opts out of SSR.
    expect(BenchAcceptRoute.options.ssr).toBe(false);
  });
});
