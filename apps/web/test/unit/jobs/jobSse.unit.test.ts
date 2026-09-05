import { describe, expect, test } from "vitest";

import {
  SSE_KEEPALIVE_FRAME,
  createJobEventStream,
  renderSseFrame,
  resumeOffsetFrom,
} from "@jobs/sse";

import type { BufferedEvent, JobRecord } from "@jobs/jobManager";
import type { JobEventSubscriber } from "@jobs/sse";

describe("renderSseFrame", () => {
  test("emits an id line, a data line, and a frame terminator", () => {
    const frame = renderSseFrame(7, { v: 1, type: "result" });
    expect(frame).toBe('id: 7\ndata: {"v":1,"type":"result"}\n\n');
  });
});

describe("resumeOffsetFrom", () => {
  function requestWith(headers: Record<string, string>, url = "http://x/e") {
    return new Request(url, { headers });
  }

  test("reads a non-negative Last-Event-ID header", () => {
    expect(resumeOffsetFrom(requestWith({ "last-event-id": "5" }))).toBe(5);
  });

  test("falls back to a lastEventId query param", () => {
    expect(resumeOffsetFrom(requestWith({}, "http://x/e?lastEventId=9"))).toBe(
      9,
    );
  });

  test("defaults to 0 when absent", () => {
    expect(resumeOffsetFrom(requestWith({}))).toBe(0);
  });

  test("treats a malformed value as 0 (replay from start)", () => {
    expect(resumeOffsetFrom(requestWith({ "last-event-id": "-1" }))).toBe(0);
    expect(resumeOffsetFrom(requestWith({ "last-event-id": "abc" }))).toBe(0);
  });
});

describe("createJobEventStream keepalive", () => {
  /** A stream over a subscriber the test drives directly: `emit` plays an event
   * to whatever listener the stream registered, and `subscribed` reports whether
   * the subscription is still held. */
  function streamOverManualSubscriber(
    replay: Array<BufferedEvent> = [],
    terminalEmitted = false,
  ) {
    let listener: ((entry: BufferedEvent) => void) | null = null;
    const manager: JobEventSubscriber = {
      subscribe: (_record, _afterId, onEntry) => {
        listener = onEntry;
        return {
          replay,
          unsubscribe: () => {
            listener = null;
          },
        };
      },
    };
    const controller = new AbortController();
    const stream = createJobEventStream({
      manager,
      record: { terminalEmitted } as unknown as JobRecord,
      afterId: 0,
      signal: controller.signal,
      keepaliveIntervalMs: 10,
    });
    return {
      stream,
      abort: () => {
        controller.abort();
      },
      emit: (entry: BufferedEvent) => listener?.(entry),
      subscribed: () => listener !== null,
    };
  }

  /** Read decoded chunks off the stream until `count` have arrived or it closes,
   * then release the body. */
  async function readChunks(
    stream: ReadableStream<Uint8Array>,
    count: number,
  ): Promise<Array<string>> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const chunks: Array<string> = [];
    try {
      while (chunks.length < count) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value));
      }
    } finally {
      await reader.cancel();
    }
    return chunks;
  }

  test("a stream with no events stays open, writing keepalive frames", async () => {
    // The run is silent for several idle windows: without the keepalive there
    // would be nothing on the wire for an intermediary to see, and the operator
    // would lose the view of a run that is still going.
    const driven = streamOverManualSubscriber();
    expect(await readChunks(driven.stream, 3)).toEqual([
      SSE_KEEPALIVE_FRAME,
      SSE_KEEPALIVE_FRAME,
      SSE_KEEPALIVE_FRAME,
    ]);
  });

  test("a keepalive frame has no event: it is an SSE comment", () => {
    // A `data:`-less frame is ignored by an EventSource and dropped by the
    // console's own parser, so a keepalive can never be mistaken for an event.
    const lines = SSE_KEEPALIVE_FRAME.split("\n");
    expect(lines.every((line) => !line.startsWith("data:"))).toBe(true);
    expect(lines[0].startsWith(":")).toBe(true);
    expect(SSE_KEEPALIVE_FRAME.endsWith("\n\n")).toBe(true);
  });

  test("an event after an idle stretch still reaches the stream", async () => {
    const driven = streamOverManualSubscriber();
    const reader = driven.stream.getReader();
    const decoder = new TextDecoder();
    const frames: Array<string> = [];
    // Read past the keepalives to the real event, then to the terminal close.
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        frames.push(decoder.decode(value));
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 30));
    driven.emit({ id: 1, event: { v: 1, type: "stage", id: "stage 1 / 2" } });
    driven.emit({
      id: 2,
      event: { v: 1, type: "result", resultWritten: true },
    });
    await pump;

    const events = frames.filter((frame) => frame !== SSE_KEEPALIVE_FRAME);
    expect(events).toEqual([
      renderSseFrame(1, { v: 1, type: "stage", id: "stage 1 / 2" }),
      renderSseFrame(2, { v: 1, type: "result", resultWritten: true }),
    ]);
    // The terminal released the subscription, so the keepalive timer went with
    // it rather than ticking on against a closed stream.
    expect(driven.subscribed()).toBe(false);
  });

  test("a client disconnect releases the subscription", async () => {
    const driven = streamOverManualSubscriber();
    const reader = driven.stream.getReader();
    driven.abort();
    expect((await reader.read()).done).toBe(true);
    expect(driven.subscribed()).toBe(false);
  });

  test("cancelling the body releases the subscription", async () => {
    const driven = streamOverManualSubscriber();
    const reader = driven.stream.getReader();
    await reader.cancel();
    expect(driven.subscribed()).toBe(false);
  });

  test("an already-terminal replay closes without arming a keepalive", async () => {
    const driven = streamOverManualSubscriber(
      [{ id: 1, event: { v: 1, type: "result", resultWritten: true } }],
      true,
    );
    expect(await readChunks(driven.stream, 5)).toEqual([
      renderSseFrame(1, { v: 1, type: "result", resultWritten: true }),
    ]);
    expect(driven.subscribed()).toBe(false);
  });
});
