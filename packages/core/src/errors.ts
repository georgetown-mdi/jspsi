// PeerAbortError (below) extends ConnectionError, so this leaf-ish error module
// imports it from the connection layer. This is a one-way edge, not a cycle:
// messageConnection.ts imports only `import type { Connection }` from ./types
// (which imports only zod) and never imports errors.ts. ConnectionError stays in
// messageConnection with the rest of the message-connection error taxonomy
// (asConnectionError, the ConnectionErrorKind type); relocating it here would
// only push the same edge the other way, splitting that taxonomy.
import { ConnectionError } from "./connection/messageConnection";

/**
 * Whether `error` or any link in its `cause` chain satisfies `predicate`.
 *
 * The single shared rule for asking "is this failure, anywhere under whatever
 * wrapped it, an X?" -- a class, a property tag, or a message fragment. Asking
 * it of the chain rather than of the value handed over keeps the answer right
 * wherever the wrapping happens: a re-raise that replaces the message and keeps
 * the original as its `cause` (the shape core's own diagnostics compose) stays
 * matched.
 *
 * The walk follows `cause` on any non-null object link, not only an `Error`, so
 * a plain object interposed in the chain does not truncate it; a predicate that
 * cares narrows with its own `instanceof`. A seen-set stops a `cause` cycle
 * from being revisited; it does not bound a chain of distinct links, and a
 * throwing `cause` accessor propagates to the caller. Rendering an arbitrary
 * chain is {@link sanitizeErrorForDisplay}'s job, which carries the depth
 * bound and the guarded read this helper deliberately does not.
 */
export function causeChainSome(
  error: unknown,
  predicate: (link: object) => boolean,
): boolean {
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  while (typeof cursor === "object" && cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    if (predicate(cursor)) return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

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
 *
 * `options.cause` is forwarded to `Error`, so a refusal whose detail does not
 * fit the display boundary's per-link cap can carry that detail as a `cause`
 * link of its own rather than spending the budget its operative sentence and
 * recovery step need (see `sanitizeErrorForDisplay`).
 */
export class UsageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UsageError";
  }
}

/**
 * Options a bounded-transport refusal takes beyond its summary message.
 *
 * @see {@link FrameSizeExceededError}
 * @see {@link DirectoryListingBoundsError}
 * @see {@link TransportOperationStalledError}
 */
export interface TransportRefusalOptions {
  /**
   * Ordered detail fragments, each rendered as a capped cause link of its own:
   * one per party that chose the bytes in it, carrying its own first-party label
   * so no bare value renders unexplained. A path, a filename, or any other value
   * a partner, a server, or an unbounded config chose belongs here rather than in
   * the summary -- the display boundary caps each link independently, so a
   * fragment on a link of its own can only ever spend its own budget.
   */
  details?: readonly string[];
}

// Folds ordered detail fragments into a cause chain, each fragment a capped
// link of its own: the display boundary caps every link separately, so a value
// one party chose can only ever spend the budget of the link it sits alone on.
// The fragments go AHEAD of `tail` -- an existing cause to preserve, like the
// transport error a connect rejected with -- so the renderer's depth bound
// reaches every labeled detail before an opaque terminal cause.
export function chainDetailCauses(
  details: readonly [string, ...string[]],
): Error;
export function chainDetailCauses(
  details: readonly string[],
  tail: unknown,
): unknown;
export function chainDetailCauses(
  details: readonly string[],
  tail?: unknown,
): unknown {
  return details.reduceRight<unknown>(
    (cause, detail) =>
      new Error(detail, cause === undefined ? undefined : { cause }),
    tail,
  );
}

// A refusal's class-uniform recovery step ahead of its ordered detail
// fragments: the step FIRST so the renderer's depth bound reaches it before any
// detail and before whatever the caller chains behind them.
function refusalCauseChain(
  recoveryStep: string,
  details: readonly string[],
): Error {
  return chainDetailCauses([recoveryStep, ...details]);
}

