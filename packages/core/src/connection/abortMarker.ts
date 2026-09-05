// The authenticated cross-party abort-marker subsystem for the file-sync
// transports: the real, stateful control that lets a party which failed
// terminally with its directory still writable leave a best-effort
// `<id>-abort.json` so a waiting peer fast-fails with a definitive
// PeerAbortError instead of waiting out the full peer-inactivity budget.
// Holds live per-exchange state (the two role-derived tokens, the captured
// write inputs, and the write-vs-seal decision one-shot the teardown
// sequencing parks on), so unlike the pure fileSyncNames/sftpConnect
// extractions it is a class FileSyncConnection composes rather than a bag
// of free functions.
//
// The abort-marker rationale -- the HKDF-derived token and its per-role /
// per-session binding, the size cap and short write budget, why the marker
// is best-effort and holds no cause, and the fail-closed read -- is
// normatively specified in docs/spec/CHANNEL_SECURITY.md ("Authenticated
// abort marker"). This module implements that control and does not
// restate it; the comments here cover only the local mechanics (state
// ownership, teardown sequencing, idempotency) the spec section does not.
//
// Not re-exported by the package barrel (main.ts barrels
// fileSyncConnection.ts, not this file), so it stays out of the public
// runtime surface while fileSyncConnection.ts composes it -- the same
// pattern as fileSyncNames.ts and sftpConnect.ts. The connection keeps
// thin delegating members (armAbort / writeAbortMarker / sealAbort /
// abortArmed and the internal test call sites) so its public surface --
// what the CLI orchestrator and the unit tests call -- is unchanged.

import { v4 as uuidv4 } from "uuid";

import type { getLoggerForVerbosity } from "../utils/logger";
import { redactAndSanitizeForDisplay } from "../utils/sanitizeErrorForDisplay";
import { toBase64Url, fromBase64Url, bytesEqual } from "../utils/crypto";
import { parseBoundedJson } from "../utils/boundedJson";
import { TransportOperationStalledError } from "../errors";
import { ABORT_SUFFIX } from "./fileSyncNames";
import type { FileInfo, FileTransportClient } from "./fileSyncConnection";

// Hard cap on the abort marker read. The envelope is ~80 bytes; 1 KiB is
// generous slack. Not MAX_FRAME_SIZE_BYTES (~512 MB): the recognizer is
// unconditional and the admin controls the bytes, and the marker is
// re-read every poll cycle, so a large cap on an admin-plantable file
// would be an availability vector. Both the pre-get() listed-size refusal
// and the bounded get() use this.
const ABORT_MARKER_MAX_BYTES = 1024;

// Short per-operation budget (put + rename) for the abort marker write. The
// marker write must not inherit boundTransport's fresh-peerTimeoutMs
// (default 1 hour) budget: a faulted write, the sick-directory case the
// marker exists for, would otherwise hang teardown. The SFTP adapter
// self-bounds reads at ~60 s, but the local-FS/filedrop adapter has no
// per-op bound, so the write rides the 1h budget there unless given its
// own short one. A few seconds is generous for an ~80-byte control file
// and fast-fails a sick transport.
const ABORT_MARKER_WRITE_BUDGET_MS = 5000;

// Bounds how long close() waits for the abort decision (write vs seal) to
// resolve -- not a bound on the marker write itself. Unref'd and
// resolve-on-timeout (modeled on withTransportBudgetVoid), so it neither
// hangs close() nor holds a failing process open. Normally resolves
// sub-second; the timeout fires only when the orchestrator is busy with a
// long local step (e.g. a large match) while the connection faults in the
// background, so it has not yet observed the fault. That path is benign:
// the marker write is best-effort and separately bounded by
// ABORT_MARKER_WRITE_BUDGET_MS, so a no-marker outcome just degrades to
// the peer-silence hedge. Once the decision is "write", close() awaits
// that write in full and separately -- the grace never truncates it.
// Reusing the write budget here is just a generous magnitude for the
// decision wait, not a coupling to the write duration.
const ABORT_DECISION_GRACE_MS = ABORT_MARKER_WRITE_BUDGET_MS;

