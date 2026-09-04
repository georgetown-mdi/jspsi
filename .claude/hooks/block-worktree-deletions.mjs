#!/usr/bin/env node
// PreToolUse hook: refuse a Bash command that would delete an agent worktree
// under .claude/worktrees/, or anything inside one this session is not working in.
//
// Why this exists: a spawned agent ran `rm -rf` across two live sibling
// worktrees mid-session and destroyed the uncommitted work in both. Nothing else
// stands in the way -- the trees are siblings on one filesystem and every session
// can reach all of them by path -- and the loss is unrecoverable, because work
// that was never committed has no branch, no stash, and no reflog behind it.
//
// What it refuses:
//   - a path inside a worktree this session is neither standing in nor owns
//   - a worktree taken whole, this session's own included, or the root they all
//     live under
//   - a path that CONTAINS live worktrees, the `rm -rf /workspace` shape, which
//     names no worktree at all
//   - a `git clean` that would delete INSIDE a worktree this session is neither
//     standing in nor owns -- its force coming from a flag or from a
//     `clean.requireForce` git resolves to false, which lifts git's own
//     requirement -- and one whose force (a flag and that config counted together)
//     reaches a doubled `-ff` plus -d in a directory that merely holds worktrees
//   - a single-force `git clean` with -d in a directory that merely holds
//     worktrees while any directory under the guarded root no longer resolves as
//     a repository: git skips a repository, not a path, so an ORPHANED tree is
//     taken by that single force along with the uncommitted work in it
//   - `git worktree remove --force`, which takes a tree git's own refusal would
//     have held on to
//
// WHICH TREE A SESSION MAY DELETE INSIDE is answered twice over, because neither
// answer alone is right. The first is the agent id the event holds: the harness
// gives an isolated agent a worktree named after that id
// (`.claude/worktrees/agent-<agent_id>`, recorded as `worktreePath` in the
// harness's own subagent metadata), so that tree is its own wherever it is
// standing. The second is the tree it IS standing in -- the worktree containing
// the directory this call's operands resolve against, which a `cd` earlier on the
// same line moves exactly as it moves that resolution. A session standing in a
// tree is doing its work there, and clearing its own probes, screenshots and
// review artifacts is that work: refusing it fired on a cleanup far more often
// than on a loss, which teaches agents to read this hook's refusals as noise.
// Neither answer buys the tree ITSELF -- a tree taken whole, and the root they all
// live under, are refused before either is consulted, and that is the loss this
// hook was built for. A session standing outside every tree has only what its id
// names, and one the event gives no agent id has nothing: that is the right answer
// for the orchestrator session working in the primary tree, from which every tree
// stays guarded. When neither answer names a tree, the refusal says so rather than
// leaving a fail-closed refusal unexplained.
//
// WHAT STANDING IN A TREE DOES NOT DETERMINE is whether the session belongs there,
// and nothing readable determines it. The harness records a worktree path only for a
// spawn it GAVE a tree to and records nothing about a tree a spawn was merely
// pointed at -- re-verify by reading its per-spawn metadata, the
// `agent-<id>.meta.json` beside the session transcript, where the path is present
// for an isolated spawn and absent for every other. So a session handed a tree,
// one that walked into it, and one that cd'ed into a sibling on this very line
// are a single event here, and each may clear that tree's CONTENTS. What that
// buys is the fix-round shape -- a spawn pointed at an existing branch worktree
// -- cleaning up after itself. Every tree the session is not standing in, and
// every tree taken whole, are guarded from all of them alike.
//
// A TREE NOBODY IS STANDING IN IS CLEARED WITHOUT A DELETION. An untracked
// leftover in a stranded tree -- a probe, a build artifact, a file a finished or
// killed session left -- is stashed in place rather than removed:
// `git -C <tree> stash push -u -- <path>` takes that path off disk while the
// content stays in the repository's stash, which is shared across worktrees and
// outlives the tree. That is the answer for a tree no session is working in: it
// clears the untracked file that holds `require-clean-tree-for-review.mjs` back,
// and it leaves the tree retirable by the plain `git worktree remove` this hook
// allows, which git holds back while a tree has modified or untracked files
// -- an ignored one does not hold it.
// Every step of that is driven against real git in the test beside this file
// rather than asserted here.
//
// What it allows by design:
//   - anything strictly inside the tree this session is standing in or owns
//     (`rm -rf node_modules`, `rm dist/bundle.js`, `rm probe.test.ts`) --
//     ordinary work on the tree the work is happening in
//   - `git worktree remove` without --force: git's own refusal on a tree with
//     uncommitted work is the guard, so only the --force spelling that defeats
//     that refusal is blocked. That plain spelling is how a finished tree is
//     retired, so it stays open to every session, owner or not
//   - `git clean -fdx` in a directory that merely HOLDS worktrees, which real git
//     answers with "Skipping repository" for each nested one; only a doubled
//     force plus -d takes those, while reaching INTO a tree needs no doubling.
//     The test beside this file drives real git against a real linked worktree
//     for every spelling rather than modelling the rule
//   - any `git clean` dry run (-n, --dry-run), which deletes nothing
//
// The commands read as deletions are rm, rmdir, unlink, shred, mv, find with a
// deleting action, and those same commands reached through xargs in a pipeline,
// plus the two git spellings above. Of the words on such a line only the ones
// that command REMOVES are read as targets, and a find primary that runs a
// command of its own is read twice over -- the tree find walks by the
// start-point rule, and the paths standing in the -exec by the rules of the
// command they are handed to. Which words those are for each spelling is driven
// in the test beside this file.
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
// environment assignments this hook collects off the command, so an inline
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
//   - COMPOSITION IS NOT UNWRAPPED. A subshell, a brace group, a command
//     substitution, a `bash -c "..."`, an alias and a shell function all keep
//     what they hold, and a lone `&` is not a separator.
//   - THE COMMAND WORD IS MATCHED LITERALLY, by basename with quotes and
//     backslashes stripped, so a quoted or backslashed spelling of a deleting
//     command is caught. A backslash that was inside quotes names a genuinely
//     different program to the shell and is read as the deleting command anyway,
//     an over-refusal in the guarded direction.
//   - ONLY sudo, command, env, nice, time, nohup, setsid, doas AND stdbuf ARE
//     PEELED as prefix words, along with their flags and the values those take.
//     Another wrapper stands where the command word belongs and the stage reads
//     as the wrapper -- `timeout 5 rm ...` among them, by design: peeling it
//     means skipping a positional duration, which is modelling that tool's
//     grammar rather than reading a prefix word.
//   - TARGETS THAT ONLY EXIST AT RUNTIME are not seen: a path read from a file,
//     built up in a variable, or produced by a glob.
//   - A `cd` MOVES THE DIRECTORY paths resolve against only when it stands as
//     its own command, and a symlink pointing into a worktree is not resolved
//     (removing the link does not follow it anyway).
//   - ONLY THE OPERANDS A DELETING COMMAND REMOVES ARE READ, so a worktree path
//     standing elsewhere on the line is not a deletion of it, and an `mv` or a
//     redirect that OVERWRITES a file inside a tree passes as `cp` always has:
//     what this hook guards is a tree taken away, not a file rewritten. `xargs`
//     is the one exception, its targets arriving from an earlier stage at
//     runtime, so in a pipeline feeding one every operand is a candidate.
//   - STANDING IN A TREE IS TAKEN FOR WORKING IN IT, so `cd <sibling> && rm -rf
//     src` is allowed where the same deletion aimed at that path from outside is
//     refused. That is the model above rather than an oversight, and it is
//     bounded: no `cd` reaches the tree itself, the root they all live under, or
//     any tree other than the one the shell ends up in.
//   - WHICH TREE THE SHELL IS STANDING IN COMES FROM THE WORKING DIRECTORY THE
//     CALL ITSELF HOLDS, which persists between calls, and not from a `cd`
//     this line spells; a `cd` moves it from there for the pipelines after it.
//     Whether the harness reports a drifted shell cwd or a stale session cwd was
//     not driven at this ref, so a session whose cwd has drifted into a tree may
//     read as standing outside it -- which refuses a cleanup rather than
//     allowing a loss.
//   - A GIT DIRECTORY REDIRECT IS READ ONLY IN THE LITERAL FORMS MEASURED IN THE
//     TEST beside this file: `-C`, `--work-tree`, and `GIT_WORK_TREE` set as a
//     leading assignment or by an `export` stage. A spelling outside that
//     measured set passes unread.
//   - clean.requireForce IS READ FROM THE COMMAND LINE AND FROM THE CONFIG FILES
//     GIT ITSELF RESOLVES, AND FROM NOTHING ELSE, the resolution asked of git
//     rather than reimplemented. So a `--config-env`, which names a variable
//     whose value stands nowhere on the line, stays unread, as does any
//     assignment reaching git by a route the stage splitting does not expose.
//
// Exit 0 allows the call; exit 2 blocks it and feeds stderr back to Claude. Any
// unexpected failure here falls through to exit 0 (fail open) so a bug in this
// hook can never wedge every Bash command.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { basename, resolve } from "node:path";

