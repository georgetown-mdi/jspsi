import { withNoListedFanOutFunctions } from "../../src/fanOutFunctions";

/**
 * Runs `body` with no function listed as a fan-out producer, so `split_on`
 * stands in for a standardizing function that expands one value into several
 * candidates without being listed as one. Only LISTED producers are bound by
 * the width bound and assembly cap (docs/spec/PROTOCOL.md, Fan-out matching);
 * an unlisted one stays fail-closed, routed to the strategy, which refuses it.
 * A step captures membership at compile time: build the dataset or key under
 * test inside `body`.
 */
export function withUnlistedFanOutFunctions<T>(body: () => T): T {
  return withNoListedFanOutFunctions(body);
}
