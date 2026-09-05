import { describe, expect, test } from "vitest";

import {
  UsageError,
  BilateralModeMismatchError,
  FrameSizeExceededError,
  DirectoryListingBoundsError,
  TransportOperationStalledError,
  ConnectionClosedError,
  InternalConsistencyError,
  PeerAbortError,
  TransportPublishIndeterminateError,
  causeChainSome,
  isPeerWaitTimeout,
  markPeerWaitTimeout,
} from "../src/errors";

// The recovery step each of the three classes chains behind its summary: the
// first cause link, read off the error itself rather than restated here.
const recoveryStepOf = (err: Error): string =>
  (err.cause as Error | undefined)?.message ?? "";

// A two-error `cause` cycle whose links are counting accessors rather than plain
// properties: without a seen-set a walk never returns, which would hang the run
// instead of failing it, so the chain refuses to be read past its own length.
const countingCauseCycle = (): {
  outer: Error;
  readCount: () => number;
} => {
  let reads = 0;
  const outer = new Error("outer");
  const inner = new Error("inner");
  const link = (from: Error, to: Error): void => {
    Object.defineProperty(from, "cause", {
      configurable: true,
      get() {
        reads += 1;
        if (reads > 8)
          throw new Error("the cause chain was walked past its own length");
        return to;
      },
    });
  };
  link(outer, inner);
  link(inner, outer);
  return { outer, readCount: () => reads };
};

// These assertions guard the operator-facing-error audit: the terminal
// transport/directory UsageError family holds a recovery-hint tag and a
// concrete operator next step, so the CLI's hint-walker suppresses its
// generic "retry without re-inviting" advisory. Each test pins the tag, the
// call site's own message on `.message`, and a stable fragment of the step
// on its own cause link, plus the exit-64 classification (instanceof
// UsageError) neither may disturb -- the link's own budget is measured in
// test/transportRefusalBudget.test.ts.
describe("terminal transport/directory error taxonomy", () => {
  test("FrameSizeExceededError tags the recovery hint and puts a next step on its own link", () => {
    const err = new FrameSizeExceededError("inbound frame exceeds the cap");
    expect(err).toBeInstanceOf(UsageError);
    expect(err.name).toBe("FrameSizeExceededError");
    expect(err.psilinkRecoveryHintEmitted).toBe(true);
    expect(err.message).toBe("inbound frame exceeds the cap");
    expect(recoveryStepOf(err)).toContain("contact your partner");
  });

  test("DirectoryListingBoundsError tags the recovery hint and puts a next step on its own link", () => {
    const err = new DirectoryListingBoundsError(
      "directory has too many entries",
    );
    expect(err).toBeInstanceOf(UsageError);
    expect(err.name).toBe("DirectoryListingBoundsError");
    expect(err.psilinkRecoveryHintEmitted).toBe(true);
    expect(err.message).toBe("directory has too many entries");
    expect(recoveryStepOf(err)).toContain("dedicated to a single exchange");
  });

  test("TransportOperationStalledError tags the recovery hint and puts a next step on its own link", () => {
    const err = new TransportOperationStalledError("SFTP read stalled");
    expect(err).toBeInstanceOf(UsageError);
    expect(err.name).toBe("TransportOperationStalledError");
    expect(err.psilinkRecoveryHintEmitted).toBe(true);
    expect(err.message).toBe("SFTP read stalled");
    expect(recoveryStepOf(err)).toContain("then retry");
  });
});

describe("errors left without a recovery hint", () => {
  test("BilateralModeMismatchError stays untagged and leaves its message intact", () => {
    // A terminal UsageError that holds its fix in the call-site message ("both
    // parties must use the same setting"), so the constructor appends nothing.
    // It is not tagged, by design: the tag only suppresses the post-handshake
    // generic advisory, and a mismatch is detected pre-handshake where that
    // advisory never fires, so a tag would suppress nothing.
    const message =
      "retain_files mismatch: this party has retain_files=true but the peer " +
      "has retain_files=false; both parties must use the same setting";
    const err = new BilateralModeMismatchError(message);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.name).toBe("BilateralModeMismatchError");
    expect(
      (err as { psilinkRecoveryHintEmitted?: unknown })
        .psilinkRecoveryHintEmitted,
    ).toBeUndefined();
    expect(err.message).toBe(message);
  });

  test("ConnectionClosedError has no hint and is not a UsageError", () => {
    // Judged stepless by the audit: an internal teardown signal that almost
    // never reaches the exit code, so the generic advisory has nothing to
    // contradict and it stays a plain Error (CLI exit 69, not 64).
    const err = new ConnectionClosedError();
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UsageError);
    expect(
      (err as { psilinkRecoveryHintEmitted?: unknown })
        .psilinkRecoveryHintEmitted,
    ).toBeUndefined();
  });
});

describe("the internal fault's recovery hint", () => {
  test("InternalConsistencyError tags the hint on the class and stays a plain Error", () => {
    // The tag suppresses the CLI's generic "retry the exchange without
    // re-inviting" advisory at the raise site -- mid-data-exchange, after the
    // handshake rotated the secret. It sits on the CLASS because every
    // internal fault takes the same step, and the one raise site's message
    // states it (pinned in psiLink.test.ts). Not a UsageError: the boundary
    // maps this class to exit 70, not the 64 that would send the operator to
    // an input the single-pass ceiling gate already cleared.
    const err = new InternalConsistencyError(
      "server: single-pass built a reply of 4096 byte(s), above the 2048 " +
        "byte(s) both parties derive from their declared sizes. The exchange " +
        "cannot proceed; report it with this message.",
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UsageError);
    expect(err.name).toBe("InternalConsistencyError");
    expect(err.psilinkRecoveryHintEmitted).toBe(true);
  });
});

