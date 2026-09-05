#!/usr/bin/env node
// Non-executable-delta verifier, run by an agent re-attesting a review.
//
// CLAUDE.md lets a pull request head be re-attested without a fresh review round
// when its diff against the already-reviewed sha changes no executable line --
// comments and markdown only. The rule requires that property be verified
// mechanically or not at all, and nothing in CI can catch a false claim:
// `npm run check:pr-checklist` compares the sha on the checklist line against
// the head and has no view of whether the claimed property holds, so an
// eyeballed "comment-only" lands an unreviewed head as reviewed.
//
// The comparison: parse each side of each changed source file to a SourceFile
// and print it back with comments suppressed; the two printed strings must be
// equal. Two cheaper primitives were measured wrong and are not to be reached
// for again -- the colocated test pins both failure modes against the installed
// TypeScript:
//
//   - the compiler's *emit* erases type positions along with comments, so a
//     type-only edit compares identical under it -- a real change attested away;
//   - a raw scanner has no parser context, so a backtick inside a comment puts
//     it in template state and it reports a comment-only edit as a change.
//
// Path classification fails closed. Markdown is exempt because the rule names
// it; a `.yml`/`.yaml` path is parsed and compared as YAML (below); every other
// non-source path -- package.json, a Dockerfile, a .sh -- is UNVERIFIABLE and
// fails the run rather than being accepted as "not a JS/TS extension",
// which would attest an executable delta in any of them. A verifier backing an
// attestation must not report HOLDS over a file it did not examine.
//
// YAML comparison: parse each side with the `yaml` package and deep-compare the
// values it materializes with `node:util`'s `isDeepStrictEqual`, which treats a
// mapping's key order as insignificant -- YAML's is -- while keeping a
// sequence's, which is not. A comparison key built by stringifying the value is
// measured wrong here the same way the two cheaper source primitives above are,
// and is not to be reached for again: `JSON.stringify` writes NaN, Infinity,
// -Infinity and null all as `null`, and an own-keys walk writes every Date
// (`!!timestamp`) and every Set (`!!set`) as the same empty object, so a real
// value change in any of them is treated as comment-only. The colocated test pins each
// of those cases as an executable delta.
//
// `uniqueKeys` and `strict` are passed even though both already default on, so a
// future default change cannot silently loosen the check. Three conditions are
// then UNVERIFIABLE rather than compared, each measured against the installed
// `yaml` and each with a soundness probe standing on it:
//
//   - a stream holding more than one document, because this verifier does not
//     attempt to align documents across two multi-document streams;
//   - a document `parseAllDocuments` reports a diagnostic for, a duplicate key
//     among them: it lands as a `doc.errors` entry rather than being resolved
//     last-wins, so it fails closed the way a syntax error does;
//   - a document that parses clean and cannot be materialized, because
//     `doc.errors` does not report every unsafe materialization -- an
//     unresolved alias throws out of `toJS()`, an alias-expansion bomb trips
//     that package's own resource cap, and an anchor aliased inside its own
//     value comes back as a circular object with no diagnostic at all, refused
//     because nothing finite was read.
//
// Each refusal is a reason on that path's own verdict, so an unreadable file
// leaves every other path in the run with a verdict. An empty or comment-only
// stream is the one zero-document case, and canonicalizes to the same `null`
// value an absent side does, so adding or deleting a comment-only YAML file
// is treated as comment-only while adding or deleting one holding any value is
// treated as an executable delta -- the same rule the source comparison applies below.
//
// A side that does not exist canonicalizes to the empty program, so adding or
// deleting a comments-only file is treated as comment-only while adding or
// deleting one holding any statement is treated as an executable delta. Rename
// detection is off, so a rename arrives as a delete plus an add and is treated
// as an executable delta on both paths -- a moved module is a changed program.
//
// File modes come off the diff record rather than the content, because a chmod
// leaves the blob identical and any content comparison treats it as no change at
// all. A path whose mode differs across two sides that both exist is
// UNVERIFIABLE whatever its extension -- the markdown exemption is for content --
// since the comparison reads programs and cannot say whether making one runnable
// is harmless. Modes are compared only across sides that exist, so an addition or
// a deletion, whose absent side is recorded as 000000, is not failed for that alone.
//
// Not covered: markdown content wholesale, including a fenced code block an
// operator would copy out; and the normalizations the printer applies, each
// measured and pinned by the test -- whitespace, blank lines, indentation, quote
// style, ASI semicolons, trailing commas, and numeric literal form all compare
// equal. The verdict is "no executable delta", not "the bytes match".
//
// Which tree the verdict is about: git runs in the worktree the process was
// invoked from, never the one holding this file, and the run names that worktree
// above its verdicts. The two are routinely different -- the primary checkout's
// copy is called by absolute path while the branch under review sits in a linked
// worktree -- and every ref short of a full sha is per-worktree, so binding to
// the script's own location resolves HEAD, HEAD~n and ORIG_HEAD against a tree
// nobody named and prints a confident verdict for a diff nobody asked about. A
// full sha is the case that hides it: linked worktrees share one object
// database, so those two resolve and diff identically from either tree.
//
// Commands run at that worktree's top level rather than at the invoking
// directory, which is measured to matter in both directions: under
// `diff.relative` a run from a subdirectory drops every changed path outside it
// and reports a vacuous HOLDS, and the `--raw` paths are root-relative only when
// the prefix is empty, which is what `git show <ref>:<path>` then reads.
//
// Exit codes: 0 the property holds; 1 it is violated or a changed path could not
// be verified; 2 usage, an invocation from outside a git worktree, or a git
// error; 3 the verifier failed its own soundness probes. The probes run before
// every comparison so an attestation proves its soundness on the TypeScript and
// `yaml` actually installed, rather than trusting that CI ran the test suite at
// some point.

