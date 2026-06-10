// This adapter drives ssh2's raw SFTPWrapper internals past the public
// ssh2-sftp-client API, so ssh2 and ssh2-sftp-client are exact-pinned in
// package.json. On any upgrade of either, re-verify the internal premises per
// the checklist in docs/SECURITY_DESIGN.md ("Upgrading the SFTP stack") before
// it merges -- a "compatible" bump can silently break a premise no normal-path
// test exercises.
import Ssh2SftpClient from "ssh2-sftp-client";
import {
  FileInfo,
  FileTransportClient,
  GetOptions,
  PutOptions,
  TransportOperationStalledError,
  getLoggerForVerbosity,
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
  withSlowOperationWarning,
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

// SSH_FX_FAILURE: the generic SFTPv3 status (4) a server returns when an
// operation did not take effect for a reason it does not further classify. The
// numeric value reaches us because ssh2-sftp-client passes ssh2's raw status
// through fmtError onto err.code (the same premise createExclusive's code-4
// handling relies on).
const SSH_FX_FAILURE = 4;

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
    // The raw ssh2 SFTPWrapper is an EventEmitter: ssh2 emits a fatal 'error' on
    // it (via doFatalSFTPError) when the server returns a malformed SFTP packet.
    // The adapter attaches its own guarded listener in connect() so that emit
    // cannot crash the process; see the connect() comment for why no one else
    // does. `unknown` rather than the full Node listener type keeps this minimal
    // -- the adapter only registers and never inspects the listener set.
    on(event: "error", listener: (err: Error) => void): unknown;
  } | null;
}

export class SSH2SFTPClientAdapter implements FileTransportClient {
  private client: Ssh2SftpClient;
  private options: Ssh2SftpClient.ConnectOptions | undefined;
  private log: ReturnType<typeof getLoggerForVerbosity>;
  // The raw SFTPWrapper this adapter has already attached its fatal-'error'
  // listener to, so connect() attaches exactly once per wrapper instance (see
  // attachFatalErrorListener). Stored as the wrapper object identity, not a
  // boolean, because ssh2-sftp-client hands back a fresh wrapper after an
  // end()/connect() cycle and the new one needs its own listener.
  private guardedSftp: object | undefined;
  // The fatal SFTP-protocol error captured by that listener, if one has fired.
  // Set once the session is dead; read by in-flight operations so they reject
  // promptly with the real cause instead of waiting out the 60 s liveness
  // deadline. Never cleared: a wrapper that emitted a fatal 'error' is
  // destroyed by ssh2 and cannot recover, and connect() resets it to undefined
  // alongside attaching a listener to a fresh wrapper.
  private fatalSftpError: Error | undefined;
  // The per-operation wall-clock liveness deadline (ms) every server-driven read
  // is bounded by. Defaults to SFTP_STALL_DEADLINE_MS and is NOT exposed through
  // any config or CLI surface -- the bound stays fixed in production for the same
  // reason the constant is (a configurable budget risks an operator raising it
  // high enough to reintroduce the denial of service). The only override is the
  // internal-only test seam on the constructor's options object, which lets a
  // fault-injection test drive the deadline in milliseconds instead of waiting
  // the real 60 s; it is never wired to user input.
  private readonly stallDeadlineMs: number;

  /**
   * `options.verbosity` sets the adapter's log verbosity (default 1).
   *
   * `options.stallDeadlineMs` is an @internal test-only override for the
   * per-operation liveness deadline; production constructs the adapter with no
   * argument (an empty options object) and gets {@link SFTP_STALL_DEADLINE_MS}.
   * It is a named options field rather than a positional argument so the seam is
   * unmistakable and a future production constructor parameter can never be
   * passed as the deadline by accident. Deliberately not surfaced via config so
   * the bound cannot be widened by an operator.
   */
  constructor(options: { verbosity?: number; stallDeadlineMs?: number } = {}) {
    this.client = new Ssh2SftpClient();
    this.log = getLoggerForVerbosity("sftp-adapter", options.verbosity ?? 1);
    this.stallDeadlineMs = options.stallDeadlineMs ?? SFTP_STALL_DEADLINE_MS;
  }