// Everything writeAbortMarker() needs, captured by arm() post-handshake so the
// write never reads the connection's path (which close() nulls during
// teardown). The client is the raw, unwrapped transport: the marker write is
// short-bounded by withTransportBudget directly (see
// ABORT_MARKER_WRITE_BUDGET_MS) rather than riding boundTransport's 1h per-op
// budget.
interface AbortWriteInputs {
  path: string;
  finalName: string;
  // A Buffer, not a string: FileTransportClient.put treats a string src as
  // a local file path to copy from (ssh2-sftp-client semantics;
  // LocalFSClient rejects it outright), so every body this codebase writes
  // is a Buffer or a header+payload chunk list -- hellos, the zero-length
  // ack, and this single-Buffer abort marker; only a data-plane message
  // uses the two-chunk [header, payload] list (see send()). A wrong shape
  // throws and, being best-effort, is silently swallowed, leaving no
  // marker.
  body: Buffer;
  client: FileTransportClient;
}

// The transport-budget primitives the subsystem borrows from FileSyncConnection,
// injected rather than re-implemented: they are transport-generic (boundTransport
// and close()'s drain use the same withTransportBudget) and stay owned by the
// connection. `runBudgeted` is withTransportBudget; `stalledError` is
// transportBudgetExceededError.
interface AbortMarkerDeps {
  log: ReturnType<typeof getLoggerForVerbosity>;
  role: () => string;
  runBudgeted: <T>(
    op: Promise<T>,
    budgetMs: number,
    makeError: () => TransportOperationStalledError,
  ) => Promise<T>;
  stalledError: (
    operation: string,
    budgetMs: number,
  ) => TransportOperationStalledError;
}

/**
 * The authenticated cross-party abort marker as a self-contained, stateful
 * subsystem {@link FileSyncConnection} composes. Owns the abort state (the two
 * role-derived tokens, the captured write inputs, and the write-vs-seal
 * decision one-shot), and exposes the operations the connection's delegating
 * members forward to. See docs/spec/CHANNEL_SECURITY.md ("Authenticated abort
 * marker").
 *
 * @internal
 */
export class AbortMarkerSubsystem {
  // Authenticated cross-party abort state, armed by arm() post-handshake (the
  // only point with a session key) and cleared with the handshake identity it
  // derives from (clear(), at close() and the rendezvous recovery sites). The
  // two tokens are role-derived, hence identity-scoped; they are NOT reset in
  // resetSessionState (which resets only per-session message counters).
  private selfAbortToken: Uint8Array<ArrayBuffer> | undefined;
  private peerAbortToken: Uint8Array<ArrayBuffer> | undefined;
  // Captured write inputs (immunizes the write against close()'s path/config
  // nulling) and write idempotency/memoization.
  private abortWriteInputs: AbortWriteInputs | undefined;
  private abortMarkerWritten = false;
  private pendingAbortWrite: Promise<void> | undefined;
  // Abort-decision one-shot: resolves to "write" (writeMarker pre-empts a later
  // seal) or "seal" (no marker coming). close() parks on it before tearing down
  // so a fault-path marker write riding the shared transport completes before
  // client.end() destroys it. decisionResolved is the gate the idempotent
  // second/third close() reads to re-enter as a no-op.
  private abortDecision: Promise<"write" | "seal"> | undefined;
  private resolveAbortDecision: ((d: "write" | "seal") => void) | undefined;
  private abortDecisionResolved = false;

  constructor(private readonly deps: AbortMarkerDeps) {}

  // True once arm() has run (derived, not stored): only an armed connection
  // writes or verifies abort markers. Read by the orchestrator's catch gate and
  // by close()/poll().
  get armed(): boolean {
    return this.selfAbortToken !== undefined;
  }