import { commandOf, eventCwd, eventForTools } from "./lib/event.mjs";
import { splitPipelines, splitStages, tokenize } from "./lib/shell.mjs";
import { isInside, isStrictlyInside } from "./lib/worktrees.mjs";

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
// that outlived the timeout. `environment` holds the assignments the guarded
// command runs git under, so a probe whose answer depends on which files git
// reads resolves them from where that command would; they are passed as an
// object to the spawn rather than through a shell, so a value containing quotes or
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
      "uncommitted work. In a STRANDED tree -- one no session is working in, waiting to " +
      "be retired -- an untracked leftover is cleared without a deletion: " +
      "`git -C <tree> stash push -u -- <path>` takes that path off disk, keeps its " +
      "content in the repository's stash, and leaves the tree retirable by that plain " +
      "remove. A tree another session is working in gets no cleanup of any kind: a stash " +
      "there rips files out from under it mid-run. If the path is not a registered " +
      "worktree at all, say so to the maintainer rather than deleting it some other " +
      "way. This hook reads a plain command " +
      "line and nothing more -- the limits listed in its header are real, so rephrasing " +
      "around this refusal defeats it and destroys the tree anyway.\n",
  );
  process.exit(2);
}

// Words that stand in front of the real command word without changing which
// command runs. Each takes only option-shaped arguments of its own, so peeling it
// needs no knowledge of its grammar -- which is why `timeout`, whose duration
// stands as a bare positional, is absent by design.
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

