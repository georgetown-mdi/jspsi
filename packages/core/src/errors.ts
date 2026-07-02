// PeerAbortError (below) extends ConnectionError, so this leaf-ish error module
// imports it from the connection layer. This is a one-way edge, not a cycle:
// messageConnection.ts imports only `import type { Connection }` from ./types
// (which imports only zod) and never imports errors.ts. ConnectionError stays in
// messageConnection with the rest of the message-connection error taxonomy
// (asConnectionError, the ConnectionErrorKind type); relocating it here would
// only push the same edge the other way, splitting that taxonomy.
import { ConnectionError } from "./connection/messageConnection";

/**
 * Thrown by {@link FileSyncConnection} when the caller has supplied an
 * invalid configuration or attempted an operation that violates usage
 * constraints: wrong directory state, stale handshake files, multiple
 * concurrent sessions sharing a path, or a send timeout. This is the
 * public API contract for the 64-vs-69 exit-code split: callers outside
 * `packages/core` -- notably the CLI -- check `instanceof UsageError` to
 * distinguish a configuration problem from a transport failure and exit
 * with 64 (EX_USAGE) rather than 69 (EX_UNAVAILABLE). Future throw sites
 * added to `synchronize()` or `send()` should throw this class rather
 * than a plain `Error` with `{ cause: "usage" }`.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * A {@link UsageError} subclass marking the one prepare-time config fault whose
 * message is safe to surface verbatim to the operator: an authored
 * ("authoritative") standardization that contradicts its own linkage terms -- a
 * transform output naming no declared linkage field, or an unknown
 * standardization function (see `validateStandardizationAgainstTerms`). Thrown
 * only by {@link prepareForExchange}, before any peer connection.
 *
 * It is a distinct type, not a plain {@link UsageError}, so the web can classify
 * exactly this fault into its actionable "config" alert -- which renders the
 * message -- while every OTHER prepare-time `UsageError` stays in the generic
 * swallowing alert. That distinction is security-relevant: the sibling payload /
 * disclosure guards (`assertPayloadSendDisclosed`,
 * `assertDisclosureMatchesCommitment`) also throw a prepare-time `UsageError`,
 * but their messages embed column names, and on the accept side those names are
 * derived from the partner's invitation -- so surfacing them verbatim would echo
 * partner-influenced text into the operator's own alert. The message THIS class
 * carries names only the local party's own authored outputs and functions, so it
 * is value-free; keying the web's surfacing on the TYPE rather than on "any
 * prepare-phase UsageError" makes that guarantee structural rather than a
 * reachability argument about which check fired.
 *
 * Being a {@link UsageError} subclass, the CLI's `instanceof UsageError` check
 * still classifies it as a configuration error (exit 64, EX_USAGE), unchanged.
 */
export class StandardizationTermsError extends UsageError {
  constructor(message: string) {
    super(message);
    this.name = "StandardizationTermsError";
  }
}

/**
 * A {@link UsageError} subclass marking a bilateral-mode mismatch detected at
 * rendezvous: the peer advertised a `lockless_rendezvous` or `retain_files`
 * setting in its hello payload that differs from this party's. These flags are
 * bilateral agreements with no negotiation (see FILE_SYNC.md "Bilateral
 * configuration"), so a difference is fatal and is surfaced fast on both
 * parties rather than stalling until the peer timeout.
 *
 * It is a distinct type, not a plain `UsageError`, so the rendezvous cleanup
 * paths can branch on it deterministically: on a mismatch the detecting party
 * leaves its own advertised hello (and the peer's) in the directory as the
 * terminal state -- skipping the on-disk sweep so the peer reads the
 * advertisement and fails too -- while still being classified as a usage error
 * (CLI exit 64) by the `instanceof UsageError` check at the CLI catch sites.
 *
 * Unlike its terminal {@link UsageError} siblings it carries no
 * `psilinkRecoveryHintEmitted` tag and appends no next step. Its call-site
 * message already names each side's setting and the concrete fix ("both parties
 * must use the same setting"), so there is no missing step to add. The tag is
 * deliberately omitted rather than set for family symmetry: the tag exists only
 * to make the CLI suppress its generic post-handshake "retry without
 * re-inviting" advisory, and a mode mismatch is detected at rendezvous, before
 * authentication starts, so that advisory never fires for it -- a tag here would
 * read as load-bearing while suppressing nothing. (Were detection ever to move
 * after the handshake, this class is where the tag would belong.)
 */
