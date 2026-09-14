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
// writing commands in WRITING_COMMANDS below. Reading through such a path is
// left alone, and so is removing the stale link itself (`rm /tmp/<name>`, which
// takes the link and not what it points at) -- removing the link is the fix, and
// blocking it would leave the session no way to clear what it just tripped over.
// A removal that reaches THROUGH the link is a write like any other: a deeper
// operand (`rm /tmp/<name>/file`), or a trailing slash, which makes `rm -rf
// /tmp/<name>/` empty the checkout and leave the link standing.
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
//   - A path operand that starts with `-`, including one after `--`, is not read
//     as a write target: isPathOperand drops it, so such a write passes.
//
// Exit 0 allows the call; exit 2 blocks it and feeds stderr back to Claude. Any
// unexpected failure here falls through to exit 0 (fail open) so a bug in this
// hook can never wedge every Bash command.

import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

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
// the redirect that captures it is read on its own. `ln` and `rm` are each read
// by their own rule below, in `linkTargets` and `removalTargets`, since neither
// writes the path it is handed the way the rest do.
const WRITING_COMMANDS = new Set([
  "cp",
  "dd",
  "install",
  "ln",
  "mkdir",
  "mv",
  "rm",
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

// The flag naming the directory a command writes into, in its two spellings.
// The short one takes the rest of its own cluster as the directory when there is
// any (`-st DIR`, `-tDIR`), which is why the value is captured here rather than
// assumed to be the next word.
const TARGET_DIRECTORY_LONG = /^--target-directory(?:=(.*))?$/;
const TARGET_DIRECTORY_SHORT = /^-[a-zA-Z]*?t(.*)$/;

// The commands that take that flag. Read for no other command, since `-t` names
// something else entirely elsewhere (`touch -t STAMP`).
const TARGET_DIRECTORY_COMMANDS = new Set(["cp", "install", "ln", "mv"]);

// One trailing slash or more at the end of a path, which decides whether `rm`
// operates on a final symlink or through it.
const TRAILING_SLASHES = /\/+$/;

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
  return (
    arg === "--in-place" ||
    arg.startsWith("--in-place=") ||
    /^-[a-hj-z]*i/.test(arg)
  );
}

// A command's operands and the directory its target-directory flag names, with
// `--` ending option parsing. A flag this does not know is stepped over and
// nothing else is, so the value of one standing as its own word is read as an
// operand -- an extra candidate path, never a lost one.
function operandsAndDirectory(args, readsTargetDirectory) {
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
    if (!readsTargetDirectory) continue;
    const long = TARGET_DIRECTORY_LONG.exec(arg);
    const short = TARGET_DIRECTORY_SHORT.exec(arg);
    if (long === null && short === null) continue;
    const attached = long === null ? short[1] : (long[1] ?? "");
    directory = attached.length > 0 ? attached : (args[index++] ?? null);
  }
  return { operands, directory };
}

// The path an `ln` call creates. `ln [-s] TARGET LINK_NAME` writes LINK_NAME
// alone: TARGET is text the new link holds, which `ln` neither reads nor writes,
// so reading it as a write refuses a command that touches nothing. Two or more
// operands write the last one -- the link name, or the directory the links are
// made in; one operand writes the link named after it in the current directory;
// `-t DIRECTORY` writes into that directory instead. A shape not read here names
// no write, the way a fail-open guard must.
function linkTargets(args) {
  const { operands, directory } = operandsAndDirectory(args, true);
  if (directory !== null) return [directory];
  if (operands.length > 1) return [operands[operands.length - 1]];
  if (operands.length === 1) return [basename(operands[0])];
  return [];
}

// The directory each operand of an `rm` call is removed from, which is what the
// removal reaches into. `rm` does not follow a symlink named as its own operand,
// so `rm /tmp/<name>` takes the link and the directory read here is the scratch
// directory holding it -- no redirect, and the fix this hook recommends. A
// trailing slash makes `rm` operate on the directory the link points at
// (`rm -rf /tmp/<name>/` empties it and leaves the link), so that shape reads the
// operand itself, the same as a deeper operand reads the link above it. Measured
// against GNU coreutils 9.1.
function removalTargets(args) {
  return operandsAndDirectory(args, false)
    .operands.filter(isPathOperand)
    .map((operand) => {
      const trimmed = operand.replace(TRAILING_SLASHES, "");
      if (trimmed === operand) return dirname(operand);
      return trimmed.length > 0 ? trimmed : "/";
    });
}

// The paths a writing command names. Every path operand counts, the sources of a
// copy included: a source read through a resolved-away /tmp path is the same
// mistake reaching the same file, and which operand is the destination varies by
// command and flag. The directory a target-directory flag names counts with
// them. `ln` and `rm` are the exceptions, read by the rules above.
function writingCommandTargets(tokens) {
  const command = invocation(tokens);
  if (command === null || !WRITING_COMMANDS.has(command.name)) return [];
  if (command.name === "sed" && !command.args.some(isInPlaceFlag)) return [];
  if (command.name === "ln")
    return linkTargets(command.args).filter(isPathOperand);
  if (command.name === "rm") return removalTargets(command.args);
  const { operands, directory } = operandsAndDirectory(
    command.args,
    TARGET_DIRECTORY_COMMANDS.has(command.name),
  );
  return [...(directory === null ? [] : [directory]), ...operands]
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

// Whether `path` exists on disk and is itself a directory. False for anything
// that does not exist, the way a fail-open guard must -- a `statSync` failure
// here means "ask the parent instead", not "block".
function isExistingDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// The worktree a path lies in, or null when it lies in none and when git will
// not answer at all: no git, a path outside every repository, a directory that
// is gone. Every unanswerable state allows, the way a fail-open guard must.
//
// A path that is itself an existing directory is asked about from itself, not
// from its parent: a write target that resolves exactly to a worktree root is a
// directory, and its parent can sit outside every repository (the main
// worktree's own parent) or inside a different, enclosing one (a linked
// worktree's parent, the main worktree) -- either way the wrong answer. Every
// other path -- a file, or one nothing below it has created yet -- still asks
// from the nearest existing ancestor, since the path itself cannot be asked.
function worktreeOf(path) {
  const directory = isExistingDirectory(path)
    ? path
    : nearestExistingDirectory(path);
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
      "what this tripped over, remove it (`rm <link>`, which this hook allows) and start again " +
      "from a fresh `mktemp -d`. Name the link itself and give it no trailing slash: a trailing " +
      "slash empties what it points at instead. If the destination really is in the repository, " +
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
