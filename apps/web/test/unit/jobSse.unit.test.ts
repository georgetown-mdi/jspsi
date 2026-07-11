import { describe, expect, test } from "vitest";

import { renderSseFrame, resumeOffsetFrom } from "@jobs/sse";

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
