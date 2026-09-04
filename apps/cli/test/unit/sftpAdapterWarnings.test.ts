import { describe, expect, test } from "vitest";

import {
  TransportOperationStalledError,
  TransportPublishIndeterminateError,
  UsageError,
  sanitizeErrorForDisplay,
} from "@psilink/core";

import {
  SFTP_SESSION_CLOSED_MESSAGE,
  cycleRedialDeclinedWarning,
  deadSessionOperationError,
  forcedIdleReleaseWarning,
  idleReleaseDeclinedWarning,
  idleReleaseDidNotCloseWarning,
  indeterminatePublishError,
  midExchangeReconnectBudgetExhaustedError,
  partnerDropAtIdleBoundaryWarning,
  remainingMidExchangeRedials,
  sessionRecoveredEphemeralWarning,
  sessionRecoveredHeldWarning,
  transitionWaitExpiredError,
  unreadableTransportLifecycleWarning,
} from "../../src/connection/sftpAdapterWarnings";

// The TEXT of the SFTP adapter's operator-facing warnings and typed errors: what
// each builder renders at every variant boundary, and the ESCAPING ALTITUDE each
// composes at.
//
// Nothing here reaches ssh2 or a server, and nothing here pins a latch or a
// cadence: which condition fires a line, how often it repeats, and which counter
// it reads are the adapter's and the ledger's, and stay pinned in
// ssh2SftpAdapter.test.ts. What that leaves for this file is the two properties a
// behavioural test reads through rather than states -- the singular/plural and
// mode pivots a count or a budget swings the sentence on, and which altitude a
// fragment is escaped at.
//
// The altitude rule is CONTRIBUTING.md's (Code Conventions): a fragment
// interpolated into an `Error` message or `cause` is composed RAW, because
// sanitizeErrorForDisplay escapes the whole rendered chain once where it is
// shown; a value reaching a `log.*` sink without ever becoming an `Error` is
// escaped with sanitizeForDisplay AT that call site. Escaping at both doubles a
// literal backslash on every pass, so one backslash in a partner filename would
// reach the operator as four.

// Every link of a composed error's cause chain, unrendered: what the builder
// actually put in the error, before any display sink has escaped it.
const rawChain = (err: unknown): string => {
  const links: string[] = [];
  let current: unknown = err;
  while (typeof current === "object" && current !== null) {
    links.push(String((current as { message?: unknown }).message ?? ""));
    current = (current as { cause?: unknown }).cause;
  }
  return links.join("\n");
};

// A fragment carrying both treatments the double-escape rule is about: a literal
// backslash (doubled by every pass of sanitizeForDisplay) and a control character
// (which one pass renders as an escape of its own).
const HOSTILE_FRAGMENT = "/remote/a\\b\u001b[31m-ack.json";
// The same fragment after exactly one pass: the backslash doubled once, the ESC
// rendered once.
const ESCAPED_ONCE = "/remote/a\\\\b\\x1b[31m-ack.json";
// What a second pass over the first would produce, and what must never appear.
const ESCAPED_TWICE = "/remote/a\\\\\\\\b\\\\x1b[31m-ack.json";

// The warning builders, which take counters and a first-party bound and nothing
// else. Hand-listed: a builder added to the module joins the sweep below only
// once its row is added here, so add the row with the builder.
const WARNING_BUILDERS: ReadonlyArray<
  readonly [string, (n: number) => string]
> = [
  [
    "sessionRecoveredEphemeralWarning",
    (n) => sessionRecoveredEphemeralWarning(n),
  ],
  ["sessionRecoveredHeldWarning", (n) => sessionRecoveredHeldWarning(n, 3)],
  [
    "unreadableTransportLifecycleWarning",
    () => unreadableTransportLifecycleWarning(1_000),
  ],
  ["idleReleaseDeclinedWarning", (n) => idleReleaseDeclinedWarning(n, 10_000)],
  ["idleReleaseDidNotCloseWarning", () => idleReleaseDidNotCloseWarning()],
  [
    "partnerDropAtIdleBoundaryWarning",
    (n) => partnerDropAtIdleBoundaryWarning(n),
  ],
  ["forcedIdleReleaseWarning", (n) => forcedIdleReleaseWarning(n)],
  ["cycleRedialDeclinedWarning", (n) => cycleRedialDeclinedWarning(n, 10_000)],
];

describe("the closed-session refusal", () => {
  test("names the drop, its likely cause, and that the operation cannot run", () => {
    expect(SFTP_SESSION_CLOSED_MESSAGE).toBe(
      "SFTP session is not open: the connection was closed or dropped after a " +
        "successful connect (typically a server idle or session-time-limit " +
        "policy, or a network drop), so this operation cannot run.",
    );
  });
});

