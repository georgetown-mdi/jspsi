import { getLogger } from "@psilink/core";

import {
  CONSOLE_PROFILE,
  DEPLOYMENT_PROFILE_ENV,
  JOB_DATA_ROOT_ENV,
  isJobApiEnabled,
  readJobApiConfig,
} from "./gate";
import { resolveJobRendezvousDir, useJobRendezvousDir } from "./jobRendezvous";
import {
  resolveSftpCredentialScratchDir,
  setupSftpCredentialScratchDir,
} from "./sftpScratch";
import { JobManager } from "./jobManager";
import { useJobInputDir } from "./workInputs";
import { useJobSecretsDir } from "./jobSecrets";

import type { JobApiConfig } from "./gate";

const log = getLogger("job-api");

/**
 * The process-wide job manager, memoized on globalThis (not module scope). Like
 * the peer server, dev-mode HMR can re-evaluate this module; a global keeps it to
 * one manager per process, so the in-memory job table and its child processes are
 * not duplicated. Undefined until the job API is enabled and first used.
 */
declare global {
  var jobManagerInstance: JobManager | undefined;
  var jobSftpCredentialScratchDir: string | undefined;
}

/**
 * Prepare the pasted-credential scratch directory at server startup when the job
 * API is enabled, memoizing the resolved path for the lazy manager construction.
 * Fail-closed: the setup asserts the directory resolves strictly outside every
 * operator mount -- the data root, the rendezvous directory, the secrets mount,
 * and the work-input directory (a misconfiguration refuses the boot) -- creates it
 * owner-only, and sweeps any credential a prior run orphaned. A no-op when the API
 * is disabled -- no manager is constructed, so no paste can be authored. The
 * server entry calls this once at startup; a {@link JobApiConfigError} propagates
 * and refuses startup.
 */
export function bootSftpCredentialScratchDir(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const config = readJobApiConfig(env);
  if (!isJobApiEnabled(config)) return;
  if (globalThis.jobSftpCredentialScratchDir !== undefined) return;
  globalThis.jobSftpCredentialScratchDir = setupSftpCredentialScratchDir(
    resolveSftpCredentialScratchDir(env),
    config.dataRoot,
    resolveJobRendezvousDir(env),
    useJobSecretsDir(env),
    useJobInputDir(env),
  );
}

/**
 * Log a startup diagnostic when a data root is configured but the deployment
 * profile is not `console`, so the job API stays disabled despite
 * `JOB_DATA_ROOT`. A no-op in a console build (the API is enabled) and in the
 * plain hosted case (no data root, nothing an operator meant to turn on). The
 * server entry calls this once at startup, the only point at which the mismatch
 * is reachable: {@link isJobApiEnabled} gates every route to 404 before
 * {@link useJobManager} runs, so a mismatched config never reaches the manager
 * on a request. Non-fatal -- a misconfigured hosted build boots with the job API
 * dark rather than refusing to start.
 */
export function warnJobApiProfileMismatch(
  config: JobApiConfig = readJobApiConfig(),
): void {
  if (isJobApiEnabled(config) || config.dataRoot.length === 0) return;
  log.warn(
    `${JOB_DATA_ROOT_ENV} is set but ${DEPLOYMENT_PROFILE_ENV} is not ` +
      `"${CONSOLE_PROFILE}"; the job API stays disabled (it runs only in a ` +
      "console build).",
  );
}

/**
 * Return the shared {@link JobManager}, or null when the job API is disabled (no
 * data root configured). Constructs the manager lazily on first use with a data
 * root read from the environment, so a disabled deployment builds nothing and
 * spawns nothing. The manager carries the resolved work-input directory when
 * configured; it does not vary per request.
 */
export function useJobManager(
  config: JobApiConfig = readJobApiConfig(),
): JobManager | null {
  if (!isJobApiEnabled(config)) return null;
  if (globalThis.jobManagerInstance === undefined) {
    const jobInputDir = useJobInputDir();
    const jobRendezvousDir = useJobRendezvousDir();
    const jobSecretsDir = useJobSecretsDir();
    // The scratch dir is prepared at boot (bootSftpCredentialScratchDir); read the
    // memoized path so a paste materializes there. Absent only if the boot setup
    // did not run, in which case a paste is refused rather than composed inline.
    const credentialScratchDir = globalThis.jobSftpCredentialScratchDir;
    globalThis.jobManagerInstance = new JobManager({
      dataRoot: config.dataRoot,
      ...(jobInputDir !== undefined ? { jobInputDir } : {}),
      ...(jobRendezvousDir !== undefined ? { jobRendezvousDir } : {}),
      ...(jobSecretsDir !== undefined ? { jobSecretsDir } : {}),
      ...(credentialScratchDir !== undefined ? { credentialScratchDir } : {}),
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
