import { describe, expect, it } from "vitest";
import {
  canonicalSource,
  classifyPath,
  fileVerdict,
  parseChangedPaths,
  sidesForStatus,
  soundnessProbes,
  summarize,
} from "./verify-nonexecutable-delta.mjs";

// These tests, not the comparison, are the load-bearing part of the verifier:
// they are what distinguishes it from the two implementations CLAUDE.md retires
// as measured wrong -- the compiler's emit (which erases type positions along
// with comments) and a raw scanner (which reads a backtick inside a comment as
// entering a template). Pinning both failure modes here means a TypeScript
// upgrade that changes printer behavior fails a check instead of silently
// degrading an attestation to a guess.
//
// Every claim below about what the printer does was measured by running it, not
// read off the compiler's source. Where the measured answer is a normalization
// (formatting collapses to equal) or a false positive (parenthesizing an
// expression reads as a change), the measurement is pinned as it stands rather
// than argued with.

const verdictOf = (before, after, path = "a.ts") =>
  fileVerdict({ path, before, after }).verdict;

describe("soundness probes", () => {
  it("all pass on the installed TypeScript (the CLI's preflight gate)", () => {
    expect(soundnessProbes().filter((probe) => !probe.ok)).toEqual([]);
  });
});

describe("comment suppression", () => {
  it("drops line, block, and JSDoc comments", () => {
    const commented =
      "/**\n * Doc.\n * @param x thing\n */\n// line comment\nexport function f(x) {\n  return x; /* block */\n}\n";
    const { canonical } = canonicalSource(commented, "a.js");
    expect(canonical).not.toMatch(/Doc\.|line comment|block|@param/);
    expect(
      verdictOf(commented, "export function f(x) {\n  return x;\n}\n", "a.js"),
    ).toBe("comment-only");
  });

  it("reads a backtick inside a comment as comment-only", () => {
    const base =
      "const a: string = `x`;\nfunction f(p: number) {\n  return p;\n}\n";
    expect(verdictOf(base, "// a backtick ` inside a comment\n" + base)).toBe(
      "comment-only",
    );
    expect(verdictOf(base, "/* a backtick ` and a ${x} */\n" + base)).toBe(
      "comment-only",
    );
  });
});

describe("type-position edits", () => {
  // Every one of these compares identical under the compiler's emit, which is
  // why the emit is not the comparand: each is a real change to the program's
  // types that a reviewer has not seen.
  const cases = [
    [
      "parameter annotation",
      "function f(p: number) {}\n",
      "function f(p: string) {}\n",
    ],
    [
      "return type",
      "function f(): number {\n  return q;\n}\n",
      "function f(): string {\n  return q;\n}\n",
    ],
    ["type alias right-hand side", "type T = string;\n", "type T = number;\n"],
    [
      "interface member type",
      "interface I {\n  a: string;\n}\n",
      "interface I {\n  a: number;\n}\n",
    ],
    [
      "optional marker",
      "interface I {\n  a?: string;\n}\n",
      "interface I {\n  a: string;\n}\n",
    ],
    [
      "generic constraint",
      "function g<T extends string>(x: T) {}\n",
      "function g<T extends number>(x: T) {}\n",
    ],
    ["as-cast target", "const v = w as string;\n", "const v = w as number;\n"],
    [
      "type-only import",
      'import type { X } from "y";\n',
      'import { X } from "y";\n',
    ],
  ];

  for (const [label, before, after] of cases) {
    it(`reads a ${label} edit as an executable delta`, () => {
      expect(verdictOf(before, after)).toBe("executable-delta");
    });
  }
});

describe("path classification", () => {
  it("treats the TypeScript/JavaScript family as parseable source", () => {
    for (const path of [
      "a.ts",
      "a.tsx",
      "a.mts",
      "a.cts",
      "a.d.ts",
      "a.js",
      "a.jsx",
      "a.mjs",
      "a.cjs",
      "deep/dir/a.TS",
    ]) {
      expect(classifyPath(path)).toBe("source");
    }
  });

  it("exempts markdown and nothing else", () => {
    expect(classifyPath("docs/spec/CHANNEL_SECURITY.md")).toBe("exempt");
    expect(classifyPath("README.MD")).toBe("exempt");
  });

  it("fails closed on every other path, rather than exempting a non-source extension", () => {
    for (const path of [
      ".github/workflows/static_checks.yaml",
      "package.json",
      "Dockerfile",
      "scripts/release.sh",
      "tools/report.py",
      ".gitignore",
      "apps/web/public/style.css",
      "fixtures/input.csv",
    ]) {
      expect(classifyPath(path)).toBe("unverifiable");
    }
  });

  it("decides an exempt or unverifiable path without reading either side", () => {
    expect(verdictOf("# heading\n", "# other\n", "docs/X.md")).toBe("exempt");
    const yaml = fileVerdict({
      path: ".github/workflows/x.yaml",
      before: null,
      after: null,
    });
    expect(yaml.verdict).toBe("unverifiable");
    expect(yaml.reason).toMatch(/cannot read it/);
  });
});

