import { sanitizeErrorForDisplay } from "@psilink/core";

/**
 * Keeps an otherwise-idle SFTP session alive past a server's idle timeout by
 * issuing a periodic no-op SFTP command, the application-layer complement to the
 * liveness BOUNDS in {@link ./sftpLivenessGuard} (those cap how long a hostile
 * server can make an operation hang; this keeps a friendly server from dropping a
 * legitimately quiet session). See {@link SftpHeartbeat}.
 *
 * The motivating failure: an SFTP server enforcing a strict idle timeout (Azure
 * Blob SFTP's is a fixed two minutes) closes the control connection when no SFTP
 * command has arrived within the window. A PSI round spends long stretches with no
 * file traffic on the side that is computing rather than polling -- and on weak
 * hardware (old agency laptops) a single round's elliptic-curve masking can run
 * for minutes. With the masking moved off the event-loop-owning thread, the timer
 * can finally fire during that stretch; this heartbeat is what fills it.
 *
 * Why a real SFTP command and not an SSH/TCP keepalive: a server keys idleness on
 * the last SFTP protocol REQUEST, not on transport-level traffic, so an SSH
 * keepalive or a TCP keepalive probe does not reset its timer. `realPath(".")` is
 * the cheapest real SFTP round-trip (one REALPATH request, a path the server
 * always resolves), so it resets the timer at negligible cost. The kernel TCP
 * keepalive the adapter also enables is a separate, transport-layer backstop (NAT/
 * firewall liveness and dead-peer detection), not a substitute for this. The
 * interval value and that layering rationale live in docs/spec/CHANNEL_SECURITY.md.
 */

/**
 * Interval, in milliseconds, between heartbeat beats: the maximum time an idle
 * session is allowed to go without a keepalive command before one is sent. Also
 * the delay before the first beat after a session goes quiet.
 *
 * Value: 60,000 ms (60 s). Half of the tightest idle timeout this must survive
 * (Azure Blob SFTP's fixed 2 minutes), so a beat always lands with a full interval
 * of margin even if one is delayed. Fixed, not operator-configurable, for the same
 * reason as {@link ./sftpLivenessGuard.SFTP_STALL_DEADLINE_MS}: a knob here is a
 * footgun (set too high, it silently stops defeating the timeout) with no upside a
 * fixed sub-timeout value does not already have. See docs/spec/CHANNEL_SECURITY.md
 * for the full rationale.
 */
