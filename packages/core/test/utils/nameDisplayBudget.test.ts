import { expect, test } from "vitest";

import { MAX_NAME_LENGTH } from "../../src/config/linkageTermsSchema";
import { DEFAULT_MAX_DISPLAY_LENGTH } from "../../src/utils/sanitizeForDisplay";

test("a name that fits the wire ceiling renders whole in the display budget", () => {
  // Two distinct names sharing a stem render as the same cut string once they run
  // past the per-value display budget, so a name the wire accepts has to fit
  // inside it: above the budget, two columns an operator can tell apart in their
  // own file reach a consent line identically. Nothing else asserts the coupling,
  // and a bare raise of the name ceiling is what would break it.
  expect(MAX_NAME_LENGTH).toBeLessThanOrEqual(DEFAULT_MAX_DISPLAY_LENGTH);
});
