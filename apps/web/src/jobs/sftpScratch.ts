import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { JOB_FILE_MODE, WORKDIR_MODE } from "./workdir";
import { JobApiConfigError } from "./gate";

/**
 * The fixed, container-internal directory a PASTED SFTP credential is
 * materialized to. It is deliberately NOT `JOB_DATA_ROOT` and NOT the resolved
 * `JOB_RENDEZVOUS_DIR`, and it needs no extra operator mount, so a raw paste
 * works with only the data root mounted. A pasted secret lives at rest only here,
 * as a server-owned 0600 file, and only long enough to be delivered to the CLI
 * child as an `@path`. The directory is owner-only (0700) and swept clean at
 * server start, so a credential orphaned by a restart never lingers -- unlike a
 * workdir, an SSH credential must not inherit the "lingers until deleted"
 * behavior. `/run` is the conventional runtime-state location; mount a tmpfs
 * there to keep pasted secrets off disk entirely, but the sweep is the backstop
 * when the container does not.
 */
export const SFTP_CREDENTIAL_SCRATCH_DIR = "/run/psilink/sftp-credentials";

/**
 * A server-side override for the scratch directory, defaulting to
 * {@link SFTP_CREDENTIAL_SCRATCH_DIR}. The container image runs as root and uses
 * the default; a non-root deployment (or the integration harness, which runs the
 * built server as an ordinary user) points it at a writable, non-partner-syncable
 * location instead. It is server-side configuration, never derived from a request,
 * and the boot containment assertion guards it exactly as it does the default -- a
 * value inside the data root or rendezvous mount refuses the boot.
 */
export const JOB_SFTP_CREDENTIAL_DIR_ENV = "JOB_SFTP_CREDENTIAL_DIR";

/** Resolve the scratch directory from {@link JOB_SFTP_CREDENTIAL_DIR_ENV},
 * falling back to the fixed container-internal default. */
export function resolveSftpCredentialScratchDir(
  env: NodeJS.ProcessEnv,
): string {
  const configured = (env[JOB_SFTP_CREDENTIAL_DIR_ENV] ?? "").trim();
  return configured.length > 0 ? configured : SFTP_CREDENTIAL_SCRATCH_DIR;
}

/**
 * Prepare the pasted-credential scratch directory at server start, fail-closed:
 * assert it resolves strictly OUTSIDE the data root and the rendezvous directory
 * (a misconfiguration that placed it inside either would make a pasted secret
 * partner-syncable or client-reachable, so it refuses the boot), create it
 * owner-only, and SWEEP any credential a prior run orphaned. Returns the resolved
 * directory. Called once at boot; a failure propagates as a {@link
 * JobApiConfigError} that refuses startup, matching the appliance's posture.
 */
export function setupSftpCredentialScratchDir(
  scratchDir: string,
  dataRoot: string,
  rendezvousDir: string | undefined,
): string {
  const resolved = path.resolve(scratchDir);
  assertScratchOutside(resolved, dataRoot, rendezvousDir);
  fs.mkdirSync(resolved, { recursive: true, mode: WORKDIR_MODE });
  fs.chmodSync(resolved, WORKDIR_MODE);
  // Re-assert on the realpath once the directory exists, so a symlinked scratch
  // path that lexically looked outside but resolves into an excluded mount is
  // caught before it is swept (a sweep of an excluded dir would delete operator
  // or partner data).
  assertScratchOutside(resolved, dataRoot, rendezvousDir);
  sweepScratchDir(resolved);
  return resolved;
}

/**
 * Materialize a pasted credential value to a server-owned 0600 file under
 * `scratchDir` with a server-generated name, returning its absolute path. Reuses
 * the workdir chmod-after-write discipline (the mode argument is not trusted
 * without a following `chmod`, since a permissive umask is not guaranteed). The
 * value is written and then dropped: the caller holds it only between request
 * parse and this write.
 */
export function materializeSftpCredential(
  scratchDir: string,
  value: string,
): string {
  const filePath = path.join(scratchDir, crypto.randomUUID());
  fs.writeFileSync(filePath, value, { mode: JOB_FILE_MODE });
  fs.chmodSync(filePath, JOB_FILE_MODE);
  return filePath;
}

/** Delete a materialized credential file. Idempotent (a missing file is not an
 * error), so it is safe to call on clear, delete, or a re-author that replaces a
 * prior pasted credential. */
export function removeSftpCredentialFile(filePath: string): void {
  fs.rmSync(filePath, { force: true });
}

/**
 * Refuse a scratch directory that is, contains, or is contained by the data root
 * or the rendezvous directory. Both nesting directions are rejected: a scratch
 * inside an excluded dir would expose the pasted secret through it, and an
 * excluded dir inside the scratch would be destroyed by the boot sweep. Checked
 * on both the lexical resolve and the realpath (when present) of each, so a
 * symlink cannot slip an excluded dir past the test. Names the excluded
 * directory's label only, never a path.
 */
function assertScratchOutside(
  scratchResolved: string,
  dataRoot: string,
  rendezvousDir: string | undefined,
): void {
  const exclusions: Array<{ dir: string; label: string }> = [];
  const add = (dir: string, label: string): void => {
    for (const form of new Set([path.resolve(dir), realpathIfPresent(dir)]))
      exclusions.push({ dir: form, label });
  };
  add(dataRoot, "the job data root");
  if (rendezvousDir !== undefined)
    add(rendezvousDir, "the rendezvous directory");

  const scratchForms = new Set([
    scratchResolved,
    realpathIfPresent(scratchResolved),
  ]);
  for (const { dir, label } of exclusions)
    for (const scratch of scratchForms)
      if (isWithin(dir, scratch) || isWithin(scratch, dir))
        throw new JobApiConfigError(
          "the pasted-credential scratch directory must resolve strictly " +
            `outside ${label}`,
        );
}

/** Whether `child` is `parent` itself or nested under it, over resolved absolute
 * paths (segment-aware, so a `..`-prefixed sibling is not read as inside). */
function isWithin(parent: string, child: string): boolean {
  if (parent === child) return true;
  const relative = path.relative(parent, child);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

/** Canonicalize `dir` to its realpath, or its lexical resolve when it does not
 * yet exist (the data root is created lazily on the first job). */
function realpathIfPresent(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** Remove every entry directly under the scratch directory. A missing or
 * unreadable directory is a no-op -- the create step is the one that must
 * succeed. */
function sweepScratchDir(dir: string): void {
  let names: Array<string>;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names)
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
}