describe("the abandoned transition's rejection", () => {
  test("names the kind that gave up, the bound, and that nothing was dialed", () => {
    expect(transitionWaitExpiredError("connect", 10_000).message).toBe(
      "this SFTP connection's connect waited 10000 ms for the session " +
        "transition ahead of it and gave up: a dial cannot run alongside " +
        "another transition on the one shared client, so nothing was dialed. " +
        "Open a new connection to retry.",
    );
  });

  test("takes the bound as an input rather than reading one", () => {
    expect(transitionWaitExpiredError("teardown", 250).message).toContain(
      "this SFTP connection's teardown waited 250 ms",
    );
  });
});

describe("the dead-session refusal", () => {
  test("names the fatal protocol error, the path, and the server's own report", () => {
    const err = deadSessionOperationError(
      "file read",
      "/remote/id-msg.json",
      "Unexpected packet before version",
    );
    expect(err).toBeInstanceOf(TransportOperationStalledError);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toBe(
      "SFTP file read stalled; refusing to wait on the server further",
    );
    const chain = rawChain(err);
    expect(chain).toContain(
      "how the file read stalled: the SFTP session was killed by a fatal " +
        "server protocol error",
    );
    expect(chain).toContain("stalled file read path: /remote/id-msg.json");
    expect(chain).toContain(
      "error the server reported: Unexpected packet before version",
    );
  });

  test("composes the path and the server's report RAW, escaped once at the sink", () => {
    // Altitude: an Error, so both partner-reachable fragments go in unescaped and
    // sanitizeErrorForDisplay escapes the whole rendered chain once. Escaping
    // inside the builder as well would double the backslash.
    const err = deadSessionOperationError(
      "file read",
      HOSTILE_FRAGMENT,
      HOSTILE_FRAGMENT,
    );
    expect(rawChain(err)).toContain(
      `stalled file read path: ${HOSTILE_FRAGMENT}`,
    );
    expect(rawChain(err)).toContain(
      `error the server reported: ${HOSTILE_FRAGMENT}`,
    );
    const rendered = sanitizeErrorForDisplay(err);
    expect(rendered).toContain(ESCAPED_ONCE);
    expect(rendered).not.toContain(ESCAPED_TWICE);
    expect(rendered).not.toContain("\u001b");
  });
});

describe("the exhausted mid-exchange reconnection budget", () => {
  test("states the exhaustion in sessions lost, singular at one", () => {
    expect(midExchangeReconnectBudgetExhaustedError(1, 1).message).toContain(
      "the mid-exchange reconnection budget is exhausted: 1 session lost over " +
        "the whole exchange against a max_reconnect_attempts=1 budget",
    );
  });

  test("pluralizes the sessions lost past one", () => {
    expect(midExchangeReconnectBudgetExhaustedError(3, 3).message).toContain(
      "the mid-exchange reconnection budget is exhausted: 3 sessions lost over " +
        "the whole exchange against a max_reconnect_attempts=3 budget",
    );
  });

  test("a budget of zero names the first drop terminal instead of an allowance spent", () => {
    // There is no allowance to describe as spent, so quoting one would
    // misdescribe an exchange that never reconnected at all.
    const message = midExchangeReconnectBudgetExhaustedError(1, 0).message;
    expect(message).toContain(
      "max_reconnect_attempts=0 permits no mid-exchange reconnection, so this " +
        "first drop is terminal and the exchange cannot continue",
    );
    expect(message).not.toContain("budget is exhausted");
    expect(message).not.toContain("1 session lost");
  });

  test("is terminal, and names both remedies by their operator-reachable names", () => {
    const err = midExchangeReconnectBudgetExhaustedError(2, 2);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toContain("Raise max_reconnect_attempts");
    expect(err.message).toContain("--connection-per-poll");
    expect(err.message).toContain("connection_per_poll: true");
  });
});

describe("the remaining-redials reading", () => {
  test("is the budget less the losses charged so far", () => {
    expect(remainingMidExchangeRedials(3, 1)).toBe(2);
    expect(remainingMidExchangeRedials(3, 3)).toBe(0);
  });

  test("clamps at zero rather than reporting a negative allowance", () => {
    // The budget bounds sessions LOST, and a teardown-exempt or unbudgeted loss
    // can carry the tally past it; the line that reads this must still say the
    // last re-dial has been spent rather than quoting a negative.
    expect(remainingMidExchangeRedials(3, 5)).toBe(0);
    expect(remainingMidExchangeRedials(0, 1)).toBe(0);
  });
});

