import { withNoListedFanOutFunctions } from "../../src/fanOutFunctions";

/**
 * Run `body` with no function listed as a fan-out producer, so `split_on` stands
 * in for the case core has no occupant for: a standardizing function that expands
 * one value into several candidates without being listed as one.
 *
 * Every rule the width bound and the assembly cap enforce binds the LISTED
 * producers (docs/spec/PROTOCOL.md, Fan-out matching), so an unlisted one must
 * stay fail-closed instead -- carried to the strategy, which refuses it. A step
 * captures the membership when it compiles, so the dataset or key under test must
 * be built inside `body`.
 */
export function withUnlistedFanOutFunctions<T>(body: () => T): T {
  return withNoListedFanOutFunctions(body);
}
