import { Readable } from "node:stream";

import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  FrameSizeExceededError,
  sanitizeErrorForDisplay,
  TransportOperationStalledError,
  UsageError,
} from "@psilink/core";

import {
  createCappedSink,
  frameSizeExceededError,
} from "../../../src/connection/frameSizeGuard";

// The renderer's own cause-link separator, read back out of a two-link render
// rather than restated here, so splitting a rendered chain into its links cannot
// drift from the framing the renderer emits.
const CAUSE_SEPARATOR = sanitizeErrorForDisplay(
  new Error("a", { cause: new Error("b") }),
).slice(1, -1);

const linksOf = (err: unknown): string[] =>
  sanitizeErrorForDisplay(err).split(CAUSE_SEPARATOR);

describe("frameSizeExceededError", () => {
  test("is a typed, terminal (UsageError) error", () => {
    const err = frameSizeExceededError("/p/x.bin", 100);
    expect(err).toBeInstanceOf(FrameSizeExceededError);
    // FrameSizeExceededError extends UsageError, which the CLI maps to exit 64
    // and the poll loop treats as terminal; both adapters must produce that.
    expect(err).toBeInstanceOf(UsageError);
  });

  test("includes the observed size when it is known up front (fstat path)", () => {
    const err = frameSizeExceededError("/p/x.bin", 100, 250);
    expect(err.message).toContain("is 250 bytes");
    expect(err.message).toContain("100 bytes");
    // The path is a fragment somebody else chose and reaches the operator on a
    // labelled link of its own, so the rendered chain is where it is read.
    expect(sanitizeErrorForDisplay(err)).toContain("inbound file: /p/x.bin");
  });

  test("omits the observed size on the streaming path", () => {
    const err = frameSizeExceededError("/p/x.bin", 100);
    expect(err.message).toContain(
      "exceeds the maximum frame size of 100 bytes",
    );
    expect(err.message).not.toMatch(/is \d+ bytes/);
  });

  // The path holds the peer-supplied filename from a get() call; a hostile
  // server must not be able to drive the operator's terminal through it.
  // Mirrors the sanitizeForDisplay categories.
  test("an ordinary path passes through unchanged", () => {
    const err = frameSizeExceededError("/drop/peer-7-42.json", 100, 250);
    expect(sanitizeErrorForDisplay(err)).toContain(
      "inbound file: /drop/peer-7-42.json",
    );
  });

  test("escapes control/ANSI characters in the path", () => {
    const err = frameSizeExceededError("/drop/\x1b[2J\x1b[31mEVIL.json", 100);
    expect(sanitizeErrorForDisplay(err)).not.toContain("\x1b");
    expect(sanitizeErrorForDisplay(err)).toContain("\\x1b");
  });

  test("escapes a newline so the path cannot spoof a log line", () => {
    const err = frameSizeExceededError("/drop/ok.json\nFAKE: clear", 100);
    // Read per link, not over the joined chain: the renderer's own cause
    // separator contains the one newline it emits, so the joined form would
    // fail on framing this test is not about. The same removal the CLI
    // integration console sentinel makes before it inspects a captured line.
    for (const link of linksOf(err)) expect(link).not.toContain("\n");
    expect(sanitizeErrorForDisplay(err)).toContain("\\x0a");
  });

  test("neutralizes deceptive Unicode (bidi-override) in the path", () => {
    const err = frameSizeExceededError("/drop/file\u202eEVIL.json", 100);
    expect(sanitizeErrorForDisplay(err)).not.toContain("\u202e");
    expect(sanitizeErrorForDisplay(err)).toContain("\\u202e");
  });

  test("neutralizes a homoglyph / confusable in the path", () => {
    // U+0430 (Cyrillic small a) renders identically to ASCII "a".
    const err = frameSizeExceededError("/drop/c\u0430fe.json", 100);
    expect(sanitizeErrorForDisplay(err)).not.toContain("\u0430");
    expect(sanitizeErrorForDisplay(err)).toContain("\\u0430");
  });

  test("fits a path bounded by nothing to the per-value budget", () => {
    // A get() names a file the peer chose, of no bounded length. Read on the
    // link as it RENDERS rather than off the builder's return, since a bound
    // held only inside the builder is one the escape at the boundary can still
    // overrun; the marker rides the same budget it was cut to, so a link that
    // spent it whole is one the operator can tell was cut.
    const link = linksOf(
      frameSizeExceededError("/drop/" + "p".repeat(100_000), 100),
    ).find((candidate) => candidate.startsWith("inbound file: "));

    expect(link).toBeDefined();
    expect(link).toContain(DISPLAY_TRUNCATION_MARKER);
    expect((link as string).length).toBeLessThanOrEqual(
      DEFAULT_MAX_DISPLAY_LENGTH,
    );
  });

  test("redacts the path before it clips it", () => {
    // Reversing the two leaves a BEGIN with its END clipped off, which the
    // renderer's own per-link pass then consumes to the end of the link --
    // taking the marker that said the path was cut with it. A key block wider
    // than the link's budget is what makes the two orders render differently.
    const block =
      "-----BEGIN OPENSSH PRIVATE KEY-----" +
      "k".repeat(4 * DEFAULT_MAX_DISPLAY_LENGTH) +
      "-----END OPENSSH PRIVATE KEY-----";

    expect(
      linksOf(frameSizeExceededError(`${block}/message.json`, 100)),
    ).toContain("inbound file: [redacted private key]/message.json");
  });
});