// The single worktree a shell is standing in, or null when its directory is
// outside every tree (the worktrees root itself included, which is no tree).
function standingTreeOf(directory) {
  return worktreeContext(directory)?.tree ?? null;
}

function standsIn(path, standingTree) {
  return standingTree !== null && isInside(path, standingTree);
}

// Which tree the refused session may work in, so a refusal is diagnosable from
// the message alone. Both answers are named when they differ -- a session
// standing in one tree while its agent id names another may work in either, and
// a message reporting one of them sends it to the wrong place. With neither, the
// message has to say that no tree was named rather than leave the fail-closed
// refusal unexplained.
function ownershipNote(ownTrees, standingTree) {
  const [owned] = ownTrees.filter((tree) => tree !== standingTree);
  if (standingTree !== null) {
    return owned === undefined
      ? ` -- this session is working in '${standingTree}'`
      : ` -- this session is working in '${standingTree}' and owns '${owned}'`;
  }
  return owned === undefined
    ? " -- this session owns no agent worktree"
    : ` -- this session owns only '${owned}'`;
}

// The live worktree roots that deleting `target` would remove along with it.
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
    (root) => isStrictlyInside(root, target) && treeCount(root) > 0,
  );
}

// Why deleting `target` is refused, or null when it may proceed. A tree taken
// whole and the root they all live under are decided before the standing tree is
// consulted, so working in a tree never buys the tree itself.
function deletionVerdict(target, ownTrees, knownRoots, standingTree) {
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
    if (owns(target, ownTrees)) {
      return `'${target}' is this session's own worktree, taken whole`;
    }
    if (standsIn(target, standingTree)) {
      return `'${target}' is the worktree this session is working in, taken whole`;
    }
    return `'${target}' is another session's worktree, taken whole${ownershipNote(ownTrees, standingTree)}`;
  }
  if (owns(target, ownTrees) || standsIn(target, standingTree)) return null;
  return `'${target}' is inside '${context.tree}', an agent worktree this session is not working in${ownershipNote(ownTrees, standingTree)}`;
}

