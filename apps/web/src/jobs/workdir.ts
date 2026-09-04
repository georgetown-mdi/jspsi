import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { EXCHANGE_RECORD_OUTCOMES } from "@psilink/core";

import { isPathWithin } from "./pathContainment";

import type { ExchangeRecordOutcome } from "@psilink/core";

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
  if (!isPathWithin(root, workdir, "strictly-under")) return null;
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
 * Resolve a fixed-name file inside a server-anchored directory -- a job workdir,
 * or the appliance's mounted data root -- and verify the resolved path stays
 * strictly under that directory, returning null when it does not.
 *
 * The counterpart of {@link resolveWorkdir} one level down, for the fixed-name
 * files the appliance composes inside a directory it owns. Every such name is a
 * server constant today ({@link JOB_FILE_NAMES} and the signing-identity
 * names), so this can only fail on a caller bug -- which is exactly why it is a
 * check rather than a comment saying so: a name that ever became client-derived,
 * or a constant that changed shape, is refused here instead of resolving
 * somewhere else on disk.
 *
 * Containment is the whole property, not the absence of a separator: a name that
 * resolves to a path under the directory is returned however it is spelled
 * (`sub/receipt.json` included), and only one resolving outside it -- a `..`
 * climb, an absolute path, or a sibling sharing the directory's prefix -- is
 * refused. The path is not created, and nothing about the leaf is stat-ed.
 */
export function resolveWorkdirFile(
  directory: string,
  name: string,
): string | null {
  const root = path.resolve(directory);
  const filePath = path.resolve(root, name);
  if (!isPathWithin(root, filePath, "strictly-under")) return null;
  return filePath;
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

/** The two fields the status path reads off a record file: the timestamp the
 * download filenames are stamped from, and what the record says became of the run
 * that wrote it. */
export interface JobRecordSummary {
  createdAt: string;
  outcome: ExchangeRecordOutcome;
}

/** The shape the status path holds a record file to: core's own `createdAt` rule
 * (ISO-8601, so the stamp is a timestamp rather than any non-empty string) and
 * core's accepted outcome set. Both are required, matching the record format,
 * which carries an outcome on every record and states it rather than leaving a
 * reader to infer one from silence (docs/spec/EXCHANGE_RECORD.md, When a record is
 * owed). */
const recordSummarySchema = z.object({
  createdAt: z.iso.datetime(),
  outcome: z.enum(EXCHANGE_RECORD_OUTCOMES),
});

/**
 * Read the summary the status path needs from a server-produced record file, or
 * null if the file cannot be read, is not JSON, or does not carry both a valid
 * `createdAt` and a recognized `outcome`. The file is small and server-produced
 * (the CLI wrote it), so it is read whole; the defensive null keeps a missing or
 * malformed record from throwing on the status path -- the caller treats null as
 * "record unavailable".
 *
 * Requiring the outcome is what lets every surface downstream state how the run
 * ended rather than guess: a file this appliance's own CLI wrote always carries
 * one, so a record without a recognized outcome is not a record this appliance can
 * describe, and it is refused here instead of being offered under a completed
 * run's framing.
 */
export function readRecordSummary(recordPath: string): JobRecordSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  } catch {
    return null;
  }
  const result = recordSummarySchema.safeParse(parsed);
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
