import Ssh2SftpClient from "ssh2-sftp-client";
import {
  FileInfo,
  FileTransportClient,
  GetOptions,
  PutOptions,
  retryPromise,
} from "@psilink/core";

import { createCappedSink } from "./frameSizeGuard";
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_FILENAME_LENGTH,
  MAX_LISTING_READDIR_BATCHES,
  directoryTooLargeError,
  filenameTooLongError,
  listingStalledByBatchCountError,
  listingStalledByTimeoutError,
} from "./listingGuard";
import {
  SFTP_STALL_DEADLINE_MS,
  transportOperationStalledError,
  withSftpOperationDeadline,
} from "./sftpLivenessGuard";

// A single entry as ssh2's SFTPWrapper.readdir reports it. Only the fields the
// transport consumes are typed; ssh2 supplies more (longname, the rest of
// attrs).
interface Ssh2DirEntry {
  filename: string;
  attrs: { mtime: number; size: number };
}

// ssh2 reports SFTP failures (including end-of-directory from readdir) as an
// Error carrying the numeric SFTP status code on `code`.
type Ssh2SftpError = Error & { code?: number };

// Typed interface for the internal ssh2 SFTPWrapper that ssh2-sftp-client
// exposes as `this.sftp`. Defined at file scope so connect(), createExclusive(),
// and list() can share it without repeating the declaration.
interface Ssh2SftpClientInternals {
  sftp: {
    open(
      path: string,
      flags: number,
      attrs: Record<string, unknown>,
      callback: (err: Error | null, handle: Buffer) => void,
    ): void;
    close(handle: Buffer, callback: (err: Error | null) => void): void;
    opendir(
      path: string,
      callback: (err: Error | null, handle: Buffer) => void,
    ): void;
    // Called with a directory handle, readdir returns ONE server batch per call
    // and reports end-of-directory as an error whose `code` is SSH_FX_EOF (not
    // as an empty list), the contract the batch loop in list() relies on. `list`
    // is supplied only on success: ssh2 omits it (passes undefined) whenever
    // `err` is set, including the EOF signal, hence the optional parameter.
    readdir(
      handle: Buffer,
      callback: (err: Ssh2SftpError | null, list?: Ssh2DirEntry[]) => void,
    ): void;
  } | null;
}

export class SSH2SFTPClientAdapter implements FileTransportClient {
  private client: Ssh2SftpClient;
  private options: Ssh2SftpClient.ConnectOptions | undefined;

  constructor() {
    this.client = new Ssh2SftpClient();
  }

  async connect(options: Record<string, unknown>): Promise<void> {
    const maxReconnects =
      (options["maxReconnectAttempts"] as number | undefined) ?? 3;
    // Exclude the psilink-specific key before handing options to ssh2.
    // FileTransportClient uses Record<string,unknown> so the interface stays
    // transport-agnostic; cast here is intentional.
    const { maxReconnectAttempts: _, ...rest } = options;
    const connectOptions = rest as Ssh2SftpClient.ConnectOptions;
    this.options = connectOptions;
    await retryPromise(
      () => this.client.connect(connectOptions),
      maxReconnects,
      1_000,
    );
    // Verify that the sftp session required by createExclusive is available.
    // Run this once after retryPromise resolves rather than inside its
    // callback so an API breakage (a permanent failure mode) does not consume
    // the retry budget with no chance of self-resolving.
    const { sftp } = this.client as unknown as Ssh2SftpClientInternals;
    if (!sftp)
      throw new Error(
        "ssh2-sftp-client 'sftp' session property is not available " +
          "after connect(); the installed version may no longer expose " +
          "it - check for breaking changes in the ssh2-sftp-client " +
          "changelog",
      );
    // createExclusive() and list() reach past the public API to drive the
    // SFTPWrapper directly (exclusive create, and bounded streamed directory
    // reads, have no public-API equivalent). Verify every method those paths
    // call is present and callable now, so an upstream rename surfaces as one
    // actionable error here at connect time rather than as a TypeError at the
    // first send()/poll -- this is the connect-time guard those methods'
    // comments promise. A bare `!sftp` check would let a renamed method slip
    // through to first use.
    for (const method of ["open", "close", "opendir", "readdir"] as const) {
      if (typeof sftp[method] !== "function")
        throw new Error(
          `ssh2-sftp-client internal SFTP session no longer exposes a ` +
            `callable '${method}()' after connect(); the installed version ` +
            `may have renamed or removed it - check for breaking changes in ` +
            `the ssh2-sftp-client changelog`,
        );
    }
  }

