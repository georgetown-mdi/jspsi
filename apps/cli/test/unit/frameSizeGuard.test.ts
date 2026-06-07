import { describe, expect, test } from "vitest";
import { FrameSizeExceededError, UsageError } from "@psilink/core";

import {
  createCappedSink,
  frameSizeExceededError,
} from "../../src/connection/frameSizeGuard";

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
    expect(err.message).toContain("/p/x.bin");
    expect(err.message).toContain("is 250 bytes");
    expect(err.message).toContain("100 bytes");
  });

  test("omits the observed size on the streaming path", () => {
    const err = frameSizeExceededError("/p/x.bin", 100);
    expect(err.message).toContain(
      "exceeds the maximum frame size of 100 bytes",
    );
    expect(err.message).not.toMatch(/is \d+ bytes/);
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

  test("fail() surfaces a genuine transport error when the cap never fires", async () => {
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
});
