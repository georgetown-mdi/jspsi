import fs from "node:fs/promises";
import path from "node:path";

import {
  retryPromise,
  withTimeout,
  TimeoutError,
  redactPrivateKeyMaterial,
  DEFAULT_SERVER_CONNECT_TIMEOUT_MS,
} from "@psilink/core";
import type {
  FileInfo,
  FileTransportClient,
  GetOptions,
  PutOptions,
  PutSource,
} from "@psilink/core";

import { frameSizeExceededError } from "./frameSizeGuard";
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_FILENAME_LENGTH,
  directoryTooLargeError,
  filenameTooLongError,
} from "./listingGuard";

// O_NOFOLLOW makes an open refuse a final-component symlink (ELOOP on POSIX),
// so a symlink planted at a rendezvous entry in the partner-writable
// directory is never traversed by the read/write primitives below. It
// refuses only the symlinked entry, not a symlinked mount point -- an
// intermediate directory component is still followed, so a legitimate
// symlinked mount is unaffected. @types/node types it as a number but it is
// absent on Windows, where `?? 0` drops it from the mask, mirroring the
// writeFileOwnerOnly / writeFileAtomic hardening in fileUtils.ts.
const OPEN_FLAGS = {
  r: fs.constants.O_RDONLY,
  w: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
  a: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND,
  wx: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
} as const;

/**
 * Opens `filePath` with the numeric equivalent of the string `flag` plus
 * `O_NOFOLLOW`, so the open refuses to traverse a symlink at the final path
 * component rather than following it.
 *
 * For the read primitive ({@link LocalFSClient.get}) this is a safety
 * check: {@link LocalFSClient.list} already filters symlink entries out, so
 * `O_NOFOLLOW` here only catches a symlink swapped in after the listing
 * committed the name (a TOCTOU race). For the write primitives
 * ({@link LocalFSClient.put}, {@link LocalFSClient.createExclusive}) it is
 * the primary defense: their destinations are built from protocol state at
 * predictable names and never pass through `list()`.
 */
function openNoFollow(filePath: string, flag: keyof typeof OPEN_FLAGS) {
  return fs.open(filePath, OPEN_FLAGS[flag] | (fs.constants.O_NOFOLLOW ?? 0));
}

/**
 * What is left of a `writev` chunk list after `bytesWritten` of its bytes have
 * landed: whole chunks the write consumed are dropped, and the one straddling
 * the boundary is advanced past its written prefix (a view, never a copy). Every
 * returned chunk is non-empty, so an empty result means exactly that the whole
 * list is written -- which is what lets the caller loop on the list's length.
 */