// Tokens that are argument syntax rather than operands, so they are never
// resolved as paths.
function isPathOperand(token) {
  return (
    !token.startsWith("-") && !["{}", ";", "+", "!", "(", ")"].includes(token)
  );
}

// The `find` primaries that run a command of their own.
const EXEC_PRIMARY = /^-(exec|execdir|ok|okdir)$/;

// What ends such a primary within a single stage: a `+`, or the bare `\` a `\;`
// terminator leaves behind -- the stage splitting above takes a `;` byte whether
// the shell escaped it or not, so only the escape reaches here, and a quoted
// `';'` leaves nothing at all, ending the primary at the end of the stage.
function endsExec(token) {
  return token === "+" || /^\\+$/.test(token);
}

function deletesPaths(command) {
  if (DELETING_COMMANDS.has(command.name)) return true;
  if (command.name === "find") {
    return (
      command.args.includes("-delete") ||
      (command.args.some((arg) => EXEC_PRIMARY.test(arg)) &&
        command.args.some((arg) => DELETING_COMMANDS.has(commandName(arg))))
    );
  }
  if (command.name === "xargs") {
    return command.args.some((arg) => DELETING_COMMANDS.has(commandName(arg)));
  }
  return false;
}

// `find` removes what it walks, so its targets are its START POINTS: the run of
// path operands that begins at the first one, ending at the expression that
// follows them. A leading option (`find -L <tree> ...`) is stepped over rather
// than read as the end of the list, and an operand inside the expression is
// never one of them: a `-name` pattern and an `-exec` command word name nothing
// find removes, while the paths an `-exec` hands a deleting command are read as
// that command's own.
function startPoints(args) {
  const points = [];
  for (const arg of args) {
    if (isPathOperand(arg)) points.push(arg);
    else if (points.length > 0) break;
  }
  return points;
}

// What a `find` primary's own command removes: find hands that command the
// arguments standing between its command word and the terminator unchanged, so a
// path written there is one the line takes away even though find never walked it
// (`find /tmp -maxdepth 0 -exec rm -rf <tree> +` names no worktree among its
// start points). The arguments are read by the rules of the command they belong
// to, so an `mv` destination inside an `-exec` is no more a removal than one on
// a stage of its own, and the `{}` find substitutes is not a literal path.
function execTargets(args) {
  const targets = [];
  for (const [index, arg] of args.entries()) {
    if (!EXEC_PRIMARY.test(arg)) continue;
    const word = args[index + 1];
    if (word === undefined || !DELETING_COMMANDS.has(commandName(word))) {
      continue;
    }
    const end = args.findIndex((token, at) => at > index && endsExec(token));
    targets.push(
      ...removalTargets({
        name: commandName(word),
        args: args.slice(index + 2, end < 0 ? args.length : end),
      }),
    );
  }
  return targets;
}

// Where a flag names the destination `mv` writes to: the index of the operand
// holding it, or null when the flag contains it inside its own token. Undefined
// when no flag names one at all, which leaves the destination the last operand.
// A short `-t` is read the way getopt reads it whatever it is bundled with, so
// `mv -vt DIR src` and `mv -fvtDIR src` name a destination exactly as `mv -t DIR
// src` does: the letters after that `t` are the directory when there are any,
// and the next argument is it when there are none.
function destinationOperand(args) {
  for (const [index, arg] of args.entries()) {
    if (arg === "--target-directory") return index + 1;
    if (arg.startsWith("--target-directory=")) return null;
    if (!/^-[^-]/.test(arg)) continue;
    const bundled = arg.indexOf("t", 1);
    if (bundled < 0) continue;
    return bundled === arg.length - 1 ? index + 1 : null;
  }
  return undefined;
}

