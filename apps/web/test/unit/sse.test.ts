import { describe, expect, test, vi } from "vitest";

import { createSSEStream } from "../../src/utils/sse.js";

describe("createSSEStream", () => {
  test("response has correct SSE headers", () => {
    const sse = createSSEStream();
    const response = sse.send();
    sse.close();

    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(response.headers.get("Connection")).toBe("keep-alive");
  });

  test("push() writes data in SSE wire format", async () => {
    const sse = createSSEStream();
    const response = sse.send();
    sse.push('{"hello":"world"}');
    sse.close();

    const text = await response.text();
    expect(text).toBe('data: {"hello":"world"}\n\n');
  });

  test("multiple push() calls produce sequential SSE events", async () => {
    const sse = createSSEStream();
    const response = sse.send();
    sse.push("first");
    sse.push("second");
    sse.close();

    const text = await response.text();
    expect(text).toBe("data: first\n\ndata: second\n\n");
  });

  test("onClosed() fires synchronously when close() is called", () => {
    const sse = createSSEStream();
    sse.send();
    const handler = vi.fn();
    sse.onClosed(handler);

    sse.close();

    expect(handler).toHaveBeenCalledOnce();
  });

  test("onClosed() fires when the reader cancels the stream", async () => {
    const sse = createSSEStream();
    const response = sse.send();
    const handler = vi.fn();
    sse.onClosed(handler);

    const reader = response.body!.getReader();
    await reader.cancel();

    expect(handler).toHaveBeenCalledOnce();
  });

  test("multiple onClosed() handlers all fire", () => {
    const sse = createSSEStream();
    sse.send();
    const h1 = vi.fn();
    const h2 = vi.fn();
    sse.onClosed(h1);
    sse.onClosed(h2);

    sse.close();

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  test("push() after close() is a no-op and does not throw", async () => {
    const sse = createSSEStream();
    const response = sse.send();
    sse.close();

    expect(() => sse.push("late")).not.toThrow();

    const text = await response.text();
    expect(text).toBe("");
  });

  test("close() after close() is a no-op and does not throw", () => {
    const sse = createSSEStream();
    sse.send();
    sse.close();

    expect(() => sse.close()).not.toThrow();
  });

  test("onClosed() does not fire a second time on double close()", () => {
    const sse = createSSEStream();
    sse.send();
    const handler = vi.fn();
    sse.onClosed(handler);

    sse.close();
    sse.close();

    expect(handler).toHaveBeenCalledOnce();
  });
});
