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
//     own -- its force coming from a flag or from a `clean.requireForce` git
//     resolves to false, which lifts git's own requirement -- and one whose force
//     (a flag and that config counted together) reaches a doubled `-ff` plus -d
//     in a directory that merely holds worktrees
//   - a single-force `git clean` with -d in a directory that merely holds
//     worktrees while any directory under the guarded root no longer resolves as
//     a repository: git skips a repository, not a path, so an ORPHANED tree --
//     one whose `.git/worktrees/<name>` admin dir was removed, or whose gitlink
//     points at a gitdir that is gone -- is taken by that single force along with
//     the uncommitted work in it
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
// A TREE HANDED TO A SESSION IS NOT A TREE IT OWNS, and that is the model rather
// than an oversight. A session pointed at an existing tree -- a spawn briefed to
// work in one, whose own id names a tree that was never created, or a session
// that entered one -- is refused inside it exactly as it is inside any other tree
// its id does not name. Recognising the hand-over would need a record of it
// written by the spawning side and keyed to the session being guarded, and there
// is no such record to read. The harness records a worktree path only for a spawn
// it GAVE a tree to, which is the id-named tree above, and records nothing about
// a tree a spawn was merely pointed at -- re-verify by reading its per-spawn
// metadata, the `agent-<id>.meta.json` beside the session transcript, where the
// path is present for an isolated spawn and absent for every other. The spawning
// call itself carries no identity for the session it creates, so a record keyed
// to that session cannot be written from there either. And the one thing naming a
// handed tree is prose in the brief the guarded session carries, which is that
// session's own claim rather than a record about it. So recognising a hand-over is
// a mechanism to build rather than a field to read, and none is built here. What
// the model costs is a session that cannot delete its own leftovers in the tree it
// was handed, which is why scratch belongs outside the tree and why the procedure
// below exists for what is already inside one.
//
// A TREE NOBODY OWNS IS CLEARED WITHOUT A DELETION. An untracked leftover in one
// -- a probe, a build artifact, a file a finished or killed session left -- is
// stashed in place rather than removed: `git -C <tree> stash push -u -- <path>`
// takes that path off disk while the content stays in the repository's stash,
// which is shared across worktrees and outlives the tree. That is the answer to
// both consequences of the ownership model above: it clears the untracked file
// that holds `require-clean-tree-for-review.mjs`, and it leaves the tree retirable
// by the plain `git worktree remove` this hook allows, which git holds back while
// a tree carries modified or untracked files -- an ignored one does not hold it.
// Every step of that is driven against real git in the test beside this file
// rather than asserted here.
//
// What it deliberately allows:
//   - anything strictly inside this session's own tree (`rm -rf node_modules`,
//     `rm dist/bundle.js`) -- ordinary work on a tree the session owns
//   - `git worktree remove` without --force: git's own refusal on a tree with
//     uncommitted work is the guard, so only the --force spelling that defeats
//     that refusal is blocked. That plain spelling is how a finished tree is
//     retired, so it stays open to every session, owner or not
//   - `git clean -fdx` in a directory that merely HOLDS worktrees, which real git
//     answers with "Skipping repository" for each nested one, while every one of
//     them still resolves as a repository; only a doubled force plus -d takes
//     those. Reaching INTO a tree is the other case and needs no doubling -- a
//     single -f deletes that tree's untracked files, -fd its untracked
//     directories. The test beside this file drives real git against a real
//     linked worktree for every spelling rather than modelling the rule
//   - any `git clean` dry run (-n, --dry-run), which deletes nothing
//
// The commands read as deletions are rm, rmdir, unlink, shred, mv, find with a
// deleting action, and those same commands reached through xargs in a pipeline,
// plus the two git spellings above.
//
// TWO QUESTIONS ARE PUT TO REAL GIT rather than modelled from its on-disk layout
// or its configuration precedence: whether a directory under the guarded root
// still resolves as a repository, and whether a config file has turned
// clean.requireForce off. Both probes are read-only, bounded by a timeout, and
// run only while their answer can still change the verdict, so an ordinary Bash
// call reaches neither. A repository probe that cannot answer leaves the
// directory treated as unresolved, so the tree stays guarded; a config probe that
// cannot answer leaves git's default in place, which is the requirement of a
// force this hook assumed before it asked. The config probe runs under the
// environment assignments this hook collects off the command -- a leading `VAR=`
// on the git stage, or an `export` stage before it -- so an inline
// `GIT_CONFIG_GLOBAL=`, `HOME=` or other `GIT_CONFIG_*` spelling moves the files
// the probe reads exactly as it moves the ones the guarded command reads. A
// collected PATH is the one assignment held back: the probe is answered by the
// git this hook itself runs, never by a binary the inspected command line names.
//
// STATED LIMITS. Beyond the two questions above, this hook reads a plain command
// line and nothing more, so each of the following reaches a worktree past it.
// They are recorded rather than closed: closing them means a shell-syntax-aware
// parser, a larger and more fragile thing than the accident this guards against
// warrants. What this hook binds is the accident -- a session deleting a tree it
// can see by path -- and not a determined bypass; a command it allows is not
// thereby endorsed.
//   - COMPOSITION IS NOT UNWRAPPED. Stages are split on &&, ||, ;, a newline
//     and the pipe, and nothing else: a subshell, a brace group, or a command
//     substitution keeps its brackets inside the stage that carries it, so
//     `(cd ../agent-other && rm -rf .)` reads as a `(cd` and an `rm` whose
//     target is `.)`, neither of which names a worktree. Nor is a command inside
//     `bash -c "..."` read, or one behind an alias or a shell function. A lone
//     `&` is not a separator either -- the same byte sits inside redirect words
//     (`2>&1`, `&>`), where a split severs a command from operands that follow
//     the redirect, and a backgrounded `cd` never moves the parent shell's
//     directory, so splitting there opens worse holes than it closes (both
//     measured against real bash) -- which leaves `cmd & rm -rf <tree>` reading
//     as one stage whose command is `cmd`, the deletion behind the `&` unseen.
//   - THE COMMAND WORD IS MATCHED LITERALLY, by basename after quotes are
//     stripped -- from the whole command line before the deletion pre-filter and
//     from each token before the match -- and after backslashes are dropped, the
//     shell removing each one outside quotes. So the quoted spellings (`r"m"`,
//     `m"v"`) and the backslashed spellings (`\rm`, `r\m`) are all caught; a
//     backslash that was inside quotes names a genuinely different program to
//     the shell and is still read as the deleting command here, an over-refusal
//     in the guarded direction.
//   - ONLY sudo, command, env, nice, time, nohup, setsid, doas AND stdbuf ARE
//     PEELED as prefix words, along with their flags and the values those flags
//     take (`sudo -u NAME`, `nice -n 10`). Another wrapper stands where the
//     command word belongs and the stage reads as the wrapper -- `timeout 5 rm
//     ...` among them, deliberately: peeling it means skipping a positional
//     duration, which is modelling that tool's grammar rather than reading a
//     prefix word.
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
//   - clean.requireForce IS READ FROM THE COMMAND LINE AND FROM THE CONFIG FILES
//     GIT ITSELF RESOLVES, AND FROM NOTHING ELSE. On the command line it is a
//     `-c clean.requireForce=<off>`, `<off>` one of git's boolean-false spellings
//     (false, no, off, 0, empty), the last such `-c` winning and any `-c` setting
//     of the key winning over the files, as real git resolves it; the persisted
//     value is asked of `git config` in the directory being cleaned rather than
//     resolved here, under the assignments described above. What stays unread is
//     what the plain command line does not carry: a `--config-env` names an
//     environment variable whose value stands nowhere on the line, so it sets the
//     key from a value the probe cannot see, as does any assignment reaching git
//     by a route the stage splitting above does not surface.
//
// Exit 0 allows the call; exit 2 blocks it and feeds stderr back to Claude. Any
// unexpected failure here falls through to exit 0 (fail open) so a bug in this
// hook can never wedge every Bash command.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";