// `mv` removes its SOURCES and writes its destination, so the destination -- the
// last operand, or the one a `-t` names -- is not a path it takes away. What that
// leaves unread is an mv that OVERWRITES a file in a tree, which is outside this
// hook's subject exactly as `cp` and a `>` redirect are: neither takes the tree,
// and neither is read here.
function moveSources(args) {
  const destination = destinationOperand(args);
  const operands = args.filter(
    (arg, index) => isPathOperand(arg) && index !== destination,
  );
  return destination === undefined ? operands.slice(0, -1) : operands;
}

// The paths a deleting command actually removes.
function removalTargets(command) {
  if (command.name === "find") {
    return [...startPoints(command.args), ...execTargets(command.args)];
  }
  if (command.name === "mv") return moveSources(command.args);
  return command.args.filter(isPathOperand);
}

// The candidate targets of a pipeline: the operands its deleting commands remove,
// and nothing else on the line. `xargs` is the one shape whose targets are not on
// its own stage -- `find <tree> -print0 | xargs -0 rm -rf` names the tree in the
// stage that reads it -- so there, and only there, every operand in the pipeline
// is a candidate.
function removalOperands(commands) {
  const deleting = commands.filter(deletesPaths);
  if (deleting.length === 0) return [];
  if (deleting.some((command) => command.name === "xargs")) {
    return commands.flatMap((command) => command.args).filter(isPathOperand);
  }
  return deleting.flatMap(removalTargets);
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

// Read a git invocation as the directory redirects it holds, its subcommand,
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
// the command line decides it, winning over the config files as real git resolves
// it; otherwise the persisted value is asked of git in the directory being
// cleaned rather than resolved here, under the environment assignments the
// command holds, which are what decide the set of files git reads it from. A
// doubled flag force has already pushed the command past every threshold this
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
// includes no `=`.
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
// one, which git no longer treats as a repository to skip, to a single force
// with -d.
function gitCleanVerdict(
  args,
  directory,
  ownTrees,
  knownRoots,
  configSettings,
  environment,
  standingTree,
) {
  if (isDryRun(args)) return null;
  const flagForce = forceCount(args);
  const context = worktreeContext(directory);
  if (context !== null) {
    if (owns(directory, ownTrees) || standsIn(directory, standingTree)) {
      return null;
    }
    if (
      flagForce === 0 &&
      !forceRequirementLifted(directory, configSettings, flagForce, environment)
    ) {
      return null;
    }
    return `'git clean' would delete inside '${directory}', an agent worktree this session is not working in${ownershipNote(ownTrees, standingTree)}`;
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
  // than model the git version. That boundary was fixed by driving real git
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

function gitVerdict(
  args,
  cwd,
  ownTrees,
  knownRoots,
  environment,
  standingTree,
) {
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
      standingTree,
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
  const event = eventForTools("Bash");
  if (event === null) process.exit(0); // unreadable, or another tool
  const command = commandOf(event);
  if (command === null) process.exit(0);
  if (!mentionsDeletion(command)) process.exit(0);

  const sessionCwd = eventCwd(event) ?? process.cwd();
  const session = worktreeContext(sessionCwd);
  const knownRoots = worktreeRoots(session?.root ?? null);
  const ownTrees = ownedTrees(event.agent_id, knownRoots);

  let cwd = sessionCwd;
  const exported = new Map();
  for (const pipeline of splitPipelines(command)) {
    // The tree the shell stands in when this pipeline runs, which a `cd` in an
    // earlier one moves exactly as it moves what a relative operand resolves
    // against.
    const standingTree = standingTreeOf(cwd);
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
        standingTree,
      );
      if (reason) block(reason);
    }
    for (const token of removalOperands(commands)) {
      const reason = deletionVerdict(
        resolve(cwd, token),
        ownTrees,
        knownRoots,
        standingTree,
      );
      if (reason) block(reason);
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