import { execFileSync } from "node:child_process";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";
import { parseAllDocuments } from "yaml";

const EXEMPT_EXTENSIONS = new Set([".md"]);
const YAML_EXTENSIONS = new Set([".yml", ".yaml"]);

const SCRIPT_KINDS = new Map([
  [".ts", ts.ScriptKind.TS],
  [".mts", ts.ScriptKind.TS],
  [".cts", ts.ScriptKind.TS],
  [".tsx", ts.ScriptKind.TSX],
  [".js", ts.ScriptKind.JS],
  [".mjs", ts.ScriptKind.JS],
  [".cjs", ts.ScriptKind.JS],
  [".jsx", ts.ScriptKind.JSX],
]);

const printer = ts.createPrinter({ removeComments: true });

/**
 * How a changed path is handled: `exempt` (markdown, which the rule allows),
 * `source` (parsed and compared as TypeScript/JavaScript), `yaml` (parsed and
 * compared as YAML), or `unverifiable` (anything else, which fails the run).
 */
export function classifyPath(path) {
  const extension = extname(path).toLowerCase();
  if (EXEMPT_EXTENSIONS.has(extension)) return "exempt";
  if (SCRIPT_KINDS.has(extension)) return "source";
  if (YAML_EXTENSIONS.has(extension)) return "yaml";
  return "unverifiable";
}

/** Whether a path's content (rather than its classification alone) decides its verdict. */
function needsContent(path) {
  const classification = classifyPath(path);
  return classification === "source" || classification === "yaml";
}

/**
 * Canonical form of one side of a source file -- the parsed AST printed back
 * with comments suppressed -- plus its parse-error count. `text` is null for a
 * side where the file does not exist, canonicalizing to the empty program.
 */
export function canonicalSource(text, path) {
  const source = ts.createSourceFile(
    path,
    text ?? "",
    ts.ScriptTarget.Latest,
    false,
    SCRIPT_KINDS.get(extname(path).toLowerCase()),
  );
  // parseDiagnostics is off the public SourceFile type, so read it defensively
  // and let a non-array count (NaN) fall through as unverifiable; a soundness
  // probe pins that it is present and populated, so a rename in a TypeScript
  // upgrade aborts the run rather than reporting every file error-free.
  const parseErrors = Array.isArray(source.parseDiagnostics)
    ? source.parseDiagnostics.length
    : Number.NaN;
  return { canonical: printer.printFile(source), parseErrors };
}

