import { isJobApiEnabled, readJobApiConfig } from "./gate";
import { JobManager } from "./jobManager";
import { loadSftpServerFromEnv } from "./sftpServer";
import { useJobInputDir } from "./workInputs";
import { useJobRendezvousDir } from "./jobRendezvous";

import type { JobApiConfig } from "./gate";
import type { JobSftpServerEntry } from "./sftpServer";

/**
 * The process-wide job manager, memoized on globalThis (not module scope). Like
 * the peer server, dev-mode HMR can re-evaluate this module; a global keeps it to
 * one manager per process, so the in-memory job table and its child processes are
 * not duplicated. Undefined until the job API is enabled and first used.
 *
 * The SFTP server entry is memoized the same way: loaded once (at startup by
 * the server entry, or lazily on first use), then shared by every manager
 * construction.
 */
declare global {
  var jobManagerInstance: JobManager | undefined;
  var jobSftpServer: JobSftpServerEntry | undefined;
}

/**
 * Return the operator-provisioned SFTP server, loading it from the environment
 * on first use, or undefined when no server file is configured. The server
 * entry calls this at startup so a malformed block (or a server file without a
 * data root, or the superseded `JOB_SFTP_REMOTES` variable) refuses to boot --
 * the same fail-closed posture as `assertJobApiStartupSafe`; a
 * {@link JobApiConfigError} propagates to the caller either way.
 */
export function useSftpServer(
  env: NodeJS.ProcessEnv = process.env,
): JobSftpServerEntry | undefined {
  return (globalThis.jobSftpServer ??= loadSftpServerFromEnv(env));
}

/**
 * Return the shared {@link JobManager}, or null when the job API is disabled (no
 * data root configured). Constructs the manager lazily on first use with a data
 * root read from the environment, so a disabled deployment builds nothing and
 * spawns nothing. The manager carries the startup-loaded SFTP server and the
 * resolved work-input directory when configured; neither varies per request.
 */
export function useJobManager(
  config: JobApiConfig = readJobApiConfig(),
): JobManager | null {
  if (!isJobApiEnabled(config)) return null;
  if (globalThis.jobManagerInstance === undefined) {
    const sftpServer = useSftpServer();
    const jobInputDir = useJobInputDir();
    const jobRendezvousDir = useJobRendezvousDir();
    globalThis.jobManagerInstance = new JobManager({
      dataRoot: config.dataRoot,
      ...(sftpServer !== undefined ? { sftpServer } : {}),
      ...(jobInputDir !== undefined ? { jobInputDir } : {}),
      ...(jobRendezvousDir !== undefined ? { jobRendezvousDir } : {}),
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
