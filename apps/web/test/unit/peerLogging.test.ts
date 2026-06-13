import { describe, expect, test, vi } from "vitest";

import {
  PEERJS_ERRORS_ONLY,
  createRedactingLogFunction,
  redactErrorIds,
  resolvePeerDebugLevel,
} from "../../src/psi/peerLogging.js";

// A 32-hex-char string in the shape deriveRendezvousPeerId produces.
const SAMPLE_ID = "0123456789abcdef0123456789abcdef";
const OTHER_ID = "fedcba9876543210fedcba9876543210";

function makeSink() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Every argument any sink method received, flattened and stringified, so a test
 * can assert an id appears nowhere in what reached the console. */
function allSinkOutput(sink: ReturnType<typeof makeSink>): string {
  return [
    ...sink.log.mock.calls,
    ...sink.warn.mock.calls,
    ...sink.error.mock.calls,
  ]
    .flat()
    .map((arg) => JSON.stringify(arg))
    .join(" ");
}

describe("resolvePeerDebugLevel", () => {
  test("leaves the configured base unchanged when not diagnosing", () => {
    expect(resolvePeerDebugLevel(PEERJS_ERRORS_ONLY, false)).toBe(
      PEERJS_ERRORS_ONLY,
    );
  });

  test("raises to the most verbose level when diagnosing", () => {
    expect(resolvePeerDebugLevel(PEERJS_ERRORS_ONLY, true)).toBe(3);
  });

  test("never lowers below a base already above errors-only", () => {
    expect(resolvePeerDebugLevel(3, false)).toBe(3);
    expect(resolvePeerDebugLevel(2, true)).toBe(3);
  });

  test("falls back to errors-only for an out-of-range or non-integer base", () => {
    // NaN would otherwise reach PeerJS as `NaN || 0` and disable all logging.
    expect(resolvePeerDebugLevel(NaN, false)).toBe(PEERJS_ERRORS_ONLY);
    expect(resolvePeerDebugLevel(NaN, true)).toBe(3);
    expect(resolvePeerDebugLevel(-1, false)).toBe(PEERJS_ERRORS_ONLY);
    expect(resolvePeerDebugLevel(2.5, false)).toBe(PEERJS_ERRORS_ONLY);
    expect(resolvePeerDebugLevel(99, false)).toBe(PEERJS_ERRORS_ONLY);
    // A valid explicit 0 (Disabled) is honored.
    expect(resolvePeerDebugLevel(0, false)).toBe(0);
  });
});

