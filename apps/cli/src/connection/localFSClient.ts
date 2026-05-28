import fs from "node:fs/promises";
import path from "node:path";

import { retryPromise, withTimeout } from "@psilink/core";
import type {
  FileInfo,
  FileTransportClient,
  GetOptions,
  PutOptions,
} from "@psilink/core";

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
   * Retries up to `options.maxReconnectAttempts` times (default: 3) with a
   * hard-coded 1-second delay between attempts, and enforces
   * `options.connectTimeoutMs` (default: 30s) per attempt.
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

    // fs.access on a stalled NFS/CIFS hard mount blocks a libuv thread
    // pool worker, not the event loop, so setTimeout fires normally and
    // this race genuinely enforces the timeout rather than waiting for the
    // OS-level retry window (which can be several minutes).
    // Known limitation: when the timeout fires, the abandoned fs.access()
    // promise continues running in the background until the OS releases
    // the thread. The proper fix — threading an AbortSignal through
    // FileTransportClient.connect so LocalFSClient can pass it to
    // fs.access — is an open task.
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
    );
  }

  /** No-op: there is no remote connection to tear down. */
  async end(): Promise<void> {}

  async list(dir: string): Promise<FileInfo[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const fileEntries = entries.filter((e) => e.isFile());
    // readdir withFileTypes provides the file type but not mtimeMs; a stat per
    // file is unavoidable. Promise.all keeps the calls parallel.
    // ENOENT means a file was deleted between readdir and stat (e.g. by the
    // peer's cleanup); omit it rather than failing the whole listing.
    const results = await Promise.all(
      fileEntries.map(async ({ name }) => {
        try {
          const stat = await fs.stat(path.join(dir, name));
          return { name, modifyTime: Math.floor(stat.mtimeMs) } as FileInfo;
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
   */
  async get(
    filePath: string,
    _options?: GetOptions,
  ): Promise<Buffer<ArrayBufferLike>> {
    return fs.readFile(filePath);
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
