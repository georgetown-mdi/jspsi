#!/usr/bin/env node
// PreToolUse hook: refuse a Bash command that writes to a path under /tmp which
// does not resolve where it is written, but into a git worktree.
//
// Why this exists: a session created its scratch directory under a fixed /tmp
// name instead of the one `mktemp -d` prints. An earlier session had left that
// same name behind as a symlink into a checkout of this repository, so the write
// followed the link and landed on repository content -- a tracked file
// overwritten by scratch output, silently, because every command involved
// succeeded and reported what it was asked to report. Nothing catches that at
// the time: the author wrote a /tmp path, read a /tmp path back, and the damage
// showed up only when a later check read the file that had been replaced.
//
// WHAT DECIDES IS RESOLUTION, NOT THE NAME. A fixed name is the habit that walks
// into this, and the message says so, but a hook cannot tell a fixed name from a
// generated one by looking at it -- and the damage needs no fixed name, only a
// scratch path that resolves somewhere it was not written. So the two conditions
// are that the path is REDIRECTED -- something below /tmp sends it elsewhere --
// and that where it lands is inside a git worktree. A directory `mktemp -d` made
// is a real directory and resolves to itself, so it never matches; neither does
// any other scratch path nothing has redirected, the detached worktree a rebase
// is done in under /tmp included, which is a git worktree standing exactly where
// it was written. A platform whose /tmp is itself a symlink (macOS, /private/tmp)
// redirects every scratch path alike, so the scratch root is resolved before the
// comparison and only what lies BELOW it counts as a redirect.
//
// A PATH THE COMMAND DID NOT WRITE AS /tmp IS NOT THIS HOOK'S BUSINESS. A
// deliberate `cp /tmp/scratch/report.md <repo path>` names its destination in the
// repository and passes untouched; what is refused is only a destination the
// author spelled as scratch.
//
// WHAT IT READS as a write: a redirection target, and the path operands of the
// writing commands in WRITING_COMMANDS below. Reading through such a path, and
// removing the stale link itself (`rm /tmp/<name>`), are deliberately left alone
// -- removing the link is the fix, and blocking it would leave the session no way
// to clear what it just tripped over.
//
// STATED LIMITS. This reads a plain command line, so each of these reaches a
// worktree. They are recorded rather than closed: closing them means a
// shell-syntax-aware parser, a larger and more fragile thing than the accident
// this guards against. What it binds is that accident, not a determined bypass.
//   - Composition is not unwrapped: a subshell, a command substitution, `bash -c
//     "..."`, an alias, a shell function. A heredoc body and a quoted string are
//     read as command text of their own, which over-refuses -- in the guarded
//     direction, and only where the path they hold resolves into a worktree.
//   - A path that only exists at runtime is not seen: one held in a variable,
//     produced by a glob, or read from a file.
//   - A writing command reached through a prefix word outside COMMAND_PREFIX_WORDS
//     (`timeout 5 cp ...`), or through `xargs` or `find -exec`, is not read.
//   - A program that writes files of its own accord -- an interpreter given a
//     script, a build tool handed an output directory -- names no write here.
//   - A `cd` on the line does not move what a relative path resolves against;
//     only the directory the call itself was made from does.
//   - Resolution is read at the time of the call. A link created later on the
//     same line is not the link this saw.
//
// Exit 0 allows the call; exit 2 blocks it and feeds stderr back to Claude. Any
// unexpected failure here falls through to exit 0 (fail open) so a bug in this
// hook can never wedge every Bash command.

import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

import { commandOf, eventCwd, eventForTools } from "./lib/event.mjs";
import { canonicalPath, nearestExistingDirectory } from "./lib/paths.mjs";
import { splitSegments, tokenize } from "./lib/shell.mjs";
import {
  isInside,
  isStrictlyInside,
  owningWorktree,
  worktreeRecords,
} from "./lib/worktrees.mjs";

// The directories a path is scratch for being under, in both spellings each has,
// so a command naming the resolved form of a scratch root directly is read as
// scratch too.
const TMP_ROOTS = [
  ...new Set(["/tmp", tmpdir()].flatMap((root) => [root, canonicalPath(root)])),
];

