import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import type {
  FileInfo,
  FileTransportClient,
  GetOptions,
  PutOptions,
  PutSource,
} from "@psilink/core";

const OPEN_FLAGS = {
  r: fs.constants.O_RDONLY,
  w: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
  a: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND,
  wx: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
} as const;

// @types/node types O_NOFOLLOW as a number, but it is absent on Windows, where
// this drops it from the mask and leaves the open otherwise unchanged.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function openNoFollow(filePath: string, flag: keyof typeof OPEN_FLAGS) {
  return fsp.open(filePath, OPEN_FLAGS[flag] | NO_FOLLOW);
}

/** Pulls a stream source fully into one Buffer before any file is opened: the
 * open below truncates, so opening first and then draining would leave the
 * destination truncated if the source threw partway. */
async function drainStream(src: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Array<Buffer> = [];
  for await (const chunk of src)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** What is left of a `writev` chunk list after `bytesWritten` bytes landed. */
function chunksAfter(
  chunks: ReadonlyArray<Uint8Array>,
  bytesWritten: number,
): Array<Uint8Array> {
  const remaining: Array<Uint8Array> = [];
  let consumed = bytesWritten;
  for (const chunk of chunks) {
    if (consumed >= chunk.byteLength) {
      consumed -= chunk.byteLength;
      continue;
    }
    remaining.push(consumed > 0 ? chunk.subarray(consumed) : chunk);
    consumed = 0;
  }
  return remaining;
}

/**
 * The file-drop directory client the harness's web party runs its file-sync
 * connection on.
 *
 * The shipped client is the CLI's `LocalFSClient`, out of reach because
 * apps/web may not import apps/cli (eslint.boundaries.mjs) and core owns
 * `FileSyncConnection` but no filesystem client for it. So this class
 * supplies its own, scoped to exactly what `FileSyncConnection` calls.
 *
 * It does not re-implement the shipped client's hardening -- the
 * directory-listing bound, the connect-retry budget, the redaction, and the
 * typed frame-size refusal, which defend the CLI against a partner-writable
 * share -- since a re-derived copy would drift. It gets right only the
 * semantics the protocol reads: an exclusive create that fails EEXIST, a
 * rename that publishes atomically, a listing that reports mtime and size,
 * and a read that refuses an over-cap frame.
 *
 * Every open applies O_NOFOLLOW, for the same reason the shipped client
 * does: the write destinations are predictable protocol names in a
 * directory the partner also writes, so a planted symlink is refused rather
 * than followed.
 */
export class HarnessFileDropClient implements FileTransportClient {
  async connect(options: Record<string, unknown>): Promise<void> {
    const dirPath = options["path"];
    if (typeof dirPath !== "string")
      throw new Error("connect: options.path is required");
    await fsp.access(dirPath, fs.constants.R_OK | fs.constants.W_OK);
  }

  async end(): Promise<void> {}

  async list(dir: string): Promise<Array<FileInfo>> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const listed: Array<FileInfo> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        // lstat, not stat: a symlink swapped in after the isFile() walk would
        // otherwise report its target's size, which the poll loop reads.
        const stat = await fsp.lstat(path.join(dir, entry.name));
        listed.push({
          name: entry.name,
          modifyTime: Math.floor(stat.mtimeMs),
          size: stat.size,
        });
      } catch (error) {
        // The peer's cleanup can delete a file between the walk and the stat.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return listed;
  }

  async get(
    filePath: string,
    options?: GetOptions,
  ): Promise<Buffer<ArrayBufferLike>> {
    const handle = await openNoFollow(filePath, "r");
    try {
      const maxBytes = options?.maxBytes;
      if (maxBytes !== undefined) {
        // Stat the OPEN handle and read exactly the statted size, so a writer
        // appending after the check cannot drive the read past the cap the
        // poll loop set; readFile() would read to live EOF instead.
        const { size } = await handle.stat();
        if (size > maxBytes)
          throw new Error(
            `${filePath} is ${size} bytes, past the ${maxBytes}-byte frame cap`,
          );
        const bounded = Buffer.alloc(size);
        const { bytesRead } = await handle.read(bounded, 0, size, 0);
        return bounded.subarray(0, bytesRead);
      }
      return await handle.readFile();
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async put(src: PutSource, dest: string, options?: PutOptions): Promise<void> {
    if (typeof src === "string")
      throw new Error(
        "put: a string src (a local path to copy) is unsupported",
      );
    const payload =
      Buffer.isBuffer(src) || Array.isArray(src) ? src : await drainStream(src);
    const handle = await openNoFollow(dest, options?.flags ?? "w");
    try {
      if (Array.isArray(payload)) {
        // A [header, payload] chunk list, written back to back so the frame
        // header is prepended without copying the payload. A short write is not
        // a failure: re-offer what the kernel did not take, or the peer reads a
        // truncated frame and waits out its whole budget on it.
        let remaining: Array<Uint8Array> = [...payload];
        while (remaining.length > 0) {
          const { bytesWritten } = await handle.writev(remaining);
          if (bytesWritten === 0)
            throw new Error(
              `put: the write of ${dest} stopped making progress with bytes ` +
                "still unwritten",
            );
          remaining = chunksAfter(remaining, bytesWritten);
        }
      } else {
        await handle.writeFile(payload);
      }
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
    // Reported rather than swallowed: on a write handle a failed close can mean
    // the bytes did not durably land.
    await handle.close();
  }

  async delete(filePath: string): Promise<void> {
    await fsp.unlink(filePath);
  }

  async safeDelete(filePath: string): Promise<void> {
    await fsp.unlink(filePath).catch(() => {});
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    await fsp.rename(fromPath, toPath);
  }

  async createExclusive(filePath: string): Promise<void> {
    // O_EXCL is what gives the lock-file race its single winner.
    const handle = await openNoFollow(filePath, "wx");
    await handle.close();
  }

  async exists(filePath: string): Promise<boolean> {
    return fsp.access(filePath).then(
      () => true,
      () => false,
    );
  }
}
