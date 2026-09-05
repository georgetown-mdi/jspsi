// The published entry points, driven as a consumer gets them: the built
// `@psilink/core` and `@psilink/core/testing`, not this source tree. Plain
// JavaScript because that is what the artifacts are.
//
// The fan-out listing is module state the testing entry's lever rewrites and the
// main entry's compiled steps read, so it only works while both entries reach ONE
// copy of `src/fanOutFunctions.ts` at run time. A build giving each entry its own
// copy passes every source-level test and leaves the lever rewriting a listing
// nothing reads.

import { beforeAll, expect, test, vi } from "vitest";

import {
  describeCoreDistStaleness,
  formatCoreDistStaleness,
} from "../../../scripts/lib/coreDistFreshness.mjs";

import {
  StandardizedDataset,
  StandardizedField,
  buildKeyStrings,
  getLogger,
} from "@psilink/core";
import {
  FAN_OUT_CANDIDATES_PER_ELEMENT,
  withNoListedFanOutFunctions,
} from "@psilink/core/testing";

beforeAll(() => {
  const staleness = describeCoreDistStaleness();
  if (staleness !== null) throw new Error(formatCoreDistStaleness(staleness));
});

const KEY = {
  name: "LN+DOB",
  elements: [{ field: "last_name" }, { field: "date_of_birth" }],
};

// A row whose last name expands past the width the key declares, through the one
// listed producer. Built per call because a step captures the listing when it
// compiles.
function overWideDataset() {
  const names = Array.from(
    { length: FAN_OUT_CANDIDATES_PER_ELEMENT + 1 },
    (_unused, index) => `NAME${index}`,
  );
  const rows = [{ last_name: names.join("|"), date_of_birth: "19750716" }];
  return new StandardizedDataset(
    [
      new StandardizedField(
        "last_name",
        "last_name",
        [{ function: "split_on", params: { delimiter: "\\|" } }],
        rows,
      ),
      new StandardizedField("date_of_birth", "date_of_birth", [], rows),
    ],
    [KEY],
  );
}

test("the testing entry's fan-out lever rewrites the listing the main entry reads", () => {
  vi.spyOn(getLogger("cleaning"), "warn").mockImplementation(() => {});

  // With `split_on` declared, the over-width row contributes nothing.
  expect(buildKeyStrings(KEY, overWideDataset(), 0)).toBeNull();

  // With nothing declared, the same expansion is an unlisted producer's, which
  // is carried to the strategy that refuses it rather than dropped.
  const carried = withNoListedFanOutFunctions(() =>
    buildKeyStrings(KEY, overWideDataset(), 0),
  );
  expect(carried?.size).toBe(FAN_OUT_CANDIDATES_PER_ELEMENT + 1);

  // And the listing is back afterwards, in the copy the main entry reads.
  expect(buildKeyStrings(KEY, overWideDataset(), 0)).toBeNull();

  vi.restoreAllMocks();
});
