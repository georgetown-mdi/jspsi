/**
 * The key file beside the configuration the operator mounted: the
 * `.alcove.key` a console run of an OPENED configuration runs under, so the
 * run continues the exchange that file established instead of needing a new
 * invitation.
 *
 * The file is checked here and then handed to the CLI child by path: the child
 * reads the secret, and writes the rotated one back to the same file at the
 * handshake, as a command-line run does. Nothing here returns the secret, and
 * no refusal states anything read from the file -- the operator is told which
 * of the two faults it is and nothing else.
 */

import { z } from "zod";

import { SHARED_SECRET_REGEX, parseSensitiveJson } from "@alcove/core";

import { JOB_FILE_NAMES } from "./intentSchemas";
import { readBoundedMountedFile } from "./boundedMountedFile";
import { resolveWorkdirFile } from "./workdir";

/** Upper bound, in bytes, on the key file this check reads. The file holds one
 * secret and one instant, so anything larger is not a key file. */
export const MAX_MOUNTED_KEY_FILE_BYTES = 10_000;

/**
 * The key-file shape, as the CLI's own reader holds it (`KeyFileSchema` in
 * `apps/cli/src/keyFile.ts`, which this workspace cannot import): a shared
 * secret of the canonical shape and an optional ISO 8601 expiry. Unknown keys
 * are stripped rather than refused, as there, so the console refuses exactly
 * the files the run itself would refuse.
 */
const mountedKeyFileSchema = z.object({
  sharedSecret: z.string().regex(SHARED_SECRET_REGEX),
  expires: z.iso.datetime().optional(),
});

/** Which of the two faults a refused mounted key file is. */
export type MountedKeyFileFault = "absent" | "invalid";

/**
 * Raised when an opened configuration's run finds no usable key file beside
 * the configuration. The message states nothing read from the file.
 */
export class MountedKeyFileRefusedError extends Error {
  constructor(readonly fault: MountedKeyFileFault) {
    super(
      fault === "absent"
        ? "the mounted working folder holds no key file beside the configuration"
        : "the key file beside the mounted configuration is not one Alcove can read",
    );
    this.name = "MountedKeyFileRefusedError";
  }
}

/**
 * The path of the key file beside the mounted configuration, once it has been
 * read and checked against the key-file shape.
 *
 * Read through {@link readBoundedMountedFile}, so a FIFO, a device, or a file
 * over {@link MAX_MOUNTED_KEY_FILE_BYTES} at the name is refused as `invalid`
 * without blocking this synchronous server.
 *
 * @throws {MountedKeyFileRefusedError} `absent` when no file is at the name,
 *   `invalid` when one is there and cannot be read or is not a key file.
 */
export function checkedMountedKeyFilePath(dataRoot: string): string {
  const filePath = resolveWorkdirFile(dataRoot, JOB_FILE_NAMES.key);
  if (filePath === null) throw new MountedKeyFileRefusedError("absent");
  const read = readBoundedMountedFile(filePath, MAX_MOUNTED_KEY_FILE_BYTES);
  if (read.outcome === "absent") throw new MountedKeyFileRefusedError("absent");
  if (read.outcome !== "read") throw new MountedKeyFileRefusedError("invalid");
  let parsed: unknown;
  try {
    parsed = parseSensitiveJson(read.source, "mounted key file");
  } catch {
    throw new MountedKeyFileRefusedError("invalid");
  }
  if (!mountedKeyFileSchema.safeParse(parsed).success)
    throw new MountedKeyFileRefusedError("invalid");
  return filePath;
}
