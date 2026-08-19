import { FAN_OUT_FUNCTION_NAMES } from "../../src/standardization";

/**
 * Run `body` with FAN_OUT_FUNCTION_NAMES emptied, so `split_on` stands in for the
 * case core has no occupant for: a standardizing function that expands one value
 * into several candidates without being listed as a fan-out producer.
 *
 * Every rule the width bound and the assembly cap enforce binds the LISTED
 * producers (docs/spec/PROTOCOL.md, Fan-out matching), so an unlisted one must
 * stay fail-closed instead -- carried to the strategy, which refuses it. A step
 * captures the membership when it compiles, so the dataset or key under test must
 * be built inside `body`.
 */
export function withUnlistedFanOutFunctions<T>(body: () => T): T {
  const names = FAN_OUT_FUNCTION_NAMES as string[];
  const listed = [...names];
  names.length = 0;
  try {
    return body();
  } finally {
    names.push(...listed);
  }
}
