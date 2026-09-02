import { isProtocolTempName, redactAndSanitizeForDisplay } from "@psilink/core";

import {
  transportOperationStalledError,
  withSftpOperationDeadline,
} from "./sftpLivenessGuard";

/**
 * The record of cleanup deletes the SFTP transport could not perform, and the
 * drain that re-issues them at the next point a session exists. See
 * {@link DeferredCleanupDeletes}.
 *
 * The never-reject cleanup delete is the one operation that reaches no recovery
 * gate at all, so under connection-per-poll it can be issued into an idle gap,
 * reach no session and remove nothing -- and it resolves all the same, so its
 * caller in core cannot tell that from a delete that landed. Only the transport
 * can, which is why the record lives here. What is admitted to it, why that
 * narrowing makes deferral sound, the cap and the per-recording budget over it,
 * and the teardown-scale bound on the drain are in docs/spec/CHANNEL_SECURITY.md,
 * "The deferred cleanup-delete record".
 */

/**
 * Cap on the connection-per-poll record of unperformed cleanup deletes of the
 * protocol's own in-flight temp file; overflow refuses rather than evicts.
 * Derivation: docs/spec/CHANNEL_SECURITY.md, "The deferred cleanup-delete
 * record".
 */
export const MAX_DEFERRED_CLEANUP_DELETES = 64;

/**
 * Re-issue budget for ONE RECORDING of a cleanup delete, after which that
 * recording gives up and its file is left behind. Derivation:
 * docs/spec/CHANNEL_SECURITY.md, "The deferred cleanup-delete record".
 *
 * @internal exported for the record's own tests
 */
export const MAX_DEFERRED_CLEANUP_REISSUES = 3;

/**
 * Per-operation deadline (ms) a drain re-issue is held to
 * ({@link DeferredCleanupDeletes.reissue}) in place of the
 * {@link ./sftpLivenessGuard.SFTP_STALL_DEADLINE_MS} every other round trip
 * carries, and so the bound on the whole drain. Derivation:
 * docs/spec/CHANNEL_SECURITY.md, "The deferred cleanup-delete record".
 */
const DEFERRED_CLEANUP_DRAIN_TIMEOUT_MS = 5_000;

// The final segment of a remote path. SFTP paths are POSIX-separated on the wire
// whatever either end's platform is, so a backslash is an ordinary character in a
// remote filename here and must not be read as a separator. A path with no
// separator at all is its own basename.
const remoteBasename = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);

/**
 * Minimal logger surface the record needs: the states it refuses are reported at
 * debug, never warned, because they fire only where a drain has repeatedly failed
 * to reach the server, which the operations that needed that server already
 * report.
 */
interface DeferredCleanupLog {
  debug: (message: string) => void;
}

/** Constructor bundle for {@link DeferredCleanupDeletes}. */
export interface DeferredCleanupDeletesOptions {
  /**
   * Connection-per-poll (ephemeral-session) mode. The record and the drain are
   * that mode's machinery: the default mode holds one session for the whole
   * exchange, so a cleanup delete never lands in a gap with no session, and
   * nothing is recorded or re-issued.
   */
  enabled: boolean;
  log: DeferredCleanupLog;
  /**
   * Issues one re-issued cleanup delete against the live session, resolving when
   * the server answers and rejecting otherwise. Injected rather than driven here
   * so that round trip stays in the adapter, where the two adapter source checks
   * examine it and its allowance is registered by the enclosing method's name
   * (scripts/sftp-tracked-round-trips.test.mjs and
   * scripts/sftp-operation-spans.test.mjs).
   */
  issueDelete: (path: string) => Promise<void>;
  /**
   * Whether a drain may be issued now. The states that drain nothing -- a fatal
   * SFTP protocol error, a latched teardown, and no live session -- are in
   * docs/spec/CHANNEL_SECURITY.md, "The deferred cleanup-delete record"; the
   * remaining two, the default held-session mode and an empty record, this class
   * answers itself.
   */
  canDrain: () => boolean;
}

/**
 * The connection-per-poll record of cleanup deletes that were not performed, and
 * the single-flight drain that re-issues them.
 *
 * {@link record} is offered a path on two readings, either sufficient on its own:
 * the release readings taken before the delete is issued, and the delete's own
 * rejection. {@link drain} is driven at the tail of each re-establishment, with
 * the session-transition lock released. Both are bounded:
 * {@link MAX_DEFERRED_CLEANUP_DELETES} entries, and
 * {@link MAX_DEFERRED_CLEANUP_REISSUES} re-issues per recording.
 */
