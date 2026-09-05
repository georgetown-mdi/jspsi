import { EventEmitter } from "node:events";

import { describe, expect, test, vi } from "vitest";

import type { KexPrimitive } from "../../../src/connection/sftpKexCapability";

// How each of the two dial paths classifies a key-exchange negotiation that
// found nothing the two ends have in common: terminal on a process that
// cannot perform one of the offered primitives, retryable everywhere else.
// The verdict decides, not the message fragment alone -- ssh2 renders a
// server's SSH_MSG_DISCONNECT into the same message, so a server or an
// on-path attacker can write it verbatim; driven on the wire in
// test/integration/sftpKexOffer.test.ts.

const forcedVerdict = vi.hoisted(() => ({
  unavailable: [] as readonly KexPrimitive[],
}));

// Only the host VERDICT is replaced; the classification, the diagnostic, and the
// adapter are the real ones. Defaulting to "every primitive available" keeps
// unavailableKexPrimitives neutral for a case that does not set it, and it is
// the reading any host running this suite supplies on its own.
vi.mock("../../../src/connection/sftpKexCapability", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/connection/sftpKexCapability")
    >();
  return {
    ...actual,
    unavailableKexPrimitives: () => forcedVerdict.unavailable,
  };
});

const { SSH2SFTPClientAdapter } =
  await import("../../../src/connection/ssh2SftpAdapter");

// The adapter is imported for its VALUE after the mock is in place, so its type
// is taken from that value rather than from a second import of the module.
type Adapter = InstanceType<typeof SSH2SFTPClientAdapter>;

// A primitive this process cannot perform, without needing a host that cannot
// perform one -- the same stand-in the capability unit and offer integration
// suites use.
const MISSING: KexPrimitive = {
  primitive: "X25519",
  matchesAlgorithm: /25519/i,
  perform: () => {
    throw new Error("error:0308010C:digital envelope routines::unsupported");
  },
};

// The message ssh2-sftp-client shows when the two ends share no key-exchange
// algorithm, measured against the pinned versions (docs/spec/DEPENDENCY_PINS.md,
// "Upgrading the SFTP Stack", which names confirming this fragment as a per-bump
// obligation).
const NEGOTIATION_FAILURE =
  "getConnection: Handshake failed: no matching key exchange algorithm";

// Counts the dials the adapter issues for one connect(), rejecting each with
// `message`. Only connect() is stubbed: every case here fails the dial, so the
// post-connect surface is never reached.
function countingDialer(message: string): {
  adapter: Adapter;
  dials: () => number;
} {
  let dials = 0;
  const adapter = new SSH2SFTPClientAdapter();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).client = {
    connect: vi.fn().mockImplementation(async () => {
      dials++;
      throw new Error(message);
    }),
  };
  return { adapter, dials: () => dials };
}

// Runs one connect() to its rejection with a reconnect budget of `retries`,
// advancing past far more retry windows than that budget could arm: a
// classification that wrongly returned "retry" shows up as a dial count above
// one, not as a slow test.
async function dialUntilRejected(
  adapter: Adapter,
  retries: number,
): Promise<Error> {
  const attempt = adapter.connect({
    host: "sftp.example.org",
    maxReconnectAttempts: retries,
  });
  // Attach before advancing so a mid-advance rejection is never unhandled.
  const settled = attempt.then(
    () => undefined,
    (error: Error) => error,
  );
  await vi.advanceTimersByTimeAsync(1_000 * (retries + 2));
  const error = await settled;
  if (error === undefined) throw new Error("expected the dial to reject");
  return error;
}