/**
 * The family of local-configuration faults whose message is composed SOLELY of
 * the local operator's own content -- so it is both actionable to that
 * operator and safe to surface to them verbatim. Raised from the pre-exchange
 * boundaries -- {@link prepareForExchange} and the CLI's pre-mint invite
 * validation -- before any credential, terms, or data are sent, and from the
 * local certificate/terms gate the terms exchange and the receipt swap both
 * apply, mid-exchange: a consumer keying on this class must not infer phase from
 * membership. The CLI's `classifyTerminalError` reads the class alone for its
 * `config` category, so a member raised at any point before the output stage
 * lands there; the web's `exchangeLifecycle`/`classifyExchangeFailure`
 * additionally requires its `prepare` phase.
 *
 * This base type is the membership rule for the web's actionable "config" alert,
 * which renders the error's message: the web classifies a prepare-phase failure
 * as `config` when it is an `OperatorConfigError`, NOT when it is merely any
 * {@link UsageError}. The distinction is security-relevant. A sibling
 * prepare-time `UsageError` whose message can embed PARTNER-influenced text must
 * stay a plain `UsageError` so its message is swallowed by the generic alert
 * rather than echoed into the operator's own UI. Keying the surfacing on this type
 * makes MEMBERSHIP a structural property (a check either is or is not a member)
 * rather than a reachability argument about which check happened to fire; each
 * member is in turn responsible for carrying only local content in its message.
 * That per-member responsibility is a ledger rather than a promise made here:
 * `apps/cli/test/unit/operatorConfigErrorSites.test.ts` enumerates every
 * construction site of this type and its subclasses, records what each message
 * interpolates and why that value is local, and fails on a site or an
 * interpolation it does not account for.
 *
 * Extend it from -- or raise it directly in -- any check that fails closed on
 * the operator's OWN configuration and whose message names only local content.
 * What that content rule excludes is TEXT another party authored, so a refusal
 * built from fixed prose over counts alone has nothing to exclude, whichever
 * document the counts were read off. {@link StandardizationTermsError} is a
 * member by subclass; a check whose refusal meets the contract without needing a
 * narrower type raises the base class directly. The two send-side disclosure
 * refusals ({@link OutboundDisclosureRefusalError}) are candidates on the same
 * reasoning -- each compares this party's own current metadata against its own
 * recorded set, so every name in their messages is local -- but joining is a
 * per-check surfacing decision, not a consequence of refusing before anything is
 * sent, so they sit outside until one is taken. The payload-SEND disclosure check
 * (`assertPayloadSendDisclosed`) is deliberately NOT a member -- on the accept side
 * its `payload.send` names are adopted from the partner's invitation, and the check
 * cannot tell its role at the throw site, so it stays conservatively out and its
 * message stays swallowed.
 *
 * Being a {@link UsageError} subclass, the CLI's `instanceof UsageError` check
 * still classifies every member as a configuration error (exit 64, EX_USAGE).
 */
export class OperatorConfigError extends UsageError {
  constructor(message: string) {
    super(message);
    this.name = "OperatorConfigError";
  }
}

/**
 * The family of refusals raised, before any credential, terms, or data are sent,
 * when this party can no longer make the outbound disclosure it recorded agreeing
 * to. The two send-side gates raise it from {@link prepareForExchange}, and a
 * non-interactive caller that cannot ask for confirmation raises it through the
 * same refusal builder; every raise compares this party's OWN current metadata
 * against its OWN recorded set:
 *
 * - `assertDisclosureMatchesCommitment` -- the column set this party committed to
 *   send when the exchange was established has drifted from what its metadata now
 *   discloses.
 * - `assertOutboundPayloadConsented` -- the set this run would send is not the one
 *   this party confirmed sending (or none was ever confirmed).
 *
 * Neither is a transport fault: both fire before any credential, terms, or data
 * are sent, and a caller that retries the same input refuses identically. That is
 * why it is a distinct type rather than a plain {@link UsageError} -- a caller
 * keeping per-failure bookkeeping branches on it deterministically (the web's
 * managed re-run records it as its own failure kind, whose recovery is
 * re-confirming the disclosure, not retrying the connection) while the CLI's
 * `instanceof UsageError` check still classifies it as a configuration error
 * (exit 64, EX_USAGE).
 *
 * Deliberately NOT an {@link OperatorConfigError}: that base type is the membership
 * rule for the web's message-rendering "config" alert, and joining it is a
 * surfacing decision taken per check.
 */
