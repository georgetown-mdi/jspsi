import fsp from "node:fs/promises";
import path from "node:path";

import {
  isValidJobId,
  jobFileExists,
  readRecordCreatedAt,
  resolveWorkdir,
} from "./workdir";
import { JOB_FILE_NAMES } from "./intent";

import type { Dirent } from "node:fs";

/**
 * The restored view of one job reconstructed purely from its on-disk artifacts,
 * with no in-memory record. Reports the servable state and the three servable
 * paths, and nothing derived from the key file or config: those are never read.
 */
export interface RestoredJobArtifacts {
  status: "succeeded" | "failed";
  resultAvailable: boolean;
  recordAvailable: boolean;
  recordCreatedAt?: string;
  workdir: string;
  outputPath: string;
  recordPath: string;
  keysPath: string;
}

/**
 * The job ids re-discoverable from `dataRoot` after a restart: the names that are
 * real directories, pass the canonical v4 UUID check, and resolve strictly under
 * the resolved data root. A missing data root yields an empty list rather than
 * throwing. A directory entry that is a symlink out of the root is excluded (it
 * is not a real directory once resolved, and a symlink target that still landed
 * inside the root would already carry a valid own name), so discovery cannot
 * follow a link out of the data root.
 */
export async function listRestorableJobIds(
  dataRoot: string,
): Promise<Array<string>> {
  let entries: Array<Dirent>;
  try {
    entries = await fsp.readdir(path.resolve(dataRoot), {
      withFileTypes: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const ids: Array<string> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isValidJobId(entry.name)) continue;
    if (resolveWorkdir(dataRoot, entry.name) === null) continue;
    ids.push(entry.name);
  }
  return ids;
}

/**
 * Classify a job from its on-disk artifacts alone, or null when the workdir does
 * not resolve or is not a real directory. `status` is `succeeded` when the result
 * file is present, else `failed` (an interrupted job -- workdir but no result --
 * is terminal/failed, never running or resumable). The record pair is available
 * all-or-nothing, matching the live status path: both files present and the
 * record's `createdAt` parses. Only the output artifacts are consulted; the key
 * file and config are never touched.
 *
 * The leaf workdir is stat-ed with `lstat`, so a symlink planted at
 * `<dataRoot>/<jobId>` is rejected rather than followed -- the same exclusion
 * discovery applies, so a direct id request cannot redirect a serve through a
 * link the way a listed job never could.
 */
export async function classifyRestoredJob(
  dataRoot: string,
  jobId: string,
): Promise<RestoredJobArtifacts | null> {
  const workdir = resolveWorkdir(dataRoot, jobId);
  if (workdir === null) return null;
  try {
    const stats = await fsp.lstat(workdir);
    if (!stats.isDirectory()) return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  const outputPath = path.join(workdir, JOB_FILE_NAMES.output);
  const recordPath = path.join(workdir, JOB_FILE_NAMES.record);
  const keysPath = path.join(workdir, JOB_FILE_NAMES.recordKeys);

  const resultAvailable = jobFileExists(outputPath);
  const recordCreatedAt =
    jobFileExists(recordPath) && jobFileExists(keysPath)
      ? readRecordCreatedAt(recordPath)
      : null;

  return {
    status: resultAvailable ? "succeeded" : "failed",
    resultAvailable,
    recordAvailable: recordCreatedAt !== null,
    ...(recordCreatedAt !== null ? { recordCreatedAt } : {}),
    workdir,
    outputPath,
    recordPath,
    keysPath,
  };
}