  // Layers the non-fatal slow-operation warning (observability) over an in-flight
  // operation. Strictly above the terminal bounds: the per-operation read
  // deadlines and the consumer-layer whole-exchange budget are what fail a stalled
  // op; this only surfaces "still working" to a watching operator, with cheap
  // observed progress where one exists. See withSlowOperationWarning.
  private warnIfSlow<T>(
    op: Promise<T>,
    operation: string,
    path: string,
    progress?: (elapsedMs: number) => string,
  ): Promise<T> {
    return withSlowOperationWarning(op, {
      operation,
      path,
      log: this.log,
      progress,
    });
  }

  // Attach a single guarded 'error' listener to the raw ssh2 SFTPWrapper.
  //
  // This and the other internal-ssh2 premises this adapter relies on are
  // enumerated, with the dependency source files to re-read and the
  // integration-test command to run, in the "Upgrading the SFTP stack" checklist
  // in docs/SECURITY_DESIGN.md ("Channel security"). Re-verify them on any ssh2 /
  // ssh2-sftp-client upgrade.
  //
  // ssh2's Client.sftp() attaches a setup-time 'error' listener to the wrapper
  // but strips it (removeListeners() inside onReady) before handing the wrapper
  // back, and ssh2-sftp-client attaches 'error' handlers only to the SSH Client
  // and to per-operation read/write streams -- never to the wrapper itself. So
  // after connect() the wrapper carries no 'error' listener. A hostile or dead
  // SFTP server (in scope under docs/SECURITY_DESIGN.md "Channel security") that
  // returns a malformed SFTP reply packet drives ssh2's doFatalSFTPError ->
  // sftp.emit('error', err) on a listener-free EventEmitter, which Node turns
  // into an uncaught exception that crashes the CLI -- skipping lock/temp-file
  // cleanup and the typed exit-code mapping. The size guards bound memory and
  // the liveness guards bound time, but a crash is neither; this listener closes
  // that last hostile-server vector.
  //
  // Handling the 'error' leaves the session dead but the process alive. ssh2's
  // doFatalSFTPError emits 'error', destroys the wrapper, then calls
  // cleanupRequests, which fails every request still in _requests at once. What
  // that bounds an IN-FLIGHT list()/get() by depends on which request the fatal
  // packet rode in on:
  //   - A malformed reply to the in-flight request ITSELF is NOT failed by
  //     cleanupRequests: ssh2's NAME and DATA handlers do `delete _requests[reqid]`
  //     unconditionally up front, BEFORE the parse/check that calls
  //     doFatalSFTPError (node_modules/ssh2/lib/protocol/SFTP.js, NAME ~2939,
  //     DATA ~2889); the HANDLE handler instead deletes inside its own malformed
  //     branch, on a defined reqid, immediately before doFatalSFTPError (~2872).
  //     The deletes differ in placement but have the same net effect: by the time
  //     cleanupRequests runs there is no entry left for that reqid and its
  //     callback never fires. The in-flight op therefore hangs until this
  //     adapter's own 60 s wall-clock deadline (list()'s deadline /
  //     withSftpOperationDeadline / the capped-sink idle window) fires -- the
  //     deadline, not cleanupRequests, is what bounds it.
  //   - A fatal error on a DIFFERENT request id, or a connection-level fault
  //     (e.g. "Invalid packet length", where no reqid was consumed), leaves the
  //     in-flight request still in _requests, so cleanupRequests does fail its
  //     callback promptly.
  // Either way the op is bounded; the deadline is load-bearing for the first,
  // realistic case and must not be removed on the assumption that cleanupRequests
  // covers in-flight ops. Capturing the cause in fatalSftpError then bounds the
  // NEXT operation (whatever bounded the in-flight one): it consults
  // deadSessionError at entry and rejects with the real reason instead of issuing
  // a request the dead wrapper can never answer. The same 60 s deadline is also
  // the sole bound for the distinct case of a server that withholds a callback
  // WITHOUT any fatal error -- no 'error' fires there, so fatalSftpError stays
  // unset and only elapsed time can fail it.
  //
  // Idempotency and the reconnect lifecycle: verified against ssh2-sftp-client
  // 12.1.1 (node_modules/ssh2-sftp-client/src/index.js), `this.sftp` is assigned
  // exactly once, in the 'ready' handler, and is otherwise only set to undefined
  // (in the constructor and in end()'s close handler); there is no auto-reconnect
  // that swaps in a fresh wrapper after connect() resolves, and connect() rejects
  // outright if `this.sftp` is already set. A new wrapper therefore appears only
  // when this adapter's own connect() runs again after an end(). Guarding on the
  // wrapper's object identity attaches once per wrapper: a repeated connect() on
  // the same live wrapper is a no-op (no duplicate listener, no
  // MaxListenersExceeded warning), while a fresh wrapper from a reconnect gets
  // its own listener.
  private attachFatalErrorListener(
    sftp: NonNullable<Ssh2SftpClientInternals["sftp"]>,
  ): void {
    if (this.guardedSftp === sftp) return;
    this.guardedSftp = sftp;
    this.fatalSftpError = undefined;
    sftp.on("error", (err: Error) => {
      this.fatalSftpError = err;
    });
  }

