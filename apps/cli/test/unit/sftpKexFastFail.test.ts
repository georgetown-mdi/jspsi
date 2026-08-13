import { describe, expect, test, vi } from "vitest";

import type { KexPrimitive } from "../../src/connection/sftpKexCapability";

// How the connect loop classifies a key-exchange negotiation that found nothing
// the two ends have in common: terminal on a process that cannot perform one of
// the primitives its offer needed, retryable everywhere else. The permanent case
// is permanent for the life of the process -- the capability verdict is memoized
// because a crypto provider is not swapped under a running program -- so a
// re-attempt puts the same withheld offer to the same server, and an operator who
// raised max_reconnect_attempts waits a second per attempt for the diagnostic the
// first attempt already had.
//
// The verdict is the whole condition, and these drive both of its values, because
// the message fragment alone cannot carry the classification: ssh2 renders a
// server's SSH_MSG_DISCONNECT description into the same message and a disconnect
// precedes host-key verification, so a server or an on-path attacker writes the
// fragment verbatim. What that party gets on a host that CAN perform everything
// ssh2 offers is the third case below -- the full reconnect budget, unchanged.
//
// What the offer itself looks like on the wire under the same forced verdict is
// driven in test/integration/sftpKexOffer.test.ts, which also drives this
// classification against a real OpenSSH sshd whose policy accepts nothing this
// process can perform.

const forcedVerdict = vi.hoisted(() => ({
  unavailable: [] as readonly KexPrimitive[],
}));

// Only the host VERDICT is replaced; the classification, the diagnostic, and the
// adapter are the real ones. Defaulting to "every primitive available" is what
// makes this seam neutral for a case that does not set it, and it is the reading
// any host running this suite supplies on its own.
vi.mock("../../src/connection/sftpKexCapability", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/connection/sftpKexCapability")
    >();
  return {
    ...actual,
    unavailableKexPrimitives: () => forcedVerdict.unavailable,
  };
});

const { SSH2SFTPClientAdapter } =
  await import("../../src/connection/ssh2SftpAdapter");

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

// The message ssh2-sftp-client surfaces when the two ends share no key-exchange
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

  test("still surfaces the diagnostic naming the primitive, ssh2's error one link down", async () => {
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
