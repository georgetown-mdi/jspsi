import { computeFieldCoverage } from "./nonEmptyAggregate";

import type {
  AggregateRequest,
  AggregateResponse,
} from "./nonEmptyAggregateController";

/**
 * The off-main-thread entry for the silent-empty aggregate. Seeded once with the
 * full row set, it recomputes {@link computeFieldCoverage} for each standardization
 * the controller posts and returns the rates tagged with the request token. Bundled
 * by Vite from {@link ./nonEmptyAggregateWorkerClient}; it pulls in only the pure
 * compute and core's pipeline runner, nothing DOM.
 */

// Worker globals are not in the app's DOM lib; narrow `globalThis` to the one
// dedicated-worker affordance this entry uses rather than pulling the WebWorker lib
// into the whole program (which would clash with DOM on `self`/`postMessage`).
interface WorkerScope {
  onmessage: ((event: { data: AggregateRequest }) => void) | null;
  postMessage: (message: AggregateResponse) => void;
}
const scope = globalThis as unknown as WorkerScope;

let rows: ReadonlyArray<Record<string, string>> = [];
let seeded = false;

scope.onmessage = (event) => {
  const request = event.data;
  if (request.kind === "rows") {
    rows = request.rawRows;
    seeded = true;
    return;
  }
  // The controller seeds the rows synchronously in its constructor before any compute
  // and worker messages are delivered in order, so a compute always arrives seeded.
  // Guard it regardless: computing over the empty default would report 0% for every
  // field -- a false silent-empty alarm, the exact failure this module exists to
  // surface honestly. Throwing routes to the controller's onerror, which settles the
  // check to "unavailable" (an honest unknown) rather than a fabricated collapse.
  if (!seeded)
    throw new Error("aggregate worker computed before rows were seeded");
  scope.postMessage({
    token: request.token,
    rates: computeFieldCoverage(rows, request.standardization),
  });
};