// Commands whose path operands are files they create or overwrite. `sed` is here
// only for its in-place spelling; without one it writes to standard output, and
// the redirect that captures it is read on its own. `ln` is read by its own rule
// in `linkTargets`, since only the link name it creates is a write.
const WRITING_COMMANDS = new Set([
  "cp",
  "dd",
  "install",
  "ln",
  "mkdir",
  "mv",
  "rsync",
  "sed",
  "tee",
  "touch",
  "truncate",
]);

// Words that stand in front of the real command word without changing which
// command runs. Each takes only option-shaped arguments of its own, which is why
// `timeout`, whose duration stands as a bare positional, is absent.
const COMMAND_PREFIX_WORDS = new Set([
  "command",
  "doas",
  "env",
  "nice",
  "nohup",
  "setsid",
  "stdbuf",
  "sudo",
  "time",
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// A redirection operator at the head of a token: an optional file descriptor or
// `&`, and one or two `>`. What follows it in the same token is the target when
// there is anything (`2>/tmp/log`); otherwise the target is the next token
// (`2> /tmp/log`).
const REDIRECT = /^(?:[0-9]+|&)?>{1,2}/;

// The noclobber override `>|` is the same redirection, written with a byte the
// stage splitting takes for a pipe -- which would otherwise leave the operator
// at the end of one stage and its target at the head of the next. Dropping the
// bar before anything is split keeps it one redirection.
const NOCLOBBER = />\|/g;

// dd names its operands by keyword rather than by position.
const DD_OPERAND = /^(?:of|if)=/;

// The `ln` flag naming the directory the links are made in, in its two
// spellings. The short one takes the rest of its own cluster as the directory
// when there is any (`-st DIR`, `-tDIR`), which is why the value is captured
// here rather than assumed to be the next word.
const TARGET_DIRECTORY_LONG = /^--target-directory(?:=(.*))?$/;
const TARGET_DIRECTORY_SHORT = /^-[a-zA-Z]*?t(.*)$/;

function isPathOperand(token) {
  return token.length > 0 && !token.startsWith("-");
}

// The command a segment invokes and its arguments, with leading assignments and
// prefix words peeled off; null when the segment invokes nothing. A flag that
// belongs to a prefix word is stepped over; the value such a flag can take
// (`sudo -u NAME`) then stands where the command word belongs and is read as the
// command, which loses a write rather than inventing one.
function invocation(tokens) {
  let index = 0;
  let sawPrefixWord = false;
  while (index < tokens.length) {
    const token = tokens[index];
    if (ASSIGNMENT.test(token)) {
      index++;
      continue;
    }
    if (COMMAND_PREFIX_WORDS.has(token)) {
      sawPrefixWord = true;
      index++;
      continue;
    }
    if (sawPrefixWord && token.startsWith("-")) {
      index++;
      continue;
    }
    break;
  }
  const word = tokens[index];
  if (word === undefined) return null;
  return { name: basename(word), args: tokens.slice(index + 1) };
}

// Every redirection target on a segment. A token whose remainder begins with `&`
// is a descriptor duplication (`2>&1`), which names no file.
function redirectionTargets(tokens) {
  const targets = [];
  for (const [index, token] of tokens.entries()) {
    const operator = REDIRECT.exec(token);
    if (operator === null) continue;
    const remainder = token.slice(operator[0].length);
    const target = remainder.length > 0 ? remainder : tokens[index + 1];
    if (target !== undefined && !target.startsWith("&")) targets.push(target);
  }
  return targets;
}

function isInPlaceFlag(arg) {
  return arg === "--in-place" || /^-[a-hj-z]*i/.test(arg);
}

// The path an `ln` call creates. `ln [-s] TARGET LINK_NAME` writes LINK_NAME
// alone: TARGET is text the new link holds, which `ln` neither reads nor writes,
// so reading it as a write refuses a command that touches nothing. Two or more
// operands write the last one -- the link name, or the directory the links are
// made in; one operand writes the link named after it in the current directory;
// `-t DIRECTORY` writes into that directory instead. A shape not read here names
// no write, the way a fail-open guard must.
function linkTargets(args) {
  const operands = [];
  let directory = null;
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    index++;
    if (arg === "--") {
      operands.push(...args.slice(index));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      operands.push(arg);
      continue;
    }
    const long = TARGET_DIRECTORY_LONG.exec(arg);
    const short = TARGET_DIRECTORY_SHORT.exec(arg);
    if (long === null && short === null) continue;
    const attached = long === null ? short[1] : (long[1] ?? "");
    directory = attached.length > 0 ? attached : (args[index++] ?? null);
  }
  if (directory !== null) return [directory];
  if (operands.length > 1) return [operands[operands.length - 1]];
  if (operands.length === 1) return [basename(operands[0])];
  return [];
}

// The paths a writing command names. Every path operand counts, the sources of a
// copy included: a source read through a resolved-away /tmp path is the same
// mistake reaching the same file, and which operand is the destination varies by
// command and flag. `ln` is the exception, read by the rule above.
function writingCommandTargets(tokens) {
  const command = invocation(tokens);
  if (command === null || !WRITING_COMMANDS.has(command.name)) return [];
  if (command.name === "sed" && !command.args.some(isInPlaceFlag)) return [];
  if (command.name === "ln")
    return linkTargets(command.args).filter(isPathOperand);
  return command.args
    .map((arg) => arg.replace(DD_OPERAND, ""))
    .filter(isPathOperand);
}

function writeTargets(command) {
  return splitSegments(command.replace(NOCLOBBER, ">")).flatMap((segment) => {
    const tokens = tokenize(segment);
    return [...redirectionTargets(tokens), ...writingCommandTargets(tokens)];
  });
}

function isUnderTmp(path) {
  return TMP_ROOTS.some((root) => isInside(path, root));
}

/** The scratch root a path lies under, or null when it lies under none. */
function tmpRootOf(path) {
  return TMP_ROOTS.find((root) => isStrictlyInside(path, root)) ?? null;
}

// Where the path would resolve if nothing below its scratch root redirected it:
// the root resolved once, the rest of the path appended unchanged. A path whose
// own resolution differs from this passes through a symlink somewhere under
// scratch.
function unredirected(path, root) {
  return join(canonicalPath(root), relative(root, path));
}

// The worktree a path lies in, or null when it lies in none and when git will
// not answer at all: no git, a path outside every repository, a directory that
// is gone. Every unanswerable state allows, the way a fail-open guard must.
function worktreeOf(path) {
  const directory = nearestExistingDirectory(path);
  if (directory === null) return null;
  const records = worktreeRecords(directory);
  if (records === null) return null;
  const paths = records.map((record) => canonicalPath(record.path));
  return owningWorktree(path, paths) ?? null;
}

function block(target, resolved, worktree) {
  process.stderr.write(
    `Blocked by block-tmp-symlink-worktree-writes hook: '${target}' is written as scratch under ` +
      `/tmp, but it resolves to '${resolved}', inside the git worktree at '${worktree}'. This ` +
      "write would land on repository content instead of on scratch, and every command on the " +
      "line would still report success. A fixed /tmp name left behind as a symlink by an " +
      "earlier session is how a path does this. Create the scratch directory with `mktemp -d` " +
      "and write under the path it prints, never a fixed /tmp name. If that leftover link is " +
      "what this tripped over, remove it (`rm <link>`, which this hook does not gate) and " +
      "start again from a fresh `mktemp -d`. If the destination really is in the repository, " +
      "write it by its own path rather than through /tmp.\n",
  );
  process.exit(2);
}

function main() {
  const event = eventForTools("Bash");
  if (event === null) process.exit(0); // unreadable, or another tool
  const command = commandOf(event);
  if (command === null) process.exit(0);

  const cwd = eventCwd(event) ?? process.cwd();
  // Nothing on a line that names no scratch directory, run from outside one, can
  // resolve out of scratch, and skipping it keeps the filesystem probes below off
  // every unrelated Bash call.
  if (!TMP_ROOTS.some((root) => command.includes(root)) && !isUnderTmp(cwd)) {
    process.exit(0);
  }

  for (const target of writeTargets(command)) {
    const path = resolve(cwd, target);
    const root = tmpRootOf(path);
    if (root === null) continue;
    const resolved = canonicalPath(path);
    if (resolved === unredirected(path, root)) continue;
    const worktree = worktreeOf(resolved);
    if (worktree !== null) block(target, resolved, worktree);
  }
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never wedge Bash on an unexpected hook error
}
