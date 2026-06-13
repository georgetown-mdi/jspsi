import { describe, expect, test, vi } from "vitest";

import {
  PEERJS_ERRORS_ONLY,
  createRedactingLogFunction,
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

  test("passes non-id content through unchanged", () => {
    const sink = makeSink();
    const logFn = createRedactingLogFunction([SAMPLE_ID], sink);

    logFn(3, "ICE candidate gathered", 42, { state: "connected" });

    expect(sink.log).toHaveBeenCalledWith(
      "PeerJS:",
      "ICE candidate gathered",
      42,
      { state: "connected" },
    );
  });
});
