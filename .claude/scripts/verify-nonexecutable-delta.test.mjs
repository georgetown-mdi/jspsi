import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createGitFixtures } from "./lib/gitFixture.mjs";
import {
  canonicalSource,
  canonicalYaml,
  classifyPath,
  collectVerdicts,
  fileVerdict,
  modeChange,
  parseChangedPaths,
  sidesForStatus,
  soundnessProbes,
  summarize,
  yamlVerdict,
} from "./verify-nonexecutable-delta.mjs";

// These tests, not the comparison, are the critical part of the verifier:
// they are what distinguishes it from the two implementations CLAUDE.md retires
// as measured wrong -- the compiler's emit (which erases type positions along
// with comments) and a raw scanner (which treats a backtick inside a comment as
// entering a template). Pinning both failure modes here means a TypeScript
// upgrade that changes printer behavior fails a check instead of silently
// degrading an attestation to a guess.
//
// Every claim below about what the printer does was measured by running it, not
// read off the compiler's source. Where the measured answer is a normalization
// (formatting collapses to equal) or a false positive (parenthesizing an
// expression is treated as a change), the measurement is pinned as it stands
// rather than argued with.

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

  it("treats a backtick inside a comment as comment-only", () => {
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
    it(`treats a ${label} edit as an executable delta`, () => {
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

  it("treats .yml and .yaml as parseable YAML", () => {
    for (const path of [
      ".github/workflows/static_checks.yaml",
      ".github/actions/setup/action.yml",
      "deep/dir/a.YAML",
    ]) {
      expect(classifyPath(path)).toBe("yaml");
    }
  });

  it("fails closed on every other path, rather than exempting a non-source extension", () => {
    for (const path of [
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
    const dockerfile = fileVerdict({
      path: "Dockerfile",
      before: null,
      after: null,
    });
    expect(dockerfile.verdict).toBe("unverifiable");
    expect(dockerfile.reason).toMatch(/cannot read it/);
  });
});

describe("added and deleted files", () => {
  it("canonicalizes an absent side to the empty program", () => {
    expect(canonicalSource(null, "a.ts").canonical).toBe("");
    expect(canonicalSource("// only a comment\n", "a.ts").canonical).toBe("");
  });

  it("treats adding or deleting a comments-only file as comment-only", () => {
    expect(verdictOf(null, "// only a comment\n")).toBe("comment-only");
    expect(verdictOf("/* only a comment */\n", null)).toBe("comment-only");
  });

  it("treats adding or deleting a file holding a statement as an executable delta", () => {
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

  it("treats parenthesizing an expression as a change, the safe direction", () => {
    // Parentheses are an AST node, so this formatting-only edit is treated as a
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

// Every claim below about the `yaml` package's behavior -- duplicate-key
// rejection, multi-document handling, key-order insensitivity, which values
// survive `toJS()` and which throw out of it -- was measured by running it, the
// same discipline the TypeScript comparison above holds itself to.
describe("YAML comparison", () => {
  const yamlVerdictOf = (before, after, path = "a.yaml") =>
    yamlVerdict({ path, before, after }).verdict;

  it("treats a comment-only edit as comment-only", () => {
    expect(yamlVerdictOf("a: 1 # note\nb: 2\n", "a: 1\nb: 2 # moved\n")).toBe(
      "comment-only",
    );
  });

  it("treats reordered mapping keys as comment-only", () => {
    expect(yamlVerdictOf("a: 1\nb: 2\n", "b: 2\na: 1\n")).toBe("comment-only");
  });

  it("treats a one-key value change as a content difference", () => {
    expect(yamlVerdictOf("a: 1\nb: 2\n", "a: 1\nb: 3\n")).toBe(
      "executable-delta",
    );
  });

  it("treats a reordered sequence as a content difference", () => {
    expect(yamlVerdictOf("a:\n  - 1\n  - 2\n", "a:\n  - 2\n  - 1\n")).toBe(
      "executable-delta",
    );
  });

  // The four values below share one JSON text (`null`), so a comparison key
  // built by stringifying the value treats every edit among them as
  // comment-only -- an executable delta attested away.
  it("tells NaN, Infinity, -Infinity, and null apart", () => {
    expect(yamlVerdictOf("a: .nan\n", "a: .inf\n")).toBe("executable-delta");
    expect(yamlVerdictOf("a: .inf\n", "a: -.inf\n")).toBe("executable-delta");
    expect(yamlVerdictOf("a: null\n", "a: .nan\n")).toBe("executable-delta");
    expect(yamlVerdictOf("a: -.inf\n", "a: ~\n")).toBe("executable-delta");
  });

  it("treats a comment edit beside an unchanged NaN as comment-only", () => {
    expect(yamlVerdictOf("a: .nan # note\n", "a: .nan\n")).toBe("comment-only");
  });

  // `!!timestamp` materializes to a Date and `!!set` to a Set, neither of which
  // holds its value in its own keys: an own-keys walk treats both sides of
  // each pair below as the same empty object.
  it("tells two timestamps and two sets apart", () => {
    expect(
      yamlVerdictOf(
        "a: !!timestamp 2001-12-14\n",
        "a: !!timestamp 2002-12-14\n",
      ),
    ).toBe("executable-delta");
    expect(yamlVerdictOf("a: !!set\n  ? x\n", "a: !!set\n  ? y\n")).toBe(
      "executable-delta",
    );
  });

  it("treats an unchanged timestamp or set as comment-only", () => {
    expect(
      yamlVerdictOf(
        "a: !!timestamp 2001-12-14 # note\n",
        "a: !!timestamp 2001-12-14\n",
      ),
    ).toBe("comment-only");
    expect(
      yamlVerdictOf("a: !!set\n  ? x\n  ? y\n", "a: !!set\n  ? y\n  ? x\n"),
    ).toBe("comment-only");
  });

  it("refuses a duplicate key rather than resolving it last-wins", () => {
    const result = yamlVerdict({
      path: "a.yaml",
      before: "a: 1\n",
      after: "a: 1\na: 2\n",
    });
    expect(result.verdict).toBe("unverifiable");
    expect(result.reason).toMatch(/does not parse/);
  });

  it("refuses a multi-document stream rather than comparing it partially", () => {
    const result = yamlVerdict({
      path: "a.yaml",
      before: "a: 1\n",
      after: "a: 1\n---\nb: 2\n",
    });
    expect(result.verdict).toBe("unverifiable");
    expect(result.reason).toMatch(/documents in one stream/);
  });

  it("refuses a document that does not parse", () => {
    const result = yamlVerdict({
      path: "a.yaml",
      before: "a: 1\n",
      after: 'a: "unterminated\n',
    });
    expect(result.verdict).toBe("unverifiable");
    expect(result.reason).toMatch(/does not parse/);
  });

  // `doc.errors` is empty for each of these: the failure is in materializing
  // the document, not in parsing it, so a verdict path that trusts the error
  // count throws out of the run instead of reporting the file.
  it("refuses an alias that does not resolve, rather than throwing", () => {
    const result = yamlVerdict({
      path: "a.yaml",
      before: "a: 1\n",
      after: "a: *missing\n",
    });
    expect(result.verdict).toBe("unverifiable");
    expect(result.reason).toMatch(/does not materialize: Unresolved alias/);
  });

  it("refuses an alias expansion the yaml package caps as an attack", () => {
    let bomb = "a: &a0 [x]\n";
    for (let i = 1; i < 8; i += 1) {
      bomb += `b${i}: &a${i} [*a${i - 1}, *a${i - 1}, *a${i - 1}]\n`;
    }
    expect(canonicalYaml(bomb).error).toMatch(
      /does not materialize: Excessive alias count/,
    );
  });

  it("refuses a self-referential anchor, which materializes to a circular value", () => {
    for (const after of ["a: &x\n  b: *x\n", "a: &x [*x]\n"]) {
      const result = yamlVerdict({ path: "a.yaml", before: "a: 1\n", after });
      expect(result.verdict).toBe("unverifiable");
      expect(result.reason).toMatch(/refers to itself/);
    }
  });

  it("compares a document whose aliases only share subtrees", () => {
    const shared = "base: &b\n  x: 1\nl: *b\nr: *b\n";
    expect(canonicalYaml(shared).error).toBe(null);
    expect(yamlVerdictOf(shared, `# note\n${shared}`)).toBe("comment-only");
    expect(yamlVerdictOf(shared, shared.replace("x: 1", "x: 2"))).toBe(
      "executable-delta",
    );
  });

  it("names the side a refusal came from, as the source comparison does", () => {
    expect(
      yamlVerdict({ path: "a.yaml", before: "a: 1\na: 2\n", after: "a: 1\n" })
        .reason,
    ).toMatch(/^before does not parse: /);
    expect(
      yamlVerdict({ path: "a.yaml", before: "a: 1\n", after: "a: *missing\n" })
        .reason,
    ).toMatch(/^after does not materialize: /);
    expect(
      yamlVerdict({
        path: "a.yaml",
        before: "a: 1\n---\nb: 2\n",
        after: "a: *missing\n",
      }).reason,
    ).toMatch(
      /^before carries 2 YAML documents in one stream[^;]*; after does not materialize: /,
    );
  });

  it("canonicalizes an absent side to the same value as an empty document", () => {
    expect(canonicalYaml(null)).toEqual({ value: null, error: null });
    expect(canonicalYaml("# only a comment\n")).toEqual({
      value: null,
      error: null,
    });
  });

  it("treats adding or deleting a comment-only YAML file as comment-only", () => {
    expect(yamlVerdictOf(null, "# only a comment\n")).toBe("comment-only");
    expect(yamlVerdictOf("# only a comment\n", null)).toBe("comment-only");
  });

  it("treats adding or deleting a YAML file holding a value as a content difference", () => {
    expect(yamlVerdictOf(null, "a: 1\n")).toBe("executable-delta");
    expect(yamlVerdictOf("a: 1\n", null)).toBe("executable-delta");
  });

  it("decides a yaml path through fileVerdict the same way", () => {
    expect(
      fileVerdict({
        path: ".github/workflows/x.yaml",
        before: "on: push\n",
        after: "on: push # trigger\n",
      }).verdict,
    ).toBe("comment-only");
    expect(
      fileVerdict({
        path: ".github/workflows/x.yaml",
        before: "on: push\n",
        after: "on: pull_request\n",
      }).verdict,
    ).toBe("executable-delta");
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

  it("parses -z raw records as a status, a path, and both file modes", () => {
    expect(
      parseChangedPaths(
        ":100644 100755 cc798ff cc798ff M\0a.ts\0" +
          ":000000 100644 0000000 39a3655 A\0b/c.mjs\0" +
          ":100644 000000 b240d97 0000000 D\0d.md\0",
      ),
    ).toEqual([
      { status: "M", path: "a.ts", beforeMode: "100644", afterMode: "100755" },
      {
        status: "A",
        path: "b/c.mjs",
        beforeMode: "000000",
        afterMode: "100644",
      },
      { status: "D", path: "d.md", beforeMode: "100644", afterMode: "000000" },
    ]);
    expect(parseChangedPaths("")).toEqual([]);
  });

  it("consumes both paths of an R/C record without desyncing the rest", () => {
    expect(
      parseChangedPaths(
        ":100644 100644 97e87e5 97e87e5 R100\0old.ts\0new.ts\0" +
          ":100644 100644 ac648be 15a410d M\0after.ts\0",
      ),
    ).toEqual([
      {
        status: "R100",
        path: "new.ts",
        beforeMode: "100644",
        afterMode: "100644",
      },
      {
        status: "M",
        path: "after.ts",
        beforeMode: "100644",
        afterMode: "100644",
      },
    ]);
  });

  it("fails a record shape it does not model closed, without desyncing the rest", () => {
    // A bare name-status record and a combined-diff record: neither has the
    // modes the comparison needs, so neither may be treated as a modelled entry.
    for (const unmodelled of [
      "M",
      "::100644 100644 100644 aaaaaaa bbbbbbb ccccccc MM",
    ]) {
      expect(
        parseChangedPaths(
          `${unmodelled}\0legacy.ts\0:100644 100644 ac648be 15a410d M\0after.ts\0`,
        ),
      ).toEqual([
        { status: null, record: unmodelled, path: "legacy.ts" },
        {
          status: "M",
          path: "after.ts",
          beforeMode: "100644",
          afterMode: "100644",
        },
      ]);
    }
  });

  it("reports a record it does not model as unverifiable rather than skipping it", () => {
    const git = (args) => (args[0] === "diff" ? "M\0a.ts\0" : "");
    const verdicts = collectVerdicts({ attested: "x", head: "y", git });
    expect(verdicts).toMatchObject([{ path: "a.ts", verdict: "unverifiable" }]);
    expect(verdicts[0].reason).toMatch(/does not model/);
    expect(summarize(verdicts).exitCode).toBe(1);
  });
});

describe("file modes", () => {
  it("reports a mode change only where both sides exist", () => {
    expect(modeChange("100644", "100755")).toEqual({
      beforeMode: "100644",
      afterMode: "100755",
    });
    expect(modeChange("100755", "100644")).toEqual({
      beforeMode: "100755",
      afterMode: "100644",
    });
    expect(modeChange("100644", "100644")).toBe(null);
    expect(modeChange("000000", "100755")).toBe(null);
    expect(modeChange("100755", "000000")).toBe(null);
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

const {
  makeTempDir,
  makeFixture: makeBareFixture,
  cleanup,
} = createGitFixtures();

afterEach(cleanup);

const makeFixture = () => makeBareFixture("nonexec-delta-");

// The `-z` records above are hand-written, which makes them a model of git's
// output rather than a measurement of it. These drive real git instead, through
// the same boundary the CLI uses. The fixtures build their own repo rather than
// naming a sha from this one: CI checks out with no `fetch-depth`, and in the
// resulting shallow clone no historical sha resolves.
describe("against a real git repository", () => {
  const byPath = (verdicts) =>
    Object.fromEntries(verdicts.map((v) => [v.path, v.verdict]));

  it("verdicts a modified, added, deleted, markdown, YAML, and non-source path from one real diff", () => {
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
      ".github/workflows/ci.yaml": "executable-delta",
    });
    expect(summarize(verdicts).exitCode).toBe(1);
  });

  it("keeps a YAML path it cannot materialize from costing the rest of the run its verdicts", () => {
    const { git, write, commit } = makeFixture();
    write(".github/workflows/alias.yaml", "a: 1\n");
    write(".github/workflows/anchor.yaml", "a: 1\n");
    write("src/commented.ts", "export const a = 1;\n");
    write("src/changed.ts", "export const b = 1;\n");
    const attested = commit("Base");

    // Both parse with no diagnostic at all; only materializing them fails.
    write(".github/workflows/alias.yaml", "a: *missing\n");
    write(".github/workflows/anchor.yaml", "a: &x\n  b: *x\n");
    write("src/commented.ts", "// why this is one\nexport const a = 1;\n");
    write("src/changed.ts", "export const b = 2;\n");
    const head = commit("Change");

    const verdicts = collectVerdicts({ attested, head, git });
    expect(byPath(verdicts)).toEqual({
      ".github/workflows/alias.yaml": "unverifiable",
      ".github/workflows/anchor.yaml": "unverifiable",
      "src/commented.ts": "comment-only",
      "src/changed.ts": "executable-delta",
    });
    const reasons = Object.fromEntries(
      verdicts.map((v) => [v.path, v.reason ?? ""]),
    );
    expect(reasons[".github/workflows/alias.yaml"]).toMatch(
      /after does not materialize: Unresolved alias/,
    );
    expect(reasons[".github/workflows/anchor.yaml"]).toMatch(
      /after refers to itself/,
    );
    // Exit 1 is the documented unverifiable-path outcome; a throw escaping the
    // run would show up as exit 2, the usage-or-git-error code.
    expect(summarize(verdicts).exitCode).toBe(1);
  });

  it("exits 0 for a real diff that is comments, markdown, and YAML formatting only", () => {
    const { git, write, remove, commit } = makeFixture();
    write("src/kept.ts", "export const a = 1;\n");
    write("src/gone.mts", "/* only a comment */\n");
    write("README.md", "# Fixture\n");
    write(".github/workflows/ci.yaml", "on:\n  push: {}\n  pull_request: {}\n");
    const attested = commit("Base");

    write("src/kept.ts", "export const a = 1; // trailing\n");
    remove("src/gone.mts");
    write("README.md", "# Fixture\n\nRewritten wholesale.\n");
    write(
      ".github/workflows/ci.yaml",
      "on: # reordered and reformatted\n  pull_request: {}\n  push: {}\n",
    );
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

    expect(git(["diff", "--raw", "-M", "-z", attested, head])).toMatch(
      /^:100644 100644 [0-9a-f]+ [0-9a-f]+ R100\0src\/mover\.ts\0src\/moved\.ts\0$/,
    );
    expect(byPath(collectVerdicts({ attested, head, git }))).toEqual({
      "src/mover.ts": "executable-delta",
      "src/moved.ts": "executable-delta",
    });
  });

  it("fails a chmod that changes no content, which name-status reports as a bare M", () => {
    const { git, write, chmod, commit } = makeFixture();
    write("src/tool.mjs", "export const run = 1;\n");
    const attested = commit("Base");

    chmod("src/tool.mjs", 0o755);
    const head = commit("Make it runnable");

    // The assumption of reading modes off `--raw`, measured rather than assumed:
    // under `--name-status` this change has no mode information at all, and
    // the blobs it points at are the same one.
    expect(
      git(["diff", "--name-status", "--no-renames", "-z", attested, head]),
    ).toBe("M\0src/tool.mjs\0");
    expect(
      git(["diff", "--raw", "--no-renames", "-z", attested, head]),
    ).toMatch(/^:100644 100755 ([0-9a-f]+) \1 M\0src\/tool\.mjs\0$/);

    const verdicts = collectVerdicts({ attested, head, git });
    expect(byPath(verdicts)).toEqual({ "src/tool.mjs": "unverifiable" });
    expect(verdicts[0].reason).toMatch(/mode changed from 100644 to 100755/);
    const result = summarize(verdicts);
    expect(result.holds).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.unverifiable.map((v) => v.path)).toEqual(["src/tool.mjs"]);
  });

  it("fails a chmod that removes the executable bit", () => {
    const { git, write, chmod, commit } = makeFixture();
    write("src/tool.mjs", "export const run = 1;\n");
    chmod("src/tool.mjs", 0o755);
    const attested = commit("Base");

    chmod("src/tool.mjs", 0o644);
    const head = commit("Stop it running");

    expect(byPath(collectVerdicts({ attested, head, git }))).toEqual({
      "src/tool.mjs": "unverifiable",
    });
  });

  it("fails a chmod on a markdown path, whose exemption covers content, not modes", () => {
    const { git, write, chmod, commit } = makeFixture();
    write("docs/plain.md", "# Plain\n");
    write("docs/rewritten.md", "# Rewritten\n");
    const attested = commit("Base");

    chmod("docs/plain.md", 0o755);
    chmod("docs/rewritten.md", 0o755);
    write("docs/rewritten.md", "# Rewritten\n\nWholesale new prose.\n");
    const head = commit("Chmod the docs");

    expect(byPath(collectVerdicts({ attested, head, git }))).toEqual({
      "docs/plain.md": "unverifiable",
      "docs/rewritten.md": "unverifiable",
    });
  });

  it("fails a chmod on a YAML path regardless of its content verdict", () => {
    const { git, write, chmod, commit } = makeFixture();
    write(".github/workflows/unchanged.yaml", "on: push\n");
    write(".github/workflows/commented.yaml", "on: push\n");
    const attested = commit("Base");

    chmod(".github/workflows/unchanged.yaml", 0o755);
    chmod(".github/workflows/commented.yaml", 0o755);
    write(".github/workflows/commented.yaml", "on: push # note\n");
    const head = commit("Chmod the workflows");

    expect(byPath(collectVerdicts({ attested, head, git }))).toEqual({
      ".github/workflows/unchanged.yaml": "unverifiable",
      ".github/workflows/commented.yaml": "unverifiable",
    });
  });

  it("fails a chmod alongside a comment edit, which alone would hold", () => {
    const { git, write, chmod, commit } = makeFixture();
    write("src/both.ts", "export const a = 1;\n");
    const attested = commit("Base");

    write("src/both.ts", "// why this is one\nexport const a = 1;\n");
    chmod("src/both.ts", 0o755);
    const head = commit("Comment and chmod");

    expect(byPath(collectVerdicts({ attested, head, git }))).toEqual({
      "src/both.ts": "unverifiable",
    });
  });

  it("does not fail an added or deleted file for its absent side's 000000 mode", () => {
    const { git, write, chmod, remove, commit } = makeFixture();
    write("src/goneComment.ts", "// only a comment\n");
    chmod("src/goneComment.ts", 0o755);
    write("src/goneCode.ts", "export const g = 1;\n");
    chmod("src/goneCode.ts", 0o755);
    const attested = commit("Base");

    remove("src/goneComment.ts");
    remove("src/goneCode.ts");
    write("src/addedComment.mjs", "// only a comment\n");
    chmod("src/addedComment.mjs", 0o755);
    write("src/addedCode.mjs", "export const c = 3;\n");
    chmod("src/addedCode.mjs", 0o755);
    const head = commit("Swap them");

    expect(byPath(collectVerdicts({ attested, head, git }))).toEqual({
      "src/goneComment.ts": "comment-only",
      "src/goneCode.ts": "executable-delta",
      "src/addedComment.mjs": "comment-only",
      "src/addedCode.mjs": "executable-delta",
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

  // `verify-rebase-invariance.mjs` compares one branch's own paths across a
  // moved base, so it passes them in. What git does with a path that reads as a
  // glob is measured here rather than trusted to the magic word.
  describe("restricted to named paths", () => {
    /** A repository where a glob-shaped path has a neighbour that path matches. */
    const withGlobShapedPath = () => {
      const fixture = makeFixture();
      fixture.write("src/star[1].ts", "export const s = 1;\n");
      fixture.write("src/star1.ts", "export const n = 1;\n");
      const attested = fixture.commit("Base");
      fixture.write("src/star[1].ts", "export const s = 1; // note\n");
      fixture.write("src/star1.ts", "export const n = 2;\n");
      return { ...fixture, attested, head: fixture.commit("Touch both") };
    };

    it("compares a named path literally, not as a pattern over its neighbours", () => {
      const { git, attested, head } = withGlobShapedPath();
      expect(byPath(collectVerdicts({ attested, head, git }))).toEqual({
        "src/star[1].ts": "comment-only",
        "src/star1.ts": "executable-delta",
      });
      expect(
        byPath(
          collectVerdicts({ attested, head, git, paths: ["src/star[1].ts"] }),
        ),
      ).toEqual({ "src/star[1].ts": "comment-only" });
    });

    it("compares nothing when the named set is empty, rather than everything", () => {
      const { git, attested, head } = withGlobShapedPath();
      expect(collectVerdicts({ attested, head, git, paths: [] })).toEqual([]);
    });
  });

  // The base-sync route in `.claude/commands/assess-review.md` (Step 4) is about
  // what this verifier reports across a merge whose first parent is the attested
  // sha and whose second is the staging tip, so these build that merge with real
  // git rather than reasoning about it. The attested-to-head diff holds the
  // whole merged staging range, so the verdict follows what that range touched:
  // the merge is not itself a verdict.
  describe("across a real base-sync merge", () => {
    /** A commit's parents, in order: the first parent first. */
    const parentsOf = (git, sha) =>
      git(["rev-list", "--parents", "-n", "1", sha]).trim().split(" ").slice(1);

    /**
     * A repository whose `staging` branch holds one base commit, with `branch`
     * cut from it holding one branch-authored commit -- the sha a round
     * attested. `base` is the file content that commit starts from.
     */
    function branchCutFromStaging(base) {
      const fixture = makeFixture();
      for (const [path, text] of Object.entries(base))
        fixture.write(path, text);
      fixture.commit("Base");
      fixture.git(["branch", "-m", "staging"]);
      fixture.git(["switch", "-q", "-c", "branch"]);
      fixture.write("src/branch.ts", "export const b = 1;\n");
      return { ...fixture, attested: fixture.commit("Branch work") };
    }

    it("reports an executable delta when the merged staging range moved code", () => {
      const { git, write, commit, attested } = branchCutFromStaging({
        "src/shared.ts": "export const a = 1;\n",
        "docs/notes.md": "# Notes\n",
      });

      git(["switch", "-q", "staging"]);
      write("src/shared.ts", "export const a = 2;\n");
      write("docs/notes.md", "# Notes\n\nMore prose.\n");
      const staging = commit("Staging moves on");

      git(["switch", "-q", "branch"]);
      git([
        "merge",
        "-q",
        "--no-ff",
        "-m",
        "Merge staging into branch",
        "staging",
      ]);
      const head = git(["rev-parse", "HEAD"]).trim();

      expect(parentsOf(git, head)).toEqual([attested, staging]);
      const verdicts = collectVerdicts({ attested, head, git });
      expect(byPath(verdicts)).toEqual({
        "src/shared.ts": "executable-delta",
        "docs/notes.md": "exempt",
      });
      expect(summarize(verdicts)).toMatchObject({ holds: false, exitCode: 1 });
    });

    // A base sync can hold, so nothing may rest on it never holding: what
    // decides is what the merged range touched, and a staging range that is
    // itself only comments and markdown leaves the merge head's program
    // identical to the attested one.
    it("holds when the merged staging range is comments and markdown only", () => {
      const { git, write, commit, attested } = branchCutFromStaging({
        "src/shared.ts": "export const a = 1;\n",
        "docs/notes.md": "# Notes\n",
      });

      git(["switch", "-q", "staging"]);
      write("src/shared.ts", "// why this is one\nexport const a = 1;\n");
      write("docs/notes.md", "# Notes\n\nRewritten wholesale.\n");
      const staging = commit("Staging documents itself");

      git(["switch", "-q", "branch"]);
      git([
        "merge",
        "-q",
        "--no-ff",
        "-m",
        "Merge staging into branch",
        "staging",
      ]);
      const head = git(["rev-parse", "HEAD"]).trim();

      expect(parentsOf(git, head)).toEqual([attested, staging]);
      const verdicts = collectVerdicts({ attested, head, git });
      expect(byPath(verdicts)).toEqual({
        "src/shared.ts": "comment-only",
        "docs/notes.md": "exempt",
      });
      expect(summarize(verdicts)).toMatchObject({ holds: true, exitCode: 0 });
    });

    it("reports the executable line a conflict resolution invents over a quiet range", () => {
      const fixture = branchCutFromStaging({
        "src/shared.ts": "// the shared note\nexport const a = 1;\n",
      });
      const { git, write, commit } = fixture;
      write("src/shared.ts", "// the branch's own note\nexport const a = 1;\n");
      const attested = commit("Reword the note");

      git(["switch", "-q", "staging"]);
      write("src/shared.ts", "// staging's own note\nexport const a = 1;\n");
      const staging = commit("Reword it differently");

      git(["switch", "-q", "branch"]);
      const conflicted = spawnSync(
        "git",
        ["merge", "--no-ff", "-m", "Merge staging into branch", "staging"],
        { cwd: fixture.dir, encoding: "utf8" },
      );
      expect(conflicted.status).toBe(1);
      expect(conflicted.stdout).toMatch(/CONFLICT \(content\)/);

      // Resolving is branch-authored change, and the resolution can include a line
      // neither side had. Here the merged range was itself only a comment, and
      // the two-ref diff still shows the invented line.
      write("src/shared.ts", "// the merged note\nexport const a = 2;\n");
      const head = commit("Resolve the conflict");

      expect(parentsOf(git, head)).toEqual([attested, staging]);
      const verdicts = collectVerdicts({ attested, head, git });
      expect(byPath(verdicts)).toEqual({
        "src/shared.ts": "executable-delta",
      });
      expect(summarize(verdicts)).toMatchObject({ holds: false, exitCode: 1 });
    });
  });
});

const SCRIPT = fileURLToPath(
  new URL("./verify-nonexecutable-delta.mjs", import.meta.url),
);

// The verdict is about the tree the process runs in, so every case states its
// own `cwd`; the default is the directory holding the script, which puts a case
// that names no tree of its own inside this repository.
const runScript = (args, cwd = dirname(SCRIPT)) => {
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, [SCRIPT, ...args], {
        cwd,
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

// The script as an agent invokes it, so argv handling, the git error path, and
// the exit codes are exercised rather than assumed. Every case here resolves
// without repo history, which is what a shallow CI checkout has. Exit 3 stays
// unreachable from a subprocess -- it needs a TypeScript whose printer fails a
// probe -- and is covered only by the soundness-probe test above.
describe("the script as an agent runs it", () => {
  it("prints usage and exits 2 unless given exactly two refs", () => {
    for (const args of [[], ["only-one"], ["one", "two", "three"]]) {
      const result = runScript(args);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(
        /^Usage: node \.claude\/scripts\/verify-nonexecutable-delta\.mjs /,
      );
      expect(result.stderr).toMatch(
        /resolve in the git worktree this is run from/,
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

  // This is the one case here that runs the probes (the usage and bad-ref cases
  // above exit before reaching them), so it is the one that pays for a
  // TypeScript program: measured alone at 350-490ms across repeated runs, and
  // at over vitest's 5s default -- an outright timeout -- once during a run
  // sharing the machine's cores with the full `npm test` fan-out. Sized at
  // roughly five times that failure, not the passing runs beside it, which
  // stayed under 1.2s under the same contention.
  const SOUNDNESS_PROBE_TIMEOUT_MS = 30_000;

  it(
    "passes its probes and exits 0 over a ref compared with itself",
    { timeout: SOUNDNESS_PROBE_TIMEOUT_MS },
    () => {
      const result = runScript(["HEAD", "HEAD"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(
        /soundness probes: (\d+)\/\1 passed on typescript /,
      );
      expect(result.stdout).toContain("(none)");
      expect(result.stdout).toMatch(/non-executable-delta property: HOLDS/);
    },
  );
});

// Which tree a verdict is about, driven rather than modelled: the script sits in
// this repository throughout, and every case below runs it against a fixture
// repository somewhere else, so a verdict resolved against the script's own tree
// names paths none of these fixtures has. The failure they stand against is
// silent rather than loud, which is why it is pinned at the per-worktree refs: a
// full sha resolves and diffs identically from either tree, since linked
// worktrees share one object database, while HEAD, HEAD~n and ORIG_HEAD each
// mean a different commit per tree.
describe("the tree a verdict is about", () => {
  const toplevelOf = (dir) =>
    execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();

  it("reads a per-worktree ref pair in the invoking tree, not the one holding the script", () => {
    const fixture = makeFixture();
    fixture.write("src/only.ts", "export const a = 1;\n");
    fixture.commit("Base");
    const linked = fixture.addWorktree("side");

    fixture.write("src/only.ts", "// why this is one\nexport const a = 1;\n");
    fixture.commit("Comment it");
    linked.write("src/only.ts", "export const a = 2;\n");
    linked.commit("Change it");

    const fromPrimary = runScript(["HEAD~1", "HEAD"], fixture.dir);
    expect(fromPrimary.stdout).toMatch(/\[comment-only +\] src\/only\.ts/);
    expect(fromPrimary.stdout).toMatch(/non-executable-delta property: HOLDS/);
    expect(fromPrimary.status).toBe(0);

    const fromLinked = runScript(["HEAD~1", "HEAD"], linked.dir);
    expect(fromLinked.stdout).toMatch(/\[EXECUTABLE DELTA\] src\/only\.ts/);
    expect(fromLinked.stdout).toMatch(
      /non-executable-delta property: VIOLATED/,
    );
    expect(fromLinked.status).toBe(1);
  });

  it("names the worktree each verdict is about", () => {
    const fixture = makeFixture();
    fixture.write("src/only.ts", "export const a = 1;\n");
    fixture.commit("Base");
    const linked = fixture.addWorktree("side");
    fixture.write("src/only.ts", "export const a = 2;\n");
    fixture.commit("Change it");
    linked.write("src/only.ts", "export const a = 3;\n");
    linked.commit("Change it differently");

    expect(runScript(["HEAD~1", "HEAD"], fixture.dir).stdout).toContain(
      `worktree: ${toplevelOf(fixture.dir)}`,
    );
    expect(runScript(["HEAD~1", "HEAD"], linked.dir).stdout).toContain(
      `worktree: ${toplevelOf(linked.dir)}`,
    );
  });

  it("verdicts the whole tree from a subdirectory, which diff.relative would truncate", () => {
    const fixture = makeFixture();
    fixture.write("tools/deep/leaf.ts", "export const leaf = 1;\n");
    fixture.write("src/changed.ts", "export const a = 1;\n");
    const attested = fixture.commit("Base");
    fixture.write("src/changed.ts", "export const a = 2;\n");
    const head = fixture.commit("Change it");
    fixture.git(["config", "diff.relative", "true"]);

    // Why the run is anchored at the top level rather than at the invoking
    // directory, measured rather than assumed: under this setting the diff
    // reports nothing at all from `tools/deep`, and a run that read it would
    // hold vacuously over a changed path it never saw.
    expect(
      fixture.git([
        "-C",
        "tools/deep",
        "diff",
        "--raw",
        "--no-renames",
        attested,
        head,
      ]),
    ).toBe("");

    const result = runScript([attested, head], join(fixture.dir, "tools/deep"));
    expect(result.stdout).toContain(`worktree: ${toplevelOf(fixture.dir)}`);
    expect(result.stdout).toMatch(/\[EXECUTABLE DELTA\] src\/changed\.ts/);
    expect(result.status).toBe(1);
  });

  it("exits 2 from outside any worktree rather than falling back to its own", () => {
    const result = runScript(
      ["HEAD", "HEAD"],
      makeTempDir("nonexec-delta-bare-"),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/is not inside a git worktree/);
    expect(result.stdout).not.toMatch(/HOLDS|VIOLATED/);
  });
});