describe("errors whose recovery hint is per instance, not per class", () => {
  test("TransportPublishIndeterminateError sets no class-level tag and is not a UsageError", () => {
    // Not a UsageError, which the poll loop treats as terminal; what that
    // distinction buys is measured in fileSyncConnection.test.ts, not argued
    // here. The tag is absent from the CLASS because a transport raises this
    // for several publishes at once -- a message, an ack, a rendezvous hello,
    // an abort marker -- which share no recovery, so the transport's own
    // instance holds no next step and suppresses nothing. The one caller
    // whose recovery is established re-raises the class tagged and holding
    // it; that instance is pinned in fileSyncMessageLoop.test.ts.
    const cause = new Error("_rename: No such file or directory");
    const err = new TransportPublishIndeterminateError("publish torn", {
      cause,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UsageError);
    expect(err.name).toBe("TransportPublishIndeterminateError");
    expect(err.cause).toBe(cause);
    expect(
      (err as { psilinkRecoveryHintEmitted?: unknown })
        .psilinkRecoveryHintEmitted,
    ).toBeUndefined();
  });
});

describe("causeChainSome", () => {
  test("matches the value handed to it, with no cause to walk", () => {
    expect(
      causeChainSome(new TypeError("boom"), (e) => e instanceof TypeError),
    ).toBe(true);
  });

  test("walks through a non-Error link instead of stopping at it", () => {
    // The chain is followed on any object link, so a plain object interposed by
    // a wrapper that is not an Error cannot hide what it wraps.
    const inner = new TypeError("boom");
    const outer = { cause: { cause: inner } };

    expect(causeChainSome(outer, (e) => e instanceof TypeError)).toBe(true);
  });

  test("returns false for a non-object, without consulting the predicate", () => {
    let consulted = false;
    const predicate = (): boolean => {
      consulted = true;
      return true;
    };

    expect(causeChainSome("not an error", predicate)).toBe(false);
    expect(causeChainSome(null, predicate)).toBe(false);
    expect(causeChainSome(undefined, predicate)).toBe(false);
    expect(consulted).toBe(false);
  });

  test("stops on a cause cycle rather than walking it forever", () => {
    const { outer, readCount } = countingCauseCycle();

    expect(causeChainSome(outer, () => false)).toBe(false);
    expect(readCount()).toBe(2);
  });

  test("propagates a throwing cause accessor to the caller", () => {
    const outer = new Error("outer");
    Object.defineProperty(outer, "cause", {
      configurable: true,
      get() {
        throw new Error("cause accessor exploded");
      },
    });

    expect(() => causeChainSome(outer, () => false)).toThrow(
      "cause accessor exploded",
    );
  });
});

describe("isPeerWaitTimeout cause-chain walk", () => {
  test("finds the tag on an error two links down another error's cause", () => {
    // No path inside this package wraps a tagged error, so the chain walk is
    // exercised only from outside -- and a top-level property check passes every
    // other suite. This is the case that separates the two.
    const tagged = markPeerWaitTimeout(
      new Error("synchronization has timed out"),
    );
    const middle = new Error("the exchange failed", { cause: tagged });
    const outer = new Error("psilink exited", { cause: middle });

    expect(isPeerWaitTimeout(outer)).toBe(true);
    // The tag is the only own enumerable property markPeerWaitTimeout adds, and
    // it sits on the innermost error alone: neither wrapper holds one, so a
    // top-level read of the outer error finds nothing to answer with.
    expect(Object.keys(tagged)).toHaveLength(1);
    expect(Object.keys(outer)).toEqual([]);
    expect(Object.keys(middle)).toEqual([]);
  });

  test("returns false on a cause cycle rather than walking it forever", () => {
    // The composed predicate, not just the helper underneath it: an inlined walk
    // that dropped the seen-set would still pass every other test here and hang
    // only on a tagless cycle.
    const { outer, readCount } = countingCauseCycle();

    expect(isPeerWaitTimeout(outer)).toBe(false);
    expect(readCount()).toBe(2);
  });

  test("finds a tag that sits inside a cause cycle", () => {
    const tagged = markPeerWaitTimeout(
      new Error("synchronization has timed out"),
    );
    const outer = new Error("outer", { cause: tagged });
    (tagged as { cause?: unknown }).cause = outer;

    expect(isPeerWaitTimeout(outer)).toBe(true);
  });
});

describe("PeerAbortError exemplar (unchanged)", () => {
  test("still has the hint and its pinned partner-contact message", () => {
    // The audit's exemplar: its message is pinned by design and must not be
    // reworded. This guards against an accidental edit to the bar the rest rose
    // to meet.
    const err = new PeerAbortError();
    expect(err.name).toBe("PeerAbortError");
    expect(err.psilinkRecoveryHintEmitted).toBe(true);
    expect(err.message).toContain(
      "Contact your partner, who holds the specific error locally.",
    );
  });
});
