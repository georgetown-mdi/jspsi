/**
 * Reading a small file the operator mounted into the console's working
 * directory -- the configuration or the key file beside it -- under a byte
 * bound, without letting what sits at the name wedge this synchronous server.
 */

import fs from "node:fs";

/** What reading a mounted file under a bound found. */
export type BoundedMountedFileRead =
  | { outcome: "read"; source: string }
  | { outcome: "absent" }
  | { outcome: "unreadable" }
  | { outcome: "over-large" };

/**
 * The UTF-8 contents of a mounted regular file no larger than `maxBytes`.
 *
 * Every check and the read itself go through the one descriptor `openSync`
 * returns, so nothing between them can swap what the path names. The file is
 * `absent` only when the open fails with `ENOENT`; any other open failure, a
 * descriptor that is not a regular file, or a failed read is `unreadable`. A
 * file is `over-large` when `fstat` reports more than the bound or when more
 * than the bound arrives, the read being bounded to one byte past the cap.
 */
export function readBoundedMountedFile(
  filePath: string,
  maxBytes: number,
): BoundedMountedFileRead {
  let fd: number;
  try {
    // O_NONBLOCK, not the plain "r" flag: opening a FIFO for read-only blocks
    // until a writer opens it, which would wedge this synchronous server on a
    // FIFO at the mounted name (or a symlink to one). O_NONBLOCK makes that
    // open return immediately instead; the fstat below then refuses it as not
    // a regular file. A regular file ignores the flag, so its open and read
    // are unchanged.
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch (error) {
    return {
      outcome:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "absent"
          : "unreadable",
    };
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { outcome: "unreadable" };
    if (stat.size > maxBytes) return { outcome: "over-large" };
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = fs.readSync(
        fd,
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        null,
      );
      if (read === 0) break;
      bytesRead += read;
    }
    if (bytesRead > maxBytes) return { outcome: "over-large" };
    return {
      outcome: "read",
      source: buffer.subarray(0, bytesRead).toString("utf8"),
    };
  } catch {
    return { outcome: "unreadable" };
  } finally {
    fs.closeSync(fd);
  }
}