  // A terminal error built from a previously captured fatal SFTP-protocol error,
  // or undefined if the session has not been killed. Every server-driven
  // operation consults this at entry so one that runs after a malformed packet
  // already destroyed the session rejects at once with the real cause, rather
  // than issuing a request the dead wrapper can never answer. For the
  // deadline-bounded reads (list/get/createExclusive) that spares them the 60 s
  // wait; for the unbounded write/stat/delete paths (put/delete/rename/exists),
  // whose buffered request on a destroyed-but-socket-still-alive channel never
  // calls back, it is the difference between a prompt failure and an indefinite
  // hang. safeDelete shares the same fatalSftpError check but RESOLVES (its
  // never-reject contract); see it for why. A typed
  // TransportOperationStalledError (a UsageError) so the poll loop and the
  // rendezvous gate treat it as terminal, the same as every other liveness bound.
  private deadSessionError(
    operation: string,
    path: string,
  ): TransportOperationStalledError | undefined {
    if (this.fatalSftpError === undefined) return undefined;
    return transportOperationStalledError(
      operation,
      path,
      `the SFTP session was killed by a fatal server protocol error ` +
        `(${this.fatalSftpError.message})`,
    );
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
    // Attach the guarded fatal-'error' listener to the raw wrapper now, while it
    // is known present and callable, so a malformed server reply can never crash
    // the process. See attachFatalErrorListener for the full rationale and the
    // reconnect/idempotency analysis.
    this.attachFatalErrorListener(sftp);
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
    const dead = this.deadSessionError("directory listing", path);
    if (dead) return Promise.reject(dead);
    // SSH_FX_EOF: the SFTP status code ssh2 reports (as err.code) from readdir
    // once the directory is fully read. Used directly rather than via a named
    // import because ssh2 does not expose its status-code table on its public
    // surface (the same reason createExclusive() uses numeric SFTP flags).
    const SSH_FX_EOF = 1;
    // Hoisted out of the executor so the slow-operation warning can report
    // entries-read-so-far as the listing's cheap observed-progress signal.
    const results: FileInfo[] = [];
    return this.warnIfSlow(
      new Promise<FileInfo[]>((resolve, reject) => {
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
        // Settle the listing exactly once, then close the handle best-effort. The
        // `settled` guard makes a late readdir callback or a late deadline fire a
        // no-op and prevents a double close. `deadline` is declared just below but
        // only read when settle() runs -- always after the timer is armed -- so the
        // forward reference resolves before it is used.
        const settle = (action: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          // Settle BEFORE closing, and never gate the settlement on the close
          // callback: a hostile server can withhold the close callback exactly as
          // it withholds a readdir, so awaiting close() here would let the deadline
          // fire, clear its own timer, then hang forever inside an un-returning
          // close -- restoring the unbounded wait this guard exists to defeat.
          // Close is best-effort cleanup that reclaims the handle on a well-behaved
          // server; a withheld close callback leaks the handle until session
          // teardown, with the listing already settled. A close() error on a
          // read-only directory handle has no data meaning, so it is swallowed.
          action();
          if (handle !== undefined) sftp.close(handle, () => {});
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
              reject(listingStalledByTimeoutError(path, this.stallDeadlineMs)),
            ),
          this.stallDeadlineMs,
        );
        // The deadline is the safety bound, not real work: cleared on every
        // terminal path, so unref'ing it only matters if the process is winding
        // down with a listing still in flight, where it must not block exit.
        deadline.unref();
        sftp.opendir(path, (openErr, openedHandle) => {
          // The deadline may have already fired (the server withheld the opendir
          // callback past the bound, then delivered it late); settle() already
          // rejected the listing, so do not open a read against it. settle() ran
          // before `handle` was assigned, though, so it could not close a handle
          // opendir is only now handing back -- close it here best-effort so this
          // late handle does not leak until session teardown.
          if (settled) {
            if (!openErr) sftp.close(openedHandle, () => {});
            return;
          }
          if (openErr) {
            settle(() => reject(openErr));
            return;
          }
          handle = openedHandle;
          const readNextBatch = (): void => {
            // Mirror the settled-guards in settle() and the readdir callback below.
            // Both call sites reach here synchronously after a settled check and the
            // deadline timer cannot fire between synchronous statements, so settled
            // is necessarily false today; re-checking at the recursion entry keeps
            // the driver self-evidently safe against any future change that could
            // re-enter it after the deadline fired, at the cost of only a skipped
            // round-trip rather than a double-settle.
            if (settled) return;
            // Pre-increment: this issues at most MAX_LISTING_READDIR_BATCHES actual
            // readdir round-trips. The (cap + 1)th entry to readNextBatch trips the
            // guard and rejects BEFORE issuing another readdir, so the server sees
            // exactly MAX_LISTING_READDIR_BATCHES readdir calls (what the test
            // asserts), even though `readdirCalls` itself reaches cap + 1 here.
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
      }),
      "directory listing",
      path,
      () =>
        `${results.length} ${results.length === 1 ? "entry" : "entries"} read ` +
        "so far",
    );
  }

  get(path: string, options?: GetOptions): Promise<Buffer<ArrayBufferLike>> {
    const dead = this.deadSessionError("file read", path);
    if (dead) return Promise.reject(dead);
    const maxBytes = options?.maxBytes;
    if (maxBytes === undefined) {
      // Uncapped reads carry no counting sink, so they have no per-chunk
      // progress signal to drive the idle bound the capped path below uses. The
      // transport always passes maxBytes, so this branch is effectively unused;
      // bound it with a coarse whole-operation deadline anyway so a withheld or
      // never-ending transfer fails rather than hanging. (A whole-operation
      // deadline would be too tight for a legitimately large capped transfer,
      // which is why the live path bounds the idle gap instead.)
      // Elapsed-only warning: an uncapped read has no counting sink, so there is
      // no cheap bytes-so-far signal to report.
      return this.warnIfSlow(
        withSftpOperationDeadline(
          this.client.get(path, undefined, {
            readStreamOptions: options,
          }) as Promise<Buffer<ArrayBufferLike>>,
          this.stallDeadlineMs,
          () =>
            transportOperationStalledError(
              "file read",
              path,
              `did not complete within ${this.stallDeadlineMs} ms (the server ` +
                `withheld the transfer)`,
            ),
        ),
        "file read",
        path,
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
    const { sink, result, complete, fail, bytesReceived } = createCappedSink(
      path,
      maxBytes,
      this.stallDeadlineMs,
    );
    // The over-cap path settles `result` from inside the sink, so this handler
    // never rejects (complete/fail are no-ops once `result` has settled);
    // `result` is the returned promise.
    void this.client.get(path, sink).then(complete, fail);
    // Warn with bytes-so-far and an average rate from the sink's running count.
    return this.warnIfSlow(result, "file read", path, (elapsedMs) => {
      const bytes = bytesReceived();
      const rate = Math.round(bytes / (elapsedMs / 1000));
      return `${bytes} bytes received so far (~${rate} bytes/s)`;
    });
  }

  put(
    src: string | Buffer | NodeJS.ReadableStream,
    dest: string,
    options?: PutOptions,
  ): Promise<unknown> {
    const dead = this.deadSessionError("file write", dest);
    if (dead) return Promise.reject(dead);
    // Report the total payload size where it is known up front (a Buffer src,
    // which is what send()/writeAck() always pass). This is observed signal taken
    // for free from the source, NOT a bytes-acked counter: instrumenting the
    // upload stream to count acked bytes would put observability machinery inside
    // the always-on write path, which the warning must stay clear of. A stream src
    // has no cheap size, so it falls back to elapsed-only.
    const totalBytes = Buffer.isBuffer(src) ? src.length : undefined;
    return this.warnIfSlow(
      retryPromise(
        () => this.client.put(src, dest, { writeStreamOptions: options }),
        this.options!.retries || 5,
        100,
      ),
      "file write",
      dest,
      totalBytes === undefined ? undefined : () => `${totalBytes} byte payload`,
    );
  }

  delete(path: string): Promise<void> {
    const dead = this.deadSessionError("file delete", path);
    if (dead) return Promise.reject(dead);
    return this.warnIfSlow(
      this.client.delete(path).then(() => {}),
      "delete",
      path,
    );
  }

  safeDelete(path: string): Promise<void> {
    // safeDelete must never reject (callers use it inside catch blocks, see the
    // FileTransportClient contract), so a dead session is a best-effort no-op
    // that RESOLVES rather than rejecting like the other guarded methods. This
    // is the realistic teardown path: a fatal protocol error stops the poll loop,
    // then close() -> cleanup() -> safeDelete drives a delete against the still-
    // alive hostile server, whose destroyed channel would buffer the request and
    // never call back -- hanging the whole teardown. Short-circuiting here returns
    // at once. (delete() above rejects instead: its callers want the error
    // surfaced, whereas safeDelete's must never see one.)
    if (this.fatalSftpError !== undefined) return Promise.resolve();
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
    const dead = this.deadSessionError("file rename", fromPath);
    if (dead) return Promise.reject(dead);
    // Retry a transient rename failure under put()'s bounded budget (one initial
    // attempt plus up to `retries` re-issues, 100 ms apart), but -- unlike put(),
    // which is idempotent -- only on the generic SSH_FX_FAILURE (status 4). That
    // is the "operation did not take effect" code that surfaced as the
    // intermittent `_rename: Failure` on the rendezvous joiner's
    // <id>-joining.json -> <id>-hello.json publish (and is equally reachable on
    // send()/writeAck()'s temp-file -> final-name publishes): the server reported
    // the rename did not happen, so `fromPath` still exists and a re-issue is
    // safe. Every other status is terminal and surfaces at once -- crucially
    // SSH_FX_NO_SUCH_FILE (2), which a second attempt would see if the first had
    // actually succeeded but its reply was lost; retrying that would turn a
    // succeeded rename into a spurious error. ssh2-sftp-client passes the raw
    // ssh2 numeric status through fmtError to err.code (the same premise
    // createExclusive relies on); a non-status library error (e.g. a dead-session
    // 'ERR_GENERIC_CLIENT') is not 4 and so is not retried.
    return this.warnIfSlow(
      retryPromise(
        () => this.client.rename(fromPath, toPath).then(() => {}),
        this.options!.retries || 5,
        100,
        (error) => (error as Ssh2SftpError | null | undefined)?.code === SSH_FX_FAILURE,
      ),
      "rename",
      `${fromPath} to ${toPath}`,
    );
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
    const dead = this.deadSessionError("exclusive create", path);
    if (dead) return Promise.reject(dead);
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
            // Raw client existence check, not this.exists(): the public method
            // is warnIfSlow-wrapped, and the whole `attempt` (this fallback
            // included) is already wrapped once at the return site, so routing
            // through this.exists() here would arm a second, overlapping slow-op
            // warning for the same logical createExclusive. The outer wrap still
            // bounds and reports this check.
            this.client
              .exists(path)
              .then(Boolean)
              .then(
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
    return this.warnIfSlow(
      withSftpOperationDeadline(attempt, this.stallDeadlineMs, () =>
        transportOperationStalledError(
          "exclusive create",
          path,
          `did not complete within ${this.stallDeadlineMs} ms (the server ` +
            `withheld the open, existence-check, or close response)`,
        ),
      ),
      "exclusive create",
      path,
    );
  }

  exists(remotePath: string): Promise<boolean> {
    // Reject rather than return a boolean on a dead session: a destroyed channel
    // cannot answer the stat, and a fabricated true/false would be a guess the
    // caller could act on. (createExclusive()'s code-4 ambiguity fallback does its
    // own existence check via the raw client, not this method, so this guard does
    // not affect it.)
    const dead = this.deadSessionError("existence check", remotePath);
    if (dead) return Promise.reject(dead);
    return this.warnIfSlow(
      this.client.exists(remotePath).then(Boolean),
      "existence check",
      remotePath,
    );
  }
}