export class BilateralModeMismatchError extends UsageError {
  constructor(message: string) {
    super(message);
    this.name = "BilateralModeMismatchError";
  }
}

/**
 * Thrown when a transport read encounters an inbound file larger than the
 * maximum frame size ({@link MAX_FRAME_SIZE_BYTES}). Raised at the transport
 * read layer -- the poll loop and rendezvous gate's pre-`get()` size check, and
 * the hard per-read byte cap inside each {@link FileTransportClient} adapter --
 * so an oversized file is refused before it is ingested into memory rather than
 * exhausting it (see docs/spec/CHANNEL_SECURITY.md).
 *
 * It is a {@link UsageError} subclass for two reasons. First, it must be a
 * terminal failure in the poll loop: {@link FileSyncConnection}'s poller stops
 * on a `UsageError` (re-reading an over-cap file cannot help and would re-incur
 * the very allocation this guards against) and reschedules on any other error,
 * so deriving from `UsageError` makes the refusal terminal without changing the
 * poller's classification. Second, an over-cap file in the shared directory is
 * the same family as the other directory-state conditions `UsageError` already
 * covers (a stray, malformed, or foreign file), so it shares the exit-64
 * (EX_USAGE) classification that tells the operator to inspect the directory or
 * peer rather than retry as if the transport were merely flaky.
 *
 * Adapters in `apps/` throw this class (re-exported on the package surface) from
 * their capped `get()` so a server that under-reports a file's size in its
 * directory listing -- evading the pre-`get()` check -- still surfaces the same
 * terminal, typed failure once the read itself crosses the cap.
 *
 * Every instance carries `psilinkRecoveryHintEmitted` and the constructor
 * appends a uniform operator next step to the call-site message. The next step
 * is class-uniform (this fault always means a peer- or admin-supplied frame
 * crossed the cap), so it lives here rather than being repeated at each throw
 * site, which supply only the specific fault detail. The tag makes the CLI's
 * hint-walker suppress its generic "retry without re-inviting" advisory: this is
 * a terminal refusal, so re-reading the same over-cap frame cannot help, and the
 * generic "retry" would contradict the specific guidance. Call-site messages
 * must not end with terminal punctuation or carry their own next step, or the
 * appended step would read as a second sentence fragment or duplicate.
 */
export class FrameSizeExceededError extends UsageError {
  readonly psilinkRecoveryHintEmitted = true;

  constructor(message: string) {
    super(
      `${message}. Confirm the rendezvous directory is dedicated to a single ` +
        `exchange and contact your partner, who may be sending a malformed or ` +
        `oversized frame.`,
    );
    this.name = "FrameSizeExceededError";
  }
}

/**
 * Thrown when a transport directory listing violates a size bound: either the
 * directory holds more entries than the configured maximum, or one entry's
 * filename exceeds the configured maximum length. Raised at the transport
 * `list()` layer in each {@link FileTransportClient} adapter -- while the
 * directory is being enumerated, before the full listing is materialized -- so a
 * hostile rendezvous directory cannot mount a memory-exhaustion denial of
 * service through directory enumeration (entry count or name length),
 * independent of file contents (see docs/spec/CHANNEL_SECURITY.md). This is the
 * directory-enumeration sibling of the per-frame
 * {@link FrameSizeExceededError}: that bound guards the per-file body read; this
 * one guards the listing that precedes it.
 *
 * Like {@link FrameSizeExceededError}, it is a {@link UsageError} subclass for
 * two reasons. First, it must be terminal in the poll loop:
 * {@link FileSyncConnection}'s poller stops on a `UsageError` (re-listing the
 * same hostile directory cannot help and would re-incur the very enumeration
 * this guards against) and reschedules on any other error, so deriving from
 * `UsageError` makes the refusal terminal without changing the poller's
 * classification. Second, an oversized or hostile shared directory is the same
 * family as the other directory-state conditions `UsageError` already covers (a
 * stray, malformed, or foreign file), so it shares the exit-64 (EX_USAGE)
 * classification that tells the operator to inspect the directory rather than
 * retry as if the transport were merely flaky.
 *
 * The concrete bound values and their derivation live with the enforcement
 * sites in the CLI adapters (`apps/cli/src/connection/listingGuard.ts`), not
 * here: unlike the frame-size cap, no `packages/core` code pre-checks a listing
 * size, so the constants belong where they are enforced.
 *
 * Carries `psilinkRecoveryHintEmitted` and appends a uniform operator next step
 * in the constructor, on the same reasoning as {@link FrameSizeExceededError}: a
 * listing that breaches its bound is terminal, so the CLI's generic "retry"
 * advisory is suppressed and replaced with the specific "the directory is shared
 * or contaminated" guidance. Call-site messages supply the specific bound detail
 * and must not end with terminal punctuation or carry their own next step.
 */
