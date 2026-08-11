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
//   - a `git clean` that would delete INSIDE a worktree this session does not
//     own -- its force coming from a flag or from a `-c clean.requireForce=false`
//     that lifts git's own requirement -- and one whose force (a flag and that
//     config counted together) reaches a doubled `-ff` plus -d in a directory
//     that merely holds worktrees
//   - `git worktree remove --force`, which takes a tree git's own refusal would
//     have held on to
//
// WHICH TREE A SESSION OWNS is read from the agent id the event carries, not from
// the directory the session is sitting in. The harness gives an isolated agent a
// worktree named after that id (`.claude/worktrees/agent-<agent_id>`, recorded as
// `worktreePath` in the harness's own subagent metadata), while a session's Bash
// cwd persists across calls and `cd` is unguarded -- so ownership taken from cwd
// hands a session that once cd'ed into a sibling tree that tree's trust for the
// rest of the run, and an everyday `cd <sibling> && rm -rf src` walks past this
// hook. A session the event gives no agent id owns NOTHING, and every tree is
// guarded from it: that is the right answer for the orchestrator session working
// in the primary tree. cwd still resolves relative paths; it no longer confers
// trust. When the id names no tree the session recognises, the refusal says so
// rather than leaving a fail-closed refusal unexplained.
//
// What it deliberately allows:
//   - anything strictly inside this session's own tree (`rm -rf node_modules`,
//     `rm dist/bundle.js`) -- ordinary work on a tree the session owns
//   - `git worktree remove` without --force: git's own refusal on a tree with
//     uncommitted work is the guard, so only the --force spelling that defeats
//     that refusal is blocked. That plain spelling is how a finished tree is
//     retired, so it stays open to every session, owner or not
//   - `git clean -fdx` in a directory that merely HOLDS worktrees, which real git
//     answers with "Skipping repository" for each nested one; only a doubled
//     force plus -d takes them. Reaching INTO a tree is the other case and needs
//     no doubling -- a single -f deletes that tree's untracked files, -fd its
//     untracked directories. The test beside this file drives real git against a
//     real linked worktree for every spelling rather than modelling the rule
//   - any `git clean` dry run (-n, --dry-run), which deletes nothing
//
// The commands read as deletions are rm, rmdir, unlink, shred, mv, find with a
// deleting action, and those same commands reached through xargs in a pipeline,
// plus the two git spellings above.
//
// STATED LIMITS. This hook reads a plain command line and nothing more, so each
// of the following reaches a worktree past it. They are recorded rather than
// closed: closing them means a shell-syntax-aware parser, a larger and more
// fragile thing than the accident this guards against warrants. What this hook
// binds is the accident -- a session deleting a tree it can see by path -- and
// not a determined bypass; a command it allows is not thereby endorsed.
//   - COMPOSITION IS NOT UNWRAPPED. Stages are split on &&, ||, ;, a newline
//     and the pipe, and nothing else: a subshell, a brace group, or a command
//     substitution keeps its brackets inside the stage that carries it, so
//     `(cd ../agent-other && rm -rf .)` reads as a `(cd` and an `rm` whose
//     target is `.)`, neither of which names a worktree. A single `&` is not a
//     separator either, so a deletion standing after one reads as an argument of
//     the command in front of it. Nor is a command inside `bash -c "..."` read,
//     or one behind an alias or a shell function.
//   - THE COMMAND WORD IS MATCHED LITERALLY, by basename after quotes are
//     stripped -- from the whole command line before the deletion pre-filter and
//     from each token before the match -- so a quoted spelling (`r"m"`, `m"v"`)
//     is caught, while an escaped one (`\rm`, `r\m`) names the same program to
//     the shell and a different one to this hook.
//   - ONLY sudo, command, env, nice AND time ARE PEELED as prefix words, along
//     with their flags and the values those flags take (`sudo -u NAME`,
//     `nice -n 10`). Another wrapper -- `timeout 5 rm ...`, `nohup`, `setsid` --
//     stands where the command word belongs and the stage reads as the wrapper.
//   - TARGETS THAT ONLY EXIST AT RUNTIME are not seen: a path read from a file,
//     built up in a variable, or produced by a glob whose literal prefix names
//     no worktree.
//   - A `cd` MOVES THE DIRECTORY paths resolve against only when it stands as
//     its own command, and a symlink pointing into a worktree is not resolved
//     (removing the link does not follow it anyway).
//   - RELATIVE-OPERAND DRIFT DETECTION DEPENDS ON THE HARNESS SUPPLYING THE
//     SHELL'S CURRENT DIRECTORY in the event's cwd. A relative deletion aimed at
//     a tree the session cd'ed into earlier is caught only when that drifted cwd
//     is what the event reports; whether the harness reports the drifted shell
//     cwd or a stale session cwd was not driven at this ref (the test supplies
//     cwd rather than observing what the harness sends). An absolute operand is
//     unaffected.
//   - A GIT DIRECTORY REDIRECT IS READ ONLY IN THE LITERAL FORMS MEASURED HERE:
//     `-C` (composed left to right against the one before it, as real git
//     composes it), `--work-tree`, and `GIT_WORK_TREE` set either as a leading
//     assignment or by an `export` stage before the git command. Those move the
//     directory a git subcommand works in -- the one `clean` walks, and the one a
//     relative `worktree remove` operand resolves against -- while `--git-dir`,
//     `GIT_DIR` and `-c core.worktree=` do not, each put to real git in the test
//     beside this file. A redirect spelling outside that measured set would pass
//     unread.
//   - clean.requireForce IS READ ONLY AS A `-c clean.requireForce=<off>` on the
//     command line, `<off>` one of git's boolean-false spellings (false, no, off,
//     0, empty), the last such `-c` winning as real git resolves it. A
//     `--config-env` naming an environment variable, or a `GIT_CONFIG_*` pair,
//     sets the same key from a value this hook cannot see, so neither is read.
//
// Exit 0 allows the call; exit 2 blocks it and feeds stderr back to Claude. Any
// unexpected failure here falls through to exit 0 (fail open) so a bug in this
// hook can never wedge every Bash command.

import { readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";

const CLAUDE_DIR = ".claude";
const WORKTREES_DIR = "worktrees";
const AGENT_TREE_PREFIX = "agent-";

const DELETING_COMMANDS = new Set(["rm", "rmdir", "unlink", "shred", "mv"]);

// Cheap pre-filter: a command that names none of these -- tested with quotes
// stripped the same blunt way the tokenizer strips them, so a quoted command
// word (`r"m"`) is not hidden from the gate -- cannot be any form this hook
// reads, and skipping it keeps the filesystem probes below off every unrelated
// Bash call.
const DELETION_MENTION = /\b(rm|rmdir|unlink|shred|mv|find|xargs|git)\b/;

function mentionsDeletion(command) {
  return DELETION_MENTION.test(command.replace(/['"]/g, ""));
}

function block(reason) {
  process.stderr.write(
    `Blocked by block-worktree-deletions hook: ${reason}.\n` +
      "An agent worktree holds work that exists nowhere else until it is committed, so " +
      "deleting one destroys it unrecoverably -- there is no branch, stash, or reflog " +
      "behind it. Leave another session's tree alone, and retire a finished tree with " +
      "`git worktree remove <path>` (no --force), which refuses while the tree still has " +
      "uncommitted work. If the path is not a registered worktree at all, say so to the " +
      "maintainer rather than deleting it some other way. This hook reads a plain command " +
      "line and nothing more -- the limits listed in its header are real, so rephrasing " +
      "around this refusal defeats it and destroys the tree anyway.\n",
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

// The command words this hook reads. A prefix word's flag may take a value
// (`sudo -u NAME`) that would otherwise stand where the command word belongs; a
// word in this set is read as the command rather than as such a value.
const INSPECTED_COMMANDS = new Set([
  ...DELETING_COMMANDS,
  "find",
  "xargs",
  "git",
  "cd",
]);

// Peel leading environment assignments and prefix words off a stage, returning
// the command it invokes, that command's arguments, and the assignments it runs
// under; null when the stage invokes nothing.
function invocation(tokens) {
  let index = 0;
  let sawPrefixWord = false;
  const environment = new Map();
  while (index < tokens.length) {
    const token = tokens[index];
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
    if (assignment !== null) {
      environment.set(assignment[1], assignment[2]);
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
      // That flag may take a value (`sudo -u NAME`, `nice -n 10`), which is not
      // the command word. A word this hook reads is taken for the command; any
      // other word is taken for the value, except the last word on the stage,
      // which has nothing after it to be the value for.
      const next = tokens[index];
      if (
        next !== undefined &&
        index + 1 < tokens.length &&
        !next.startsWith("-") &&
        !INSPECTED_COMMANDS.has(basename(next))
      ) {
        index++;
      }
      continue;
    }
    break;
  }
  const word = tokens[index];
  if (word === undefined) return null;
  return { name: basename(word), args: tokens.slice(index + 1), environment };
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

// The prefix a path carries when it lies strictly under `directory`, which is
// just "/" at the filesystem root -- appending a separator there builds "//",
// which nothing starts with, and `rm -rf /` would match no worktree at all.
function childPrefix(directory) {
  return directory === "/" ? "/" : `${directory}/`;
}

function isInside(path, directory) {
  return path === directory || path.startsWith(childPrefix(directory));
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

// Worktree roots this session knows about: the one it is working in, and the
// project's own, which is how a session outside any worktree still knows what a
// deletion above it would take.
function worktreeRoots(sessionRoot) {
  const roots = new Set();
  if (sessionRoot !== null) roots.add(sessionRoot);
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (projectDir) roots.add(resolve(projectDir, CLAUDE_DIR, WORKTREES_DIR));
  return [...roots];
}

// The worktrees this session owns: the tree named after its agent id, under each
// root it knows about. An event with no agent id yields none, so a session that
// is not an isolated agent owns nothing and every tree is guarded from it.
function ownedTrees(agentId, roots) {
  if (typeof agentId !== "string" || agentId === "") return [];
  return roots.map((root) => `${root}/${AGENT_TREE_PREFIX}${agentId}`);
}

function owns(path, ownTrees) {
  return ownTrees.some((tree) => isInside(path, tree));
}

// Why a refusal stands even though the session may be sitting in the tree it
// names: ownership comes from the agent id, so this says which tree that id
// bought, and a fail-closed refusal is diagnosable from the message alone.
function ownershipNote(ownTrees) {
  return ownTrees.length === 0
    ? " -- this session owns no agent worktree"
    : ` -- this session owns only '${ownTrees[0]}'`;
}

// The live worktree roots that deleting `target` would carry off with it.
function rootsUnder(target, knownRoots) {
  const candidates = new Set(knownRoots);
  candidates.add(resolve(target, CLAUDE_DIR, WORKTREES_DIR));
  // A target that IS a `.claude` directory holds the root one level down, not
  // two: `resolve` alone would build a `.claude/.claude/worktrees` that exists
  // nowhere and the trees under it would go uncounted.
  if (basename(target) === CLAUDE_DIR) {
    candidates.add(resolve(target, WORKTREES_DIR));
  }
  return [...candidates].filter(
    (root) => root.startsWith(childPrefix(target)) && treeCount(root) > 0,
  );
}

// Why deleting `target` is refused, or null when it may proceed.
function deletionVerdict(target, ownTrees, knownRoots) {
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
    return owns(target, ownTrees)
      ? `'${target}' is this session's own worktree, taken whole`
      : `'${target}' is another session's worktree, taken whole${ownershipNote(ownTrees)}`;
  }
  if (owns(target, ownTrees)) return null;
  return `'${target}' is inside '${context.tree}', an agent worktree this session does not own${ownershipNote(ownTrees)}`;
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

// Read a git invocation as the directory redirects it carries, its subcommand,
// and that subcommand's arguments. Repeated `-C` is kept in order rather than
// overwritten: real git applies each one from where the last one left it, so
// `-C a -C b` lands in `a/b` and a second `-C .` stays where the first went.
function gitInvocation(args) {
  const chdirs = [];
  let workTree = null;
  const configSettings = [];
  let index = 0;
  while (index < args.length && args[index].startsWith("-")) {
    const token = args[index];
    const equals = token.indexOf("=");
    const option = equals >= 0 ? token.slice(0, equals) : token;
    const attached = equals >= 0 ? token.slice(equals + 1) : null;
    const value = attached ?? args[index + 1];
    if (value !== undefined) {
      if (option === "-C") chdirs.push(value);
      else if (option === "--work-tree") workTree = value;
      else if (option === "-c") configSettings.push(value);
    }
    index += VALUE_GLOBALS.has(option) && attached === null ? 2 : 1;
  }
  return {
    chdirs,
    workTree,
    configSettings,
    subcommand: args[index],
    args: args.slice(index + 1),
  };
}

// `git clean` refuses to delete without a force UNLESS `clean.requireForce` is
// configured off, so a `-c` that disables it satisfies the force condition on
// its own. The key is compared case-folded (git folds config key names) and the
// value against git's boolean-false spellings, both measured against real git in
// the test beside this file; the last `-c` setting of the key wins, as real git
// resolves it. A `--config-env` spelling or a `GIT_CONFIG_*` environment pair
// names a value this hook cannot see and is not read.
const REQUIRE_FORCE_KEY = "clean.requireforce";
const FORCE_DISABLING_VALUES = new Set(["false", "no", "off", "0", ""]);

function requireForceDisabled(configSettings) {
  let disabled = false;
  for (const setting of configSettings) {
    const equals = setting.indexOf("=");
    const key = (
      equals >= 0 ? setting.slice(0, equals) : setting
    ).toLowerCase();
    if (key !== REQUIRE_FORCE_KEY) continue;
    // A bare `-c clean.requireForce` (no value) sets the boolean true.
    const value =
      equals >= 0 ? setting.slice(equals + 1).toLowerCase() : "true";
    disabled = FORCE_DISABLING_VALUES.has(value);
  }
  return disabled;
}

// Any unambiguous abbreviation of `--force`. git accepts a long option shortened
// to any unique prefix, and `f` is the only long option beginning with it for
// both `git clean` and `git worktree remove`, so `--f`, `--fo`, `--for`,
// `--forc` and `--force` all mean force (measured against real git in the test
// beside this file); `--f=` and `--forcex` do not, so the match is anchored and
// carries no `=`.
const FORCE_ABBREVIATION = /^--f(?:o(?:r(?:c(?:e)?)?)?)?$/;

// How many times a force is asked for, counting a repeated short flag (`-ff`), a
// repeated long one, and every unambiguous abbreviation git honours.
function forceCount(args) {
  let count = 0;
  for (const arg of args) {
    if (FORCE_ABBREVIATION.test(arg)) count++;
    else if (/^-[a-eg-z]*f/.test(arg)) count += (arg.match(/f/g) || []).length;
  }
  return count;
}

// A dry run reports and deletes nothing, so no spelling of it is a deletion.
function isDryRun(args) {
  return args.some((arg) => arg === "--dry-run" || /^-[a-mo-z]*n/.test(arg));
}

// The two `git clean` cases, which real git answers differently. Reaching INTO a
// worktree is an ordinary clean of that tree, so one force takes its untracked
// files and -d its untracked directories. A directory that merely HOLDS
// worktrees loses them only to a doubled force with -d, because git skips a
// nested repository for every lesser spelling.
function gitCleanVerdict(args, directory, ownTrees, knownRoots, forceDisabled) {
  if (isDryRun(args)) return null;
  // A disabled `clean.requireForce` satisfies git's baseline force requirement,
  // so this counts it as one force: a single real -f on top of it reaches the
  // doubled force that removes a nested repository on git <= 2.44, where a
  // disabled requireForce feeds the same force counter a real -f does. git >= 2.45
  // stopped feeding that counter from the config, so there this shape only skips
  // the nested tree and the guard, which blocks it either way, conservatively
  // over-refuses it rather than model the git version. That boundary was settled
  // by driving real git across it (the 2.44/2.45 versions), not by reading git.
  const force = forceCount(args) + (forceDisabled ? 1 : 0);
  if (force === 0) return null;
  const context = worktreeContext(directory);
  if (context !== null) {
    if (owns(directory, ownTrees)) return null;
    return `'git clean' would delete inside '${directory}', an agent worktree this session does not own${ownershipNote(ownTrees)}`;
  }
  const cleansDirectories = args.some(
    (arg) => arg === "--directories" || /^-[a-ce-z]*d/.test(arg),
  );
  if (force < 2 || !cleansDirectories) return null;
  const [root] = rootsUnder(directory, knownRoots);
  return root === undefined
    ? null
    : `'git clean' with a doubled force and -d in '${directory}' can remove nested repositories, including the ${describeTrees(treeCount(root))} under '${root}'`;
}

// The directory a git invocation ends up working in: each `-C` applied from
// where the one before it landed, then a work-tree redirect resolved from there,
// with `--work-tree` winning over its environment spelling when both are given.
// Real git moves both the directory `clean` walks and the one a relative
// `worktree remove` operand resolves against, so this is what a git path is
// resolved from -- measured against real git rather than modelled.
function gitDirectory(git, cwd, environment) {
  const chdir = git.chdirs.reduce((dir, next) => resolve(dir, next), cwd);
  const workTree = git.workTree ?? environment.get("GIT_WORK_TREE") ?? null;
  return workTree === null ? chdir : resolve(chdir, workTree);
}

function gitVerdict(args, cwd, ownTrees, knownRoots, environment) {
  const git = gitInvocation(args);
  const directory = gitDirectory(git, cwd, environment);
  if (git.subcommand === "clean") {
    return gitCleanVerdict(
      git.args,
      directory,
      ownTrees,
      knownRoots,
      requireForceDisabled(git.configSettings),
    );
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

// The variables an `export VAR=val ...` stage sets for the commands that follow
// it, the way a `VAR=val cmd` prefix sets one for a single command -- the same
// GIT_WORK_TREE redirect, reached through git's environment rather than its flags
// (measured against real git in the test beside this file). A bare `VAR=val`
// standing as its own stage is a shell variable git never sees, so only the
// exported form is read.
function exportedAssignments(command) {
  if (command.name !== "export") return [];
  return command.args.flatMap((arg) => {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(arg);
    return assignment === null ? [] : [[assignment[1], assignment[2]]];
  });
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
  if (!mentionsDeletion(command)) process.exit(0);

  const sessionCwd = typeof event.cwd === "string" ? event.cwd : process.cwd();
  const session = worktreeContext(sessionCwd);
  const knownRoots = worktreeRoots(session?.root ?? null);
  const ownTrees = ownedTrees(event.agent_id, knownRoots);

  let cwd = sessionCwd;
  const exported = new Map();
  for (const pipeline of splitPipelines(command)) {
    const commands = splitStages(pipeline)
      .map((stage) => invocation(tokenize(stage)))
      .filter((entry) => entry !== null);
    for (const entry of commands) {
      if (entry.name !== "git") continue;
      const reason = gitVerdict(
        entry.args,
        cwd,
        ownTrees,
        knownRoots,
        new Map([...exported, ...entry.environment]),
      );
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
          ownTrees,
          knownRoots,
        );
        if (reason) block(reason);
      }
    }
    if (commands.length === 1) {
      for (const [name, value] of exportedAssignments(commands[0])) {
        exported.set(name, value);
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