describe("added and deleted files", () => {
  it("canonicalizes an absent side to the empty program", () => {
    expect(canonicalSource(null, "a.ts").canonical).toBe("");
    expect(canonicalSource("// only a comment\n", "a.ts").canonical).toBe("");
  });

  it("reads adding or deleting a comments-only file as comment-only", () => {
    expect(verdictOf(null, "// only a comment\n")).toBe("comment-only");
    expect(verdictOf("/* only a comment */\n", null)).toBe("comment-only");
  });

  it("reads adding or deleting a file carrying a statement as an executable delta", () => {
    expect(verdictOf(null, "export const a = 1;\n")).toBe("executable-delta");
    expect(verdictOf("export const a = 1;\n", null)).toBe("executable-delta");
  });
});

describe("formatting-only edits (measured, not assumed)", () => {
  it("collapses whitespace, indentation, and blank-line changes to comment-only", () => {
    expect(
      verdictOf(
        "const a = 1;\n\n\nconst b   =  2;\n",
        "const a = 1;\nconst b = 2;\n",
      ),
    ).toBe("comment-only");
    expect(
      verdictOf(
        "export function f(\n  a,\n  b,\n) {\n  return a + b;\n}\n",
        "export function f(a, b) {\n  return a + b;\n}\n",
        "a.js",
      ),
    ).toBe("comment-only");
  });

  it("collapses quote style, an ASI semicolon, and a trailing comma to comment-only", () => {
    expect(verdictOf("const a = 'x';\n", 'const a = "x";\n')).toBe(
      "comment-only",
    );
    expect(verdictOf("const a = 1\n", "const a = 1;\n")).toBe("comment-only");
    expect(verdictOf("f(\n  a,\n  b,\n);\n", "f(a, b);\n")).toBe(
      "comment-only",
    );
    expect(verdictOf("const n = 0x10;\n", "const n = 16;\n")).toBe(
      "comment-only",
    );
  });

  it("reads parenthesizing an expression as a change, the safe direction", () => {
    // Parentheses are an AST node, so this formatting-only edit reads as a
    // delta. That costs a full review round it did not strictly need; the
    // opposite error would attest an unreviewed head.
    expect(verdictOf("const e = 1 + 2;\n", "const e = (1 + 2);\n")).toBe(
      "executable-delta",
    );
    expect(
      verdictOf(
        "const e = <div a={1} />;\n",
        "const e = (\n  <div a={1} />\n);\n",
        "a.tsx",
      ),
    ).toBe("executable-delta");
  });
});

describe("unparseable content", () => {
  it("reports a side that does not parse as unverifiable", () => {
    const result = fileVerdict({
      path: "a.ts",
      before: "const a = 1;\n",
      after: "const a = ;\nfunction (\n",
    });
    expect(result.verdict).toBe("unverifiable");
    expect(result.reason).toMatch(/parse errors/);
  });
});

describe("diff status handling", () => {
  it("maps the statuses it models to the sides that exist", () => {
    expect(sidesForStatus("A")).toEqual({ before: false, after: true });
    expect(sidesForStatus("D")).toEqual({ before: true, after: false });
    expect(sidesForStatus("M")).toEqual({ before: true, after: true });
  });

  it("returns null for a status it does not model", () => {
    for (const status of ["T", "R100", "C75", "U", "X"]) {
      expect(sidesForStatus(status)).toBe(null);
    }
  });

  it("parses -z name-status records", () => {
    expect(parseChangedPaths("M\0a.ts\0A\0b/c.mjs\0D\0d.md\0")).toEqual([
      { status: "M", path: "a.ts" },
      { status: "A", path: "b/c.mjs" },
      { status: "D", path: "d.md" },
    ]);
    expect(parseChangedPaths("")).toEqual([]);
  });

  it("consumes both paths of an R/C record without desyncing the rest", () => {
    expect(parseChangedPaths("R100\0old.ts\0new.ts\0M\0after.ts\0")).toEqual([
      { status: "R100", path: "new.ts" },
      { status: "M", path: "after.ts" },
    ]);
  });
});

describe("summarize", () => {
  const at = (path, verdict) => ({ path, verdict });

  it("holds and exits 0 when every path is exempt or comment-only", () => {
    const result = summarize([
      at("a.md", "exempt"),
      at("b.ts", "comment-only"),
    ]);
    expect(result.holds).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("fails on an executable delta", () => {
    const result = summarize([
      at("b.ts", "comment-only"),
      at("c.ts", "executable-delta"),
    ]);
    expect(result.holds).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.deltas.map((v) => v.path)).toEqual(["c.ts"]);
  });

  it("fails on an unverifiable path, so no verdict rests on a file that was not examined", () => {
    const result = summarize([
      at("b.ts", "comment-only"),
      at("Dockerfile", "unverifiable"),
    ]);
    expect(result.holds).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.unverifiable.map((v) => v.path)).toEqual(["Dockerfile"]);
  });

  it("holds vacuously when the two refs differ in nothing", () => {
    expect(summarize([])).toMatchObject({ holds: true, exitCode: 0 });
  });
});
