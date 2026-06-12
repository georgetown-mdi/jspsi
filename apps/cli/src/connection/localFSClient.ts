import fs from "node:fs/promises";
import path from "node:path";

import { retryPromise, withTimeout, TimeoutError } from "@psilink/core";
import type {
  FileInfo,
  FileTransportClient,
  GetOptions,
  PutOptions,
} from "@psilink/core";

import { frameSizeExceededError } from "./frameSizeGuard";
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_FILENAME_LENGTH,
  directoryTooLargeError,
  filenameTooLongError,
} from "./listingGuard";

/**
 * {@link FileTransportClient} backed by the local filesystem. Use this when
 * both parties share a network-mounted folder (e.g. an IT-provisioned share
 * synced to an SFTP server). No SSH connection is made; the operating system's
 * filesystem driver handles all I/O.
 *
 * NOTE: `rename` relies on OS primitives that are atomic only within a single
 * filesystem. The mounted share and the message temp files must reside on the
 * same volume. This is always true when both paths are within the same network
 * mount.
 */
export class LocalFSClient implements FileTransportClient {
  /**
   * Verifies read/write access to the directory specified by `options.path`.
   * Enforces `options.connectTimeoutMs` (default: 30s) per attempt. A fast
   * transient failure (e.g. the share or its permissions still settling) is
   * retried up to `options.maxReconnectAttempts` times (default: 3) with a
   * hard-coded 1-second delay; a per-attempt TIMEOUT is terminal and is NOT
   * retried, because the abandoned `fs.access` keeps its thread-pool worker
   * until the OS releases the syscall and a retry cannot un-stick it -- so
   * retrying would only strand a second stalled worker. This bounds concurrent
   * stalled workers to one.
   */
  async connect(options: Record<string, unknown>): Promise<void> {
    const dirPath = options["path"];
    if (typeof dirPath !== "string")
      throw new Error("LocalFSClient.connect: options.path is required");

    const connectTimeoutMs =
      (options["connectTimeoutMs"] as number | undefined) ?? 30_000;
    if (connectTimeoutMs < 0)
      throw new Error("connectTimeoutMs must be non-negative");
    const maxReconnects =
      (options["maxReconnectAttempts"] as number | undefined) ?? 3;
    if (maxReconnects < 0)
      throw new Error("maxReconnectAttempts must be non-negative");

    // fs.access on a stalled NFS/CIFS hard mount blocks a libuv thread-pool
    // worker, not the event loop, so setTimeout fires normally and this race
    // enforces the per-attempt deadline rather than waiting out the OS-level
    // retry window (which can be several minutes).
    //
    // A timed-out attempt is TERMINAL -- the shouldRetry predicate below stops
    // the retry loop on a TimeoutError. The abandoned fs.access keeps its
    // thread-pool worker until the OS releases the syscall, and nothing
    // in-process can cancel an already-dispatched blocking syscall: fs.access
    // does not honor an AbortSignal, and libuv's uv_cancel only drops
    // still-queued work, never work a worker is already executing. So retrying
    // a hang cannot succeed where the first attempt timed out and would only
    // strand a second stalled worker (and, across maxReconnects, more), risking
    // exhaustion of the default 4-thread pool. Retries are therefore reserved
    // for a mount that ANSWERS with a fast transient error (EACCES/ENOENT while
    // a share or its permissions are still settling); connectTimeoutMs is the
    // per-attempt wait budget, raised for a legitimately slow mount. This
    // bounds concurrent stalled workers to one and fails a dead mount in ~one
    // timeout window instead of maxReconnects of them.
    await retryPromise(
      () =>
        withTimeout(
          fs
            .access(dirPath, fs.constants.R_OK | fs.constants.W_OK)
            .catch((err: unknown) => {
              throw new Error(
                `cannot read/write filedrop directory: ${dirPath}: ` +
                  (err instanceof Error ? err.message : String(err)),
              );
            }),
          connectTimeoutMs,
          `timed out opening ${dirPath}`,
        ),
      maxReconnects,
      1_000,
      // A TimeoutError means the mount did not answer within the budget; a
      // retry cannot un-stick it and would only stack another stalled worker,
      // so it is terminal. Every other (fast) error is the transient the retry
      // budget exists for. The brand-on-name fallback keeps a timeout terminal
      // even if @psilink/core were ever loaded as two copies in one process (a
      // future dual-package split), where instanceof across the copies would
      // silently fail and otherwise re-enable the very worker-stacking retry
      // this guards against. No non-timeout error this path sees carries that
      // name (the wrapped access failure below is a fresh Error), so the
      // fallback cannot make a transient error wrongly terminal.
      (err) =>
        !(
          err instanceof TimeoutError ||
          (err instanceof Error && err.name === "TimeoutError")
        ),
    );
  }

  /** No-op: there is no remote connection to tear down. */
  async end(): Promise<void> {}

