#!/usr/bin/env node
// PreToolUse hook: refuse a Bash command that would delete an agent worktree
// under .claude/worktrees/, or anything inside one this session does not own.
//
// Why this exists: a spawned agent ran `rm -rf` across two live sibling
// worktrees mid-session and destroyed the uncommitted work in both. Nothing else
// stands in the way -- the trees are siblings on one filesystem and every session
// can reach all of them by path -- and the loss is unrecoverable, because work
// that was never committed has no branch, no stash, and no reflog behind it.
//
// What it refuses:
//   - a path inside a worktree this session does not own
//   - a worktree taken whole, this session's own included, or the root they all
//     live under
//   - a path that CONTAINS live worktrees, the `rm -rf /workspace` shape, which
//     names no worktree at all
//
// What it deliberately allows:
//   - anything strictly inside this session's own tree (`rm -rf node_modules`,
//     `rm dist/bundle.js`) -- ordinary work on a tree the session owns
//   - `git worktree remove` without --force: git's own refusal on a tree with
//     uncommitted work is the guard, so only the --force spelling that defeats
//     that refusal is blocked
//   - `git clean -fdx`, which real git shows SKIPS a nested worktree ("Would skip
//     repository"); only a doubled force plus -d removes one, and that is the
//     spelling this hook reads
//
// The commands read as deletions are rm, rmdir, unlink, shred, mv, find with a
// deleting action, and those same commands reached through xargs in a pipeline,
// plus the two git spellings above. Deliberate limits, each costing a rephrase
// rather than a capability: targets that only exist at runtime (read from a file,
// computed in a script, or run inside `bash -c "..."`) are not read, a `cd` moves
// the directory paths resolve against only when it stands as its own command, and
// a symlink pointing into a worktree is not resolved (removing the link does not
// follow it anyway).
//
// Exit 0 allows the call; exit 2 blocks it and feeds stderr back to Claude. Any
// unexpected failure here falls through to exit 0 (fail open) so a bug in this
// hook can never wedge every Bash command.

import { readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";

const CLAUDE_DIR = ".claude";
const WORKTREES_DIR = "worktrees";

const DELETING_COMMANDS = new Set(["rm", "rmdir", "unlink", "shred", "mv"]);

// Cheap pre-filter: a command that names none of these cannot be any form this
// hook reads, and skipping it keeps the filesystem probes below off every
// unrelated Bash call.
const DELETION_MENTION = /\b(rm|rmdir|unlink|shred|mv|find|xargs|git)\b/;

function block(reason) {
  process.stderr.write(
    `Blocked by block-worktree-deletions hook: ${reason}.\n` +
      "An agent worktree holds work that exists nowhere else until it is committed, so " +
      "deleting one destroys it unrecoverably -- there is no branch, stash, or reflog " +
      "behind it. Leave another session's tree alone, and retire a finished tree with " +
      "`git worktree remove <path>` (no --force), which refuses while the tree still has " +
      "uncommitted work. If the path is not a registered worktree at all, say so to the " +
      "maintainer rather than deleting it some other way.\n",
  );
  process.exit(2);
}

// Split a command line into pipelines, then each pipeline into its stages, so a
// deletion hidden in a compound command or fed from an earlier stage is still
// inspected. Pragmatic, not a full shell parser.
function splitPipelines(command) {
  return command.split(/\s*(?:&&|\|\||[;\n])\s*/);
}

function splitStages(pipeline) {
  return pipeline.split(/\s*\|\s*/);
}

// Whitespace tokenizer that keeps quoted spans intact, then strips quotes, so a
// quoted path reads the same as a bare one. Not POSIX-complete.
function tokenize(stage) {
  const tokens = stage.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) || [];
  return tokens.map((token) => token.replace(/['"]/g, ""));
}

// Words that stand in front of the real command word without changing which
// command runs.
const COMMAND_PREFIX_WORDS = new Set([
  "sudo",
  "command",
  "env",
  "nice",
  "time",
]);

// Peel leading environment assignments and prefix words off a stage, returning
// the command it invokes and that command's arguments; null when the stage
// invokes nothing.
function invocation(tokens) {
  let index = 0;
  let sawPrefixWord = false;
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index++;
      continue;
    }
    if (COMMAND_PREFIX_WORDS.has(token)) {
      sawPrefixWord = true;
      index++;
      continue;
    }
    // A flag belonging to a prefix word (`env -i rm ...`); before any prefix word
    // a flag means this stage is not a command invocation at all.
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

// The `.claude/worktrees` root a path lies under and the single worktree inside
// it the path belongs to, or null when the path is nowhere near one.
function worktreeContext(path) {
  const parts = path.split("/");
  for (let i = 0; i + 1 < parts.length; i++) {
    if (parts[i] === CLAUDE_DIR && parts[i + 1] === WORKTREES_DIR) {
      return {
        root: parts.slice(0, i + 2).join("/"),
        tree: parts.length > i + 2 ? parts.slice(0, i + 3).join("/") : null,
      };
    }
  }
  return null;
}

function isInside(path, directory) {
  return path === directory || path.startsWith(`${directory}/`);
}

function treeCount(root) {
  try {
    return readdirSync(root).length;
  } catch {
    return 0;
  }
}

function describeTrees(count) {
  return `${count} live worktree${count === 1 ? "" : "s"}`;
}

// Worktree roots this session knows to be live: the one it is working in, and
// the project's own, which is how a session outside any worktree still knows
// what a deletion above it would take.
function liveRoots(sessionRoot) {
  const roots = new Set();
  if (sessionRoot !== null) roots.add(sessionRoot);
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (projectDir) roots.add(resolve(projectDir, CLAUDE_DIR, WORKTREES_DIR));
  return [...roots].filter((root) => treeCount(root) > 0);
}

// The live worktree roots that deleting `target` would carry off with it.
function rootsUnder(target, knownRoots) {
  const candidates = new Set(knownRoots);
  candidates.add(resolve(target, CLAUDE_DIR, WORKTREES_DIR));
  return [...candidates].filter(
    (root) => root.startsWith(`${target}/`) && treeCount(root) > 0,
  );
}

// Why deleting `target` is refused, or null when it may proceed.
function deletionVerdict(target, ownTree, knownRoots) {
  const context = worktreeContext(target);
  if (context === null) {
    const [root] = rootsUnder(target, knownRoots);
    return root === undefined
      ? null
      : `'${target}' contains '${root}' and the ${describeTrees(treeCount(root))} in it`;
  }
  if (target === context.root) {
    return `'${target}' is the root every agent worktree lives under`;
  }
  if (target === context.tree) {
    return target === ownTree
      ? `'${target}' is this session's own worktree, taken whole`
      : `'${target}' is another session's worktree, taken whole`;
  }
  if (ownTree !== null && isInside(target, ownTree)) return null;
  return `'${target}' is inside '${context.tree}', an agent worktree this session does not own`;
}

// Tokens that are argument syntax rather than operands, so they are never
// resolved as paths.
function isPathOperand(token) {
  return (
    !token.startsWith("-") && !["{}", ";", "+", "!", "(", ")"].includes(token)
  );
}

function deletesPaths(command) {
  if (DELETING_COMMANDS.has(command.name)) return true;
  if (command.name === "find") {
    return (
      command.args.includes("-delete") ||
      (command.args.some((arg) => /^-(exec|execdir|ok|okdir)$/.test(arg)) &&
        command.args.some((arg) => DELETING_COMMANDS.has(basename(arg))))
    );
  }
  if (command.name === "xargs") {
    return command.args.some((arg) => DELETING_COMMANDS.has(basename(arg)));
  }
  return false;
}

// git global options that consume a following token as their value, so the
// subcommand scan does not mistake that value for the subcommand.
const VALUE_GLOBALS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
]);

// Read a git invocation as the directory it runs in, its subcommand, and that
// subcommand's arguments.
function gitInvocation(args) {
  let chdir = null;
  let index = 0;
  while (index < args.length && args[index].startsWith("-")) {
    const token = args[index];
    const equals = token.indexOf("=");
    const option = equals >= 0 ? token.slice(0, equals) : token;
    const attached = equals >= 0 ? token.slice(equals + 1) : null;
    if (option === "-C") chdir = attached ?? args[index + 1];
    index += VALUE_GLOBALS.has(option) && attached === null ? 2 : 1;
  }
  return { chdir, subcommand: args[index], args: args.slice(index + 1) };
}

// How many times a force is asked for, counting a repeated short flag (`-ff`)
// and a repeated long one alike.
function forceCount(args) {
  let count = 0;
  for (const arg of args) {
    if (arg === "--force") count++;
    else if (/^-[a-eg-z]*f/.test(arg)) count += (arg.match(/f/g) || []).length;
  }
  return count;
}

// `git clean` removes a nested repository -- which is what a worktree is -- only
// with a doubled force and -d; real git reports "Would skip repository" for
// every lesser spelling.
function gitCleanVerdict(args, directory, ownTree, knownRoots) {
  const cleansDirectories = args.some(
    (arg) => arg === "--directories" || /^-[a-ce-z]*d/.test(arg),
  );
  if (forceCount(args) < 2 || !cleansDirectories) return null;
  const context = worktreeContext(directory);
  if (context !== null) {
    if (ownTree !== null && isInside(directory, ownTree)) return null;
    return `'git clean' with a doubled force and -d runs in '${directory}', inside an agent worktree this session does not own`;
  }
  const [root] = rootsUnder(directory, knownRoots);
  return root === undefined
    ? null
    : `'git clean' with a doubled force and -d in '${directory}' removes nested repositories, including the ${describeTrees(treeCount(root))} under '${root}'`;
}

function gitVerdict(args, cwd, ownTree, knownRoots) {
  const git = gitInvocation(args);
  const directory = resolve(cwd, git.chdir ?? ".");
  if (git.subcommand === "clean") {
    return gitCleanVerdict(git.args, directory, ownTree, knownRoots);
  }
  if (git.subcommand !== "worktree" || git.args[0] !== "remove") return null;
  const removeArgs = git.args.slice(1);
  if (forceCount(removeArgs) === 0) return null;
  const path = removeArgs.find(isPathOperand);
  if (path === undefined) return null;
  const target = resolve(directory, path);
  return worktreeContext(target) === null
    ? null
    : `'git worktree remove --force' deletes '${target}' along with any uncommitted work in it`;
}

// The directory a stage moves into, for the `cd <dir> && rm <relative path>`
// shape; null for every other stage.
function chdirTarget(command) {
  if (command.name !== "cd") return null;
  return command.args.find(isPathOperand) ?? null;
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0); // unreadable event -- do not interfere
  }
  if (event.tool_name !== "Bash") process.exit(0);
  const command = event?.tool_input?.command;
  if (typeof command !== "string") process.exit(0);
  if (!DELETION_MENTION.test(command)) process.exit(0);

  const sessionCwd = typeof event.cwd === "string" ? event.cwd : process.cwd();
  const session = worktreeContext(sessionCwd);
  const ownTree = session?.tree ?? null;
  const knownRoots = liveRoots(session?.root ?? null);

  let cwd = sessionCwd;
  for (const pipeline of splitPipelines(command)) {
    const commands = splitStages(pipeline)
      .map((stage) => invocation(tokenize(stage)))
      .filter((entry) => entry !== null);
    for (const entry of commands) {
      if (entry.name !== "git") continue;
      const reason = gitVerdict(entry.args, cwd, ownTree, knownRoots);
      if (reason) block(reason);
    }
    // Once any stage of a pipeline deletes, every operand in it is a candidate
    // target: `find <tree> -print0 | xargs -0 rm -rf` names the tree in the
    // stage that reads it, not the stage that deletes it.
    if (commands.some(deletesPaths)) {
      for (const token of commands.flatMap((entry) => entry.args)) {
        if (!isPathOperand(token)) continue;
        const reason = deletionVerdict(
          resolve(cwd, token),
          ownTree,
          knownRoots,
        );
        if (reason) block(reason);
      }
    }
    const moved = commands.length === 1 ? chdirTarget(commands[0]) : null;
    if (moved !== null) cwd = resolve(cwd, moved);
  }
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never wedge Bash on an unexpected hook error
}
