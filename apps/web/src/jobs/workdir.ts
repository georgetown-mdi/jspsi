import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

/**
 * A server-generated job id: a v4 UUID. The client never supplies it, and every
 * route validates its format before any filesystem use, so a crafted id cannot
 * escape the data root.
 */
export function generateJobId(): string {
  return crypto.randomUUID();
}

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Validate a job id against the exact v4 UUID shape. This is the first gate on
 * every route that touches the filesystem: a value that is not a canonical v4
 * UUID (a traversal payload, an absolute path, an empty string) is rejected
 * before it is ever joined to the data root.
 */
export function isValidJobId(id: string): boolean {
  return UUID_V4_PATTERN.test(id);
}

/** Owner-only directory mode (rwx------). */
export const WORKDIR_MODE = 0o700;
/** Owner-only file mode (rw-------). */
export const JOB_FILE_MODE = 0o600;

/**
 * Resolve the workdir for a job id under `dataRoot` and verify the resolved path
 * stays strictly under the resolved data root. Returns null when the id is
 * malformed or the resolved path escapes the root (a defense-in-depth check on
 * top of the id validation: even a validated id is confirmed to resolve inside
 * the root before use). The path is not created here.
 */
export function resolveWorkdir(dataRoot: string, jobId: string): string | null {
  if (!isValidJobId(jobId)) return null;
  const root = path.resolve(dataRoot);
  const workdir = path.resolve(root, jobId);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (!workdir.startsWith(rootWithSep)) return null;
  return workdir;
}

/**
 * Create a job's workdir (mode 0o700) under the data root. The data root itself is
 * created if missing. Fails if the workdir already exists, so a reused id cannot
 * clobber an existing job's files.
 */
export async function createWorkdir(
  dataRoot: string,
  jobId: string,
): Promise<{ workdir: string }> {
  const workdir = resolveWorkdir(dataRoot, jobId);
  if (workdir === null)
    throw new Error("job id did not resolve to a path under the data root");
  // Owner-only when this process creates the data root; a pre-existing root's
  // mode is the operator's to set (the sensitive per-job material is owner-only
  // beneath it regardless).
  await fsp.mkdir(path.resolve(dataRoot), {
    recursive: true,
    mode: WORKDIR_MODE,
  });
  await fsp.mkdir(workdir, { mode: WORKDIR_MODE });
  await fsp.chmod(workdir, WORKDIR_MODE);
  return { workdir };
}

/**
 * Write a file into a job workdir with owner-only permissions (0o600). The name
 * is a server constant (see JOB_FILE_NAMES) and is joined to the already-verified
 * workdir; content is the client-supplied bytes. Written mode is enforced with an
 * explicit chmod after the write, since a restrictive umask is not guaranteed.
 */
export async function writeJobFile(
  workdir: string,
  name: string,
  content: string,
): Promise<string> {
  const filePath = path.join(workdir, name);
  await fsp.writeFile(filePath, content, { mode: JOB_FILE_MODE });
  await fsp.chmod(filePath, JOB_FILE_MODE);
  return filePath;
}

/** Whether a file at the given path exists and is readable. */
export function jobFileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether a job's result file exists and is readable. */
export function resultFileExists(outputPath: string): boolean {
  return jobFileExists(outputPath);
}

/** The ISO-8601 rule core stamps a record's `createdAt` with, applied here so the
 * status path validates the timestamp the same way rather than accepting any
 * non-empty string. */
const recordCreatedAtSchema = z.iso.datetime();

/**
 * Read the `createdAt` timestamp from a server-produced record file, or null if
 * the file cannot be read, is not JSON, or its `createdAt` is not a valid
 * ISO-8601 timestamp. The file is small and server-produced (the CLI wrote it),
 * so it is read whole; the defensive null keeps a missing or malformed record
 * from throwing on the status path -- the caller treats null as "record
 * unavailable".
 */
export function readRecordCreatedAt(recordPath: string): string | null {
  let createdAt: unknown;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    createdAt = (parsed as { createdAt?: unknown } | null)?.createdAt;
  } catch {
    return null;
  }
  const result = recordCreatedAtSchema.safeParse(createdAt);
  return result.success ? result.data : null;
}

/** Remove a job's workdir and everything under it. Idempotent. */
export async function removeWorkdir(workdir: string): Promise<void> {
  await fsp.rm(workdir, { recursive: true, force: true });
}

/**
 * Whether the workdir leaf is a real directory. `lstat` (not `stat`) so a symlink
 * planted at `<dataRoot>/<jobId>` reports as not-a-directory and is refused rather
 * than followed -- the disk-only DELETE arm's guard against removing through a
 * link out of the data root. A missing leaf is false, not an error.
 */
export async function workdirDirectoryExists(
  workdir: string,
): Promise<boolean> {
  try {
    const stats = await fsp.lstat(workdir);
    return stats.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