  end(): Promise<void> {
    return this.client.end().then(() => {});
  }

  /**
   * Lists a remote directory under the directory-listing bounds (see
   * {@link ./listingGuard}), enforced at the transport read layer.
   *
   * It does NOT delegate to ssh2-sftp-client's `list()`: that passes the
   * directory PATH to `sftp.readdir`, which internally loops readdir until EOF
   * and accumulates the entire listing into one array before returning, so a
   * hostile directory's full (attacker-controlled) entry set is already resident
   * by the time any check could run. Instead this opens a directory handle and
   * reads one server batch at a time, applying the count and filename-length
   * checks as entries arrive, so an oversized or hostile directory is refused
   * before the full listing is materialized -- the SFTP path carries the
   * in-scope adversary (the server admin), so it must be bounded as firmly as
   * the local one. A single READDIR response is itself bounded by the SSH
   * transport's maximum packet size, so the bounded allocation is at most the
   * cap plus one batch.
   *
   * The session is reached via the same internal `sftp` property
   * createExclusive() uses; see its comment for the access-via-internals
   * rationale and the connect-time guard against an upstream API rename.
   *
   * The streamed read is bounded for liveness as well as for size. A hostile
   * server admin (in scope under docs/SECURITY_DESIGN.md "Channel security") can
   * hang this read indefinitely -- by returning valid but empty (count = 0)
   * non-EOF readdir batches forever, which advance neither size bound and never
   * signal EOF, or by withholding a readdir/close callback entirely so the call
   * never settles. Both are bounded here: a total readdir round-trip cap
   * ({@link MAX_LISTING_READDIR_BATCHES}) fails the progress-free flood, and a
   * whole-operation wall-clock deadline ({@link SFTP_STALL_DEADLINE_MS}) fails the
   * withheld-callback case (the only one no batch count can catch). Each surfaces
   * a typed terminal {@link TransportOperationStalledError} (a `UsageError`, so
   * the poll loop treats it as terminal) and closes the open directory handle on
   * the way out rather than leaking it. The same liveness class on {@link get}
   * and {@link createExclusive} is bounded by {@link withSftpOperationDeadline}.
   */
  list(path: string): Promise<FileInfo[]> {
    const { sftp } = this.client as unknown as Ssh2SftpClientInternals;
    if (!sftp)
      return Promise.reject(
        new Error(
          "SFTP session is not open; if this occurs after a successful " +
            "connect(), the ssh2-sftp-client internal API may have changed - " +
            "verify that the installed version still exposes the 'sftp' " +
            "session property",
        ),
      );
    // SSH_FX_EOF: the SFTP status code ssh2 reports (as err.code) from readdir
    // once the directory is fully read. Used directly rather than via a named
    // import because ssh2 does not expose its status-code table on its public
    // surface (the same reason createExclusive() uses numeric SFTP flags).
    const SSH_FX_EOF = 1;
    return new Promise<FileInfo[]>((resolve, reject) => {
      const results: FileInfo[] = [];
      let settled = false;
      // Undefined until opendir hands back a handle. settle() closes it only when
      // it is set, so a deadline that fires before (or instead of) a successful
      // opendir still settles -- with nothing to close.
      let handle: Buffer | undefined;
      // Round-trip counter for the liveness bound. A hostile server can return
      // valid but empty (count = 0) non-EOF readdir batches forever: each one
      // advances neither the entry-count nor the filename-length size bound and
      // never carries the EOF status, so the batch loop would recurse without
      // end. Capping the total readdir calls fails that progress-free flood with
      // a typed terminal error. (Production is safe from deep synchronous
      // recursion because ssh2 dispatches each readdir callback from a socket
      // event, a fresh tick; the cap is the DoS bound, not a stack guard.)
      let readdirCalls = 0;
      // Always clear the deadline, close the handle if one was opened, then
      // settle once. A close() failure on a read-only directory handle carries
      // no data meaning, so it is swallowed rather than allowed to mask the
      // result or the refusal (matching get()'s close handling). The `settled`
      // guard makes a late readdir callback or a late deadline fire a no-op and
      // prevents a double close. `deadline` is declared just below but only read
      // when settle() runs -- always after the timer is armed -- so the forward
      // reference resolves before it is used.
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (handle === undefined) action();
        else sftp.close(handle, () => action());
      };
      // Whole-operation wall-clock deadline. The round-trip cap cannot catch a
      // server that withholds an opendir/readdir/close callback entirely -- no
      // batch ever arrives to count -- so only elapsed time can fail that case.
      // Armed before opendir so it also bounds an opendir that never calls back;
      // settle() clears it on every terminal path so a completed listing leaves
      // no pending timer.
      const deadline = setTimeout(
        () =>
          settle(() =>
            reject(listingStalledByTimeoutError(path, SFTP_STALL_DEADLINE_MS)),
          ),
        SFTP_STALL_DEADLINE_MS,
      );
      sftp.opendir(path, (openErr, openedHandle) => {
        // The deadline may have already fired (the server withheld the opendir
        // callback past the bound, then delivered it late); settle() is then a
        // no-op, so do not open a read against an already-rejected listing.
        if (settled) return;
        if (openErr) {
          settle(() => reject(openErr));
          return;
        }
        handle = openedHandle;
        const readNextBatch = (): void => {
          if (++readdirCalls > MAX_LISTING_READDIR_BATCHES) {
            settle(() =>
              reject(
                listingStalledByBatchCountError(
                  path,
                  MAX_LISTING_READDIR_BATCHES,
                ),
              ),
            );
            return;
          }
          // openedHandle (not the outer `handle`) is the non-null Buffer here;
          // the outer `handle` exists only to let settle() close it on any path.
          sftp.readdir(openedHandle, (readErr, list) => {
            // A readdir callback delivered after the deadline already settled
            // must not process a batch against a rejected listing.
            if (settled) return;
            if (readErr) {
              if (readErr.code === SSH_FX_EOF) settle(() => resolve(results));
              else settle(() => reject(readErr));
              return;
            }
            // `list` is defined whenever readErr is null (the branch above has
            // already returned otherwise); `?? []` keeps the type honest and
            // treats a defensively-missing batch as empty. Apply the two bounds
            // in the SAME order as LocalFSClient.list(): the entry-count bound
            // first -- it governs every entry whatever its name -- then the
            // per-name length bound, so both adapters surface the same error
            // variant for a directory that breaches both at once. results.length
            // counts every entry seen (none are filtered out here), matching
            // LocalFSClient's `scanned`.
            for (const entry of list ?? []) {
              if (results.length >= MAX_DIRECTORY_ENTRIES) {
                settle(() =>
                  reject(directoryTooLargeError(path, MAX_DIRECTORY_ENTRIES)),
                );
                return;
              }
              if (entry.filename.length > MAX_FILENAME_LENGTH) {
                settle(() =>
                  reject(
                    filenameTooLongError(
                      path,
                      entry.filename,
                      MAX_FILENAME_LENGTH,
                    ),
                  ),
                );
                return;
              }
              results.push({
                name: entry.filename,
                // ssh2 reports mtime in seconds; FileInfo.modifyTime is ms -- the
                // same conversion ssh2-sftp-client's list() applies.
                modifyTime: entry.attrs.mtime * 1000,
                size: entry.attrs.size,
              });
            }
            readNextBatch();
          });
        };
        readNextBatch();
      });
    });
  }

  get(path: string, options?: GetOptions): Promise<Buffer<ArrayBufferLike>> {
    const maxBytes = options?.maxBytes;
    if (maxBytes === undefined) {
      // Uncapped reads carry no counting sink, so they have no per-chunk
      // progress signal to drive the idle bound the capped path below uses. The
      // transport always passes maxBytes, so this branch is effectively unused;
      // bound it with a coarse whole-operation deadline anyway so a withheld or
      // never-ending transfer fails rather than hanging. (A whole-operation
      // deadline would be too tight for a legitimately large capped transfer,
      // which is why the live path bounds the idle gap instead.)
      return withSftpOperationDeadline(
        this.client.get(path, undefined, {
          readStreamOptions: options,
        }) as Promise<Buffer<ArrayBufferLike>>,
        SFTP_STALL_DEADLINE_MS,
        () =>
          transportOperationStalledError(
            "file read",
            path,
            `did not complete within ${SFTP_STALL_DEADLINE_MS} ms (the server ` +
              `withheld the transfer)`,
          ),
      );
    }

    // Capped read. Stream into the shared counting sink rather than letting
    // ssh2-sftp-client buffer the whole transfer. The sink retains only the
    // under-cap prefix and, the instant the running total crosses the cap,
    // settles its own `result` with the typed terminal error AND fails the
    // write callback so the library aborts and destroys the read stream at the
    // server. So a server that under-reports the file's size in its directory
    // listing (and thus slips past the poll loop's pre-get() check) still
    // cannot drive an unbounded allocation here -- allocation stays bounded to
    // roughly maxBytes however the transfer ends.
    //
    // The over-cap outcome is owned by the sink, decided at the point of
    // detection; this get()'s own settle only feeds the non-over-cap cases via
    // complete()/fail(). That removes the resolve-vs-reject race in
    // ssh2-sftp-client's stream-destination handling (it resolves via the read
    // stream's 'end' event but rejects via the sink's 'error' event) -- see
    // createCappedSink. No encoding is forwarded (raw Buffer chunks) so the byte
    // count is exact; the caller's own toString() decodes, matching the buffer
    // that the uncapped path and LocalFSClient return.
    const { sink, result, complete, fail } = createCappedSink(path, maxBytes);
    // The over-cap path settles `result` from inside the sink, so this handler
    // never rejects (complete/fail are no-ops once `result` has settled);
    // `result` is the returned promise.
    void this.client.get(path, sink).then(complete, fail);
    return result;
  }

  put(
    src: string | Buffer | NodeJS.ReadableStream,
    dest: string,
    options?: PutOptions,
  ): Promise<unknown> {
    return retryPromise(
      () => this.client.put(src, dest, { writeStreamOptions: options }),
      this.options!.retries || 5,
      100,
    );
  }

  delete(path: string): Promise<void> {
    return this.client.delete(path).then(() => {});
  }

  safeDelete(path: string): Promise<void> {
    return retryPromise(
      () =>
        this.client.delete(path, true).then(
          () => {},
          () => {},
        ),
      1,
      100,
    );
  }

  rename(fromPath: string, toPath: string): Promise<void> {
    return this.client.rename(fromPath, toPath).then(() => {});
  }

  createExclusive(path: string): Promise<void> {
    // ssh2-sftp-client does not expose exclusive file creation; access the
    // underlying SFTP session to open with SSH_FXF_WRITE | SSH_FXF_CREAT |
    // SSH_FXF_EXCL (0x2A). SSH_FXF_EXCL is part of the core SFTPv3 protocol
    // and requires no server extension. Numeric flags are used directly instead
    // of a string alias ('wx') because SFTPWrapper's string-to-openmask
    // translator is not part of the public API contract, and an unrecognized
    // string would silently degrade to a non-exclusive open.
    //
    // On exclusive-create failure, SFTPv4+ servers return
    // SSH_FX_FILE_ALREADY_EXISTS (status 11), which is unambiguously mapped to
    // EEXIST. SFTPv3 servers — including OpenSSH in its default mode — return
    // SSH_FX_FAILURE (status 4), which is the generic SFTPv3 failure code and
    // does not distinguish "file already exists" from quota, permissions, or
    // other I/O errors. For code 4 this method calls exists() after the failure:
    // if the file is present, the exclusive-create lost a genuine lock-file race
    // (EEXIST); if the file is absent, the failure was a real I/O error and the
    // original error is propagated unchanged. This preserves correct lock-file
    // race recovery while surfacing I/O errors at synchronization time rather
    // than deferring them to the first send().
    //
    // ssh2 sets err.code to the numeric SFTP status code, not the POSIX
    // string "EEXIST". The string form is passed through unchanged in case a
    // future ssh2 version normalizes it first.
    //
    // ssh2-sftp-client stores the underlying ssh2 SFTPWrapper in `this.sftp`.
    // This has been true throughout the library's history and is true of the
    // version range in package.json (^12.0.1). There is no public method for
    // exclusive file creation, so we access this field via the file-scope
    // Ssh2SftpClientInternals interface. The null check below guards against
    // a closed or prematurely-ended session; an API rename is caught at
    // connect time by the check in connect().
    const { sftp } = this.client as unknown as Ssh2SftpClientInternals;
    if (!sftp)
      return Promise.reject(
        new Error(
          "SFTP session is not open; if this occurs after a successful " +
            "connect(), the ssh2-sftp-client internal API may have changed - " +
            "verify that the installed version still exposes the 'sftp' " +
            "session property",
        ),
      );
    // SSH_FXF_WRITE (0x02) | SSH_FXF_CREAT (0x08) | SSH_FXF_EXCL (0x20)
    const EXCL_WRITE_CREATE = 0x2a;
    const attempt = new Promise<void>((resolve, reject) => {
      sftp.open(path, EXCL_WRITE_CREATE, {}, (openErr, handle) => {
        if (openErr) {
          // Normalize SFTPv4+ FILE_ALREADY_EXISTS (11) directly to EEXIST.
          // SFTPv3 FAILURE (4) is ambiguous: resolve it via an exists() check
          // and normalize to EEXIST only when the file is actually present.
          // If a future ssh2 version already normalizes to the POSIX string
          // "EEXIST", pass the error through unchanged to avoid wrapping noise.
          // A new error is created for the numeric codes rather than mutating
          // openErr: ssh2 constructs a fresh error per callback, but treating
          // the caught object as immutable avoids surprising callers that
          // inspect the original.
          const errCode = (openErr as unknown as Record<string, unknown>).code;
          if (errCode === 11) {
            reject(
              Object.assign(new Error(openErr.message), {
                code: "EEXIST",
                cause: openErr,
              }),
            );
            return;
          }
          if (errCode === 4) {
            // If exists() itself rejects (e.g., a second network failure
            // immediately after the exclusive-open failure), the ambiguity
            // cannot be resolved; propagate openErr unchanged so the caller
            // sees the original I/O error rather than a confusing secondary
            // one.
            this.exists(path).then(
              (fileExists) => {
                reject(
                  fileExists
                    ? Object.assign(new Error(openErr.message), {
                        code: "EEXIST",
                        cause: openErr,
                      })
                    : Object.assign(
                        new Error(
                          `SFTP exclusive-create failed (SSH_FX_FAILURE) ` +
                            `and the target file is not present, so the ` +
                            `cause is a server-side I/O error rather than a ` +
                            `lock-file race. Check the SFTP server logs for ` +
                            `the underlying cause (disk full, permissions, ` +
                            `quota) before retrying; SFTPv3 cannot ` +
                            `distinguish a transient race from a permanent ` +
                            `failure, so a single retry is reasonable only ` +
                            `if a race is plausible. Original error: ` +
                            `${openErr.message}`,
                        ),
                        { cause: openErr },
                      ),
                );
              },
              () => reject(openErr),
            );
            return;
          }
          reject(openErr);
          return;
        }
        sftp.close(handle, (closeErr) => {
          if (closeErr) reject(closeErr);
          else resolve();
        });
      });
    });
    // Bound the whole operation -- open, the SFTPv3 code-4 exists() fallback, and
    // close -- against a server that withholds any of those callbacks, so an
    // exclusive create cannot hang the rendezvous lock path forever. The wrapper
    // only races: a handle opened just before a withheld close is not reclaimed
    // (that close cannot itself complete), but the exchange fails terminally
    // rather than stalling, and the session teardown releases the session.
    return withSftpOperationDeadline(
      attempt,
      SFTP_STALL_DEADLINE_MS,
      () =>
        transportOperationStalledError(
          "exclusive create",
          path,
          `did not complete within ${SFTP_STALL_DEADLINE_MS} ms (the server ` +
            `withheld the open or close response)`,
        ),
    );
  }

  exists(remotePath: string): Promise<boolean> {
    return this.client.exists(remotePath).then(Boolean);
  }
}
