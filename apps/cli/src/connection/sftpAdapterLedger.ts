/**
 * The operator-facing accounting one SFTP adapter keeps over a run: the counters
 * its end-of-run summary reports, the outstanding-operation gauge its idle
 * boundary is held on, and the cadence its repeating warnings share.
 *
 * It is deliberately transport-blind -- no ssh2 or ssh2-sftp-client type reaches
 * it, and it holds no session, socket or client state. What it records is the
 * adapter's own integers, never a partner-controlled value, so the whole of it
 * can be read back by the summary and the machine metrics event without a
 * disclosure question. See {@link ./ssh2SftpAdapter} for the events that drive
 * it.
 */

/**
 * Warn cadence for the adapter's repeating operator conditions: the first
 * occurrence draws a line, then every `SFTP_REDIAL_WARN_INTERVAL`-th. Every such
 * condition here recurs once per poll cycle for as long as it lasts -- a partner
 * whose server caps session lifetime, one that never closes a released
 * connection, a transition stuck long enough to decline the cycle's dial -- so
 * an unpaced line would fill an hours-long exchange's log while silence would
 * hide the condition altogether. An observability cadence only, independent of
 * every bound the adapter enforces.
 */
export const SFTP_REDIAL_WARN_INTERVAL = 10;

/** Constructor options for {@link SftpAdapterLedger}. */
export interface SftpAdapterLedgerOptions {
  /** Where a due paced line is written, at the adapter's own log verbosity. */
  warn: (message: string) => void;
}

/**
 * One adapter's run counters and warn cadence. Each counter starts at zero and
 * only rises over the adapter's life, so a run that never reached a condition
 * reports zero for it rather than nothing; the outstanding-operation gauge is
 * the one reading that also falls.
 */
export class SftpAdapterLedger {
  private readonly warn: (message: string) => void;
  private transportRetries = 0;
  private outstanding = 0;
  // Whether a held-boundary stretch is currently open. Not derivable from the
  // two counters below: what closes a stretch is the outstanding count
  // emptying, which leaves no trace in either.
  private holdStretchOpen = false;
  private heldBoundaries = 0;
  private heldBoundaryStretches = 0;
  private declinedReleases = 0;
  private forcedReleases = 0;
  private releasedBoundaries = 0;
  private declinedCycleRedials = 0;

  constructor(options: SftpAdapterLedgerOptions) {
    this.warn = options.warn;
  }

  /**
   * Warn about the `count`-th occurrence of a repeating condition, on the
   * cadence they all share: the first, then every
   * {@link SFTP_REDIAL_WARN_INTERVAL}-th. `alsoDue` adds an occurrence off that
   * cadence the operator is owed anyway -- the last re-dial a budget permits,
   * which a budget shorter than the interval never reaches. `build` runs only
   * when the line is due, so a suppressed one costs nothing to compose.
   *
   * `count` is the caller's own running total for that condition rather than a
   * tally kept here, so every stream is paced on exactly the number its message
   * quotes and the two cannot drift apart.
   */
  pacedWarn(count: number, build: () => string, alsoDue = false): void {
    if (!alsoDue && count !== 1 && count % SFTP_REDIAL_WARN_INTERVAL !== 0)
      return;
    this.warn(build());
  }

  /** Count one re-issue of a data operation past its first attempt. */
  countTransportRetry(): void {
    this.transportRetries += 1;
  }

  /**
   * Count one operation as outstanding; the returned call settles it. Balanced
   * however the operation settles -- one unbalanced failure would read as an
   * operation still on the wire for the rest of the exchange, and pin every
   * later idle boundary open.
   */
  openOperation(): () => void {
    this.outstanding += 1;
    return () => {
      this.outstanding -= 1;
      // An empty wire ends whatever stretch of held boundaries was open: the
      // next held boundary begins a new one. Read after the decrement, so the
      // operation settling here is not counted as still holding.
      if (this.outstanding === 0) this.holdStretchOpen = false;
    };
  }

  /**
   * Count one idle boundary held for an outstanding operation, opening a hold
   * stretch when none is open.
   */
  countHeldBoundary(): void {
    this.heldBoundaries += 1;
    if (this.holdStretchOpen) return;
    this.holdStretchOpen = true;
    this.heldBoundaryStretches += 1;
  }

  /** Count one idle release that gave up its wait, and report the run total. */
  countDeclinedRelease(): number {
    this.declinedReleases += 1;
    return this.declinedReleases;
  }

  /** Count one idle boundary this side forced closed, and report the total. */
  countForcedRelease(): number {
    this.forcedReleases += 1;
    return this.forcedReleases;
  }

  /** Count one idle boundary the partner closed on request. */
  countReleasedBoundary(): void {
    this.releasedBoundaries += 1;
  }

  /** Count one cycle-start re-dial that gave up its wait, and report the total. */
  countDeclinedCycleRedial(): number {
    this.declinedCycleRedials += 1;
    return this.declinedCycleRedials;
  }

  /**
   * Operations issued and not yet settled. Read as a non-zero test -- whether an
   * idle boundary may close a session -- never as a quantity: two spans keep the
   * count for a recovered operation and they nest, so one operation inside its
   * recovery reads as more than one.
   */
  get outstandingOperations(): number {
    return this.outstanding;
  }

  /** Re-issues of a data operation past its first attempt, over the run. */
  get transportRetryCount(): number {
    return this.transportRetries;
  }

  /** Idle boundaries held for an operation this side had issued. */
  get heldBoundaryCount(): number {
    return this.heldBoundaries;
  }

  /** Unbroken stretches those held boundaries fall in. */
  get heldBoundaryStretchCount(): number {
    return this.heldBoundaryStretches;
  }

  /** Idle releases that closed nothing, having given up their wait. */
  get declinedReleaseCount(): number {
    return this.declinedReleases;
  }

  /** Idle boundaries this side closed itself past the release's bound. */
  get forcedReleaseCount(): number {
    return this.forcedReleases;
  }

  /** Idle boundaries the partner's server closed on request. */
  get releasedBoundaryCount(): number {
    return this.releasedBoundaries;
  }

  /** Cycle-start re-dials that dialed nothing, having given up their wait. */
  get declinedCycleRedialCount(): number {
    return this.declinedCycleRedials;
  }
}