/**
 * Whether a materialized YAML value contains a reference back to itself.
 * `ancestors` is the path currently being walked and `acyclic` the nodes
 * already cleared, which keeps a document whose aliases share subtrees to one
 * visit per node.
 */
function containsCycle(value, ancestors = new Set(), acyclic = new Set()) {
  if (value === null || typeof value !== "object") return false;
  if (ancestors.has(value)) return true;
  if (acyclic.has(value)) return false;
  ancestors.add(value);
  const children =
    value instanceof Map
      ? [...value.keys(), ...value.values()]
      : value instanceof Set
        ? [...value]
        : Object.values(value);
  const cyclic = children.some((child) =>
    containsCycle(child, ancestors, acyclic),
  );
  ancestors.delete(value);
  if (!cyclic) acyclic.add(value);
  return cyclic;
}

/**
 * Canonical form of one side of a YAML path -- the value its single document
 * materializes to -- or, in `error`, the reason this verifier will not compare
 * that side, which every caller checks before reading `value`. `text` is null
 * for a side where the file does not exist; that and a zero-document stream
 * (an empty or comment-only file) both canonicalize to `value: null`, the same
 * "no content" reading `canonicalSource` gives an absent TypeScript/JavaScript
 * side. Nothing the side is refused for throws out of here: a refusal is a
 * reason string, so the run's other paths still reach their own verdicts.
 */
export function canonicalYaml(text) {
  if (text === null) return { value: null, error: null };
  let documents;
  try {
    documents = parseAllDocuments(text, { uniqueKeys: true, strict: true });
  } catch (error) {
    return { value: undefined, error: `does not parse: ${error.message}` };
  }
  if (documents.length > 1) {
    return {
      value: undefined,
      error: `carries ${documents.length} YAML documents in one stream -- this verifier compares a single document only`,
    };
  }
  const [document] = documents;
  if (document === undefined) return { value: null, error: null };
  if (document.errors.length > 0) {
    return {
      value: undefined,
      error: `does not parse: ${document.errors[0].message}`,
    };
  }
  let value;
  try {
    value = document.toJS();
    if (containsCycle(value)) {
      return {
        value: undefined,
        error:
          "refers to itself -- this verifier compares finite values, and an anchor aliased inside its own value materializes to a circular one",
      };
    }
  } catch (error) {
    return {
      value: undefined,
      error: `does not materialize: ${error.message}`,
    };
  }
  return { value, error: null };
}

/**
 * Verdict for one changed YAML path. `before` and `after` are the file's text
 * at each ref, or null where it does not exist on that side. A refused side is
 * named in the reason, the way the source comparison names the side its parse
 * errors came from.
 */
export function yamlVerdict({ path, before, after }) {
  const left = canonicalYaml(before);
  const right = canonicalYaml(after);
  if (left.error !== null || right.error !== null) {
    return {
      path,
      verdict: "unverifiable",
      reason: [
        left.error === null ? null : `before ${left.error}`,
        right.error === null ? null : `after ${right.error}`,
      ]
        .filter((reason) => reason !== null)
        .join("; "),
    };
  }
  return {
    path,
    verdict: isDeepStrictEqual(left.value, right.value)
      ? "comment-only"
      : "executable-delta",
  };
}

/**
 * Verdict for one changed path. `before` and `after` are the file's text at each
 * ref, or null where it does not exist on that side; both are ignored for a path
 * decided by classification alone.
 */
export function fileVerdict({ path, before, after }) {
  const classification = classifyPath(path);
  if (classification === "exempt") return { path, verdict: "exempt" };
  if (classification === "unverifiable") {
    return {
      path,
      verdict: "unverifiable",
      reason:
        "not markdown, YAML, or a TypeScript/JavaScript path -- this verifier cannot read it for executable content",
    };
  }
  if (classification === "yaml") return yamlVerdict({ path, before, after });
  const left = canonicalSource(before, path);
  const right = canonicalSource(after, path);
  if (left.parseErrors !== 0 || right.parseErrors !== 0) {
    return {
      path,
      verdict: "unverifiable",
      reason: `parse errors (${left.parseErrors} before, ${right.parseErrors} after) -- the printed form of a broken parse is invented, not canonical`,
    };
  }
  return {
    path,
    verdict:
      left.canonical === right.canonical ? "comment-only" : "executable-delta",
  };
}