  // The gate the idempotent second/third close() reads to re-enter as a no-op.
  get decisionResolved(): boolean {
    return this.abortDecisionResolved;
  }

  // The memoized bounded marker write, or undefined when none has been issued.
  // close() awaits it in full on the "write" decision.
  get pendingWrite(): Promise<void> | undefined {
    return this.pendingAbortWrite;
  }

  /**
   * Arms the authenticated cross-party abort marker, called by the
   * orchestrator once post-handshake with the two derived per-direction
   * tokens (self = the token written into `<myId>-abort.json` on a fault;
   * peer = the token a `<peerId>-abort.json` is verified against). Captures
   * everything the marker write needs now -- the directory path and a
   * precomputed envelope body -- so the write never reads `this.path`
   * (which close() nulls during teardown), and initializes the
   * write-vs-seal decision one-shot the teardown sequencing parks on. Must
   * be called after open(); if no path is available yet, the write
   * degrades to a no-op rather than throwing.
   *
   * `id` names this party for the marker filename; `writeDir` is the
   * outbound directory (see the outbound-capture comment below);
   * `rawClient` is the raw, unwrapped transport the short-bounded write
   * rides.
   */
  arm(
    selfToken: Uint8Array<ArrayBuffer>,
    peerToken: Uint8Array<ArrayBuffer>,
    id: string,
    writeDir: string | undefined,
    rawClient: FileTransportClient,
  ): void {
    this.selfAbortToken = selfToken;
    this.peerAbortToken = peerToken;
    this.abortMarkerWritten = false;
    this.abortDecisionResolved = false;
    this.pendingAbortWrite = undefined;
    this.abortDecision = new Promise<"write" | "seal">((resolve) => {
      this.resolveAbortDecision = resolve;
    });
    // The abort marker is a self-write (`<myId>-abort.json`), so it is captured
    // for the OUTBOUND directory; the peer reads its own `<peerId>-abort.json`
    // from its inbound, which is this party's outbound. In shared mode this is
    // just `path`.
    this.abortWriteInputs =
      writeDir === undefined
        ? undefined
        : {
            path: writeDir,
            finalName: `${id}${ABORT_SUFFIX}`,
            // The on-disk envelope: { version, token }. `version` is spelled out
            // to match the full-word control-body convention (locklessRendezvous
            // / retainFiles). ~80 bytes serialized. Buffer-wrapped (see
            // AbortWriteInputs.body) so put() writes the bytes rather than
            // treating the string as a source path.
            body: Buffer.from(
              JSON.stringify({
                version: 1,
                token: toBase64Url(selfToken),
              }),
              "utf-8",
            ),
            client: rawClient,
          };
  }

  // Resolve the abort decision exactly once. The first caller wins: a catch-path
  // writeMarker() ("write") pre-empts the doCleanup seal ("seal"), and vice
  // versa. decisionResolved latches so the parked close() unblocks and the
  // idempotent later close() re-enters as a no-op.
  private resolveAbortDecisionOnce(decision: "write" | "seal"): void {
    if (this.abortDecisionResolved) return;
    this.abortDecisionResolved = true;
    this.resolveAbortDecision?.(decision);
  }

  /**
   * Triggered by the orchestrator's catch on a terminal organic fault
   * (directory still writable). Resolves the abort decision to "write"
   * (pre-empting a later seal()) and memoizes the bounded marker write,
   * returning the same promise to every caller -- the parked close() and
   * the catch both await it. Idempotent and best-effort: a faulted write
   * simply leaves no marker, and the peer falls back to the peer-silence
   * hedge. Rejection is absorbed by both awaiters (close() must stay
   * non-throwing).
   */
  writeMarker(): Promise<void> {
    this.resolveAbortDecisionOnce("write");
    if (this.pendingAbortWrite === undefined)
      this.pendingAbortWrite = this.runAbortMarkerWrite();
    return this.pendingAbortWrite;
  }

