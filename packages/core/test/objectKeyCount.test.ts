import { expect, test } from "vitest";

import { exceedsOwnKeyCount } from "../src/utils/objectKeyCount";

test("returns false at or below the bound, true above it", () => {
  expect(exceedsOwnKeyCount({}, 0)).toBe(false);
  expect(exceedsOwnKeyCount({ a: 1, b: 2 }, 2)).toBe(false);
  expect(exceedsOwnKeyCount({ a: 1, b: 2, c: 3 }, 2)).toBe(true);
});

test("counts own enumerable keys only, not inherited ones", () => {
  const proto = { inherited: 1 };
  const obj = Object.create(proto) as Record<string, unknown>;
  obj.own = 1;
  // `for...in` would visit `inherited`, but the hasOwnProperty guard keeps it from
  // counting toward the bound.
  expect(exceedsOwnKeyCount(obj, 1)).toBe(false);
});

test("stops at the bound instead of processing every key's body", () => {
  // Pins the loop's short-circuit: it returns as soon as a (max + 1)th own key is
  // seen rather than counting all keys then comparing. This bounds the per-key
  // BODY work, NOT the underlying enumeration -- on a real (non-Proxy) object V8
  // builds the full own-key list up front, so the helper is O(n) in key count
  // (see its doc comment); this is not a sub-linear-cost claim. The Proxy makes
  // the per-key descriptor reads observable; a variant that processed every key
  // would tally ~100k.
  let inspected = 0;
  const huge = new Proxy(
    {},
    {
      ownKeys: () => Array.from({ length: 100_000 }, (_, i) => `k${i}`),
      getOwnPropertyDescriptor: () => {
        inspected++;
        return { enumerable: true, configurable: true, value: 1 };
      },
    },
  );
  expect(exceedsOwnKeyCount(huge, 8)).toBe(true);
  expect(inspected).toBeLessThan(64);
});
