import type { CSVParseWorker } from "./csvParseController";

/**
 * Spawn the real CSV-parse worker. Isolated in its own module so the
 * `new Worker(new URL(...))` Vite resolves at build time is pulled in only where a
 * worker is actually spawned -- imported lazily from {@link ./csvParseController} in
 * the browser -- and never loaded under Node (which the controller's unit tests
 * import).
 */
export function defaultSpawnCSVParseWorker(): CSVParseWorker {
  // `{ type: "module" }` lets the worker use ESM imports (`@psilink/core`). The real
  // `Worker` is structurally wider than the narrow interface the controller drives,
  // so adapt it.
  return new Worker(new URL("./csvParse.worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as CSVParseWorker;
}
