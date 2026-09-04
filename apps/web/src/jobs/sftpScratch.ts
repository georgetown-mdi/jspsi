import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { JOB_FILE_MODE, WORKDIR_MODE } from "./workdir";
import { JobApiConfigError } from "./gate";
import { isPathWithin } from "./pathContainment";

/**
 * The fixed, container-internal directory a PASTED SFTP credential is
 * materialized to. It is NOT `JOB_DATA_ROOT` and NOT the resolved
 * `JOB_RENDEZVOUS_DIR`, and needs no extra operator mount, so a raw paste
 * works with only the data root mounted. A pasted secret lives at rest only
 * here, as a server-owned 0600 file, only long enough to be delivered to the
 * CLI child as an `@path`. The directory is owner-only (0700) and swept clean
 * at server start, so a credential orphaned by a restart never lingers --
 * unlike a workdir, an SSH credential must not inherit the "lingers until
 * deleted" behavior. `/run` is the conventional runtime-state location; mount
 * a tmpfs there to keep pasted secrets off disk entirely, with the sweep as
 * the fallback when the container does not.
 */
export const SFTP_CREDENTIAL_SCRATCH_DIR = "/run/psilink/sftp-credentials";

/**
 * A server-side override for the scratch directory, defaulting to
 * {@link SFTP_CREDENTIAL_SCRATCH_DIR}. The container image ships that default
 * directory owned by the unprivileged account it runs as, so it uses the default;
 * a deployment running under some other account -- a container started with
 * `--user`, which is how the console launcher runs one against a data root the
 * operator owns -- or the integration harness, which runs the built server as an
 * ordinary user, points it at a writable, non-partner-syncable location instead,
 * since the fixed default sits under root-owned `/run` and cannot be created at
 * boot. It is server-side
 * configuration, never derived from a request, and the boot containment assertion
 * guards it exactly as it does the default -- a value inside the data root or
 * rendezvous mount refuses the boot.
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
 * assert it resolves strictly OUTSIDE every operator mount -- the data root,
 * every rendezvous mount, the secrets mount, and the work-input directory,
 * each in both nesting directions -- create it owner-only, and SWEEP any
 * credential a prior run orphaned. A scratch dir coinciding with, nesting
 * under, or containing any of those mounts would expose a pasted secret or be
 * destroyed by the boot sweep, so it refuses the boot. Containment is checked
 * on the realpath twice: BEFORE any directory is created or re-moded (so a
 * symlinked scratch path cannot cause a side effect before the refusal), and
 * again after creation and before the destructive sweep (so a symlink swapped
 * into the scratch path in that window cannot lead the sweep into an operator
 * mount). Called once at boot; a failure propagates as a {@link
 * JobApiConfigError} that refuses startup, matching the console's posture.
 */
export function setupSftpCredentialScratchDir(
  scratchDir: string,
  dataRoot: string,
  rendezvousDirs: ReadonlyArray<string>,
  secretsDir?: string,
  inputDir?: string,
): string {
  const resolved = path.resolve(scratchDir);
  const exclusions = scratchExclusions(
    dataRoot,
    rendezvousDirs,
    secretsDir,
    inputDir,
  );
  assertScratchOutside(resolved, exclusions);
  assertScratchOutside(intendedRealpath(resolved), exclusions);
  try {
    fs.mkdirSync(resolved, { recursive: true, mode: WORKDIR_MODE });
    fs.chmodSync(resolved, WORKDIR_MODE);
  } catch (error) {
    throw scratchFsError(resolved, "created", error);
  }
  assertScratchOutside(realpathIfPresent(resolved), exclusions);
  try {
    sweepScratchDir(resolved);
  } catch (error) {
    throw scratchFsError(resolved, "swept", error);
  }
  return resolved;
}

/**
 * Materialize a pasted credential value to a server-owned 0600 file under
 * `scratchDir` with a server-generated name, returning its absolute path.
 * Reuses the workdir chmod-after-write discipline (the mode argument is not
 * trusted without a following `chmod`, since a permissive umask is not
 * guaranteed). The value is written and then dropped: the caller holds it
 * only between request parse and this write. A failure after the file is
 * created (a partial write, a chmod that cannot set the mode) best-effort
 * removes the file before rethrowing the ORIGINAL error; a cleanup that
 * itself fails is swallowed so it cannot mask that error, and the boot sweep
 * is the safety check for any residue it leaves.
 */
