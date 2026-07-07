import { encodePsiWorkerInit } from "./psiCryptoController";

import type {
  PsiCryptoWorker,
  SpawnPsiCryptoWorker,
} from "./psiCryptoController";

/**
 * Spawn the real PSI-crypto worker. Isolated in its own module so the
 * `new Worker(new URL(...))` Vite resolves and bundles at build time is pulled in
 * only where a worker is actually spawned (imported from
 * {@link ./exchangeLifecycle} in the browser) and never evaluated under Node -- which
 * {@link ./psiCryptoController}'s unit tests import.
 *
 * The role/id seed rides the Worker's `name` (the browser analogue of the CLI
 * worker's `workerData`; see {@link encodePsiWorkerInit}), so it is available
 * synchronously at worker startup and the worker's message channel carries only
 * crypto requests. `{ type: "module" }` lets the worker use ESM imports
 * (`@psilink/core`, the WASM worker build). The real `Worker` is structurally wider
 * than the narrow interface the host drives, so adapt it.
 */
export const defaultSpawnPsiCryptoWorker: SpawnPsiCryptoWorker = (init) =>
  new Worker(new URL("./psiCrypto.worker.ts", import.meta.url), {
    type: "module",
    name: encodePsiWorkerInit(init),
  }) as unknown as PsiCryptoWorker;
