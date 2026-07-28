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
// it; every other non-source path -- package.json, a workflow yaml, a
// Dockerfile, a .sh -- is UNVERIFIABLE and fails the run rather than being waved
// through as "not a JS/TS extension", which would attest an executable delta in
// any of them. A verifier backing an attestation must not report HOLDS over a
// file it did not examine.
//
// A side that does not exist canonicalizes to the empty program, so adding or
// deleting a comments-only file reads comment-only while adding or deleting one
// carrying any statement reads as an executable delta. Rename detection is off,
// so a rename arrives as a delete plus an add and reads as an executable delta
// on both paths -- a moved module is a changed program.
//
// Not covered: file modes, so a chmod with no content change reads comment-only;
// markdown content wholesale, including a fenced code block an operator would
// copy out; and the normalizations the printer applies, each measured and pinned
// by the test -- whitespace, blank lines, indentation, quote style, ASI
// semicolons, trailing commas, and numeric literal form all compare equal. The
// verdict is "no executable delta", not "the bytes match".
//
// Exit codes: 0 the property holds; 1 it is violated or a changed path could not
// be verified; 2 usage or git error; 3 the verifier failed its own soundness
// probes. The probes run before every comparison so an attestation proves its
// soundness on the TypeScript actually installed, rather than trusting that CI
// ran the test suite at some point.

import { execFileSync } from "node:child_process";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const EXEMPT_EXTENSIONS = new Set([".md"]);

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
 * `source` (parsed and compared), or `unverifiable` (anything else, which fails
 * the run).
 */
export function classifyPath(path) {
  const extension = extname(path).toLowerCase();
  if (EXEMPT_EXTENSIONS.has(extension)) return "exempt";
  if (SCRIPT_KINDS.has(extension)) return "source";
  return "unverifiable";
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
        "not markdown and not a TypeScript/JavaScript path -- this verifier cannot read it for executable content",
    };
  }
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
 * Which sides of a `--name-status` entry exist, or null for a status this
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

/**
 * `git diff --name-status -z` output as `{status, path}` entries. An R/C entry
 * carries a second path; `--no-renames` rules those out, but the extra field is
 * consumed anyway so one unexpected entry cannot desync the rest of the parse.
 */
export function parseChangedPaths(stdout) {
  const fields = stdout.split("\0").filter((field) => field !== "");
  const entries = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i];
    i += 1;
    if (/^[RC]/.test(status)) {
      entries.push({ status, path: fields[i + 1] });
      i += 2;
      continue;
    }
    entries.push({ status, path: fields[i] });
    i += 1;
  }
  return entries;
}

/**
 * Verdicts for every path changed between two refs. `git` runs one git command
 * from an array of arguments and returns its stdout, throwing on a nonzero exit;
 * injecting it lets a test drive a fixture repo through the same code the CLI
 * runs against this one.
 */
export function collectVerdicts({ attested, head, git }) {
  for (const ref of [attested, head]) {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  }
  return parseChangedPaths(
    git(["diff", "--name-status", "--no-renames", "-z", attested, head]),
  ).map(({ status, path }) => {
    const sides = sidesForStatus(status);
    if (sides === null) {
      return {
        path,
        verdict: "unverifiable",
        reason: `diff status ${status} is not modelled -- compare it by hand or take a full round`,
      };
    }
    // Content is read only for a parseable source path; an exempt or
    // unverifiable verdict is decided by the path alone.
    const isSource = classifyPath(path) === "source";
    return fileVerdict({
      path,
      before:
        isSource && sides.before ? git(["show", `${attested}:${path}`]) : null,
      after: isSource && sides.after ? git(["show", `${head}:${path}`]) : null,
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
];

/**
 * The soundness probes as `{name, ok}` results: the properties the comparison
 * rests on, re-measured against the installed TypeScript on every run.
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
      "Usage: node .claude/scripts/verify-nonexecutable-delta.mjs <attested-sha> <head-sha>\n",
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

  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
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
