import { describe, expect, it } from "vitest";
import { stripCodeSpans } from "./markdownFences.mjs";

describe("stripCodeSpans", () => {
  it("blanks a single-backtick span, preserving offsets", () => {
    const text = "see `](target)` here";
    const stripped = stripCodeSpans(text);
    expect(stripped).not.toContain("](target)");
    expect(stripped.length).toBe(text.length);
  });

  it("leaves a genuine link outside a span untouched", () => {
    const text = "[label](real.md)";
    expect(stripCodeSpans(text)).toBe(text);
  });

  it("preserves a newline inside a span that crosses one", () => {
    const text = "a `one\ntwo` b\n[c](d.md)";
    const stripped = stripCodeSpans(text);
    expect(stripped.split("\n").length).toBe(text.split("\n").length);
    expect(stripped).toContain("[c](d.md)");
  });

  it("closes a double-backtick span at the next double-backtick run, keeping an interior single backtick", () => {
    const text = "x ``a ` b`` y";
    const stripped = stripCodeSpans(text);
    expect(stripped).not.toContain("`");
    expect(stripped.length).toBe(text.length);
  });

  it("leaves an unmatched opening run as literal text", () => {
    const text = "price is `5 and no close";
    expect(stripCodeSpans(text)).toBe(text);
  });
});