export class OutboundDisclosureRefusalError extends UsageError {
  constructor(message: string) {
    super(message);
    this.name = "OutboundDisclosureRefusalError";
  }
}

/**
 * The refusal raised, before any credential, terms, or data are sent, when this
 * party's input cannot fully satisfy the linkage terms the two parties agreed to
 * -- a declared key whose fields the columns cannot produce, a key whose own
 * declared cleaning drops every record, or terms declaring no key at all. One
 * grading decides it (`decideLinkageTermsVerdict`) and one boundary enforces it
 * ({@link prepareForExchange}); a front end that grades earlier gives advance
 * notice of this same refusal rather than holding a threshold of its own.
 *
 * Not a transport fault: it fires before anything is sent, and a caller that
 * retries the same input refuses identically, so a surface offering a retry would
 * loop an unattended run on a deterministic local fault. That is why it is a
 * distinct type rather than a plain {@link UsageError} -- a caller keeping
 * per-failure bookkeeping branches on it deterministically (the web's managed
 * re-run records it in the benign input tier) while the CLI's `instanceof
 * UsageError` check still classifies it as a configuration error (exit 64,
 * EX_USAGE).
 *
 * Deliberately NOT an {@link OperatorConfigError}: the field and key names it
 * enumerates are the AGREED terms' own, adopted from the partner's invitation on
 * every accept path, so its message is not composed solely of local content and
 * stays out of the surfacing contract that base type carries. The names ride
 * capped cause links of their own, so a surface that renders the chain spends
 * their budget on them alone and reaches the summary and its remedy first.
 */
export class LinkageTermsUnsatisfiableError extends UsageError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LinkageTermsUnsatisfiableError";
  }
}

/**
 * The specific {@link OperatorConfigError} for an authored ("authoritative")
 * standardization that contradicts its own linkage terms -- a transform output
 * naming no declared linkage field, or an unknown standardization function (see
 * `validateStandardizationAgainstTerms`). Thrown only by
 * {@link prepareForExchange}, and only for an AUTHORED standardization; its message
 * interpolates that standardization's transform outputs and step functions. On the
 * web the only party that reaches this throw is the inviter, with its own authored
 * standardization (local content): the acceptor's standardization is derived from
 * its adopted terms via `getDefaultStandardization`, whose outputs are exactly
 * those terms' field names, so it is consistent with them by construction and does
 * not reach this throw (pinned in standardization.test.ts). Adopted, partner-origin
 * field names therefore never surface here -- every message this type carries is
 * the authoring party's own local content. See {@link OperatorConfigError} for why
 * the web keys its actionable "config" alert on that base type rather than on any
 * prepare-phase {@link UsageError}.
 */
export class StandardizationTermsError extends OperatorConfigError {
  constructor(message: string) {
    super(message);
    this.name = "StandardizationTermsError";
  }
}