/**
 * Which sides of a `--raw` record exist, or null for a status this
 * verifier does not model -- a type change (a file swapped for a symlink, whose
 * blob is a path rather than a program), or a rename/copy that survived
 * `--no-renames`.
 */
export function sidesForStatus(status) {
  if (status === "A") return { before: false, after: true };
  if (status === "D") return { before: true, after: false };
  if (status === "M") return { before: true, after: true };
  return null;
}

const ABSENT_MODE = "000000";

/**
 * The file-mode change between the two sides of a diff record, or null where
 * there is none to report. A side that does not exist is recorded as `000000`, which is
 * not a mode the file ever had, so modes are compared only where both sides
 * exist.
 */
export function modeChange(beforeMode, afterMode) {
  if (beforeMode === ABSENT_MODE || afterMode === ABSENT_MODE) return null;
  if (beforeMode === afterMode) return null;
  return { beforeMode, afterMode };
}

const RAW_RECORD = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z]\d*)$/;

/**
 * `git diff --raw -z` output as `{status, path, beforeMode, afterMode}` entries.
 * The raw format is the one that holds file modes; `--name-status` reports a
 * mode-only change as a bare `M` and would attest a chmod away. Its metadata
 * field packs both modes and the status, NUL-separated from the path that
 * follows, so a record whose metadata does not read reports a null status --
 * with its raw text as `record` -- to fail closed downstream. Such a record
 * still consumes one path field, as an R/C entry consumes its second path, so
 * one unexpected entry cannot desync the rest of the parse.
 */
export function parseChangedPaths(stdout) {
  const fields = stdout.split("\0").filter((field) => field !== "");
  const entries = [];
  for (let i = 0; i < fields.length;) {
    const record = fields[i];
    i += 1;
    const metadata = RAW_RECORD.exec(record);
    if (metadata === null) {
      entries.push({ status: null, record, path: fields[i] });
      i += 1;
      continue;
    }
    const [, beforeMode, afterMode, status] = metadata;
    const pathFields = /^[RC]/.test(status) ? 2 : 1;
    entries.push({
      status,
      path: fields[i + pathFields - 1],
      beforeMode,
      afterMode,
    });
    i += pathFields;
  }
  return entries;
}

/**
 * Verdicts for every path changed between two refs. `git` runs one git command
 * from an array of arguments and returns its stdout, throwing on a nonzero exit;
 * injecting it lets a test drive a fixture repo through the same code the CLI
 * runs against this one.
 *
 * `paths`, where given, narrows the diff to exactly those paths -- an empty
 * array to none of them. Each goes to git under `:(literal)` magic, so a path
 * holding `*`, `?`, or a bracket matches itself rather than globbing over its
 * neighbours. The caller that passes it -- `verify-rebase-invariance.mjs`,
 * comparing one branch's own paths across a moved base -- owns the argument
 * that the paths it leaves out need no verdict.
 */
export function collectVerdicts({ attested, head, git, paths }) {
  for (const ref of [attested, head]) {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  }
  if (paths !== undefined && paths.length === 0) return [];
  const restriction =
    paths === undefined ? [] : ["--", ...paths.map((p) => `:(literal)${p}`)];
  return parseChangedPaths(
    git([
      "diff",
      "--raw",
      "--no-renames",
      "-z",
      attested,
      head,
      ...restriction,
    ]),
  ).map(({ status, record, path, beforeMode, afterMode }) => {
    if (status === null) {
      return {
        path,
        verdict: "unverifiable",
        reason: `diff record "${record}" has a shape this verifier does not model -- compare it by hand or take a full round`,
      };
    }
    const sides = sidesForStatus(status);
    if (sides === null) {
      return {
        path,
        verdict: "unverifiable",
        reason: `diff status ${status} is not modelled -- compare it by hand or take a full round`,
      };
    }
    const mode = modeChange(beforeMode, afterMode);
    if (mode !== null) {
      return {
        path,
        verdict: "unverifiable",
        reason: `file mode changed from ${mode.beforeMode} to ${mode.afterMode} -- this verifier compares file content, not modes`,
      };
    }
    // Content is read only for a parseable path; an exempt or unverifiable
    // verdict is decided by the path alone.
    const readContent = needsContent(path);
    return fileVerdict({
      path,
      before:
        readContent && sides.before
          ? git(["show", `${attested}:${path}`])
          : null,
      after:
        readContent && sides.after ? git(["show", `${head}:${path}`]) : null,
    });
  });
}

