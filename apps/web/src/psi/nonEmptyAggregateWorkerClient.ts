import type { AggregateWorker } from "./nonEmptyAggregateController";

/**
 * Spawn the real aggregate worker. Isolated in its own module so the
 * `new Worker(new URL(...))` Vite resolves at build time is never pulled into the
 * Node-loadable controller (which the unit tests import) -- only the browser hook
 * imports this.
 */
export function defaultSpawnAggregateWorker(): AggregateWorker {
  // The worker's message contract is exactly AggregateRequest/AggregateResponse, so
  // adapt the structurally-wider real `Worker` to the narrow interface the
  // controller drives. The `{ type: "module" }` form lets the worker use ESM
  // imports (`@psilink/core`, the pure compute).
  return new Worker(new URL("./nonEmptyAggregate.worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as AggregateWorker;
}