describe("createCappedSink", () => {
  test("resolves with the concatenated bytes for an under-cap transfer", async () => {
    const { sink, result, complete } = createCappedSink("/p/ok.bin", 32);
    sink.write(Buffer.from("hel"));
    sink.write(Buffer.from("lo"));
    complete();
    expect((await result).toString()).toBe("hello");
  });

  test("rejects with FrameSizeExceededError the instant the cap is crossed", async () => {
    // No external 'error' listener is attached: createCappedSink attaches its
    // own no-op listener, so the cap-fire (which fails the write callback and
    // makes the Writable emit 'error') is handled rather than crashing the
    // process as an unhandled event.
    const { sink, result } = createCappedSink("/p/big.bin", 32);
    sink.write(Buffer.alloc(20)); // under cap: retained
    sink.write(Buffer.alloc(20)); // crosses cap: rejects `result` at detection
    await expect(result).rejects.toBeInstanceOf(FrameSizeExceededError);
  });

  test("the over-cap rejection wins even if complete() is called afterward", async () => {
    // Models the resolve-vs-reject race: the underlying get() resolves (which
    // would call complete()) after the cap already fired. The cap must win.
    const { sink, result, complete } = createCappedSink("/p/big.bin", 32);
    sink.write(Buffer.alloc(40)); // crosses cap
    complete(); // late completion is a no-op once `result` has settled
    await expect(result).rejects.toBeInstanceOf(FrameSizeExceededError);
  });

  test("fail() exposes a genuine transport error when the cap never fires", async () => {
    const { result, fail } = createCappedSink("/p/x.bin", 32);
    const transportErr = new Error("connection reset");
    fail(transportErr);
    await expect(result).rejects.toBe(transportErr);
  });

  test("a late fail() cannot overwrite an over-cap rejection", async () => {
    const { sink, result, fail } = createCappedSink("/p/big.bin", 32);
    sink.write(Buffer.alloc(40)); // crosses cap: `result` rejects now
    fail(new Error("generic transport error")); // no-op after settle
    await expect(result).rejects.toBeInstanceOf(FrameSizeExceededError);
  });

  test("rejects with a terminal TransportOperationStalledError when the transfer goes idle", async () => {
    // The liveness bound: a server that opens the stream but withholds data (no
    // write ever arrives) is failed by the idle deadline, since the size cap
    // never fires when no bytes accumulate. The error is terminal (a UsageError)
    // so the poll loop fails the exchange rather than retrying into the hang.
    vi.useFakeTimers();
    try {
      const { result } = createCappedSink("/p/silent.bin", 32, 1_000);
      const assertion = expect(result).rejects.toBeInstanceOf(
        TransportOperationStalledError,
      );
      await vi.advanceTimersByTimeAsync(1_001);
      await assertion;
      await expect(result).rejects.toBeInstanceOf(UsageError);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the idle stall tears down the upstream read stream, not just the sink", async () => {
    // Regression: the idle path must destroy the sink WITH an error, not just
    // close it -- ssh2-sftp-client's get(path, dst) tears down the upstream
    // read stream only when its promise rejects via the sink's 'error' event,
    // not 'close'. Models that wiring (pipe a real Readable in; tear it down
    // on the sink's 'error') and asserts the source is destroyed once the idle
    // deadline fires.
    vi.useFakeTimers();
    try {
      const { sink, result } = createCappedSink("/p/stall.bin", 32, 1_000);
      // A read stream that opens but never delivers data -- the withheld-transfer
      // DoS the idle bound exists to catch.
      const source = new Readable({ read() {} });
      source.on("error", () => {});
      sink.on("error", () => source.destroy());
      source.pipe(sink);

      const assertion = expect(result).rejects.toBeInstanceOf(
        TransportOperationStalledError,
      );
      await vi.advanceTimersByTimeAsync(1_001);
      await assertion;
      // The sink was destroyed with an error (the trigger for ssh2's upstream
      // teardown), which here propagated to the modeled read stream.
      expect(sink.errored).toBeInstanceOf(Error);
      expect(source.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a chunk resets the idle window, so a still-progressing transfer is not stalled", async () => {
    // The idle timer resets on each write: a transfer that delivers a chunk
    // before the window elapses and then completes is not failed, even though
    // the wall-clock span from creation to completion exceeds the window.
    vi.useFakeTimers();
    try {
      const { sink, result, complete } = createCappedSink(
        "/p/slow.bin",
        32,
        1_000,
      );
      await vi.advanceTimersByTimeAsync(800); // under the window
      sink.write(Buffer.from("hi")); // progress: resets the idle window
      await vi.advanceTimersByTimeAsync(800); // under the window again (1600 total)
      complete();
      expect((await result).toString()).toBe("hi");
    } finally {
      vi.useRealTimers();
    }
  });
});