export class DirectoryListingBoundsError extends UsageError {
  readonly psilinkRecoveryHintEmitted = true;

  constructor(message: string) {
    super(
      `${message}. Confirm the rendezvous directory is dedicated to a single ` +
        `exchange between exactly two parties and is not shared or ` +
        `contaminated; clear any foreign entries or use a fresh directory.`,
    );
    this.name = "DirectoryListingBoundsError";
  }
}

/**
 * Thrown when a server-driven transport operation fails to make progress within
 * its liveness bound -- the withheld-response / never-terminating class on the
 * SFTP {@link FileTransportClient} adapter, where every read awaits a callback
 * the server controls. A hostile (or dead) server admin can hang an operation
 * indefinitely: a `list()` that keeps returning empty, non-EOF readdir batches
 * (advancing no entry, never signalling end-of-directory) or whose
 * readdir/close callback never fires; a `get()` whose transfer withholds data or
 * never ends; an exclusive `createExclusive()` whose open/close callback never
 * fires. Each is bounded -- by a round-trip cap, a per-chunk idle window, or a
 * whole-operation wall-clock deadline as the operation allows -- and surfaces
 * this error rather than awaiting forever (and, for a directory or file handle
 * opened before the stall, leaking it). See docs/spec/CHANNEL_SECURITY.md.
 *
 * This is the liveness sibling of the memory bounds
 * {@link DirectoryListingBoundsError} and {@link FrameSizeExceededError}: those
 * cap what a hostile directory or file can allocate; this caps the time and
 * round-trips a hostile server can make an operation consume. The memory bounds
 * do not cover this vector -- a progress-free stream never grows an allocation,
 * and a withheld callback accumulates nothing at all.
 *
 * Like its siblings, it is a {@link UsageError} subclass for two reasons. First,
 * it must be terminal in the poll loop: {@link FileSyncConnection}'s poller stops
 * on a `UsageError` (retrying the same hung operation cannot help and would
 * re-incur the stall) and reschedules on any other error, so deriving from
 * `UsageError` makes the refusal terminal -- it fails the exchange rather than
 * spinning retries into the same hang -- without changing the poller's
 * classification. Second, a hung or progress-free server is the same family as
 * the other directory-state conditions `UsageError` already covers, so it shares
 * the exit-64 (EX_USAGE) classification that tells the operator to inspect the
 * directory or peer rather than retry as if the transport were merely flaky.
 *
 * The concrete bound values and their derivation live with the enforcement sites
 * in the CLI adapter (`apps/cli/src/connection/sftpLivenessGuard.ts` and
 * `listingGuard.ts`), alongside the size bounds, for the same reason: no
 * `packages/core` code drives these reads, so the constants belong where they
 * are enforced.
 *
 * Carries `psilinkRecoveryHintEmitted` and appends a uniform operator next step
 * in the constructor, on the same reasoning as {@link FrameSizeExceededError}:
 * the operation is failed rather than retried into the same hang, so the CLI's
 * generic advisory is suppressed and replaced with the specific "check the
 * endpoint and the peer, then retry" guidance -- the one terminal-transport
 * fault where re-running the command can succeed once the server recovers.
 * Call-site messages supply the specific stalled-operation detail and must not
 * end with terminal punctuation or carry their own next step.
 */
export class TransportOperationStalledError extends UsageError {
  readonly psilinkRecoveryHintEmitted = true;

  constructor(message: string) {
    super(
      `${message}. Verify the transport endpoint is reachable and the peer is ` +
        `still running, then retry.`,
    );
    this.name = "TransportOperationStalledError";
  }
}