/**
 * The refusal for a standardization step naming a function this build does not
 * recognize, raised where the step is COMPILED rather than where a
 * configuration is validated: the agreed terms' linkage-key element transforms
 * (compiled as a key's fate is classified, before its first row is read), a
 * party's own standardization pipeline, and the public `runPipeline` entry
 * point. It is the compile-time counterpart of
 * {@link StandardizationTermsError}, which covers the same fault where an
 * AUTHORED standardization is validated against its own terms, before an
 * exchange runs.
 *
 * A {@link UsageError} subclass, so the CLI's error->exit boundary classifies it
 * as a configuration error (exit 64) rather than the 69 that invites an
 * unattended supervisor to retry: an element the agreed terms declare and this
 * build cannot run is a fault in the terms, deterministic in them, and every
 * retry reaches the same refusal (see docs/spec/CHANNEL_SECURITY.md).
 *
 * Deliberately NOT an {@link OperatorConfigError}, unlike its authored-config
 * counterpart: an element transform is adopted verbatim from the partner's
 * invitation on the accept path, so this refusal is not always about the
 * operator's own content, and its message stays swallowed by the web's generic
 * alert. The raise site narrows the offending name to a literal this build
 * recognizes before interpolating it, so no partner free text reaches the
 * message either way.
 */