describe("the recovered-session line, connection-per-poll", () => {
  test("counts the sessions lost, singular at one", () => {
    expect(sessionRecoveredEphemeralWarning(1)).toContain(
      "was transparently re-dialed (1 session lost to the partner so far this " +
        "exchange); the exchange continues.",
    );
  });

  test("pluralizes them past one", () => {
    expect(sessionRecoveredEphemeralWarning(4)).toContain(
      "was transparently re-dialed (4 sessions lost to the partner so far this " +
        "exchange); the exchange continues.",
    );
  });

  test("reads the re-dial as this mode working, uncharged and unbudgeted", () => {
    // The split from the held-session line: same drop, different cause, remedy
    // and bound, so neither line's reading appears in the other.
    const message = sessionRecoveredEphemeralWarning(1);
    expect(message).toContain(
      "The rendezvous case needs nothing from you: the re-dial is this mode " +
        "working and the exchange survives the cap.",
    );
    expect(message).toContain(
      "These re-dials are not charged against max_reconnect_attempts",
    );
    expect(message).toContain("(peer_timeout_ms)");
    expect(message).not.toContain("--connection-per-poll");
    expect(message).not.toContain("max_reconnect_attempts=");
  });
});

describe("the recovered-session line, held session", () => {
  test("the first drop reads as one drop rather than a running total", () => {
    expect(sessionRecoveredHeldWarning(1, 3)).toContain(
      "The SFTP session dropped mid-exchange and was transparently re-dialed; " +
        "the exchange continues.",
    );
  });

  test("a later drop reads as the running total it is", () => {
    expect(sessionRecoveredHeldWarning(2, 3)).toContain(
      "The SFTP session has now dropped mid-exchange 2 times this exchange; " +
        "this drop was transparently re-dialed and the exchange continues.",
    );
  });

  test("states the budget left, pluralized past one further re-dial", () => {
    expect(sessionRecoveredHeldWarning(1, 3)).toContain(
      "2 further mid-exchange re-dials are allowed by max_reconnect_attempts=3 " +
        "before the exchange fails.",
    );
    expect(sessionRecoveredHeldWarning(2, 3)).toContain(
      "1 further mid-exchange re-dial is allowed by max_reconnect_attempts=3 " +
        "before the exchange fails.",
    );
  });

  test("the last permitted re-dial says so rather than counting zero of them", () => {
    const message = sessionRecoveredHeldWarning(3, 3);
    expect(message).toContain(
      "That was the last re-dial allowed by max_reconnect_attempts=3: the next " +
        "mid-exchange drop ends the exchange.",
    );
    expect(message).not.toContain("0 further mid-exchange re-dial");
  });

  test("names the mode switch as the real fix and the poll interval as conditional", () => {
    const message = sessionRecoveredHeldWarning(1, 3);
    expect(message).toContain(
      "--connection-per-poll, which dials a fresh session each poll cycle " +
        "instead of holding one, is the real fix for that case",
    );
    expect(message).toContain(
      "a longer poll interval (--polling-frequency) helps only if the server " +
        "is instead reacting to how often this exchange queries it",
    );
  });
});

describe("the unreadable transport lifecycle", () => {
  test("names what it costs and what the operator can do about it", () => {
    const message = unreadableTransportLifecycleWarning(1_000);
    expect(message).toContain(
      "closes it from this side first and waits up to 1000 ms for that " +
        "close, even on a connection that had already closed",
    );
    expect(message).toContain(
      "does not fully support the installed SFTP library",
    );
    expect(message).toContain("The exchange still completes.");
    expect(message).toContain("https://github.com/georgetown-mdi/jspsi/issues");
    // The ssh2 reading behind it is contributor-tier detail, logged at debug by
    // the adapter rather than put on the operator's terminal.
    expect(message).not.toContain("ssh2's client.on()");
    expect(message).not.toContain("docs/spec/DEPENDENCY_PINS.md");
  });
});

describe("the idle boundary that closed nothing", () => {
  test("the declined release names the bound and counts the boundaries, singular at one", () => {
    expect(idleReleaseDeclinedWarning(1, 10_000)).toContain(
      "did not complete within the release's 10000 ms wait, and closing the " +
        "session alongside it would corrupt the one shared client.",
    );
    expect(idleReleaseDeclinedWarning(1, 10_000)).toContain(
      "(1 idle boundary released nothing this way so far this exchange).",
    );
  });

  test("the declined release pluralizes the boundaries past one", () => {
    expect(idleReleaseDeclinedWarning(6, 10_000)).toContain(
      "(6 idle boundaries released nothing this way so far this exchange).",
    );
  });

  test("the release that ended no transport carries no count and names the ssh2 changelog", () => {
    // The one degraded outcome with no run total, so it has no pivot to swing on.
    expect(idleReleaseDidNotCloseWarning()).toBe(
      "The connection-per-poll idle release did not close the SFTP session " +
        "and its transport is still writable, which the ssh2 client's end() " +
        "should have ended: the session may still be live and held across " +
        "this idle gap, which is the one thing this mode exists to prevent. " +
        "Check the ssh2 changelog.",
    );
  });
});