/** Overall outcome for a run's file verdicts, with the process exit code. */
export function summarize(verdicts) {
  const deltas = verdicts.filter((v) => v.verdict === "executable-delta");
  const unverifiable = verdicts.filter((v) => v.verdict === "unverifiable");
  const holds = deltas.length === 0 && unverifiable.length === 0;
  return { holds, deltas, unverifiable, exitCode: holds ? 0 : 1 };
}

const probeCanonical = (text, path = "probe.ts") =>
  canonicalSource(text, path).canonical;

const probeYamlVerdict = (before, after) =>
  yamlVerdict({ path: "probe.yaml", before, after }).verdict;

const PROBES = [
  {
    name: "comments are suppressed (line, block, and JSDoc)",
    run: () =>
      probeCanonical(
        "/**\n * Doc.\n * @param x thing\n */\n// line\nexport function f(x) {\n  return x; /* block */\n}\n",
      ) === probeCanonical("export function f(x) {\n  return x;\n}\n"),
  },
  {
    name: "a backtick inside a comment reads as comment-only",
    run: () => {
      const base = "const a: string = `x`;\n";
      return (
        probeCanonical(base) === probeCanonical("// tick ` here\n" + base) &&
        probeCanonical(base) === probeCanonical("/* tick ` ${x} */\n" + base)
      );
    },
  },
  {
    name: "a type annotation edit reads as a change",
    run: () =>
      probeCanonical("function f(p: number) {\n  return p;\n}\n") !==
      probeCanonical("function f(p: string) {\n  return p;\n}\n"),
  },
  {
    name: "a type alias edit reads as a change",
    run: () =>
      probeCanonical("type T = string;\n") !==
      probeCanonical("type T = number;\n"),
  },
  {
    name: "an absent side canonicalizes to the empty program",
    run: () =>
      probeCanonical(null) === "" &&
      probeCanonical("// comments only\n") === "",
  },
  {
    name: "a parse error is counted rather than printed as canonical",
    run: () =>
      canonicalSource("const a = ;\nfunction (\n", "probe.ts").parseErrors >
        0 && canonicalSource("const a = 1;\n", "probe.ts").parseErrors === 0,
  },
  {
    name: "a YAML comment change reads as comment-only",
    run: () =>
      probeYamlVerdict("a: 1 # x\nb: 2\n", "a: 1 # y\nb: 2\n") ===
      "comment-only",
  },
  {
    name: "reordering YAML mapping keys reads as comment-only",
    run: () =>
      probeYamlVerdict("a: 1\nb: 2\n", "b: 2\na: 1\n") === "comment-only",
  },
  {
    name: "reordering a YAML sequence reads as a change",
    run: () =>
      probeYamlVerdict("a:\n  - 1\n  - 2\n", "a:\n  - 2\n  - 1\n") ===
      "executable-delta",
  },
  {
    name: "YAML values that share one JSON text read as a change",
    run: () =>
      probeYamlVerdict("a: .nan\n", "a: .inf\n") === "executable-delta" &&
      probeYamlVerdict("a: .inf\n", "a: -.inf\n") === "executable-delta" &&
      probeYamlVerdict("a: null\n", "a: .nan\n") === "executable-delta" &&
      probeYamlVerdict("a: .nan # x\n", "a: .nan # y\n") === "comment-only",
  },
  {
    name: "YAML values that share one set of own keys read as a change",
    run: () =>
      probeYamlVerdict(
        "a: !!timestamp 2001-12-14\n",
        "a: !!timestamp 2002-12-14\n",
      ) === "executable-delta" &&
      probeYamlVerdict("a: !!set\n  ? x\n", "a: !!set\n  ? y\n") ===
        "executable-delta",
  },
  {
    name: "a duplicate YAML key is refused rather than resolved last-wins",
    run: () => canonicalYaml("a: 1\na: 2\n").error !== null,
  },
  {
    name: "a multi-document YAML stream is refused rather than compared partially",
    run: () => canonicalYaml("a: 1\n---\nb: 2\n").error !== null,
  },
  {
    name: "a YAML alias that does not resolve is refused rather than thrown",
    run: () => canonicalYaml("a: *missing\n").error !== null,
  },
  {
    name: "a self-referential YAML anchor is refused rather than compared",
    run: () => canonicalYaml("a: &x\n  b: *x\n").error !== null,
  },
  {
    name: "an absent YAML side canonicalizes to the same value as an empty document",
    run: () =>
      canonicalYaml(null).error === null &&
      canonicalYaml(null).value === null &&
      canonicalYaml("# comment only\n").error === null &&
      canonicalYaml("# comment only\n").value === null,
  },
];