  // The actual temp-then-rename write (atomic appearance), short-bounded on
  // both ops so a sick directory cannot hang teardown. The marker is not
  // tracked in responsibleFiles, so this party's own cleanup() never sweeps
  // it and it persists for the peer to read. On timeout/failure (put
  // succeeds but rename rejects) the budget rejects and the op is
  // abandoned, leaving a temp-*.tmp. No safeDelete is attempted here: the
  // next exchange's entry-time orphaned-temp sweep removes it (in both
  // modes, since a temp is a failed in-flight write, never transcript),
  // running before any poll-loop unexpected-files policy. A delete on the
  // already-sick transport that just failed the rename would only add
  // another bounded wait for no gain over the self-heal.
  private async runAbortMarkerWrite(): Promise<void> {
    const inputs = this.abortWriteInputs;
    if (inputs === undefined || this.abortMarkerWritten) return;
    // Signal teardown before issuing the write so its own re-dial is exempt from
    // the transport's mid-exchange reconnection cap: this write is the fast-fail
    // marker a waiting peer most needs precisely when a capping server has just
    // exhausted that budget, and it can be issued from the orchestrator's catch
    // BEFORE close() runs (close() also signals, but may lose that race). No-op on
    // a transport that does not implement it.
    inputs.client.beginTeardown?.();
    const tempPath = `${inputs.path}/temp-${uuidv4()}.tmp`;
    const finalPath = `${inputs.path}/${inputs.finalName}`;
    await this.deps.runBudgeted(
      inputs.client.put(inputs.body, tempPath, {
        flags: "w",
        encoding: "utf-8",
      }),
      ABORT_MARKER_WRITE_BUDGET_MS,
      () =>
        this.deps.stalledError(
          `abort marker write to ${tempPath}`,
          ABORT_MARKER_WRITE_BUDGET_MS,
        ),
    );
    await this.deps.runBudgeted(
      inputs.client.rename(tempPath, finalPath),
      ABORT_MARKER_WRITE_BUDGET_MS,
      () =>
        this.deps.stalledError(
          `abort marker rename to ${finalPath}`,
          ABORT_MARKER_WRITE_BUDGET_MS,
        ),
    );
    this.abortMarkerWritten = true;
    this.deps.log.debug(
      `[${this.deps.role()}] wrote abort marker ${inputs.finalName}`,
    );
  }

  /**
   * Declares "no marker coming" -- called at the top of the orchestrator's
   * doCleanup on every terminal path. A no-op once a writeMarker() has
   * pre-empted it. The single chokepoint that frees a parked close() on the
   * clean-completion, signal, and echo paths so teardown does not block on
   * the grace period. Pure synchronous one-shot; safe on an unarmed
   * connection (it just latches a resolution the skipped close() gate
   * never reads).
   */
  seal(): void {
    this.resolveAbortDecisionOnce("seal");
  }

