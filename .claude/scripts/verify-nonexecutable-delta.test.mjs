import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalSource,
  classifyPath,
  collectVerdicts,
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

// The `-z` records above are hand-written, which makes them a model of git's
// output rather than a measurement of it. These drive real git instead, through
// the same seam the CLI uses. The fixtures build their own repo rather than
// naming a sha from this one: CI checks out with no `fetch-depth`, and in the
// resulting shallow clone no historical sha resolves.
describe("against a real git repository", () => {
  const dirs = [];

  afterEach(() => {
    while (dirs.length > 0) {
      rmSync(dirs.pop(), { recursive: true, force: true });
    }
  });

  function makeFixture() {
    const dir = mkdtempSync(join(tmpdir(), "nonexec-delta-"));
    dirs.push(dir);
    const git = (args) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "verifier-test@example.invalid"]);
    git(["config", "user.name", "Verifier Test"]);
    return {
      git,
      write: (path, text) => {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      },
      remove: (path) => rmSync(join(dir, path)),
      commit: (message) => {
        git(["add", "-A"]);
        git(["commit", "-q", "-m", message]);
        return git(["rev-parse", "HEAD"]).trim();
      },
    };
  }

  const byPath = (verdicts) =>
    Object.fromEntries(verdicts.map((v) => [v.path, v.verdict]));

  it("verdicts a modified, added, deleted, markdown, and non-source path from one real diff", () => {
    const { git, write, remove, commit } = makeFixture();
    write("src/commented.ts", "export const a = 1;\n");
    write("src/changed.ts", "export const b = 1;\n");
    write("src/dropped.js", "// only a comment\n");
    write("docs/notes.md", "# Notes\n");
    write("package.json", '{ "name": "fixture" }\n');
    write(".github/workflows/ci.yaml", "on: push\n");
    const attested = commit("Base");

    write("src/commented.ts", "// why this is one\nexport const a = 1;\n");
    write("src/changed.ts", "export const b = 2;\n");
    remove("src/dropped.js");
    write("src/added.mjs", "export const c = 3;\n");
    write("docs/notes.md", "# Notes\n\nMore prose.\n");
    write("package.json", '{ "name": "fixture", "version": "1.0.0" }\n');
    write(".github/workflows/ci.yaml", "on: pull_request\n");
    const head = commit("Change");

    const verdicts = collectVerdicts({ attested, head, git });
    expect(byPath(verdicts)).toEqual({
      "src/commented.ts": "comment-only",
      "src/changed.ts": "executable-delta",
      "src/dropped.js": "comment-only",
      "src/added.mjs": "executable-delta",
      "docs/notes.md": "exempt",
      "package.json": "unverifiable",
      ".github/workflows/ci.yaml": "unverifiable",
    });
    expect(summarize(verdicts).exitCode).toBe(1);
  });

  it("exits 0 for a real diff that is comments and markdown only", () => {
    const { git, write, remove, commit } = makeFixture();
    write("src/kept.ts", "export const a = 1;\n");
    write("src/gone.mts", "/* only a comment */\n");
    write("README.md", "# Fixture\n");
    const attested = commit("Base");

    write("src/kept.ts", "export const a = 1; // trailing\n");
    remove("src/gone.mts");
    write("README.md", "# Fixture\n\nRewritten wholesale.\n");
    const head = commit("Comments and markdown");

    const result = summarize(collectVerdicts({ attested, head, git }));
    expect(result).toMatchObject({ holds: true, exitCode: 0 });
    expect(result.deltas).toEqual([]);
    expect(result.unverifiable).toEqual([]);
  });

  it("sees a rename as a delete plus an add, so a moved module is a delta", () => {
    const { git, write, commit } = makeFixture();
    write("src/mover.ts", "export const moved = 1;\n");
    const attested = commit("Base");

    git(["mv", "src/mover.ts", "src/moved.ts"]);
    const head = commit("Move it");

    expect(git(["diff", "--name-status", "-M", "-z", attested, head])).toBe(
      "R100\0src/mover.ts\0src/moved.ts\0",
    );
    expect(byPath(collectVerdicts({ attested, head, git }))).toEqual({
      "src/mover.ts": "executable-delta",
      "src/moved.ts": "executable-delta",
    });
  });

  it("reads paths that -z emits raw and the default format would C-quote", () => {
    const { git, write, commit } = makeFixture();
    write("src/has space.ts", "export const s = 1;\n");
    write("src/uni-é.ts", "export const u = 1;\n");
    const attested = commit("Base");

    write("src/has space.ts", "export const s = 1; // note\n");
    write("src/uni-é.ts", "export const u = 2;\n");
    const head = commit("Touch both");

    expect(
      git([
        "-c",
        "core.quotePath=true",
        "diff",
        "--name-status",
        "--no-renames",
        attested,
        head,
      ]),
    ).toContain('"src/uni-\\303\\251.ts"');
    expect(byPath(collectVerdicts({ attested, head, git }))).toEqual({
      "src/has space.ts": "comment-only",
      "src/uni-é.ts": "executable-delta",
    });
  });
});

const SCRIPT = fileURLToPath(
  new URL("./verify-nonexecutable-delta.mjs", import.meta.url),
);

// The script as an agent invokes it, so argv handling, the git error path, and
// the exit codes are exercised rather than assumed. Every case here resolves
// without repo history, which is what a shallow CI checkout has. Exit 3 stays
// unreachable from a subprocess -- it needs a TypeScript whose printer fails a
// probe -- and is covered only by the soundness-probe test above.
describe("the script as an agent runs it", () => {
  const runScript = (args) => {
    try {
      return {
        status: 0,
        stdout: execFileSync(process.execPath, [SCRIPT, ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
        stderr: "",
      };
    } catch (error) {
      return {
        status: error.status,
        stdout: error.stdout,
        stderr: error.stderr,
      };
    }
  };

  it("prints usage and exits 2 unless given exactly two refs", () => {
    for (const args of [[], ["only-one"], ["one", "two", "three"]]) {
      const result = runScript(args);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(
        /^Usage: node \.claude\/scripts\/verify-nonexecutable-delta\.mjs /,
      );
      expect(result.stdout).toBe("");
    }
  });

  it("exits 2 when a ref does not resolve, rather than reporting a verdict", () => {
    const result = runScript(["HEAD", "no-such-ref-9f3c1a"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^error: /m);
    expect(result.stdout).not.toMatch(/HOLDS|VIOLATED/);
  });

  it("passes its probes and exits 0 over a ref compared with itself", () => {
    const result = runScript(["HEAD", "HEAD"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /soundness probes: (\d+)\/\1 passed on typescript /,
    );
    expect(result.stdout).toContain("(none)");
    expect(result.stdout).toMatch(/non-executable-delta property: HOLDS/);
  });
});