const CLAUDE_DIR = ".claude";
const WORKTREES_DIR = "worktrees";
const AGENT_TREE_PREFIX = "agent-";
const GIT_PROBE_TIMEOUT_MS = 5000;

const DELETING_COMMANDS = new Set(["rm", "rmdir", "unlink", "shred", "mv"]);

// Cheap pre-filter: a command that names none of these -- tested with quotes
// and backslashes stripped the same blunt way the token match strips them, so a
// quoted (`r"m"`) or backslashed (`r\m`) command word is not hidden from the
// gate -- cannot be any form this hook reads, and skipping it keeps the
// filesystem probes below off every unrelated Bash call.
const DELETION_MENTION = /\b(rm|rmdir|unlink|shred|mv|find|xargs|git)\b/;

function mentionsDeletion(command) {
  return DELETION_MENTION.test(command.replace(/['"\\]/g, ""));
}

// Put a read-only question to real git and return its answer, or null when it
// gave none: no git on PATH, a directory that is gone, a non-zero exit, or a run
// that outlived the timeout. `environment` carries the assignments the guarded
// command runs git under, so a probe whose answer depends on which files git
// reads resolves them from where that command would; they are passed as an
// object to the spawn rather than through a shell, so a value carrying quotes or
// spaces reaches git as it stands. The three settings below are the probe's own
// contract and are not the command's to move: which git answers it -- a spawn
// resolves the program from the CHILD's PATH, so a collected PATH would have
// this hook execute a binary the command line named -- and the shape the answer
// is read in.
function askGit(args, cwd, environment = new Map()) {
  const probe = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_PROBE_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      ...Object.fromEntries(environment),
      PATH: process.env.PATH,
      LC_ALL: "C",
      GIT_PAGER: "cat",
    },
  });
  return probe.status === 0 ? (probe.stdout ?? "").trim() : null;
}