describe("a key exchange this process cannot perform", () => {
  test("ends the dial at the first refusal, spending no reconnect budget", async () => {
    vi.useFakeTimers();
    forcedVerdict.unavailable = [MISSING];
    const { adapter, dials } = countingDialer(NEGOTIATION_FAILURE);
    try {
      // A non-zero budget is what makes the assertion meaningful: a working
      // classification refuses to spend it on a negotiation whose outcome is
      // fixed by this process's own crypto provider. The count is the observed
      // dials, not a wall-clock bound on how long the rejection takes.
      await dialUntilRejected(adapter, 3);
      expect(dials()).toBe(1);
      // No re-dial happened, so nothing is reported as a reconnect either.
      expect(adapter.reconnectCount).toBe(0);
    } finally {
      forcedVerdict.unavailable = [];
      vi.useRealTimers();
    }
  });

  test("still reports the diagnostic naming the primitive, ssh2's error one link down", async () => {
    vi.useFakeTimers();
    forcedVerdict.unavailable = [MISSING];
    const { adapter } = countingDialer(NEGOTIATION_FAILURE);
    try {
      // What the operator reads is the whole point of failing early rather than
      // late: the same diagnostic, at the first attempt instead of the last.
      const error = await dialUntilRejected(adapter, 3);
      expect(error.message).toContain("X25519");
      expect(error.message).toContain("server's administrator");
      expect((error.cause as Error).message).toContain(
        "no matching key exchange algorithm",
      );
    } finally {
      forcedVerdict.unavailable = [];
      vi.useRealTimers();
    }
  });

  test("a transient failure on the same host still spends the budget", async () => {
    vi.useFakeTimers();
    forcedVerdict.unavailable = [MISSING];
    const { adapter, dials } = countingDialer("connection refused");
    try {
      // The verdict is a property of the process, not of the dial: it must not
      // turn every rejection on such a host terminal.
      const error = await dialUntilRejected(adapter, 2);
      expect(error.message).toContain("connection refused");
      expect(dials()).toBe(3);
    } finally {
      forcedVerdict.unavailable = [];
      vi.useRealTimers();
    }
  });

  test("a host-key rejection stays terminal, and keeps its own message", async () => {
    vi.useFakeTimers();
    forcedVerdict.unavailable = [MISSING];
    const { adapter, dials } = countingDialer(
      "Host denied (verification failed)",
    );
    try {
      // The other terminal class, driven here on a host missing the primitive:
      // the two classifications coexist, and a host-key rejection is not
      // re-raised as a key-exchange diagnostic. (The same rejection on a host
      // that can perform everything ssh2 offers is pinned in
      // ssh2SftpAdapter.test.ts.)
      const error = await dialUntilRejected(adapter, 3);
      expect(error.message).toContain("Host denied");
      expect(error.message).not.toContain("X25519");
      expect(dials()).toBe(1);
    } finally {
      forcedVerdict.unavailable = [];
      vi.useRealTimers();
    }
  });
});

