import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ZodError } from "zod";

import { JOB_FILE_NAMES } from "./intentSchemas";

import { formatFirstIssue } from "./schemaIssueMessage";
import { handBackConfigDocument } from "./handoff";
import { mountedUnconductedDocument } from "./configLoad";
import { resolveWorkdirFile } from "./workdir";

import type { JobConfigurationHandBack } from "./intentSchemas";

/**
 * Handing the configuration the operator opened back into their working folder,
 * for a channel the console does not conduct (`PUT /api/jobs/config`).
 *
 * A run's hand-off shows the operator a template to copy; this one cannot, since
 * the document's connection can hold a credential no browser receives. It is
 * written in place of the `psilink.yaml` it was opened from instead, the file
 * the command line runs, and the response states only that it was written.
 */

/**
 * Raised when the hand-back is not written. Its message reaches the operator,
 * so it states what stopped the write and what to do, and names no value from
 * the file and no container path.
 */
export class ConfigurationHandBackRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationHandBackRefusedError";
  }
}

/** The message reaching the operator when the file could not be replaced. */
const UNWRITABLE_CONFIGURATION_MESSAGE =
  "The console could not write psilink.yaml in your working folder. Check " +
  "that the folder and the file are writable, then save again.";

/**
 * Write `handBack` into the mounted configuration: re-read the file, compose
 * the edited settings over it with its connection unchanged, and replace it.
 *
 * @throws {ConfigurationLoadRefusedError} when the mount no longer holds a
 *   configuration this hand-back applies to (see `mountedUnconductedDocument`).
 * @throws {ConfigurationHandBackRefusedError} when the settings do not make a
 *   valid configuration, or the file could not be written.
 */
export function handBackMountedConfiguration(
  dataRoot: string,
  handBack: JobConfigurationHandBack,
): void {
  const mountedDocument = mountedUnconductedDocument(dataRoot);
  let text: string;
  try {
    text = handBackConfigDocument(handBack, mountedDocument);
  } catch (error) {
    if (error instanceof ZodError)
      throw new ConfigurationHandBackRefusedError(
        "These settings do not make a configuration psilink can run (" +
          formatFirstIssue(error.issues) +
          "). Change them, then save again.",
      );
    throw error;
  }
  replaceMountedConfiguration(dataRoot, text);
}

/**
 * Replace the mounted `psilink.yaml` with `text`: written to a new file beside
 * the one it replaces, flushed, and renamed over it, so an interrupted write
 * leaves the operator's file as it was. A `psilink.yaml` that is a link is
 * replaced at the file it names, and the replacement keeps the file's own
 * permission bits.
 */
function replaceMountedConfiguration(dataRoot: string, text: string): void {
  const filePath = resolveWorkdirFile(dataRoot, JOB_FILE_NAMES.config);
  if (filePath === null)
    throw new Error("the configuration name resolved outside the data root");
  let temporary: string | undefined;
  try {
    const target = fs.realpathSync(filePath);
    const mode = fs.statSync(target).mode & 0o777;
    temporary = path.join(
      path.dirname(target),
      `.${path.basename(target)}.${crypto.randomUUID()}.tmp`,
    );
    const fd = fs.openSync(temporary, "wx", mode);
    try {
      fs.writeFileSync(fd, text);
      fs.fchmodSync(fd, mode);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
    temporary = undefined;
  } catch {
    throw new ConfigurationHandBackRefusedError(
      UNWRITABLE_CONFIGURATION_MESSAGE,
    );
  } finally {
    if (temporary !== undefined) fs.rmSync(temporary, { force: true });
  }
}