export class UnknownStandardizationFunctionError extends UsageError {
  constructor(message: string) {
    super(message);
    this.name = "UnknownStandardizationFunctionError";
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
 * authentication starts, so there is no advisory for a tag to suppress -- it
 * would read as load-bearing while suppressing nothing (the untagged shape is
 * pinned in errors.test.ts). (Were detection ever to move after the handshake,
 * this class is where the tag would belong.)
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
 * Every instance carries `psilinkRecoveryHintEmitted` and the constructor puts a
 * uniform operator next step on a cause link of its own. The next step is
 * class-uniform (this fault always means a peer- or admin-supplied frame crossed
 * the cap), so it lives here rather than being repeated at each throw site,
 * which supply only the specific fault detail. Its own link is what gives it its
 * own display budget: on the summary it would share one capped link with the
 * call site's prose and the path that prose names, and the cap would delete it.
 * The tag makes the CLI's hint-walker suppress its generic "retry without re-inviting"
 * advisory: this is a terminal refusal, so re-reading the same over-cap frame
 * cannot help, and the generic "retry" would contradict the specific guidance.
 * Call-site messages must not end with terminal punctuation, and pass every
 * value somebody else chose as a `details` fragment rather than composing it
 * into the summary.
 */
export class FrameSizeExceededError extends UsageError {
  readonly psilinkRecoveryHintEmitted = true;

  constructor(message: string, options?: TransportRefusalOptions) {
    super(message, {
      cause: refusalCauseChain(
        `Confirm the rendezvous directory is dedicated to a single exchange ` +
          `and contact your partner, who may be sending a malformed or ` +
          `oversized frame.`,
        options?.details ?? [],
      ),
    });
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
 * Carries `psilinkRecoveryHintEmitted` and puts a uniform operator next step on
 * its own cause link, on the same reasoning as {@link FrameSizeExceededError}: a
 * listing that breaches its bound is terminal, so the CLI's generic "retry"
 * advisory is suppressed and replaced with the specific "the directory is shared
 * or contaminated" guidance. Call-site messages supply the specific bound detail,
 * must not end with terminal punctuation, and pass the directory path and the
 * offending entry name as `details` fragments.
 */
export class DirectoryListingBoundsError extends UsageError {
  readonly psilinkRecoveryHintEmitted = true;

  constructor(message: string, options?: TransportRefusalOptions) {
    super(message, {
      cause: refusalCauseChain(
        `Confirm the rendezvous directory is dedicated to a single exchange ` +
          `between exactly two parties and is not shared or contaminated; ` +
          `clear any foreign entries or use a fresh directory.`,
        options?.details ?? [],
      ),
    });
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
 * Carries `psilinkRecoveryHintEmitted` and puts a uniform operator next step on
 * its own cause link, on the same reasoning as {@link FrameSizeExceededError}:
 * the operation is failed rather than retried into the same hang, so the CLI's
 * generic advisory is suppressed and replaced with the specific "check the
 * endpoint and the peer, then retry" guidance -- the one terminal-transport
 * fault where re-running the command can succeed once the server recovers.
 * Call-site messages name the stalled operation and the refusal, must not end
 * with terminal punctuation, and pass every value beyond that label -- how the
 * operation stalled, the path it named, and any message the server itself
 * reported -- as `details` fragments.
 */
export class TransportOperationStalledError extends UsageError {
  readonly psilinkRecoveryHintEmitted = true;

  constructor(message: string, options?: TransportRefusalOptions) {
    super(message, {
      cause: refusalCauseChain(
        `Verify the transport endpoint is reachable and the peer is still ` +
          `running, then retry.`,
        options?.details ?? [],
      ),
    });
    this.name = "TransportOperationStalledError";
  }
}

/**
 * Thrown when two derivations of the same quantity inside ONE party disagree --
 * a fault in this implementation rather than in anything an operator, a partner,
 * or a transport supplied. Its raise site is the single-pass send-time reply-cap
 * backstop: the reply this party built outgrew the byte cap both parties derive
 * from their declared sizes, on an exchange whose declared sizes the over-ceiling
 * gate has already cleared, so no dataset either operator controls and no
 * transport condition is what stopped the send.
 *
 * A plain `Error` rather than a {@link UsageError}: exit 64 (EX_USAGE) tells the
 * operator that their input or configuration is what to fix, and here their
 * declared sizes are the very thing already found within budget. The CLI's
 * error->exit boundary maps this class to EX_SOFTWARE (70) instead of the 69
 * (EX_UNAVAILABLE) any other plain `Error` takes there, because 69 reads as a
 * transport blip an unattended supervisor retries, and a retry re-runs the whole
 * exchange -- re-sending this party's records -- only to rebuild the same reply
 * and refuse it again. The message's remedy is to report it, and 70 is the code
 * that carries that to a supervisor reading nothing else.
 *
 * On the CLI's machine-readable event stream the terminal `error` event's
 * category is `exchange`, the default bucket, since that classification keys on
 * the run phase and on `OperatorConfigError` / `ConnectionError` membership,
 * neither of which this class joins. The exit code, not the category, is where an
 * internal fault is observable -- the mirror of the `security` category, which is
 * observable only in the category (see docs/spec/CLI_EVENTS.md).
 *
 * `psilinkRecoveryHintEmitted` is a class field, the
 * {@link FrameSizeExceededError} shape rather than
 * {@link TransportPublishIndeterminateError}'s per-instance one: every internal
 * fault takes the same next step -- report it, never retry -- so no raise site
 * has a different one to choose, and each states that step in its own message
 * (the reply-cap backstop's ends "report it with this message", pinned in
 * psiLink.test.ts). The tag makes the CLI's hint-walker suppress its generic
 * "retry the exchange without re-inviting" advisory, which would otherwise print
 * beneath that message: the backstop fires mid-data-exchange, after the
 * handshake rotated the secret, which is the window that advisory fires in, and
 * it prescribes exactly what the EX_SOFTWARE mapping above exists to stop -- a
 * whole further exchange, this party's records re-sent, rebuilding the same
 * reply and refusing it again. The convention stays two-state, so a raise site
 * added here carries its own next step in its message.
 */
export class InternalConsistencyError extends Error {
  readonly psilinkRecoveryHintEmitted = true;

  constructor(message: string) {
    super(message);
    this.name = "InternalConsistencyError";
  }
}

/**
 * Thrown by a transport whose publish of a file was torn by a session drop and
 * whose outcome the transport cannot settle: the operation is rejected, and
 * whether the peer received what was published is undetermined. It is the
 * distinguishable middle between a publish confirmed to have landed (the
 * operation resolves) and one determined not to have (the operation rejects with
 * the failure the server reported).
 *
 * A rejection, never a resolution: a caller that treats this as success would be
 * reporting an unpublished message as sent. What it changes is the CHARACTER of
 * the rejection, so a caller that must not act on a message the peer may already
 * hold -- {@link FileSyncMessageLoop}'s send path, whose `seq` slot is not
 * reusable once the peer may have consumed a message under that name -- can tell
 * the two apart. The `cause` carries the transport's original error, so the
 * status and paths it names render on their own line of the operator-facing
 * cause chain rather than inside this message.
 *
 * A plain `Error` rather than a {@link UsageError}, the classification the poll
 * loop reads as terminal. What that distinction buys is measured in
 * `fileSyncConnection.test.ts`, on the one publish this class can reach from
 * `poll()` -- the retain-mode ack, whose name the next cycle re-derives
 * identically. In isolation the loop reschedules, republishes the ack, and
 * delivers the message; under the CLI's composition, where `fromEventConnection`
 * fails the connection on the first emitted poll error, the same staging ends the
 * exchange with the ack never republished. So the classification buys the loop's
 * own retry, not a surviving exchange.
 *
 * The `psilinkRecoveryHintEmitted` tag is a per-instance property here, not a
 * class field, and the class itself sets none. A transport raises it for any of
 * several publishes -- a message, an ack, a rendezvous hello, an abort marker --
 * which share no recovery, so the transport's instance names the publish, adds
 * no next step, and suppresses nothing.
 * {@link FileSyncMessageLoop}'s send path re-raises the class for the one publish
 * whose recovery is established, holding the transport's instance as its `cause`;
 * that instance names the message, carries the recovery, and is tagged, so the
 * generic advisory -- which prescribes a plain retry -- is suppressed rather than
 * printed alongside a contradicting step. The convention stays two-state: an
 * error is tagged exactly when it carries its own next step.
 */
export class TransportPublishIndeterminateError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = "TransportPublishIndeterminateError";
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
 * next step. It is a local teardown signal that almost never reaches the process
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
 * recognizes it, and -- being neither a {@link UsageError} nor a
 * `ConnectionError` of kind `usage` -- the CLI's exit-code check yields 69 (the
 * exchange failed because the peer died), not the 64 both of those reach.
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

/** The property {@link markPeerWaitTimeout} sets and {@link isPeerWaitTimeout} reads. */
const PEER_WAIT_TIMEOUT_TAG = "psilinkPeerWaitTimedOut";

/**
 * Tags an error as "this party waited its full budget for the partner and the
 * partner never came": the rendezvous peer-wait timeouts and the key-exchange
 * handshake timeout. It is a property tag rather than a subclass so it adds a
 * machine-readable identity without changing either error's message (both are
 * pinned exactly by existing tests) or its `instanceof` classification, which
 * the CLI's 64-vs-69 exit-code split reads.
 *
 * It is deliberately NOT {@link PeerAbortError}'s `psilinkRecoveryHintEmitted`,
 * whose meaning is the unrelated "suppress the CLI's generic advisory". A tagged
 * error asserts only the local fact that the wait expired, never a reason for
 * the partner's absence. A consumer that knows more about the run (the CLI knows
 * whether this run swept the shared folder at entry) combines that with this tag
 * to offer a likely cause; the tag alone never carries one.
 *
 * Not applied to the joiner-sentinel timeout, which is a different failure --
 * the partner did arrive and then stalled mid-arrival -- already carrying its own
 * specific diagnosis and next step.
 */
export function markPeerWaitTimeout<E extends object>(error: E): E {
  return Object.assign(error, { [PEER_WAIT_TIMEOUT_TAG]: true });
}

/**
 * Whether `error`, or anything in its `cause` chain, carries the
 * {@link markPeerWaitTimeout} tag.
 */
export function isPeerWaitTimeout(error: unknown): boolean {
  return causeChainSome(
    error,
    (link) => (link as Record<string, unknown>)[PEER_WAIT_TIMEOUT_TAG] === true,
  );
}