describe("the same negotiation failure on a host that can perform everything", () => {
  test("is retried up to the reconnect budget", async () => {
    vi.useFakeTimers();
    const { adapter, dials } = countingDialer(NEGOTIATION_FAILURE);
    try {
      // The message on its own decides nothing: with an empty verdict the
      // failure is an ordinary dial failure, retried like any other, and a
      // server that writes the fragment through its own SSH_MSG_DISCONNECT
      // description ends no dial early.
      const error = await dialUntilRejected(adapter, 2);
      expect(dials()).toBe(3);
      // And it reaches the operator as ssh2's own text, unwrapped: there is no
      // missing primitive to name.
      expect(error.message).toContain("no matching key exchange algorithm");
      expect(error.message).not.toContain("X25519");
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- the connection-per-poll cycle-start re-dial --------------------------
//
// The other dial path, and the one an unattended scheduled run takes at every
// poll tick. It classifies DOWNSTREAM of the diagnostic: what reaches it is what
// the dial sequence threw, whose message the diagnostic replaced and whose cause
// holds ssh2's own, so the fragment the connect loop matched is no longer there.
// A rejection ends the exchange; `false` skips this cycle for the next tick.

// A faithful stand-in for the ssh2 Client ssh2-sftp-client exposes on `.client`:
// the EventEmitter surface the adapter's transport-lifecycle watch attaches to,
// the socket call sites the idle release drives, and the no-ops connect() would
// otherwise warn about.
const releasableClient = () =>
  Object.assign(new EventEmitter(), {
    setNoDelay: () => {},
    _sock: { setKeepAlive: () => {}, writableEnded: false, destroy: () => {} },
    end: () => {},
  });

// An adapter in connection-per-poll mode whose first dial -- the exchange's own
// connect() -- succeeds and whose cycle-start re-dial rejects with `redialError`.
// The session is modeled by a flag the fixture's own dial sets, so a test can
// drop it the way a released or server-dropped session leaves the adapter.
function cyclingAdapter(redialError: () => Error) {
  const wrapper = {
    open: vi.fn(),
    close: vi.fn(),
    opendir: vi.fn(),
    readdir: vi.fn(),
    on: vi.fn(),
  };
  const session = { live: false };
  let dials = 0;
  const connect = vi.fn().mockImplementation(async () => {
    dials += 1;
    if (dials === 1) {
      session.live = true;
      return;
    }
    throw redialError();
  });
  const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
  const log = {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    error: vi.fn(),
  };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (adapter as any).log = log;
  (adapter as any).client = {
    get sftp() {
      return session.live ? wrapper : null;
    },
    connect,
    client: releasableClient(),
    end: vi.fn().mockResolvedValue(true),
    realPath: vi.fn().mockResolvedValue("/"),
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return { adapter, session, log, dials: () => dials };
}

type CyclingAdapter = ReturnType<typeof cyclingAdapter>;

// One poll cycle's start over a session that is gone: the exchange's connect(),
// then the idle boundary's release modeled by dropping the session, then the
// re-dial the poll loop drives at the next tick. `budget` is the operator's
// max_reconnect_attempts, which the re-dial inherits from the retained options.
async function redialAfterRelease(
  fixture: CyclingAdapter,
  budget: number,
): Promise<boolean | Error> {
  await fixture.adapter.connect({
    host: "sftp.example.org",
    maxReconnectAttempts: budget,
  });
  fixture.session.live = false;
  return fixture.adapter.ensureConnected().catch((error: Error) => error);
}

// The line the transient branch reports before skipping the cycle: its presence
// is what says a rejection was classified as transient, and its absence what says
// the cycle was never skipped at all.
const SKIPPED_CYCLE_WARNING = "skipping this poll cycle";

const warnedAboutASkippedCycle = (fixture: CyclingAdapter): boolean =>
  fixture.log.warn.mock.calls.some((call) =>
    (call[0] as string).includes(SKIPPED_CYCLE_WARNING),
  );

describe("a cycle-start re-dial into a key exchange this process cannot perform", () => {
  test("ends the exchange at once instead of skipping the cycle", async () => {
    forcedVerdict.unavailable = [MISSING];
    try {
      // A non-zero budget is what makes the dial count meaningful: neither the
      // dial's own retry loop nor the poll loop above it may spend anything on a
      // negotiation whose outcome this process's crypto provider has already
      // fixed.
      const fixture = cyclingAdapter(() => new Error(NEGOTIATION_FAILURE));
      const outcome = await redialAfterRelease(fixture, 3);

      // A rejection is what core's poll loop treats as terminal; `false` there
      // would be another skipped cycle, and another tick into the ceiling.
      expect(outcome).toBeInstanceOf(Error);
      expect(fixture.dials()).toBe(2);
      expect(warnedAboutASkippedCycle(fixture)).toBe(false);
    } finally {
      forcedVerdict.unavailable = [];
    }
  });

  test("includes the diagnostic naming the primitive, ssh2's error one link down", async () => {
    forcedVerdict.unavailable = [MISSING];
    try {
      // What the operator reads in place of the peer-silence error the ceiling
      // produced: the missing primitive, the remedy, and ssh2's own text still
      // reachable beneath it.
      const outcome = (await redialAfterRelease(
        cyclingAdapter(() => new Error(NEGOTIATION_FAILURE)),
        3,
      )) as Error;

      expect(outcome.message).toContain("X25519");
      expect(outcome.message).toContain("server's administrator");
      expect((outcome.cause as Error).message).toContain(
        "no matching key exchange algorithm",
      );
    } finally {
      forcedVerdict.unavailable = [];
    }
  });

  test("the same failure on a host that can perform everything skips the cycle", async () => {
    // The verdict is the whole condition here as at the connect loop: with
    // nothing unavailable the identical message is an ordinary dial failure, so a
    // server that writes the fragment through its own SSH_MSG_DISCONNECT
    // description ends no exchange. Budget 0 keeps this to the one re-dial.
    const fixture = cyclingAdapter(() => new Error(NEGOTIATION_FAILURE));
    const outcome = await redialAfterRelease(fixture, 0);

    expect(outcome).toBe(false);
    expect(warnedAboutASkippedCycle(fixture)).toBe(true);
  });

  test("a host-key rejection stays fatal, and keeps its own message", async () => {
    forcedVerdict.unavailable = [MISSING];
    try {
      // The classification that was already here, driven on a host missing the
      // primitive: the two coexist, and a possible MITM is not re-raised as a
      // key-exchange diagnostic.
      const outcome = (await redialAfterRelease(
        cyclingAdapter(() => new Error("Host denied (verification failed)")),
        3,
      )) as Error;

      expect(outcome).toBeInstanceOf(Error);
      expect(outcome.message).toContain("Host denied");
      expect(outcome.message).not.toContain("X25519");
    } finally {
      forcedVerdict.unavailable = [];
    }
  });

  test("an ordinary transient dial failure still skips the cycle", async () => {
    forcedVerdict.unavailable = [MISSING];
    try {
      // The verdict is a property of the process, not of the dial: a briefly
      // unreachable server must not become terminal on a host that happens to be
      // missing a primitive.
      const fixture = cyclingAdapter(() => new Error("connect ECONNREFUSED"));
      const outcome = await redialAfterRelease(fixture, 0);

      expect(outcome).toBe(false);
      expect(warnedAboutASkippedCycle(fixture)).toBe(true);
    } finally {
      forcedVerdict.unavailable = [];
    }
  });

  test("a dial the teardown settled reports nothing and skips, on such a host too", async () => {
    forcedVerdict.unavailable = [MISSING];
    try {
      // An abandoning teardown destroys the transport under a dial in flight, and
      // that rejection has the same error a genuine peer close does. This run
      // has no next tick to promise, so it stays silent -- and the verdict must
      // not turn the teardown's own doing into a reported failure.
      const fixture: CyclingAdapter = cyclingAdapter(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (fixture.adapter as any).session.beginClose();
        return new Error("Connection closed");
      });
      const outcome = await redialAfterRelease(fixture, 0);

      expect(outcome).toBe(false);
      expect(fixture.log.warn).not.toHaveBeenCalled();
    } finally {
      forcedVerdict.unavailable = [];
    }
  });
});
