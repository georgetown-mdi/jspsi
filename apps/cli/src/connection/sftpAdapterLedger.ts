/**
 * The operator-facing accounting one SFTP adapter keeps over a run: the sessions
 * it established and lost, the counters its end-of-run summary reports, the
 * outstanding-operation gauge its idle boundary is held on, and the cadence its
 * repeating warnings share.
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

/**
 * Why a session generation ended. Every generation ends for exactly one of
 * these, and `partner` is the only one that is a LOSS in the operator's sense --
 * the other three are this side's own doing and so reach neither the reconnect
 * counters nor the cumulative mid-exchange budget.
 */
export type LossCause = (typeof LOSS_CAUSES)[number];

// The counter rows are built from this list, and the type is read off it, so a
// cause cannot be added to one and missed by the other -- which would leave its
// row absent and its count reading NaN.
const LOSS_CAUSES = ["partner", "deliberate", "teardown", "fatal"] as const;

/**
 * What one invocation of the connection-per-poll idle release did, drawn from a
 * total and mutually exclusive partition. It is the recorded value: the session
 * reading the release leaves behind and the counter it moves are both
 * projections of it (see {@link ./ssh2SftpAdapter}), so a future outcome has to
 * state both answers or it does not compile.
 *
 * The first four close nothing and so end no generation: `skipped` reached the
 * front of the transition queue with teardown already latched, `held` found an
 * operation this side had issued still unsettled, `declined` gave up its bounded
 * wait for the transition ahead of it, and `alreadyEnded` found the session gone
 * with its loss already accounted for by whatever took it.
 *
 * `noSession` is that same absent session with the generation still live: a
 * partner-side drop cleared it inside this cycle with nothing on the wire to
 * observe it, so this boundary is the first thing that does. `closedByPeer`,
 * `releasedOverEndedTransport` and `released` are the
 * three ways a session that WAS there ends, told apart by which side ended the
 * transport beneath it -- the peer's FIN already consumed, the peer's disconnect
 * already answered by ssh2 ending its own half, or neither, which is the
 * ordinary release. `forced` is any of those three whose close the partner
 * withheld past the release's bound, so this side destroyed the transport; which
 * side ended it is the reading the entry classification already recorded, and
 * the forcing does not change that answer.
 *
 * `didNotClose` and `destroyDidNotClear` are the two degraded tails, both
 * leaving the session live: the release's own `end()` did not end the transport,
 * and the forced destroy did not clear the session.
 */
export type IdleBoundaryOutcome = (typeof IDLE_BOUNDARY_OUTCOMES)[number];

// The source of truth for the partition, on the same terms as the loss causes
// above: the counter rows are built from this list and the type is read off it.
const IDLE_BOUNDARY_OUTCOMES = [
  "skipped",
  "held",
  "declined",
  "alreadyEnded",
  "noSession",
  "closedByPeer",
  "releasedOverEndedTransport",
  "released",
  "forced",
  "didNotClose",
  "destroyDidNotClear",
] as const;

/**
 * The whole of one adapter's session accounting. The invariant -- no
 * generation leaves the live state without exactly one recorded loss cause --
 * is held structurally rather than asserted: every dial charges any
 * still-pending end before advancing, and {@link SftpAdapterLedger.dialSucceeded}
 * raises on one that slipped through. The sum identity this implies
 * (`generationsEnded` equals the sum of {@link losses}) is an identity of the
 * ledger itself, so no test asserts it; tests pin WHICH cause each driven end
 * charged.
 *
 * @internal
 */
export interface SftpSessionAccounting {
  readonly generations: number;
  readonly liveGeneration: number | undefined;
  readonly generationsEnded: number;
  readonly losses: Readonly<Record<LossCause, number>>;
  readonly boundaries: Readonly<Record<IdleBoundaryOutcome, number>>;
}

/** Constructor options for {@link SftpAdapterLedger}. */
export interface SftpAdapterLedgerOptions {
  /** Where a due paced line is written, at the adapter's own log verbosity. */
  warn: (message: string) => void;
}

