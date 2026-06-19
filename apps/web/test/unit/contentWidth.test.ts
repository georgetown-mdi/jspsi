import { describe, expect, test } from "vitest";

import {
  DEFAULT_CONTENT_WIDTH,
  resolveContentWidth,
} from "@components/contentWidth";

// The route-side half of the content-width seam: a route declares its width in
// staticData, and resolveContentWidth projects the active match chain to the one
// value the shell sizes both chrome and content to. The render side -- that the
// value reaches both the header and the content container -- is covered in
// test/browser/appShell.test.ts.
describe("resolveContentWidth", () => {
  test("returns the leaf route's declared width", () => {
    expect(
      resolveContentWidth([
        { staticData: {} },
        { staticData: { contentWidth: "lg" } },
      ]),
    ).toBe("lg");
  });

  test("uses the deepest match that declares a width", () => {
    // A leaf that declares none inherits the nearest ancestor that does, so a
    // shared layout route can set a default its leaves narrow from.
    expect(
      resolveContentWidth([
        { staticData: { contentWidth: "lg" } },
        { staticData: {} },
      ]),
    ).toBe("lg");
  });

  test("falls back to the default when no match declares a width", () => {
    expect(resolveContentWidth([{ staticData: {} }, {}])).toBe(
      DEFAULT_CONTENT_WIDTH,
    );
    expect(resolveContentWidth([])).toBe(DEFAULT_CONTENT_WIDTH);
  });

  test("defaults to the wide width", () => {
    // The home route's width and the bare-wordmark fallback; the accept route
    // opts into a narrower one.
    expect(DEFAULT_CONTENT_WIDTH).toBe("xl");
  });
});