describe("createRedactingLogFunction", () => {
  test("redacts a peer id interpolated into a warning string", () => {
    const sink = makeSink();
    const logFn = createRedactingLogFunction([SAMPLE_ID], sink);

    logFn(2, `You received a malformed message from ${SAMPLE_ID} of type X`);

    expect(sink.warn).toHaveBeenCalledTimes(1);
    const printed = sink.warn.mock.calls[0].join(" ");
    expect(printed).not.toContain(SAMPLE_ID);
    expect(printed).toContain("[redacted-peer-id]");
  });

  test("redacts a peer id passed as its own argument", () => {
    const sink = makeSink();
    const logFn = createRedactingLogFunction([SAMPLE_ID], sink);

    logFn(2, "Unrecognized message type:", "OFFER", "from peer:", SAMPLE_ID);

    expect(allSinkOutput(sink)).not.toContain(SAMPLE_ID);
  });

  test("redacts a peer id inside an Error message", () => {
    const sink = makeSink();
    const logFn = createRedactingLogFunction([SAMPLE_ID], sink);

    logFn(1, new Error(`connection to ${SAMPLE_ID} failed`));

    expect(sink.error).toHaveBeenCalledTimes(1);
    expect(allSinkOutput(sink)).not.toContain(SAMPLE_ID);
  });

  test("redacts a peer id buried in a structured message object", () => {
    const sink = makeSink();
    const logFn = createRedactingLogFunction([SAMPLE_ID, OTHER_ID], sink);

    logFn(3, "You received an unrecognized message:", {
      type: "OFFER",
      src: SAMPLE_ID,
      payload: { connectionId: OTHER_ID },
    });

    expect(allSinkOutput(sink)).not.toContain(SAMPLE_ID);
    expect(allSinkOutput(sink)).not.toContain(OTHER_ID);
  });

  test("redacts a peer id in an object passed as two separate arguments", () => {
    const sink = makeSink();
    const logFn = createRedactingLogFunction([SAMPLE_ID], sink);

    // The same reference twice: a cycle-guard shared across arguments would
    // return the second occurrence unredacted.
    const arg = { src: SAMPLE_ID };
    logFn(3, arg, arg);

    expect(allSinkOutput(sink)).not.toContain(SAMPLE_ID);
  });

  test("redacts a peer id in a cyclic object without leaking the original", () => {
    const sink = makeSink();
    const logFn = createRedactingLogFunction([SAMPLE_ID], sink);

    const cyclic: Record<string, unknown> = { src: SAMPLE_ID };
    cyclic.self = cyclic;
    logFn(3, cyclic);

    expect(allSinkOutput(sink)).not.toContain(SAMPLE_ID);
  });

  test("routes each level to the matching console method", () => {
    const sink = makeSink();
    const logFn = createRedactingLogFunction([], sink);

    logFn(3, "verbose");
    logFn(2, "warning");
    logFn(1, "error");

    expect(sink.log).toHaveBeenCalledTimes(1);
    expect(sink.warn).toHaveBeenCalledTimes(1);
    expect(sink.error).toHaveBeenCalledTimes(1);
  });

  test("level 0 (Disabled) prints nothing", () => {
    const sink = makeSink();
    const logFn = createRedactingLogFunction([], sink);

    logFn(0, "should not print");

    expect(sink.log).not.toHaveBeenCalled();
    expect(sink.warn).not.toHaveBeenCalled();
    expect(sink.error).not.toHaveBeenCalled();
  });

  test("passes non-id content through unchanged and preserves structure", () => {
    const sink = makeSink();
    const logFn = createRedactingLogFunction([SAMPLE_ID], sink);

    logFn(3, "ICE candidate gathered", 42, {
      state: "connected",
      src: SAMPLE_ID,
    });

    // Non-id content survives; the surrounding structure is preserved, only the
    // id is replaced (guards against a regression that over-redacts or flattens).
    expect(sink.log).toHaveBeenCalledWith(
      "PeerJS:",
      "ICE candidate gathered",
      42,
      {
        state: "connected",
        src: "[redacted-peer-id]",
      },
    );
  });

  test("never throws into the caller, and never prints the raw value, on a throwing getter", () => {
    const sink = makeSink();
    const logFn = createRedactingLogFunction([SAMPLE_ID], sink);
    const hostile = {
      get peer(): string {
        throw new Error("boom");
      },
    };

    expect(() => logFn(2, hostile)).not.toThrow();
    expect(sink.warn).toHaveBeenCalledTimes(1);
    expect(sink.warn).toHaveBeenCalledWith("PeerJS WARNING:", "[unredactable]");
  });
});

describe("redactErrorIds", () => {
  test("redacts ids from an Error's message and stack, in place", () => {
    const err = new Error(`ID "${SAMPLE_ID}" is taken`);
    const result = redactErrorIds(err, [SAMPLE_ID]);

    expect(result).toBe(err);
    expect(err.message).not.toContain(SAMPLE_ID);
    expect(err.message).toContain("[redacted-peer-id]");
    expect(err.stack ?? "").not.toContain(SAMPLE_ID);
  });

  test("preserves a control discriminant the error carries", () => {
    const err = Object.assign(new Error(`from peer:${SAMPLE_ID}`), {
      type: "peer-unavailable",
    });
    redactErrorIds(err, [SAMPLE_ID]);

    expect((err as { type: string }).type).toBe("peer-unavailable");
    expect(err.message).not.toContain(SAMPLE_ID);
  });

  test("passes a non-Error value through unchanged", () => {
    const obj = { type: "network" };
    expect(redactErrorIds(obj, [SAMPLE_ID])).toBe(obj);
    expect(redactErrorIds("plain", [SAMPLE_ID])).toBe("plain");
  });

  test("fails closed on a frozen error: no throw, no leaked id", () => {
    // Assigning to a frozen error's message throws a TypeError that re-embeds the
    // original message; the helper must catch that and return a redacted error,
    // never let the id-bearing TypeError escape.
    const err = Object.freeze(new Error(`ID "${SAMPLE_ID}" is taken`));
    let result: unknown;
    expect(() => {
      result = redactErrorIds(err, [SAMPLE_ID]);
    }).not.toThrow();
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).not.toContain(SAMPLE_ID);
    expect((result as Error).message).toContain("[redacted-peer-id]");
  });
});