/**
 * The soundness probes as `{name, ok}` results: the properties the comparisons
 * rest on, re-measured against the installed TypeScript and `yaml` on every run.
 */
export function soundnessProbes() {
  return PROBES.map(({ name, run }) => ({ name, ok: run() }));
}

const LABELS = {
  exempt: "exempt",
  "comment-only": "comment-only",
  "executable-delta": "EXECUTABLE DELTA",
  unverifiable: "UNVERIFIABLE",
};

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [attested, head, ...extra] = process.argv.slice(2);
  if (!attested || !head || extra.length > 0) {
    process.stderr.write(
      "Usage: node .claude/scripts/verify-nonexecutable-delta.mjs <attested-sha> <head-sha>\n" +
        "Both refs resolve in the git worktree this is run from, whatever tree holds the script,\n" +
        "and that worktree is what the verdict is about. A per-worktree ref (HEAD, HEAD~n,\n" +
        "ORIG_HEAD) means a different commit in each linked tree, so name full shas unless you\n" +
        "are running inside the tree you mean.\n",
    );
    process.exit(2);
  }

  const failedProbes = soundnessProbes().filter((probe) => !probe.ok);
  if (failedProbes.length > 0) {
    for (const probe of failedProbes) {
      process.stderr.write(`soundness probe failed: ${probe.name}\n`);
    }
    process.stderr.write(
      `verifier is unsound on typescript ${ts.version} -- no verdict; fix .claude/scripts/verify-nonexecutable-delta.mjs before attesting anything\n`,
    );
    process.exit(3);
  }

  let worktree;
  try {
    worktree = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    process.stderr.write(
      `error: ${process.cwd()} is not inside a git worktree -- this verifier reports on the tree it is run from, so run it inside the one whose refs you are naming (git: ${error.message ?? error})\n`,
    );
    process.exit(2);
  }

  const git = (args) =>
    execFileSync("git", args, {
      cwd: worktree,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });

  let verdicts;
  try {
    verdicts = collectVerdicts({ attested, head, git });
  } catch (error) {
    process.stderr.write(`error: ${error.message ?? error}\n`);
    process.exit(2);
  }

  const width = Math.max(...Object.values(LABELS).map((l) => l.length));
  process.stdout.write(
    `soundness probes: ${PROBES.length}/${PROBES.length} passed on typescript ${ts.version}\n`,
  );
  process.stdout.write(`worktree: ${worktree}\n`);
  process.stdout.write(`changed paths ${attested}..${head}:\n`);
  if (verdicts.length === 0) process.stdout.write("  (none)\n");
  for (const { path, verdict, reason } of verdicts) {
    process.stdout.write(`  [${LABELS[verdict].padEnd(width)}] ${path}\n`);
    if (reason !== undefined)
      process.stdout.write(`   ${" ".repeat(width)} ${reason}\n`);
  }

  const { holds, deltas, unverifiable, exitCode } = summarize(verdicts);
  process.stdout.write(
    holds
      ? `\nnon-executable-delta property: HOLDS -- this head may be re-attested, recording both shas on the checklist line\n`
      : `\nnon-executable-delta property: VIOLATED -- ${deltas.length} executable delta(s), ${unverifiable.length} unverifiable path(s); this head takes a full review round\n`,
  );
  process.exit(exitCode);
}