// Whether git resolves `directory` as a repository root -- the property that
// makes `git clean` skip it instead of removing it. An empty prefix is git's own
// answer that the directory it started from is the top of a working tree; a
// directory that only sits inside one answers with the path down to it, and an
// orphaned worktree answers not at all. Asked of git rather than read out of the
// gitlink, because which of those states git still treats as a repository is
// git's behavior and not this hook's reading of the layout.
function resolvesAsRepository(directory) {
  return askGit(["rev-parse", "--show-prefix"], directory) === "";
}

// The first directory under a worktree root that git would not skip, and so
// removes along with any uncommitted work in it. One probe subprocess per entry,
// so it stops at the first hit rather than pricing every sibling.
function firstTreeGitWouldNotSkip(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const tree = `${root}/${entry.name}`;
    if (!resolvesAsRepository(tree)) return tree;
  }
  return undefined;
}

function block(reason) {
  process.stderr.write(
    `Blocked by block-worktree-deletions hook: ${reason}.\n` +
      "An agent worktree holds work that exists nowhere else until it is committed, so " +
      "deleting one destroys it unrecoverably -- there is no branch, stash, or reflog " +
      "behind it. Leave another session's tree alone, and retire a finished tree with " +
      "`git worktree remove <path>` (no --force), which refuses while the tree still has " +
      "uncommitted work. Only in a tree this session was handed -- pointed at by its own " +
      "spawn brief, the fix-round shape -- is an untracked leftover cleared without a " +
      "deletion: `git -C <tree> stash push -u -- <path>` takes that path off disk, keeps " +
      "its content in the repository's stash, and leaves the tree retirable by that plain " +
      "remove. A tree this session was not handed is another live session's workplace: a " +
      "stash there rips files out from under its owner mid-run, so it gets no cleanup of " +
      "any kind. If the path is not a registered worktree at all, say so to the " +
      "maintainer rather than deleting it some other way. This hook reads a plain command " +
      "line and nothing more -- the limits listed in its header are real, so rephrasing " +
      "around this refusal defeats it and destroys the tree anyway.\n",
  );
  process.exit(2);
}

// Split a command line into pipelines, then each pipeline into its stages, so a
// deletion hidden in a compound command or fed from an earlier stage is still
// inspected. Pragmatic, not a full shell parser. A lone `&` is deliberately not
// a separator: the same byte sits inside redirect words (`2>&1`, `&>`), where a
// split severs the command from operands that follow the redirect, and a
// backgrounded `cd X &` runs in a subshell that never moves the parent shell's
// directory -- both measured against real bash. Backgrounded composition stays
// a stated limit in the header.
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
// command runs. Each takes only option-shaped arguments of its own, so peeling it
// needs no knowledge of its grammar -- which is why `timeout`, whose duration
// stands as a bare positional, is deliberately absent.
const COMMAND_PREFIX_WORDS = new Set([
  "sudo",
  "command",
  "env",
  "nice",
  "time",
  "nohup",
  "setsid",
  "doas",
  "stdbuf",
]);