  // Bounds close()'s wait for the abort decision. Resolves with the decision
  // if it lands first, or "timeout" once the unref'd grace period elapses.
  // The local `decision` reference is captured so a concurrent clear()
  // nulling this.abortDecision cannot strand this wait.
  awaitDecisionOrGrace(): Promise<"write" | "seal" | "timeout"> {
    const decision =
      this.abortDecision ?? Promise.resolve<"write" | "seal">("seal");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ABORT_DECISION_GRACE_MS);
      timer.unref();
    });
    return Promise.race([decision.finally(() => clearTimeout(timer)), grace]);
  }

  // Clears the identity-scoped abort state, mirroring the peerId/handshakeRole
  // clears: the tokens are role-derived, so they live and die with the handshake
  // identity. Belt-and-suspenders -- the session-keyed token is the real
  // cross-session barrier -- so the exact placement (close() and the two
  // rendezvous recovery sites) is tidiness, not security.
  //
  // abortDecisionResolved resets to false, its unarmed/initial value (the
  // same value arm() sets). This is safe even though false is also the
  // close() gate's re-entry condition, because every reader checks armed
  // first, and clearing selfAbortToken here makes armed false -- so the
  // cleared, unarmed state never re-enters the gate regardless of
  // abortDecisionResolved. A future reader of decisionResolved must
  // preserve that ordering (check armed first).
  clear(): void {
    this.selfAbortToken = undefined;
    this.peerAbortToken = undefined;
    this.abortWriteInputs = undefined;
    this.abortMarkerWritten = false;
    this.pendingAbortWrite = undefined;
    this.abortDecision = undefined;
    this.resolveAbortDecision = undefined;
    this.abortDecisionResolved = false;
  }

  // Reads and verifies a present `<peerId>-abort.json` against the
  // locally-derived peer abort token. Returns true only on an authenticated
  // match (the caller then fast-fails with a PeerAbortError); every other
  // outcome -- absent, oversized, unreadable, malformed, wrong version,
  // decode failure, or non-match -- returns false so the loop keeps
  // polling and eventually falls back to the peer-silence hedge.
  // Self-contained and non-throwing: the admin controls these bytes, so a
  // read failure must never show as anything but "ignore".
  //
  // `client` is the boundTransport-wrapped poll-loop transport (NOT the raw
  // rawClient the write rides); `path` is the inbound directory.
  async verifyPeerMarker(
    client: FileTransportClient,
    allFiles: Array<FileInfo>,
    path: string,
    peerId: string,
  ): Promise<boolean> {
    const peerToken = this.peerAbortToken;
    if (peerToken === undefined) return false;
    const markerName = `${peerId}${ABORT_SUFFIX}`;
    const listed = allFiles.find((file) => file.name === markerName);
    if (listed === undefined) return false;
    // Pre-get() listed-size refusal: never get() a file the listing already
    // reports as over the cap, mirroring the message path's pre-get size gate.
    // The marker is re-read every cycle, so a large read here would be the
    // availability vector ABORT_MARKER_MAX_BYTES exists to bound.
    if (listed.size > ABORT_MARKER_MAX_BYTES) {
      this.deps.log.debug(
        `[${this.deps.role()}] ignoring oversized abort marker ` +
          `${redactAndSanitizeForDisplay(markerName)} (${listed.size} bytes)`,
      );
      return false;
    }
    try {
      // Bounded get() with the small cap (not MAX_FRAME_SIZE_BYTES, which
      // the message path uses) as the hard safety check against a server
      // under-reporting the listed size above. This rides this.client (the
      // boundTransport poll-loop budget), not the short rawClient budget
      // the write uses: it is one read among the cycle's list() and
      // message get(), all on that shared budget, and on SFTP the adapter
      // self-bounds reads. The short rawClient budget is reserved for the
      // teardown write, which must fast-fail so a faulting process is not
      // held open; a stalled read here only defers detection by one cycle
      // (caught below -> false -> keep polling).
      const raw = await client.get(`${path}/${markerName}`, {
        encoding: "utf-8",
        maxBytes: ABORT_MARKER_MAX_BYTES,
      });
      const parsed = parseBoundedJson(raw.toString());
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as { version?: unknown }).version !== 1 ||
        typeof (parsed as { token?: unknown }).token !== "string"
      )
        return false;
      const decoded = fromBase64Url((parsed as { token: string }).token);
      // Constant-time, length-mismatch-safe: a wrong-length decode returns false
      // without a separate length check.
      return bytesEqual(decoded, peerToken);
    } catch {
      // Oversize (a server that under-reported the size), JSON/parse failure,
      // base64url decode failure, or a transient read error: ignore and keep
      // polling. Re-reading the tiny file each cycle lets a delayed atomic write
      // (or a torn read on a sync-mediated transport) self-heal on a later cycle.
      return false;
    }
  }
}