export function materializeSftpCredential(
  scratchDir: string,
  value: string,
): string {
  const filePath = path.join(scratchDir, crypto.randomUUID());
  try {
    fs.writeFileSync(filePath, value, { mode: JOB_FILE_MODE });
    fs.chmodSync(filePath, JOB_FILE_MODE);
  } catch (error) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Cleanup is best-effort: a delete that itself fails (EROFS/EIO) must not
      // mask the original write/chmod error, and the boot sweep is the safety
      // check for the residue it leaves.
    }
    throw error;
  }
  return filePath;
}

/** Delete a materialized credential file. Idempotent (a missing file is not an
 * error), so it is safe to call on clear, delete, or a re-author that replaces a
 * prior pasted credential. */
export function removeSftpCredentialFile(filePath: string): void {
  fs.rmSync(filePath, { force: true });
}

/**
 * A resolved directory the scratch dir must stay OUTSIDE, paired with the human
 * label a rejection names.
 */
interface ScratchExclusion {
  dir: string;
  label: string;
}

/**
 * The operator mounts the scratch directory must resolve strictly outside: the
 * data root, every configured rendezvous mount (one on a single-mount console,
 * both legs on a split-provisioned console), and -- when configured -- the
 * secrets mount and the work-input directory. Each is added both as its lexical
 * resolve and, when it exists, its realpath, so a symlinked mount is caught too.
 * Duplicates are dropped.
 */
function scratchExclusions(
  dataRoot: string,
  rendezvousDirs: ReadonlyArray<string>,
  secretsDir: string | undefined,
  inputDir: string | undefined,
): Array<ScratchExclusion> {
  const exclusions: Array<ScratchExclusion> = [];
  const add = (dir: string, label: string): void => {
    for (const form of new Set([path.resolve(dir), realpathIfPresent(dir)]))
      exclusions.push({ dir: form, label });
  };
  add(dataRoot, "the job data root");
  for (const rendezvousDir of rendezvousDirs)
    add(rendezvousDir, "the rendezvous directory");
  if (secretsDir !== undefined) add(secretsDir, "the secrets mount");
  if (inputDir !== undefined) add(inputDir, "the work-input directory");
  return exclusions;
}

/**
 * Refuse a scratch path that is, contains, or is contained by any excluded mount.
 * Both nesting directions are rejected: a scratch inside an excluded dir would
 * expose the pasted secret through it, and an excluded dir inside the scratch would
 * be destroyed by the boot sweep. Names the excluded directory's label only, never
 * a path.
 */
function assertScratchOutside(
  scratch: string,
  exclusions: Array<ScratchExclusion>,
): void {
  for (const { dir, label } of exclusions)
    if (
      isPathWithin(dir, scratch, "at-or-under") ||
      isPathWithin(scratch, dir, "at-or-under")
    )
      throw new JobApiConfigError(
        "the pasted-credential scratch directory must resolve strictly " +
          `outside ${label}`,
      );
}

/**
 * Resolve where a `mkdir -p` of `target` would land, following any LIVE symlinked
 * ancestor, WITHOUT creating anything: the realpath of `target` if it exists,
 * otherwise the realpath of its nearest existing ancestor with the non-existent
 * tail re-appended. Only live (resolvable) symlinks are followed -- a dangling
 * symlink component throws in `realpathSync`, so reconstruction falls back to
 * re-appending it as a plain tail segment, and the subsequent `mkdirSync` of
 * `target` then fails closed on that dangling component, creating nothing. Lets the
 * boot containment check run on the true resolved path before any directory is
 * created or re-moded.
 */
function intendedRealpath(target: string): string {
  const tail: Array<string> = [];
  let current = target;
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length === 0 ? real : path.join(real, ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...tail);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Wrap a scratch-directory filesystem failure as the typed {@link
 * JobApiConfigError} the boot expects, naming the (server-side, non-secret)
 * scratch path, the errno, and the override that relocates it. The override is
 * named because the reader who meets this most is the one the path and errno
 * leave nowhere to go: a console run as an account other than the one the
 * image built the default directory for, where the default under root-owned
 * `/run` cannot be created, every operator mount is excluded, and this variable
 * is the only thing left that moves it.
 */
function scratchFsError(
  scratchPath: string,
  action: string,
  error: unknown,
): JobApiConfigError {
  const code =
    error instanceof Error && "code" in error
      ? String((error as NodeJS.ErrnoException).code)
      : "unknown";
  return new JobApiConfigError(
    `the pasted-credential scratch directory ${scratchPath} could not be ` +
      `${action} (${code}); set ${JOB_SFTP_CREDENTIAL_DIR_ENV} to a directory ` +
      "the account this server runs as can create, outside every mounted " +
      "folder",
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