describe("the partner's drop at an idle boundary", () => {
  test("counts the boundaries it met, singular at one", () => {
    expect(partnerDropAtIdleBoundaryWarning(1)).toContain(
      "(1 idle boundary met a session the partner had already ended so far " +
        "this exchange).",
    );
  });

  test("pluralizes them past one", () => {
    expect(partnerDropAtIdleBoundaryWarning(5)).toContain(
      "(5 idle boundaries met a session the partner had already ended so far " +
        "this exchange).",
    );
  });

  test("is not the recovery line's wording: nothing was re-dialed here", () => {
    const message = partnerDropAtIdleBoundaryWarning(1);
    expect(message).not.toContain("transparently");
    expect(message).toContain(
      "these sessions are not charged against max_reconnect_attempts.",
    );
  });
});

describe("the forced idle release", () => {
  test("counts the boundaries closed from this side, singular at one", () => {
    expect(forcedIdleReleaseWarning(1)).toContain(
      "(1 idle boundary closed this way so far this exchange).",
    );
  });

  test("pluralizes them past one", () => {
    expect(forcedIdleReleaseWarning(2)).toContain(
      "(2 idle boundaries closed this way so far this exchange).",
    );
  });
});

describe("the declined cycle-start re-dial", () => {
  test("names the bound and counts the cycles skipped, singular at one", () => {
    expect(cycleRedialDeclinedWarning(1, 10_000)).toContain(
      "did not complete within the re-dial's 10000 ms wait, and dialing " +
        "alongside it would corrupt the one shared client",
    );
    expect(cycleRedialDeclinedWarning(1, 10_000)).toContain(
      "(1 cycle skipped this way so far this exchange)",
    );
  });

  test("pluralizes the cycles past one", () => {
    expect(cycleRedialDeclinedWarning(3, 10_000)).toContain(
      "(3 cycles skipped this way so far this exchange)",
    );
  });
});

describe("the undetermined publish", () => {
  test("leads with the sentence to act on and trails the destination", () => {
    const err = indeterminatePublishError(
      new Error("_rename: No such file or directory"),
      "/remote/id-hello.json",
    );
    expect(err).toBeInstanceOf(TransportPublishIndeterminateError);
    expect(err.message).toBe(
      "the publish may or may not have reached the partner: it was cut off " +
        "mid-operation and could not be confirmed afterwards. " +
        "Destination: /remote/id-hello.json",
    );
  });

  test("carries the re-issue's own error only as the cause", () => {
    const cause = new Error("_rename: No such file or directory");
    const err = indeterminatePublishError(cause, "/remote/id-hello.json");
    expect(err.cause).toBe(cause);
    expect(err.message).not.toContain("_rename");
  });

  test("composes the destination RAW, escaped once at the sink", () => {
    // Altitude: an Error, so the partner-derived destination goes in unescaped
    // and the display sink escapes the rendered chain once.
    const err = indeterminatePublishError(new Error("torn"), HOSTILE_FRAGMENT);
    expect(err.message).toContain(`Destination: ${HOSTILE_FRAGMENT}`);
    const rendered = sanitizeErrorForDisplay(err);
    expect(rendered).toContain(ESCAPED_ONCE);
    expect(rendered).not.toContain(ESCAPED_TWICE);
    expect(rendered).not.toContain("\u001b");
  });
});

describe("the escaping altitude every warning builder composes at", () => {
  // The warning builders take counters and a first-party bound and nothing else,
  // so no untrusted fragment can reach a log sink through one of them and none
  // escapes anything: a fragment given to one later has to arrive already escaped
  // by the call site that is its sink. The runtime half of that, which a
  // signature alone cannot state, is that no rendering introduces a byte the
  // console sentinel would fail on, nor a backslash a later pass could double.
  test.each(WARNING_BUILDERS)(
    "%s renders printable ASCII with no escape of its own",
    (_name, render) => {
      for (const count of [0, 1, 2, 7, 1_000]) {
        const message = render(count);
        expect(message).toMatch(/^[ -~]+$/);
        expect(message).not.toContain("\\");
      }
    },
  );
});
