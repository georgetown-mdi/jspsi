import { describe, expect, it } from "vitest";
import { fencedBlocks, jsBlocks, stripCodeSpans } from "./markdownFences.mjs";

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

const FENCE = "```";

describe("fencedBlocks", () => {
  it("reads a block's content, language, and first content line", () => {
    const source = `intro\n${FENCE}sh title="recipe"\nnpm test\n${FENCE}\nafter\n`;
    expect(fencedBlocks(source)).toEqual([
      { code: "npm test", startLine: 3, language: "sh", closed: true },
    ]);
  });

  it("closes a block only on the same fence character, run length, and nothing after it", () => {
    const source = `${FENCE}sh\none\n~~~\n${FENCE}sh\n${FENCE}\nafter\n`;
    expect(fencedBlocks(source).map((block) => block.code)).toEqual([
      `one\n~~~\n${FENCE}sh`,
    ]);
  });

  it("reports a block whose closing fence never arrives", () => {
    const source = `${FENCE}sh\none\ntwo\n`;
    expect(fencedBlocks(source)).toEqual([
      { code: "one\ntwo\n", startLine: 2, language: "sh", closed: false },
    ]);
  });
});

describe("jsBlocks", () => {
  it("reads only js fences, and reports their line numbers", () => {
    const source = `intro\n${FENCE}sh\nnpm test\n${FENCE}\nmid\n${FENCE}js\nconst a = 1\n${FENCE}\n`;
    expect(jsBlocks(source)).toEqual([{ code: "const a = 1", startLine: 7 }]);
  });
});