  /**
   * Enforces the directory-listing bounds (see {@link ./listingGuard}) at the
   * transport read layer. The enumeration streams entries through `fs.opendir`
   * rather than `fs.readdir`: `readdir` materializes the whole directory into one
   * array (and this method then fans out a stat per file), so both allocations
   * would scale with the attacker-controlled entry count before any check could
   * run. `opendir` yields entries in bounded batches, so the count check below
   * stops the walk -- and caps the retained `fileNames` array and the downstream
   * stat fan-out -- at {@link MAX_DIRECTORY_ENTRIES} regardless of how many
   * entries the directory actually holds. The count check covers every entry
   * (the adversary controls the count whatever the entry type); the returned set
   * is still files only, preserving the prior behavior.
   */
  async list(dir: string): Promise<FileInfo[]> {
    const fileNames: string[] = [];
    let scanned = 0;
    // The for-await loop closes the directory handle automatically on normal
    // completion, on break, and on throw (the async iterator's return() runs),
    // so an over-bound directory does not leak the handle.
    for await (const entry of await fs.opendir(dir)) {
      if (++scanned > MAX_DIRECTORY_ENTRIES)
        throw directoryTooLargeError(dir, MAX_DIRECTORY_ENTRIES);
      if (entry.name.length > MAX_FILENAME_LENGTH)
        throw filenameTooLongError(dir, entry.name, MAX_FILENAME_LENGTH);
      if (entry.isFile()) fileNames.push(entry.name);
    }
    // opendir provides the file type but not mtimeMs; a stat per file is
    // unavoidable. Promise.all keeps the calls parallel. ENOENT means a file was
    // deleted between the walk and stat (e.g. by the peer's cleanup); omit it
    // rather than failing the whole listing.
    const results = await Promise.all(
      fileNames.map(async (name) => {
        try {
          const stat = await fs.stat(path.join(dir, name));
          return {
            name,
            modifyTime: Math.floor(stat.mtimeMs),
            size: stat.size,
          } as FileInfo;
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw err;
        }
      }),
    );
    return results.filter((e): e is FileInfo => e !== null);
  }

  /**
   * `options.encoding` is not applied; always returns a raw Buffer. Callers
   * that need a decoded string should use `.toString(encoding)` on the result.
   *
   * When `options.maxBytes` is set, the read is bounded to that many bytes: the
   * file is opened, the open handle is `fstat`ed, and a file larger than the cap
   * is refused with a typed terminal error (see {@link frameSizeExceededError})
   * before any content buffer is allocated. The stat and the read share one
   * file handle, so that read pulls exactly the fstat'd size; a writer that
   * appends after the stat (a TOCTOU race a plain `stat` + `readFile` would
   * lose) cannot drive an allocation past the cap. Omitting `maxBytes` keeps the
   * original unbounded
   * `readFile` fast path.
   */
  async get(
    filePath: string,
    options?: GetOptions,
  ): Promise<Buffer<ArrayBufferLike>> {
    const maxBytes = options?.maxBytes;
    if (maxBytes === undefined) return fs.readFile(filePath);

    const handle = await fs.open(filePath, "r");
    try {
      const { size } = await handle.stat();
      if (size > maxBytes)
        throw frameSizeExceededError(filePath, maxBytes, size);
      const buffer = Buffer.allocUnsafe(size) as Buffer<ArrayBufferLike>;
      let offset = 0;
      // Read exactly the fstat'd size from this handle. A single read() can
      // return short, so loop until satisfied; bytesRead === 0 means the file
      // was truncated under us (EOF before `size`), in which case the shorter
      // prefix is returned rather than a buffer with an uninitialized tail.
      while (offset < size) {
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          size - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return offset === size
        ? buffer
        : (buffer.subarray(0, offset) as Buffer<ArrayBufferLike>);
    } finally {
      // Swallow a close() failure. This handle is read-only, so a failed close
      // carries no data-integrity meaning; letting it reject here would replace
      // the in-flight result -- masking a FrameSizeExceededError (whose
      // UsageError type the poll loop relies on to stop re-reading the oversized
      // file) or turning a successful read into a spurious transport error.
      await handle.close().catch(() => {});
    }
  }

  async put(
    src: string | Buffer | NodeJS.ReadableStream,
    dest: string,
    options?: PutOptions,
  ): Promise<void> {
    if (typeof src === "string") {
      // ssh2-sftp-client interprets a string src as a local file path to copy
      // from; LocalFSClient does not support that usage.
      throw new Error(
        "LocalFSClient.put: string src is not supported; pass a Buffer or " +
          "stream",
      );
    }
    const writeOptions = {
      flag: options?.flags ?? "w",
      encoding: options?.encoding as BufferEncoding | null | undefined,
    };
    if (Buffer.isBuffer(src)) {
      await fs.writeFile(dest, src, writeOptions);
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of src) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      await fs.writeFile(dest, Buffer.concat(chunks), writeOptions);
    }
  }

  async delete(filePath: string): Promise<void> {
    await fs.unlink(filePath);
  }

  async safeDelete(filePath: string): Promise<void> {
    await fs.unlink(filePath).catch(() => {});
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    await fs.rename(fromPath, toPath);
  }

  async createExclusive(filePath: string): Promise<void> {
    const handle = await fs.open(filePath, "wx");
    await handle.close();
  }

  async exists(filePath: string): Promise<boolean> {
    return fs
      .access(filePath)
      .then(() => true)
      .catch(() => false);
  }
}
