#!/usr/bin/env node
// PreToolUse hook: refuse a Bash command that opens with `cd` into an agent
// worktree under .claude/worktrees/.
//
// Why this exists: the Bash tool's directory persists between calls, so a
// command beginning `cd <tree> && ...` does not scope that one call to the tree
// -- it re-homes the session into it. The write fence every non-isolated spawn
// inherits follows the session's directory, so the move lands later spawns, and
// the shells of runs already under way, in a tree that is not theirs. It was
// observed against a session whose implementer was writing in a sibling tree.
// `env -C <tree> <command>` and `git -C <tree> <args>` scope the call and leave
// the session where it stands, which is what the refusal names.
//
// What it refuses: a command whose FIRST token is `cd` and whose target
// resolves inside a single worktree under a `.claude/worktrees/` root.
//
// What it allows by design:
//   - a `cd` into the tree the call is already being made from: the session is
//     homed there already, so nothing moves
//   - a `cd` to the `.claude/worktrees` root itself, which is no worktree
//   - a `cd` anywhere else -- /workspace, a /tmp rebase tree, a subdirectory
//
// What it cannot see: a `cd` that is not the command's first token, one whose
// target is a variable or a `~` path (neither is expanded here), and a
// directory change made by anything other than `cd`. The narrow match is the
// point: the observed shape is the leading `cd`, and a false positive on a
// wider one would cost a capability rather than a rephrase.
//
// Exit 0 allows the call; exit 2 blocks it and feeds stderr back to Claude. Any
// unexpected failure here falls through to exit 0 (fail open) so a bug in this
// hook can never wedge every Bash command.

import { resolve } from "node:path";

import { commandOf, eventCwd, eventForTools } from "./lib/event.mjs";
import { splitPipelines, splitStages, tokenize } from "./lib/shell.mjs";
import { isInside, worktreeContext } from "./lib/worktrees.mjs";

// Options `cd` takes in front of its target. A lone `-` is not one of them: it
// names the previous directory, which this hook cannot resolve.
const CD_OPTIONS = /^(?:--|-[A-Za-z]+)$/;

function block(tree) {
  process.stderr.write(
    `Blocked by block-worktree-cd hook: this command opens with a \`cd\` into ${tree}, ` +
      "which re-homes this session into that worktree rather than scoping the call to it. " +
      "The write fence every non-isolated spawn inherits moves with it, onto a tree that " +
      "may already be another agent's.\n" +
      `Scope the call instead: \`env -C ${tree} <command>\`, or \`git -C ${tree} <args>\` ` +
      "for a git question about that tree.\n",
  );
  process.exit(2);
}

/**
 * The directory a command's leading `cd` names, or null when the command does
 * not open with one or names no target (a bare `cd`, which goes home).
 */
function leadingCdTarget(command) {
  const leading = splitStages(splitPipelines(command)[0])[0];
  const tokens = tokenize(leading ?? "");
  if (tokens[0] !== "cd") return null;
  const target = tokens.slice(1).find((token) => !CD_OPTIONS.test(token));
  return target ?? null;
}

function main() {
  const event = eventForTools("Bash");
  if (event === null) process.exit(0); // unreadable, or another tool
  const command = commandOf(event);
  if (command === null) process.exit(0);

  const target = leadingCdTarget(command);
  if (target === null) process.exit(0);

  const from =
    eventCwd(event) ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const context = worktreeContext(resolve(from, target));
  if (context === null || context.tree === null) process.exit(0);
  if (isInside(resolve(from), context.tree)) process.exit(0); // already homed there

  block(context.tree);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never wedge Bash on an unexpected hook error
}
