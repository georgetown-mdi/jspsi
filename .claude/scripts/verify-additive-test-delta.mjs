#!/usr/bin/env node
// Additive-test-delta verifier, run by an agent re-attesting a review whose head
// moved by adding tests.
//
// `.claude/commands/assess-review.md` (Step 4) lets a round-attested head be
// re-attested with no fresh round when its diff against the attested sha only
// INSERTS lines in test files. This decides that property, mechanically, for the
// reason the sibling verifier's header states: nothing in CI can catch a false
// claim, since `npm run check:pr-checklist` compares the sha on the checklist
// line against the head and has no view of whether the claimed property holds.
//
// The general test-only case is NOT this property and stays refused. A test
// change can weaken a control -- a deleted assertion, a loosened expectation, a
// mock that bypasses a check -- so the only delta admitted here is one that
// leaves every line the round already read exactly where it was, and adds
// nothing that reaches past the statement holding it.
//
// What counts as a test file is a list of directories, not a guess:
// `apps/<app>/test/` and `packages/<package>/test/`, each holding only code the
// suites run. Every other path is refused, `scripts/*.test.mjs` among them --
// those are the tests OF the repository's checks, and several hold the check's
// own pin data, where one inserted entry widens a control rather than testing
// it (`scripts/sftp-tracked-round-trips.test.mjs` holds
// `ALLOWED_OUTSIDE_THE_BRACKET`, a list of call sites exempted from the bracket
// the check enforces). Inside those directories a path is read only when it is
// TypeScript or JavaScript by extension and is not a dotfile or a tool
// configuration file: a fixture, a vector, or a binary is content this verifier
// cannot read as test code, and a configuration file decides how other code is
// linted, built, or run.
//
// Insertion-only is read off git's own patch rather than a line count, because
// the count alone cannot tell an inserted line from a replaced one. Each changed
// path is diffed by itself under `--unified=0 --inter-hunk-context=0`, so every
// line in a hunk body is part of the change, and the path is admitted only when
// every one of them is an insertion. What that refuses was measured against real
// git rather than assumed, and the colocated test pins each: a replaced line
// arrives as a deletion beside its insertion, so a modification is refused; a
// deleted line is refused; appending to a file that lacked a trailing newline
// rewrites its last line, so it too arrives as a deletion and is refused; a
// binary change produces no hunks at all and is refused; and a rename, with
// rename detection off, arrives as a delete plus an add, so the delete refuses
// it. A diff algorithm is free to choose which lines it calls inserted, but it
// cannot represent a removed line as anything but a deletion, so the choice can
// only make this verifier refuse more.
//
// The patch is read per path, under `:(literal)` magic, so no file name is
// parsed out of a patch header and a path holding a glob character matches
// itself. Inside a hunk body every line has its own prefix, so an inserted
// line that reads like a patch header is still an insertion.
//
// Two classes of inserted line are refused by content, because each reaches past
// the statement that holds it and can change what an existing test measures:
//
//   - a lint or type-check suppression, which turns off a rule for code the
//     round read under it;
//   - a call into the test runner's module registry, globals, environment,
//     clock, or configuration -- `vi.mock` and its neighbours, listed below.
//     `vi.spyOn` is among them because a spy is not restored at the end of the
//     test that set it unless the suite says so, and this verifier does not read
//     each workspace's runner configuration to find out.
//
// Not covered: whether an inserted test is any good. A round reads tests for
// what they assert, and no reading happens here -- this path attests only that
// nothing the round read changed, which is why a single deleted line sends the
// head back to the paths Step 4 states.
//
// Which tree the verdict is about: git runs in the worktree the process was
// invoked from, never the one holding this file, and the run names that worktree
// above its verdicts. Name full shas -- a per-worktree ref (`HEAD`, `HEAD~n`,
// `ORIG_HEAD`) means a different commit in each linked tree.
//
// Exit codes: 0 the property holds; 1 it is violated or a changed path could not
// be read; 2 usage, an invocation from outside a git worktree, or a git error;
// 3 the verifier failed its own soundness probes. The probes drive the installed
// git over throwaway files before every run, so an attestation rests on what
// that git does rather than on what this file says it does.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  modeChange,
  parseChangedPaths,
  sidesForStatus,
} from "./verify-nonexecutable-delta.mjs";

/** The directories this verifier treats as holding test code and nothing else. */
const TEST_DIRECTORY = /^(apps|packages)\/[^/]+\/test\/[^/]/;

const TEST_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
]);

/** A dotfile, or a file named for the tool whose behaviour it configures. */
const CONFIGURATION_BASENAME =
  /^(\.|(eslint|prettier|vitest|vite|tsconfig|tsup|rollup|babel|jest|playwright|package)[.-])/i;

