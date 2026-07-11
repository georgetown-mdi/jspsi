import { isJobApiEnabled, readJobApiConfig } from "./gate";
import { JobManager } from "./jobManager";

import type { JobApiConfig } from "./gate";

/**
 * The process-wide job manager, memoized on globalThis (not module scope). Like
 * the peer server, dev-mode HMR can re-evaluate this module; a global keeps it to
 * one manager per process, so the in-memory job table and its child processes are
 * not duplicated. Undefined until the job API is enabled and first used.
 */
declare global {
  var jobManagerInstance: JobManager | undefined;
}

/**
 * Return the shared {@link JobManager}, or null when the job API is disabled (no
 * data root configured). Constructs the manager lazily on first use with a data
 * root read from the environment, so a disabled deployment builds nothing and
 * spawns nothing.
 */
export function useJobManager(
  config: JobApiConfig = readJobApiConfig(),
): JobManager | null {
  if (!isJobApiEnabled(config)) return null;
  return (globalThis.jobManagerInstance ??= new JobManager({
    dataRoot: config.dataRoot,
  }));
}

/**
 * SIGTERM every running child if a manager exists. Wired into the server
 * lifecycle so no orphaned CLI outlives the server; a no-op when the API was
 * never enabled.
 */
export function shutdownJobManager(): void {
  globalThis.jobManagerInstance?.shutdown();
}
