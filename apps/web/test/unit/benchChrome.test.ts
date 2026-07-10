import { describe, expect, test } from "vitest";

import { DEFAULT_CHROME, resolveChrome } from "@components/chrome";

describe("resolveChrome", () => {
  test("defaults to the legacy shell when no match declares a chrome", () => {
    expect(resolveChrome([])).toBe("legacy");
    expect(resolveChrome([{ staticData: {} }, {}])).toBe(DEFAULT_CHROME);
  });

  test("a layout route's declaration reaches its whole subtree", () => {
    expect(
      resolveChrome([
        { staticData: {} },
        { staticData: { chrome: "bench" } },
        { staticData: {} },
      ]),
    ).toBe("bench");
  });

  test("the deepest declaring match wins", () => {
    expect(
      resolveChrome([
        { staticData: { chrome: "legacy" } },
        { staticData: { chrome: "bench" } },
      ]),
    ).toBe("bench");
    expect(
      resolveChrome([
        { staticData: { chrome: "bench" } },
        { staticData: { chrome: "legacy" } },
      ]),
    ).toBe("legacy");
  });
});
