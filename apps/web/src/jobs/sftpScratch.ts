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
 * assert it resolves strictly OUTSIDE every operator mount -- the data root, the
 * rendezvous directory, the secrets mount, and the work-input directory, each in
 * both nesting directions -- create it owner-only, and SWEEP any credential a
 * prior run orphaned. A scratch dir that coincides with, nests under, or contains
 * any of those mounts would either expose a pasted secret through it or be
 * destroyed by the boot sweep, so it refuses the boot. The containment check runs
 * on the realpath BEFORE any directory is created or re-moded, so a symlinked
 * scratch path resolving into an excluded mount cannot cause a side effect on that
 * mount before the refusal. Returns the resolved directory. Called once at boot; a
 * failure propagates as a {@link JobApiConfigError} that refuses startup, matching
 * the appliance's posture.
 */
export function setupSftpCredentialScratchDir(
  scratchDir: string,
  dataRoot: string,
  rendezvousDir: string | undefined,
  secretsDir?: string,
  inputDir?: string,
): string {
  const resolved = path.resolve(scratchDir);
  const exclusions = scratchExclusions(
    dataRoot,
    rendezvousDir,
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
  try {
    sweepScratchDir(resolved);
  } catch (error) {
    throw scratchFsError(resolved, "swept", error);
  }
  return resolved;
}

/**
 * Materialize a pasted credential value to a server-owned 0600 file under
 * `scratchDir` with a server-generated name, returning its absolute path. Reuses
 * the workdir chmod-after-write discipline (the mode argument is not trusted
 * without a following `chmod`, since a permissive umask is not guaranteed). The
 * value is written and then dropped: the caller holds it only between request
 * parse and this write. Any failure after the file is created (a partial write on
 * a full filesystem, a chmod that cannot set the mode) removes the file before
 * rethrowing, so a failed materialization leaves nothing at rest.
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
    fs.rmSync(filePath, { force: true });
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
 * data root, and -- when configured -- the rendezvous directory, the secrets
 * mount, and the work-input directory. Each is added both as its lexical resolve
 * and, when it exists, its realpath, so a symlinked mount is caught too.
 * Duplicates are dropped.
 */
function scratchExclusions(
  dataRoot: string,
  rendezvousDir: string | undefined,
  secretsDir: string | undefined,
  inputDir: string | undefined,
): Array<ScratchExclusion> {
  const exclusions: Array<ScratchExclusion> = [];
  const add = (dir: string, label: string): void => {
    for (const form of new Set([path.resolve(dir), realpathIfPresent(dir)]))
      exclusions.push({ dir: form, label });
  };
  add(dataRoot, "the job data root");
  if (rendezvousDir !== undefined)
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
    if (isWithin(dir, scratch) || isWithin(scratch, dir))
      throw new JobApiConfigError(
        "the pasted-credential scratch directory must resolve strictly " +
          `outside ${label}`,
      );
}

/**
 * Whether `child` is `parent` itself or nested under it, over resolved absolute
 * paths. Segment-aware in both directions: a sibling whose basename merely starts
 * with `..` (`/x/..data` under `/x`, relative `"..data"`) is correctly within,
 * while a genuine `../` escape (`/x/../y`) is not.
 *
 * @internal exported for unit tests; production code calls it through {@link setupSftpCredentialScratchDir}.
 */
export function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !(
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

/**
 * Resolve where a `mkdir -p` of `target` would land, following any symlinked
 * ancestor, WITHOUT creating anything: the realpath of `target` if it exists,
 * otherwise the realpath of its nearest existing ancestor with the non-existent
 * tail re-appended. Lets the boot containment check run on the true resolved path
 * before any directory is created or re-moded.
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

/** Wrap a scratch-directory filesystem failure as the typed {@link
 * JobApiConfigError} the boot expects, naming the (server-side, non-secret)
 * scratch path and the errno. */
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
      `${action} (${code})`,
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