const zeroed = <K extends string>(keys: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;

/**
 * One adapter's session generations, run counters and warn cadence. Each counter
 * starts at zero and only rises over the adapter's life, so a run that never
 * reached a condition reports zero for it rather than nothing; the
 * outstanding-operation gauge is the one reading that also falls.
 */
export class SftpAdapterLedger {
  private readonly warn: (message: string) => void;
  // Sessions this adapter has established, counted so a loss can be attributed
  // to the session that suffered it. Identity is what the accounting needs and
  // neither the count of dials nor the count of recovery arms supplies it: one
  // drop tears every operation on the wire, so a fan-out of them enters recovery
  // together, and the session they lost is the one thing they have in common.
  private generations = 0;
  // The generation currently live, or undefined once it has ended. Cleared by
  // the loss that ends it, which is what makes a second charge for the same
  // generation impossible rather than merely unlikely.
  private live: number | undefined;
  private readonly losses = zeroed(LOSS_CAUSES);
  private readonly boundaries = zeroed(IDLE_BOUNDARY_OUTCOMES);
  private connectRetries = 0;
  private transportRetries = 0;
  private outstanding = 0;
  // Whether a held-boundary stretch is currently open. Not derivable from the
  // two counters below: what closes a stretch is the outstanding count
  // emptying, which leaves no trace in either.
  private holdStretchOpen = false;
  private heldBoundaryStretches = 0;
  private partnerDropsAtBoundaries = 0;
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

  /**
   * Record a dial that established a session, and report the generation it
   * begins. A dial reaching here over a generation that is still live would be
   * replacing a session whose end nothing recorded, which is the invariant this
   * ledger exists to hold, so it raises rather than silently advancing.
   */
  dialSucceeded(): number {
    if (this.live !== undefined)
      throw new Error(
        `an SFTP dial established session generation ${this.generations + 1} ` +
          `while generation ${this.live} was still live, so that generation ` +
          `ended with no recorded cause; every transition that ends a session ` +
          `records the loss that ended it before the next dial runs`,
      );
    this.generations += 1;
    this.live = this.generations;
    return this.generations;
  }

  /**
   * Record that `generation` ended, for `cause`, and report whether this call is
   * what recorded it. `false` means that generation had already ended -- a
   * sibling recovery arm reached the same lost session first, or the transition
   * that took it away charged it -- so the caller must not charge a budget or
   * warn for it a second time.
   *
   * An undefined `generation` is the same answer: there is nothing live to end.
   */
  recordLoss(generation: number | undefined, cause: LossCause): boolean {
    if (generation === undefined || generation !== this.live) return false;
    this.live = undefined;
    this.losses[cause] += 1;
    return true;
  }

  /**
   * Count one idle-boundary outcome, and report that outcome's run total. A
   * `held` boundary also opens a hold stretch when none is open.
   */
  countBoundary(outcome: IdleBoundaryOutcome): number {
    this.boundaries[outcome] += 1;
    if (outcome === "held" && !this.holdStretchOpen) {
      this.holdStretchOpen = true;
      this.heldBoundaryStretches += 1;
    }
    return this.boundaries[outcome];
  }

  /**
   * Count one idle boundary whose session the partner ended rather than the
   * release, and report the run total. Its own tally rather than a sum over the
   * boundary rows above: a boundary this side had to force closed is recorded as
   * `forced` whichever side ended the transport beneath it, so no combination of
   * those rows answers this.
   */
  countPartnerDropAtBoundary(): number {
    this.partnerDropsAtBoundaries += 1;
    return this.partnerDropsAtBoundaries;
  }

  /** Count one dialing-retry re-attempt past a connect's first. */
  countConnectRetry(): void {
    this.connectRetries += 1;
  }

  /** Count one re-issue of a data operation past its first attempt. */
  countTransportRetry(): void {
    this.transportRetries += 1;
  }

  /** Count one cycle-start re-dial that gave up its wait, and report the total. */
  countDeclinedCycleRedial(): number {
    this.declinedCycleRedials += 1;
    return this.declinedCycleRedials;
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

  /** The generation currently live, or undefined when no session is. */
  get liveGeneration(): number | undefined {
    return this.live;
  }

  /**
   * Operations issued and not yet settled. Read as a non-zero test -- whether an
   * idle boundary may close a session -- never as a quantity.
   */
  get outstandingOperations(): number {
    return this.outstanding;
  }

  /**
   * Connection re-establishments this run: connect-time dialing retries past the
   * first attempt, plus every session the partner took away.
   */
  get reconnectCount(): number {
    return this.connectRetries + this.losses.partner;
  }

  /** The subset of {@link reconnectCount} that were sessions lost mid-exchange. */
  get midExchangeReconnectCount(): number {
    return this.losses.partner;
  }

  /** Re-issues of a data operation past its first attempt, over the run. */
  get transportRetryCount(): number {
    return this.transportRetries;
  }

  /** Idle boundaries held for an operation this side had issued. */
  get heldBoundaryCount(): number {
    return this.boundaries.held;
  }

  /** Unbroken stretches those held boundaries fall in. */
  get heldBoundaryStretchCount(): number {
    return this.heldBoundaryStretches;
  }

  /** Idle releases that closed nothing, having given up their wait. */
  get declinedReleaseCount(): number {
    return this.boundaries.declined;
  }

  /** Idle boundaries this side closed itself past the release's bound. */
  get forcedReleaseCount(): number {
    return this.boundaries.forced;
  }

  /**
   * Idle boundaries at which the session was released -- every way a release
   * ends one, the forced close included, which is what makes it
   * {@link forcedReleaseCount}'s denominator.
   */
  get releasedBoundaryCount(): number {
    return (
      this.boundaries.released +
      this.boundaries.releasedOverEndedTransport +
      this.boundaries.forced
    );
  }

  /** Cycle-start re-dials that dialed nothing, having given up their wait. */
  get declinedCycleRedialCount(): number {
    return this.declinedCycleRedials;
  }

  /** @internal */
  get accounting(): SftpSessionAccounting {
    return {
      generations: this.generations,
      liveGeneration: this.live,
      generationsEnded: this.generations - (this.live === undefined ? 0 : 1),
      losses: { ...this.losses },
      boundaries: { ...this.boundaries },
    };
  }
}