const REFUSED_INSERTIONS = [
  {
    name: "a lint or type-check suppression",
    pattern:
      /eslint-disable|oxlint-disable|prettier-ignore|@ts-(ignore|nocheck|expect-error)|\b(v8|c8|istanbul) ignore\b/,
    sample: "// eslint-disable-next-line no-restricted-syntax",
  },
  {
    name: "a test double reaching past the statement that holds it",
    pattern:
      /\b[A-Za-z_$][\w$]*\.(mock|doMock|unmock|doUnmock|hoisted|spyOn|stubGlobal|stubEnv|useFakeTimers|setSystemTime|setConfig)\s*\(|\bexpect\.extend\s*\(/,
    sample: 'vi.mock("../src/guard");',
  },
];

/**
 * Why a changed path is not one this verifier treats as test-only, or null where
 * it is. Every class it admits is named here, and everything else is refused.
 */
export function testPathRefusal(path) {
  if (!TEST_DIRECTORY.test(path))
    return "is outside apps/<app>/test/ and packages/<package>/test/, the only directories this verifier treats as test-only";
  const name = basename(path);
  if (CONFIGURATION_BASENAME.test(name))
    return "is a dotfile or a tool configuration file, which decides how other code is linted, built, or run";
  if (!TEST_EXTENSIONS.has(extname(name).toLowerCase()))
    return "is not a TypeScript or JavaScript file, so its inserted lines cannot be read as test code";
  return null;
}

const HUNK_HEADER = /^@@ /;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

/**
 * The lines one path's patch inserts, or in `error` the reason this verifier
 * will not read it -- which every caller checks before reading `lines`. Only the
 * hunk bodies are read: a line inside one has its own prefix, so an inserted
 * line that reads like a patch header cannot be mistaken for one.
 */
export function insertedLines(patch) {
  const lines = patch.split("\n");
  const firstHunk = lines.findIndex((line) => HUNK_HEADER.test(line));
  if (firstHunk === -1) {
    if (/^(Binary files|GIT binary patch)/m.test(patch))
      return {
        lines: [],
        error:
          "changed as a binary file, which git reports with no hunks at all, so this verifier cannot tell an insertion from a rewrite",
      };
    return {
      lines: [],
      error:
        "changed according to the diff record but produced no patch hunks, a shape this verifier does not model",
    };
  }
  const inserted = [];
  for (const line of lines.slice(firstHunk)) {
    if (line === "" || line === NO_NEWLINE_MARKER) continue;
    if (HUNK_HEADER.test(line)) continue;
    if (line.startsWith("+")) {
      inserted.push(line.slice(1));
      continue;
    }
    if (line.startsWith("-"))
      return {
        lines: [],
        error:
          "deletes a line, and a replaced line arrives the same way, so this is not an addition to what the round read",
      };
    if (line.startsWith(" "))
      return {
        lines: [],
        error:
          "holds context lines under --unified=0, so this run cannot tell an inserted line from an unchanged one",
      };
    return {
      lines: [],
      error: `holds the patch line ${JSON.stringify(line)}, a shape this verifier does not model`,
    };
  }
  return { lines: inserted, error: null };
}

/**
 * Why one of the inserted lines is refused by content, or null where none is.
 */
export function insertionRefusal(lines) {
  for (const line of lines) {
    const refused = REFUSED_INSERTIONS.find(({ pattern }) =>
      pattern.test(line),
    );
    if (refused !== undefined)
      return `inserts ${refused.name}: ${JSON.stringify(line.trim())}`;
  }
  return null;
}

/** Verdict for one changed path, given the patch git produced for it. */
export function pathVerdict({ path, patch }) {
  const pathRefusal = testPathRefusal(path);
  if (pathRefusal !== null)
    return { path, verdict: "refused", reason: pathRefusal };
  const { lines, error } = insertedLines(patch);
  if (error !== null) return { path, verdict: "refused", reason: error };
  const contentRefusal = insertionRefusal(lines);
  if (contentRefusal !== null)
    return { path, verdict: "refused", reason: contentRefusal };
  return { path, verdict: "additive-test", inserted: lines.length };
}

const PATCH_ARGS = [
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
  "--unified=0",
  "--inter-hunk-context=0",
];

/**
 * Verdicts for every path changed between two refs. `git` runs one git command
 * from an array of arguments and returns its stdout, throwing on a nonzero exit;
 * injecting it lets a test drive a fixture repository through the same code the
 * CLI runs against this one.
 */
export function collectVerdicts({ attested, head, git }) {
  for (const ref of [attested, head]) {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  }
  return parseChangedPaths(
    git(["diff", "--raw", "--no-renames", "-z", attested, head]),
  ).map(({ status, record, path, beforeMode, afterMode }) => {
    if (status === null)
      return {
        path,
        verdict: "refused",
        reason: `has the diff record ${JSON.stringify(record)}, a shape this verifier does not model`,
      };
    const sides = sidesForStatus(status);
    if (sides === null)
      return {
        path,
        verdict: "refused",
        reason: `has diff status ${status}, a shape this verifier does not model`,
      };
    if (!sides.after)
      return {
        path,
        verdict: "refused",
        reason:
          "is deleted at the head, which removes lines the round read rather than adding any",
      };
    const mode = modeChange(beforeMode, afterMode);
    if (mode !== null)
      return {
        path,
        verdict: "refused",
        reason: `changed file mode from ${mode.beforeMode} to ${mode.afterMode}, which is not a line at all`,
      };
    return pathVerdict({
      path,
      patch: git([
        "diff",
        ...PATCH_ARGS,
        attested,
        head,
        "--",
        `:(literal)${path}`,
      ]),
    });
  });
}

/** Overall outcome for a run's path verdicts, with the process exit code. */
export function summarize(verdicts) {
  const refused = verdicts.filter((v) => v.verdict === "refused");
  const holds = refused.length === 0;
  return { holds, refused, exitCode: holds ? 0 : 1 };
}

/**
 * The patch the installed git produces between two throwaway files, read
 * through the same parser a run reads a real patch with.
 */
function probePatch(before, after) {
  const dir = mkdtempSync(join(tmpdir(), "additive-test-delta-probe-"));
  try {
    writeFileSync(join(dir, "before"), before);
    writeFileSync(join(dir, "after"), after);
    // --no-index takes two paths and exits 1 when they differ, so the run is
    // read off stdout rather than off the exit status.
    const { stdout } = spawnSync(
      "git",
      ["diff", "--no-index", ...PATCH_ARGS, "--", "before", "after"],
      { cwd: dir, encoding: "utf8" },
    );
    return insertedLines(stdout ?? "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BINARY = Buffer.from([97, 0, 98]).toString("binary");

const PROBES = [
  {
    name: "an inserted line is reported as an insertion and nothing else",
    run: () => {
      const { lines, error } = probePatch("a\nb\n", "a\nnew\nb\n");
      return error === null && lines.length === 1 && lines[0] === "new";
    },
  },
  {
    name: "two insertions far apart are reported without the lines between them",
    run: () => {
      const { lines, error } = probePatch(
        "1\n2\n3\n4\n5\n6\n7\n8\n9\n",
        "1\nX\n2\n3\n4\n5\n6\n7\n8\n9\nY\n",
      );
      return error === null && lines.join(",") === "X,Y";
    },
  },
  {
    name: "a replaced line is refused rather than read as an insertion",
    run: () => probePatch("a\nb\n", "a\nB\n").error !== null,
  },
  {
    name: "a deleted line is refused",
    run: () => probePatch("a\nb\n", "a\n").error !== null,
  },
  {
    name: "appending to a file with no trailing newline is refused",
    run: () => probePatch("a", "a\nb\n").error !== null,
  },
  {
    name: "a binary change is refused rather than read as an empty insertion",
    run: () => probePatch(BINARY, "a\nc\n").error !== null,
  },
  {
    name: "an inserted line that reads like a patch header is read as an insertion",
    run: () => {
      const { lines, error } = probePatch("a\n", "a\n+++ b/x\n");
      return error === null && lines.join(",") === "+++ b/x";
    },
  },
  {
    name: "each refused insertion class matches the line it names",
    run: () =>
      REFUSED_INSERTIONS.every(
        ({ pattern, sample }) =>
          pattern.test(sample) && insertionRefusal([sample]) !== null,
      ),
  },
];

/**
 * The soundness probes as `{name, ok}` results: the properties the comparison
 * rests on, re-measured against the installed git on every run.
 */
export function soundnessProbes() {
  return PROBES.map(({ name, run }) => ({ name, ok: run() }));
}

const LABELS = {
  "additive-test": "additive test",
  refused: "REFUSED",
};

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [attested, head, ...extra] = process.argv.slice(2);
  if (!attested || !head || extra.length > 0) {
    process.stderr.write(
      "Usage: node .claude/scripts/verify-additive-test-delta.mjs <attested-sha> <head-sha>\n" +
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
      "verifier is unsound on the installed git -- no verdict; fix .claude/scripts/verify-additive-test-delta.mjs before attesting anything\n",
    );
    process.exit(3);
  }

  let worktree;
  let gitVersion;
  try {
    const run = (args) =>
      execFileSync("git", args, {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    gitVersion = run(["--version"]);
    worktree = run(["rev-parse", "--show-toplevel"]);
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
    `soundness probes: ${PROBES.length}/${PROBES.length} passed on ${gitVersion}\n`,
  );
  process.stdout.write(`worktree: ${worktree}\n`);
  process.stdout.write(`changed paths ${attested}..${head}:\n`);
  if (verdicts.length === 0) process.stdout.write("  (none)\n");
  for (const { path, verdict, reason, inserted } of verdicts) {
    const count = inserted === undefined ? "" : ` (+${inserted})`;
    process.stdout.write(
      `  [${LABELS[verdict].padEnd(width)}] ${path}${count}\n`,
    );
    if (reason !== undefined)
      process.stdout.write(`   ${" ".repeat(width)} ${reason}\n`);
  }

  const { holds, refused, exitCode } = summarize(verdicts);
  process.stdout.write(
    holds
      ? "\nadditive-test-delta property: HOLDS -- this head may be re-attested, recording both shas on the checklist line\n"
      : `\nadditive-test-delta property: VIOLATED -- ${refused.length} refused path(s); this head takes one of the other paths Step 4 states, or a full review round\n`,
  );
  process.exit(exitCode);
}