/**
 * Thrown into an in-flight {@link FileSyncConnection} wait when the connection
 * is closed mid-rendezvous or mid-send. `close()` aborts a shared
 * `AbortController` whose `reason` is an instance of this class, so any wait
 * parked between polls/retries rejects promptly instead of resuming against a
 * connection that is tearing down.
 *
 * Unlike {@link UsageError}, this is a plain `Error`: a deliberate local
 * teardown is a transport-availability condition, so the CLI's
 * `instanceof UsageError` check classifies it as exit 69 (EX_UNAVAILABLE),
 * not the 64 (EX_USAGE) reserved for caller misconfiguration. In practice it
 * almost never surfaces as the process exit code -- `close()` only races an
 * in-flight wait under a signal, where `signalReceived` owns the code
 * (130/143) and this rejection is logged and swallowed.
 *
 * It lives here in `errors.ts` -- and is therefore re-exported on the package's
 * public surface by main.ts's `export *` -- deliberately: this file is the
 * single home for the connection error taxonomy ({@link UsageError},
 * {@link BilateralModeMismatchError}), and splitting one error type out into a
 * non-barrelled module to hide it would be the more surprising inconsistency.
 * (`cancellableDelay` is hidden in the non-barrelled fileSyncConstants.ts for
 * the opposite reason: it is an internal helper with no taxonomy home.) Treat
 * this class as an internal teardown signal, not a stability contract -- the
 * plain-`Error`/exit-69 classification above is the contract; consumers should
 * not depend on catching it by type.
 *
 * It deliberately carries no `psilinkRecoveryHintEmitted` tag and no operator
 * next step: the operator-facing-error audit (board item 199419757) judged it to
 * have none. It is a local teardown signal that almost never reaches the process
 * exit code (the signal handler owns 130/143 and this rejection is logged and
 * swallowed), so there is no actionable step to surface and nothing for the
 * generic CLI advisory to contradict.
 */
export class ConnectionClosedError extends Error {
  constructor(message = "connection closed during wait") {
    super(message);
    this.name = "ConnectionClosedError";
  }
}

/**
 * Thrown on the waiting side when the peer leaves an authenticated abort marker
 * (`<peerId>-abort.json`) whose token verifies against this party's
 * locally-derived peer abort token. It is a definitive, key-authenticated signal
 * that the peer terminated the exchange -- not an inactivity timeout or a slow
 * dataset -- so the waiting party fails fast instead of waiting out its full
 * peer-inactivity budget and then printing the generic peer-silence hedge.
 *
 * It extends {@link ConnectionError} with kind `"transport"` deliberately. The
 * error crosses two {@link asConnectionError} seams on its way to
 * `runProtocol`'s catch -- the `fromEventConnection` bridge's `onError` and the
 * `EncryptedMessageConnection` decorator's `receive` catch -- each of which
 * passes an existing `ConnectionError` through unchanged but wraps anything else
 * as `{ cause }`. As a `ConnectionError("transport")` it survives both intact and
 * arrives top-level, so the catch's echo gate (which must not write a marker in
 * response to a `PeerAbortError`, or the waiting party would reflect one back)
 * recognizes it, and -- because it is NOT a {@link UsageError} -- the CLI's
 * `instanceof UsageError ? 64 : 69` exit-code check yields 69 (the exchange
 * failed because the peer died), not the 64 reserved for local misconfiguration.
 *
 * It carries no partner-controlled bytes: the marker token never decodes to
 * display text and the message is fixed, so the display-boundary sanitizer is
 * only belt-and-suspenders here. `psilinkRecoveryHintEmitted` is set so the
 * CLI's hint-walker suppresses its generic "retry without re-inviting" advisory,
 * which would otherwise contradict the definitive peer-abort message. (This
 * reuses the CLI-recovery convention that `auth.ts` already sets on core errors.)
 */
export class PeerAbortError extends ConnectionError {
  readonly psilinkRecoveryHintEmitted = true;

  constructor(options?: ErrorOptions) {
    super(
      "the peer authentically signaled that it aborted the exchange; this is " +
        "a definitive peer-side termination, not an inactivity timeout or a " +
        "slow dataset. Contact your partner, who holds the specific error " +
        "locally.",
      "transport",
      options,
    );
    this.name = "PeerAbortError";
  }
}