function chunksAfter(
  chunks: readonly Uint8Array[],
  bytesWritten: number,
): Uint8Array[] {
  const remaining: Uint8Array[] = [];
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

/** Pulls a stream source fully into one Buffer before any file is opened. */
async function drainStream(src: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of src) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * {@link FileTransportClient} backed by the local filesystem. Use this when
 * both parties share a network-mounted folder (e.g. an IT-provisioned share
 * synced to an SFTP server). No SSH connection is made; the operating
 * system's filesystem driver handles all I/O.
 *
 * `rename` relies on OS primitives that are atomic only within a single
 * filesystem, so the mounted share and the message temp files must reside
 * on the same volume -- always true when both paths are within the same
 * network mount.
 */
export class LocalFSClient implements FileTransportClient {
  private reconnectAttempts = 0;

  /**
   * Connection re-establishment attempts over this client's life: the number of
   * connect-retry re-attempts past the first, summed across every `connect()`
   * call. A plain operational counter, never a partner-controlled value.
   */
  get reconnectCount(): number {
    return this.reconnectAttempts;
  }

  /**
   * The whole of {@link reconnectCount} here: every attempt this client counts
   * is a `connect()` re-attempt, since it opens no session to lose.
   */
  get connectRetryCount(): number {
    return this.reconnectAttempts;
  }

  /**
   * The session and retry counters the SFTP adapter reports, each fixed at 0
   * here: the filedrop transport opens no connection or session, so there is
   * nothing to drop, retry, or release mid-exchange. These are required, not
   * decorative -- the end-of-run summary and the metrics event read one
   * union of both client types, so a metric absent here would not compile
   * there.
   */
  get transportRetryCount(): number {
    return 0;
  }

  /** See {@link transportRetryCount}. */
  get midExchangeReconnectCount(): number {
    return 0;
  }

  /** See {@link transportRetryCount}. */
  get forcedReleaseCount(): number {
    return 0;
  }

  /** See {@link transportRetryCount}. */
  get releasedBoundaryCount(): number {
    return 0;
  }

  /** See {@link transportRetryCount}. */
  get declinedReleaseCount(): number {
    return 0;
  }

  /** See {@link transportRetryCount}. */
  get declinedCycleRedialCount(): number {
    return 0;
  }

  /** See {@link transportRetryCount}. */
  get heldBoundaryCount(): number {
    return 0;
  }

  /** See {@link transportRetryCount}. */
  get heldBoundaryStretchCount(): number {
    return 0;
  }

  /**
   * Verifies read/write access to the directory specified by `options.path`.
   * Enforces `options.connectTimeoutMs` (default: 30s) per attempt. A fast
   * transient failure (e.g. the share or its permissions still settling) is
   * retried up to `options.maxReconnectAttempts` times (default: 3) with a
   * hard-coded 1-second delay; a per-attempt TIMEOUT is terminal and is NOT
   * retried (see the shouldRetry predicate for why).
   */
  async connect(options: Record<string, unknown>): Promise<void> {
    const dirPath = options["path"];
    if (typeof dirPath !== "string")
      throw new Error("LocalFSClient.connect: options.path is required");

    const connectTimeoutMs =
      (options["connectTimeoutMs"] as number | undefined) ??
      DEFAULT_SERVER_CONNECT_TIMEOUT_MS;
    if (connectTimeoutMs < 0)
      throw new Error("connectTimeoutMs must be non-negative");
    const maxReconnects =
      (options["maxReconnectAttempts"] as number | undefined) ?? 3;
    if (maxReconnects < 0)
      throw new Error("maxReconnectAttempts must be non-negative");

    // fs.access on a stalled NFS/CIFS hard mount blocks a libuv thread-pool
    // worker, not the event loop, so setTimeout fires normally and this race
    // enforces the per-attempt deadline rather than waiting out the OS-level
    // retry window (which can run several minutes); see the shouldRetry
    // predicate below for why a timed-out attempt is terminal. Incrementing
    // the reconnect count inside the retried callback ties it to the retry
    // loop's own re-issue decision, with no separate state.
    let attempted = false;
    await retryPromise(
      () => {
        if (attempted) this.reconnectAttempts += 1;
        attempted = true;
        return withTimeout(
          fs
            .access(dirPath, fs.constants.R_OK | fs.constants.W_OK)
            .catch((err: unknown) => {
              throw new Error(
                `cannot read/write filedrop directory: ` +
                  `${redactPrivateKeyMaterial(dirPath)}: ` +
                  (err instanceof Error ? err.message : String(err)),
              );
            }),
          connectTimeoutMs,
          `timed out opening ${dirPath}`,
        );
      },
      maxReconnects,
      1_000,
      // A TimeoutError means the mount did not answer within the budget; the
      // abandoned fs.access keeps its thread-pool worker (fs.access ignores
      // AbortSignal, and libuv cannot cancel already-dispatched work), so a
      // retry would only strand another worker toward exhausting the
      // default 4-thread pool. A timeout is therefore terminal; every other
      // (fast) error is the transient the retry budget exists for
      // (EACCES/ENOENT while a share is still settling). The name check
      // alongside `instanceof` is a fallback for `@psilink/core` loaded as
      // two module copies, where `instanceof` alone would silently fail.
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
   * Enforces the directory-listing bounds (see {@link ./listingGuard}) at
   * the transport read layer. Enumeration streams entries through
   * `fs.opendir` rather than `fs.readdir`: `readdir` would materialize the
   * whole directory -- and this method's per-file stat fan-out -- to scale
   * with an attacker-controlled entry count before any check could run.
   * `opendir` yields entries in bounded batches, so the count check below
   * stops the walk at {@link MAX_DIRECTORY_ENTRIES} regardless of the
   * directory's actual size. The count covers every entry of any type; the
   * returned set is files only.
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
    // unavoidable. lstat (not stat) keeps this metadata read from following a
    // symlink swapped in after the isFile() walk committed the name -- it would
    // report the link target's size, which the poll loop's size check consumes.
    // Promise.all keeps the calls parallel. ENOENT means a file was deleted
    // between the walk and stat (e.g. by the peer's cleanup); omit it rather
    // than failing the whole listing.
    const results = await Promise.all(
      fileNames.map(async (name) => {
        try {
          const stat = await fs.lstat(path.join(dir, name));
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
   * that need a decoded string should use `.toString(encoding)` on the
   * result.
   *
   * When `options.maxBytes` is set, the read is bounded to that many bytes:
   * the handle is `fstat`ed and a file larger than the cap is refused (see
   * {@link frameSizeExceededError}) before any content buffer is allocated.
   * The stat and read share one handle, so a writer that appends after the
   * stat cannot drive an allocation past the cap -- a TOCTOU race a plain
   * `stat` + `readFile` would lose. Omitting `maxBytes` keeps the unbounded
   * fast path.
   *
   * Both paths open through {@link openNoFollow}, so a symlink at
   * `filePath` is refused rather than followed.
   */
  async get(
    filePath: string,
    options?: GetOptions,
  ): Promise<Buffer<ArrayBufferLike>> {
    const maxBytes = options?.maxBytes;
    if (maxBytes === undefined) {
      const handle = await openNoFollow(filePath, "r");
      try {
        return (await handle.readFile()) as Buffer<ArrayBufferLike>;
      } finally {
        // Read-only handle: a failed close has no data-integrity meaning and
        // must not replace the returned buffer, the same reason the bounded path
        // below swallows its close error.
        await handle.close().catch(() => {});
      }
    }

    const handle = await openNoFollow(filePath, "r");
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
      // has no data-integrity meaning; letting it reject here would replace
      // the in-flight result -- masking a FrameSizeExceededError (whose
      // UsageError type the poll loop relies on to stop re-reading the oversized
      // file) or turning a successful read into a spurious transport error.
      await handle.close().catch(() => {});
    }
  }

  async put(src: PutSource, dest: string, options?: PutOptions): Promise<void> {
    if (typeof src === "string") {
      // ssh2-sftp-client interprets a string src as a local file path to copy
      // from; LocalFSClient does not support that usage.
      throw new Error(
        "LocalFSClient.put: string src is not supported; pass a Buffer or " +
          "stream",
      );
    }
    const flag = options?.flags ?? "w";
    const encoding = options?.encoding as BufferEncoding | null | undefined;
    // Drain a plain stream source to a Buffer BEFORE opening dest. The open
    // below is O_CREAT|O_TRUNC, so opening first and then pulling from the
    // stream would truncate dest up front and, if the source threw partway,
    // leave it truncated rather than untouched. A Buffer or [header, payload]
    // chunk list is already fully in memory, so it is written as-is.
    const payload: Buffer | Uint8Array[] =
      Buffer.isBuffer(src) || Array.isArray(src) ? src : await drainStream(src);
    // Write through an O_NOFOLLOW handle so a symlink planted at `dest` is
    // refused rather than redirecting the write to the link's target. Opening
    // the handle here (rather than deferring the flag to fs.writeFile) is what
    // lets the numeric O_NOFOLLOW mask apply on every write branch.
    const handle = await openNoFollow(dest, flag);
    try {
      if (Array.isArray(payload)) {
        // A [header, payload] chunk list: write the parts back-to-back with
        // writev so the 10-byte header is prepended without concatenating
        // the payload into a fresh buffer (the payload is never copied,
        // mirroring the send-path peak-shaving). The resulting on-disk
        // bytes are the parts joined, byte-identical to their
        // concatenation. encoding does not apply to a raw chunk list and is
        // not passed.
        //
        // A SHORT write is not a failure and does not reject: the kernel may
        // take fewer bytes than offered, and what it did not take would
        // otherwise publish as a truncated frame -- so re-offer what remains
        // until nothing is, the way get() loops its reads. No position is
        // passed on any pass, so each write continues at the handle's own
        // position and an `a` (append) flag keeps its meaning.
        let remaining = payload;
        while (remaining.length > 0) {
          const { bytesWritten } = await handle.writev(remaining);
          if (bytesWritten === 0)
            throw new Error(
              `LocalFSClient.put: the write of ${dest} stopped making ` +
                "progress with bytes still unwritten",
            );
          remaining = chunksAfter(remaining, bytesWritten);
        }
      } else {
        await handle.writeFile(payload, { encoding });
      }
    } catch (err) {
      // Preserve the write failure: close best-effort so a close error on the
      // already-failed path cannot replace (mask) why the write failed, the same
      // reason get() swallows its own close error.
      await handle.close().catch(() => {});
      throw err;
    }
    // Write succeeded: await close and report its error rather than swallow it
    // -- on a write handle a failed close can signal the bytes did not durably
    // land (e.g. a deferred ENOSPC), the same as createExclusive's direct close.
    await handle.close();
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
    // O_EXCL already refuses any pre-existing entry (a planted symlink included);
    // O_NOFOLLOW via openNoFollow is defense in depth on the same open.
    const handle = await openNoFollow(filePath, "wx");
    await handle.close();
  }

  async exists(filePath: string): Promise<boolean> {
    return fs
      .access(filePath)
      .then(() => true)
      .catch(() => false);
  }
}