// The program a word names, as the shell resolves it: outside quotes the shell
// removes a backslash and keeps the character behind it, so `\rm` and `r\m`
// both run rm. A backslash that was inside quotes names a genuinely different
// program; it is still read as the deleting command here, an over-refusal in
// the guarded direction.
function commandName(word) {
  return basename(word.replace(/\\/g, ""));
}

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
        !INSPECTED_COMMANDS.has(commandName(next))
      ) {
        index++;
      }
      continue;
    }
    break;
  }
  const word = tokens[index];
  if (word === undefined) return null;
  return {
    name: commandName(word),
    args: tokens.slice(index + 1),
    environment,
  };
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
        command.args.some((arg) => DELETING_COMMANDS.has(commandName(arg))))
    );
  }
  if (command.name === "xargs") {
    return command.args.some((arg) => DELETING_COMMANDS.has(commandName(arg)));
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
// configured off, so a setting that disables it satisfies the force condition on
// its own. The key is compared case-folded (git folds config key names) and the
// value against git's boolean-false spellings, both measured against real git in
// the test beside this file; the last `-c` setting of the key wins, as real git
// resolves it. Null when no `-c` names the key at all, which is what sends the
// question on to git's own config files.
const REQUIRE_FORCE_KEY = "clean.requireforce";
const FORCE_DISABLING_VALUES = new Set(["false", "no", "off", "0", ""]);

function commandLineRequireForce(configSettings) {
  let disabled = null;
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

// Whether git's own requirement of a force is lifted for this clean. A `-c` on
// the command line settles it, winning over the config files as real git resolves
// it; otherwise the persisted value is asked of git in the directory being
// cleaned rather than resolved here, under the environment assignments the
// command carries, which are what decide the set of files git reads it from. A
// doubled flag force has already carried the command past every threshold this
// config could move it to, so the probe is skipped there.
function forceRequirementLifted(
  directory,
  configSettings,
  flagForce,
  environment,
) {
  const fromCommandLine = commandLineRequireForce(configSettings);
  if (fromCommandLine !== null) return fromCommandLine;
  if (flagForce >= 2) return false;
  return (
    askGit(
      ["config", "--type=bool", "--get", REQUIRE_FORCE_KEY],
      directory,
      environment,
    ) === "false"
  );
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
// worktrees loses the healthy ones only to a doubled force with -d, because git
// skips a nested repository for every lesser spelling -- and loses an orphaned
// one, which git no longer reads as a repository to skip, to a single force
// with -d.
function gitCleanVerdict(
  args,
  directory,
  ownTrees,
  knownRoots,
  configSettings,
  environment,
) {
  if (isDryRun(args)) return null;
  const flagForce = forceCount(args);
  const context = worktreeContext(directory);
  if (context !== null) {
    if (owns(directory, ownTrees)) return null;
    if (
      flagForce === 0 &&
      !forceRequirementLifted(directory, configSettings, flagForce, environment)
    ) {
      return null;
    }
    return `'git clean' would delete inside '${directory}', an agent worktree this session does not own${ownershipNote(ownTrees)}`;
  }
  const cleansDirectories = args.some(
    (arg) => arg === "--directories" || /^-[a-ce-z]*d/.test(arg),
  );
  if (!cleansDirectories) return null;
  // The roots check comes first: with no guarded root under the directory the
  // verdict is null at any force, so the config probe's answer could not change
  // it and must not run (the header's only-while-it-can-matter invariant).
  const roots = rootsUnder(directory, knownRoots);
  if (roots.length === 0) return null;
  // A lifted force requirement satisfies git's baseline, so this counts it as one
  // force: a single real -f on top of it reaches the doubled force that removes a
  // nested repository on git <= 2.44, where a disabled requireForce feeds the same
  // force counter a real -f does. git >= 2.45 stopped feeding that counter from
  // the config, so there this shape only reaches the single-force threshold and
  // the guard, which blocks it either way, conservatively over-refuses it rather
  // than model the git version. That boundary was settled by driving real git
  // across it (the 2.44/2.45 versions), not by reading git.
  const force =
    flagForce +
    (forceRequirementLifted(directory, configSettings, flagForce, environment)
      ? 1
      : 0);
  if (force === 0) return null;
  if (force >= 2) {
    const [root] = roots;
    return `'git clean' with a doubled force and -d in '${directory}' can remove nested repositories, including the ${describeTrees(treeCount(root))} under '${root}'`;
  }
  for (const root of roots) {
    const orphan = firstTreeGitWouldNotSkip(root);
    if (orphan !== undefined) {
      return `'git clean' with -d in '${directory}' would remove '${orphan}', which git no longer resolves as a repository and so no longer skips`;
    }
  }
  return null;
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
      git.configSettings,
      environment,
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
