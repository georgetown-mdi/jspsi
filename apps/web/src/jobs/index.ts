import { isJobApiEnabled, readJobApiConfig } from "./gate";
import { JobManager } from "./jobManager";
import { loadSftpRemotesFromEnv } from "./sftpRemotes";

import type { JobApiConfig } from "./gate";
import type { JobSftpRemotesTable } from "./sftpRemotes";

/**
 * The process-wide job manager, memoized on globalThis (not module scope). Like
 * the peer server, dev-mode HMR can re-evaluate this module; a global keeps it to
 * one manager per process, so the in-memory job table and its child processes are
 * not duplicated. Undefined until the job API is enabled and first used.
 *
 * The SFTP remotes table is memoized the same way: loaded once (at startup by
 * the server entry, or lazily on first use), then shared by every manager
 * construction.
 */
declare global {
  var jobManagerInstance: JobManager | undefined;
  var jobSftpRemotesTable: JobSftpRemotesTable | undefined;
}

/**
 * Return the operator-provisioned SFTP remotes table, loading it from the
 * environment on first use, or undefined when no remotes file is configured.
 * The server entry calls this at startup so a malformed table (or a remotes
 * file without a data root) refuses to boot -- the same fail-closed posture as
 * `assertJobApiStartupSafe`; a {@link JobApiConfigError} propagates to the
 * caller either way.
 */
export function useSftpRemotesTable(
  env: NodeJS.ProcessEnv = process.env,
): JobSftpRemotesTable | undefined {
  return (globalThis.jobSftpRemotesTable ??= loadSftpRemotesFromEnv(env));
}

/**
 * Return the shared {@link JobManager}, or null when the job API is disabled (no
 * data root configured). Constructs the manager lazily on first use with a data
 * root read from the environment, so a disabled deployment builds nothing and
 * spawns nothing. The manager carries the startup-loaded SFTP remotes table when
 * one is configured; the table never varies per request.
 */
export function useJobManager(
  config: JobApiConfig = readJobApiConfig(),
): JobManager | null {
  if (!isJobApiEnabled(config)) return null;
  if (globalThis.jobManagerInstance === undefined) {
    const sftpRemotes = useSftpRemotesTable();
    globalThis.jobManagerInstance = new JobManager({
      dataRoot: config.dataRoot,
      ...(sftpRemotes !== undefined ? { sftpRemotes } : {}),
    });
  }
  return globalThis.jobManagerInstance;
}

/**
 * SIGTERM every running child if a manager exists. Wired into the server
 * lifecycle so no orphaned CLI outlives the server; a no-op when the API was
 * never enabled.
 */
export function shutdownJobManager(): void {
  globalThis.jobManagerInstance?.shutdown();
}
