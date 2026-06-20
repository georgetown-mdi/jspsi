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

test("early-exits after the bound rather than walking every key", () => {
  // The whole point of the helper over `Object.keys(obj).length`: it stops once
  // the count passes `max`, so a pathological-count record is judged cheaply. A
  // Proxy reports a huge key set but tallies how many keys are inspected; a full
  // walk would inspect all 100k.
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
