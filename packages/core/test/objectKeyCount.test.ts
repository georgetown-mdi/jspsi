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
  // `for...in` would visit `inherited`, but the hasOwnProperty guard keeps it
  // from counting toward the bound.
  expect(exceedsOwnKeyCount(obj, 1)).toBe(false);
});

test("stops at the bound instead of processing every key's body", () => {
  // Pins the loop's short-circuit: it returns once the (max + 1)th own key
  // appears, without counting every key first. This bounds only the per-key
  // body work, not enumeration -- V8 builds the full own-key list up front for
  // a real object, so the helper is O(n) in key count (see its doc comment),
  // not sub-linear. The Proxy makes per-key descriptor reads observable;
  // scanning every key would tally ~100k.
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