export const SFTP_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Idle time, in milliseconds, before the kernel begins sending TCP keepalive
 * probes on the SFTP socket (`net.Socket.setKeepAlive`'s initialDelay). This is
 * the transport-layer backstop beneath {@link SftpHeartbeat}: it keeps NAT/
 * firewall flow state warm and lets the kernel detect a silently dead peer, but --
 * because it rides below the SFTP protocol -- it does NOT reset a server's
 * SFTP-command idle timer, which is why the application heartbeat exists.
 *
 * Value: 30,000 ms (30 s). Comfortably below common NAT idle windows (often 5 min)
 * and below the application heartbeat interval, so probes keep the flow alive
 * between heartbeats. Node only sets the initial-delay (TCP_KEEPIDLE); the probe
 * interval and count keep their OS defaults. See docs/spec/CHANNEL_SECURITY.md.
 */
export const SFTP_TCP_KEEPALIVE_DELAY_MS = 30_000;

/** Minimal logger surface the heartbeat needs: keepalive traffic is trace-only. */
interface HeartbeatLog {
  trace: (message: string) => void;
}

export interface SftpHeartbeatOptions {
  /**
   * Issues the no-op keepalive command (a bounded `realPath(".")`). Must return a
   * promise that settles when the server answers or the wait is bounded out; its
   * outcome is swallowed (logged at trace), never surfaced to the exchange, so a
   * failing keepalive cannot itself fail a round.
   */
  ping: () => Promise<unknown>;
  log: HeartbeatLog;
  /**
   * Beat interval; defaults to {@link SFTP_HEARTBEAT_INTERVAL_MS}. A test seam
   * only -- production constructs the heartbeat with no override.
   */
  intervalMs?: number;
}

/**
 * A self-rescheduling keepalive for one SFTP session. {@link start} arms it after
 * a successful connect; the adapter brackets every server-driven operation with
 * {@link opStarted}/{@link opSettled} so a beat is suppressed while real traffic is
 * already keeping the session alive; {@link stop} tears it down on every terminal
 * path.
 *
 * Concurrency: ssh2-sftp-client shares connection-level temp listeners across
 * operations, so two operations in flight on one client at once is unsafe. The
 * heartbeat therefore never pings while an adapter operation is in flight
 * (`inFlight > 0`) or while a previous ping has not settled (`pinging`), and it
 * only pings after a full interval of genuine idleness. The one residual overlap
 * -- a real operation that begins in the same turn a just-issued ping is still on
 * the wire -- is benign: on a healthy session each completes through its own
 * per-request SFTPWrapper callback, and on a dying one both operations failing is
 * the correct outcome. (Re-verify this premise on any ssh2-sftp-client upgrade,
 * per the "Upgrading the SFTP Stack" checklist in docs/spec/DEPENDENCY_PINS.md.)
 */
export class SftpHeartbeat {
  private readonly ping: () => Promise<unknown>;
  private readonly log: HeartbeatLog;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  // Wall-clock (Date.now) of the last observed session activity: a connect, or an
  // operation starting or settling. The idle window is measured from here.
  private lastActivityAt = 0;
  // Count of adapter operations currently on the wire. While non-zero the session
  // is being kept alive by real traffic, so no beat is issued.
  private inFlight = 0;
  // True while a heartbeat ping is itself in flight, so beats never stack.
  private pinging = false;
  // Latched by stop(): a fired-but-not-yet-run tick, and a ping settling after
  // teardown, both no-op once set so nothing reschedules past stop().
  private stopped = false;
  // Bumped by every start()/stop(). A ping issued -- or an operation bracketed by
  // opStarted/opSettled -- in one cycle captures the epoch; its late settlement is
  // ignored once the epoch has moved on, so a ping or op that outlives a teardown or
  // a reconnect can neither clear the new cycle's `pinging` flag, reschedule a beat
  // onto it, nor decrement the new session's in-flight count.
  private epoch = 0;

  constructor(options: SftpHeartbeatOptions) {
    this.ping = options.ping;
    this.log = options.log;
    this.intervalMs = options.intervalMs ?? SFTP_HEARTBEAT_INTERVAL_MS;
  }

  /**
   * Arm the heartbeat after a successful connect. Idempotent across reconnects: it
   * resets the idle clock and re-schedules, so a fresh session starts a fresh
   * window whether or not a prior one was running.
   */
  start(): void {
    this.stopped = false;
    // Fresh cycle: advance the epoch (fencing the prior cycle's stragglers; see the
    // epoch field) and drop the transient state a torn-down session may have left
    // set -- a stuck `pinging`, or an `inFlight` an interrupted op never balanced --
    // either of which would otherwise make every tick on the new session skip its
    // beat.
    this.epoch += 1;
    this.pinging = false;
    this.inFlight = 0;
    this.lastActivityAt = Date.now();
    this.schedule(this.intervalMs);
  }

  /**
   * A server-driven adapter operation began: the session is active. Returns the
   * current epoch as a token the matching {@link opSettled} must present, so an op
   * whose session was torn down (a stop()/start() has since moved the epoch on)
   * cannot decrement a later session's in-flight count when it finally settles.
   */
  opStarted(): number {
    this.inFlight += 1;
    this.lastActivityAt = Date.now();
    return this.epoch;
  }

  /**
   * A server-driven adapter operation settled (resolved or rejected). `token` is the
   * epoch {@link opStarted} returned; a settle whose epoch has since moved is ignored
   * (see the epoch field), so a straggler cannot decrement or count as activity on a
   * later session.
   */
  opSettled(token: number): void {
    if (token !== this.epoch) return;
    if (this.inFlight > 0) this.inFlight -= 1;
    this.lastActivityAt = Date.now();
  }

  /**
   * Stop the heartbeat on a terminal/cleanup path (session end or a fatal server
   * error). Clears the pending timer and latches `stopped` so any tick or ping
   * already scheduled reschedules nothing. Safe to call when never started and
   * safe to call repeatedly.
   */
  stop(): void {
    this.stopped = true;
    // Advance the epoch (see the epoch field) and drop the transient counters so a
    // later start() begins from a clean slate.
    this.epoch += 1;
    this.pinging = false;
    this.inFlight = 0;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), Math.max(delayMs, 0));
    // The heartbeat is a background keepalive, never real work: every terminal
    // path clears it, so unref'ing it only matters when the process is winding
    // down with the timer still armed, where it must not hold the process open
    // (the deliberately unref'd SFTP-liveness-timer teardown contract).
    this.timer.unref();
  }

  private tick(): void {
    if (this.stopped) return;
    // Real traffic (a live operation, or a ping still settling) is already keeping
    // the session alive, and ssh2-sftp-client forbids a second concurrent op, so
    // skip this beat and re-check after a full interval.
    if (this.inFlight > 0 || this.pinging) {
      this.schedule(this.intervalMs);
      return;
    }
    // Activity may have landed after this timer was armed; only beat once the
    // session has actually been idle for a full interval, else wait out the
    // remainder (measured from lastActivityAt so idle never exceeds one interval).
    const idleMs = Date.now() - this.lastActivityAt;
    if (idleMs < this.intervalMs) {
      this.schedule(this.intervalMs - idleMs);
      return;
    }
    this.sendPing();
  }

  private sendPing(): void {
    this.pinging = true;
    // Bind this ping to the current cycle so its late settlement below is fenced off
    // a later cycle (see the epoch field).
    const epoch = this.epoch;
    void this.ping()
      .then(() => this.log.trace("SFTP keepalive sent"))
      .catch((err: unknown) =>
        this.log.trace(
          `SFTP keepalive failed: ${sanitizeErrorForDisplay(err)}`,
        ),
      )
      .finally(() => {
        if (epoch !== this.epoch) return;
        this.pinging = false;
        this.lastActivityAt = Date.now();
        // A ping that settled after stop() must not re-arm a torn-down heartbeat.
        if (!this.stopped) this.schedule(this.intervalMs);
      });
  }
}