export class DeferredCleanupDeletes {
  private readonly enabled: boolean;
  private readonly log: DeferredCleanupLog;
  private readonly issueDelete: (path: string) => Promise<void>;
  private readonly canDrain: () => boolean;
  // Paths of the protocol's own in-flight temp writes whose cleanup delete was
  // not performed, kept for re-issue at the next point a session exists (see
  // record, which is where the shape is enforced, and drain). Populated only in
  // connection-per-poll mode, where the never-reject cleanup delete -- outside
  // the recovery chokepoint, and so outside the session gate that chokepoint
  // applies -- can be issued into an idle gap and reach no session at all. Only
  // the adapter can tell that no-op from a real delete: safeDelete resolves
  // either way, so its caller in core cannot. Keyed by path because the same path
  // recorded twice is one cleanup, and because the drain removes by identity; the
  // value is the re-issues that path has left (see
  // MAX_DEFERRED_CLEANUP_REISSUES), carried on the record rather than in a
  // counter of its own so an entry cannot outlive its budget.
  private readonly budgetByPath = new Map<string, number>();
  // The drain currently running, so a second call joins it rather than issuing a
  // second delete for the same path. Cleared when it settles, which is what lets
  // a later re-establishment drain a record made after this one took its
  // snapshot.
  private draining: Promise<void> | undefined;

  constructor(options: DeferredCleanupDeletesOptions) {
    this.enabled = options.enabled;
    this.log = options.log;
    this.issueDelete = options.issueDelete;
    this.canDrain = options.canDrain;
  }

  /** @internal */
  get recorded(): ReadonlyMap<string, number> {
    return this.budgetByPath;
  }

  /**
   * Record a cleanup delete that was not performed, so the next point at which a
   * session exists re-issues it. Connection-per-poll only. What is admitted to
   * the record, why that narrowing makes deferral sound, and the cap and budget
   * over it are in docs/spec/CHANNEL_SECURITY.md, "The deferred cleanup-delete
   * record".
   */
  record(path: string, reissuesLeft = MAX_DEFERRED_CLEANUP_REISSUES): void {
    if (!this.enabled) return;
    if (!isProtocolTempName(remoteBasename(path))) return;
    if (reissuesLeft <= 0) {
      this.log.debug(
        `a cleanup delete was re-issued ${MAX_DEFERRED_CLEANUP_REISSUES} ` +
          `times on this SFTP connection without succeeding, so it is not ` +
          `recorded again and its file is left behind: ` +
          redactAndSanitizeForDisplay(path),
      );
      return;
    }
    // An entry already standing keeps the budget it holds: a decrement arriving
    // from a re-issue whose path was re-recorded while it was in flight is
    // discarded rather than applied to that newer recording.
    if (this.budgetByPath.has(path)) return;
    if (this.budgetByPath.size >= MAX_DEFERRED_CLEANUP_DELETES) {
      this.log.debug(
        `${MAX_DEFERRED_CLEANUP_DELETES} cleanup deletes are already recorded ` +
          `for re-issue on this SFTP connection, so this one is not recorded ` +
          `and its file is left behind: ${redactAndSanitizeForDisplay(path)}`,
      );
      return;
    }
    this.budgetByPath.set(path, reissuesLeft);
  }

  /**
   * Re-issue every recorded cleanup delete, at a point where a session exists.
   * Driven at the tail of the adapter's ensureConnected(), OUTSIDE the
   * transition. The seams it covers, the states that drain nothing, and the bound
   * over the concurrent re-issues are in docs/spec/CHANNEL_SECURITY.md, "The
   * deferred cleanup-delete record".
   */
  drain(): Promise<void> {
    if (this.budgetByPath.size === 0) return Promise.resolve();
    if (!this.canDrain()) return Promise.resolve();
    // A drain already running holds the snapshot it took; a record made after
    // that snapshot is left for the next re-establishment rather than issued
    // alongside it, so no path is deleted twice concurrently and this cannot
    // re-enter itself.
    this.draining ??= this.runDrain().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private runDrain(): Promise<void> {
    const snapshot = [...this.budgetByPath];
    this.budgetByPath.clear();
    return Promise.all(
      snapshot.map(([path, reissuesLeft]) => this.reissue(path, reissuesLeft)),
    ).then(() => {});
  }

  /**
   * One re-issued cleanup delete, on the same never-reject terms as safeDelete's
   * own, and resolving whatever happens. A failure offers the path back to the
   * record with one fewer re-issue left, so a server briefly unreachable at one
   * boundary is swept at the next.
   */
  private reissue(path: string, reissuesLeft: number): Promise<void> {
    return withSftpOperationDeadline(
      this.issueDelete(path),
      DEFERRED_CLEANUP_DRAIN_TIMEOUT_MS,
      () =>
        transportOperationStalledError(
          "file delete",
          path,
          `did not complete within ${DEFERRED_CLEANUP_DRAIN_TIMEOUT_MS} ms ` +
            "(the server withheld the delete response)",
        ),
    ).then(
      () => {},
      () => {
        this.record(path, reissuesLeft - 1);
      },
    );
  }
}
