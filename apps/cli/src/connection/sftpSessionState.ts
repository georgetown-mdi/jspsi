/**
 * The connection-lifecycle state one SFTP adapter carries across its whole life:
 * how far its teardown has got, what the ssh2 Client's transport has reported
 * about closing, and the one-shot budgets whose whole content is "this run has
 * already done that once". Transport-blind, like {@link ./sftpAdapterLedger}: no
 * ssh2 or ssh2-sftp-client type reaches it, and it holds no session, socket or
 * client object.
 *
 * It holds the state that outlives a session generation. Per-session values --
 * the guarded SFTPWrapper, the captured fatal error, the transition queue, the
 * boundary reading -- stay on the adapter, where the transition lock that orders
 * them is. See {@link ./ssh2SftpAdapter} for the events that drive this, and
 * docs/notes/sftp-adapter-state-machine.md for the model the adapter's session
 * machine follows.
 */

/**
 * How far the connection's terminal close has got. The two latches behind it are
 * separate facts, not a progression: `beginTeardown()` says a teardown-driven
 * re-dial is still wanted but exempt from the mid-exchange reconnection cap,
 * while `beginClose()` forbids a re-dial outright -- and `end()` does not
 * require `beginTeardown()` first, so all four combinations are reachable. Both
 * latches are monotonic, so this only ever advances.
 */
export type TeardownState =
  "running" | "tearingDown" | "closing" | "closingAfterTeardown";

/**
 * What is known about the ssh2 Client's transport close, as the three states it
 * can be in rather than the two booleans that would encode them: `unreadable`
 * when the installed ssh2-sftp-client exposes no `client.on()` to watch through
 * (an absence of information, not an observation), `owed` when the transport has
 * emitted its `'end'` without its `'close'` -- the window in which a dial on the
 * same Client is rejected by connect-time listeners -- and `delivered`
 * otherwise. The measured ordering, and what an unwatchable Client costs, are in
 * docs/spec/DEPENDENCY_PINS.md, "Upgrading the SFTP Stack".
 */
export type TransportCloseReading = "unreadable" | "owed" | "delivered";

/** The whole of one adapter's connection-lifecycle state. */
export class SftpSessionState {
  #teardown: TeardownState = "running";
  #transportClose: TransportCloseReading = "unreadable";
  #abandonedTeardownClosedTransport = false;
  #peerAnswerDiagnosisSpent = false;
  #unreadableLifecycleWarned = false;
  #keyboardInteractiveAttached = false;

  /** How far the terminal close has got. */
  get teardown(): TeardownState {
    return this.#teardown;
  }

  /**
   * Whether `end()` has latched. Read once per transition inside the transition
   * queue's critical section, and that single read is the whole of "no session
   * transition begins after teardown has been latched". It also refuses a reopen
   * of a terminally closed connection and stops session recovery from launching
   * a re-dial into a teardown, whose readyTimeout would slow a clean close and
   * whose fresh session would outlive the teardown.
   */
  get isClosing(): boolean {
    return (
      this.#teardown === "closing" || this.#teardown === "closingAfterTeardown"
    );
  }

  /**
   * Whether `beginTeardown()` has latched. Read where a session loss is
   * classified: a drop under a teardown this side drove is not a partner's.
   */
  get isTearingDown(): boolean {
    return (
      this.#teardown === "tearingDown" ||
      this.#teardown === "closingAfterTeardown"
    );
  }

  /** Latch the start of the connection's close()/teardown. Idempotent. */
  beginTeardown(): void {
    if (this.#teardown === "running") this.#teardown = "tearingDown";
    else if (this.#teardown === "closing")
      this.#teardown = "closingAfterTeardown";
  }

  /** Latch `end()`. Idempotent. */
  beginClose(): void {
    this.#teardown =
      this.#teardown === "tearingDown" ||
      this.#teardown === "closingAfterTeardown"
        ? "closingAfterTeardown"
        : "closing";
  }

  /**
   * Whether an abandoning teardown closed the transport itself, cutting short
   * whatever dial the transition it gave up on was running. That dial rejects
   * with the same error a genuine peer close produces (measured; see
   * docs/spec/DEPENDENCY_PINS.md), so telling "this adapter closed it" from "the
   * partner dropped us" takes this reading rather than a match on the error
   * text. Never cleared: it is only ever set on a connection already closing.
   */
  get abandonedTeardownClosedTransport(): boolean {
    return this.#abandonedTeardownClosedTransport;
  }

  /** Record that an abandoning teardown drove the transport close itself. */
  recordAbandonedTeardownClose(): void {
    this.#abandonedTeardownClosedTransport = true;
  }

  /** What is known about the transport's close. */
  get transportClose(): TransportCloseReading {
    return this.#transportClose;
  }

  /**
   * Take the one-per-adapter permission to attach the transport-lifecycle
   * listeners, moving the reading off `unreadable`. False on every later call:
   * ssh2-sftp-client constructs its Client once and reuses it across reconnects,
   * so re-attaching per reconnect would stack duplicate listeners.
   */
  beginWatchingTransport(): boolean {
    if (this.#transportClose !== "unreadable") return false;
    this.#transportClose = "delivered";
    return true;
  }

  /** The transport emitted its `'end'`; its `'close'` is now owed. */
  recordTransportEnd(): void {
    if (this.#transportClose !== "unreadable") this.#transportClose = "owed";
  }

  /** The transport emitted its `'close'`; nothing is owed. */
  recordTransportClose(): void {
    if (this.#transportClose !== "unreadable")
      this.#transportClose = "delivered";
  }

  /**
   * Whether this connection's single non-SSH-answer diagnosis has been taken.
   * The diagnosis opens a TCP connection of its own and the connection-per-poll
   * mode dials at every cycle start, so an unspent budget would re-dial a peer
   * that is already answering wrongly once per tick for as long as the condition
   * stands. What it says is that this run has already told the operator what
   * answered the port.
   */
  get peerAnswerDiagnosisSpent(): boolean {
    return this.#peerAnswerDiagnosisSpent;
  }

  /**
   * Spend that budget, at the point the diagnosis opens its own connection
   * rather than at the point it produces a diagnostic: the connection is the
   * cost.
   */
  spendPeerAnswerDiagnosis(): void {
    this.#peerAnswerDiagnosisSpent = true;
  }

  /**
   * Take the one warning that the transport lifecycle cannot be read. Whether
   * the Client exposes `on()` is a property of the installed version rather than
   * of any one drop, so a second copy tells the operator nothing the first did
   * not.
   */
  spendUnreadableLifecycleWarning(): boolean {
    if (this.#unreadableLifecycleWarned) return false;
    this.#unreadableLifecycleWarned = true;
    return true;
  }

  /**
   * Whether the keyboard-interactive answer handler is attached. It goes on the
   * ssh2 Client once per adapter, on the same terms as the transport listeners:
   * ssh2-sftp-client reuses that Client across reconnects, so a per-reconnect
   * re-attach would stack duplicates and eventually trip a MaxListenersExceeded
   * warning.
   */
  get keyboardInteractiveAttached(): boolean {
    return this.#keyboardInteractiveAttached;
  }

  /**
   * Record that handler as attached, after the attach itself: an adapter that
   * could not attach one has not spent this, so a later call still tries.
   */
  recordKeyboardInteractiveAttached(): void {
    this.#keyboardInteractiveAttached = true;
  }
}
