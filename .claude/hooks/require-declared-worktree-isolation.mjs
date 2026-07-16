#!/usr/bin/env node
// PreToolUse hook: refuse an Agent spawn whose prompt tells the agent it is in an
// isolated worktree while the call does not actually pass isolation:"worktree".
//
// Why this exists: `isolation:"worktree"` on the Agent call is the ONLY thing that
// puts a subagent in its own worktree; prose in the prompt is inert. A spawn that
// asserts "you are in an isolated worktree" but omits the flag lands the agent in
// the shared /workspace, where concurrent writers clobber each other's uncommitted
// edits and race the IDE formatter (the exact five-way collision this hook was
// written after). The tell is a contradiction inside a single call -- the prompt
// claims isolation the call did not request -- so it is checkable, and a check
// cannot rot the way a convention note does.
//
// Scope: this fires ONLY on the contradiction. A spawn that correctly passes the
// flag is allowed; a spawn whose prompt never claims worktree isolation is allowed
// (a solo writer or a read-only reviewer deliberately sharing /workspace is fine);
// an instruction to CREATE a detached /tmp worktree by hand is not a claim of
// present isolation and does not match. So the false-positive surface is narrow and
// a legitimate call is never wedged by a stray mention of the word.
//
// Fail-open scaffolding follows block-protected-push.mjs: JSON event on stdin, exit
// 0 allows, exit 2 blocks and feeds stderr back to Claude. This is an ergonomics /
// process gate, not a security boundary -- nothing catastrophic slips through a
// missed block (worst case is a collision the author will see) -- so every
// unexpected error fails OPEN rather than wedge Agent spawns.

import { readFileSync } from "node:fs";

// Present-tense assertions that the agent's current working directory IS an
// isolated worktree. Kept deliberately narrow: each targets a claim of STATE
// ("you are in ...", "this/your worktree", "isolated worktree"), not an
// instruction to build one ("create a /tmp worktree", "git worktree add"), which
// describes the agent making its own and is a legitimate un-flagged pattern.
const ISOLATION_CLAIMS = [
  /\bisolated\s+(?:git\s+)?worktree\b/i,
  /\byou\s+are\s+(?:currently\s+|now\s+)?(?:in|inside|working\s+(?:in|inside))\s+(?:an?\s+|your\s+|the\s+)?(?:isolated\s+|own\s+|fresh\s+|git\s+)*worktree\b/i,
  /\b(?:this|your)\s+(?:own\s+)?(?:isolated\s+|fresh\s+|git\s+)*worktree\b/i,
];

function block(reason) {
  process.stderr.write(
    `Blocked by require-declared-worktree-isolation hook: ${reason}.\n`,
  );
  process.exit(2);
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0); // unreadable event -- do not interfere
  }
  if (event.tool_name !== "Agent") process.exit(0);

  // Already isolated: the flag is the only thing that matters; nothing to check.
  if (event?.tool_input?.isolation === "worktree") process.exit(0);

  const prompt = event?.tool_input?.prompt;
  if (typeof prompt !== "string" || prompt.length === 0) process.exit(0);

  const claimsIsolation = ISOLATION_CLAIMS.some((re) => re.test(prompt));
  if (!claimsIsolation) process.exit(0);

  block(
    "the spawn prompt tells the agent it is in an isolated worktree, but the call " +
      'does not pass isolation:"worktree", so the agent will run in the shared ' +
      "/workspace and can collide with concurrent writers (clobbered edits, " +
      'formatter races). Either pass isolation:"worktree" on the Agent call (then ' +
      "have the agent run .claude/scripts/worktree-init.sh first to provision " +
      "node_modules), or drop the worktree claim from the prompt if the agent is " +
      "meant to share /workspace",
  );
}

try {
  main();
} catch {
  // Fail open on any unexpected error: this gate guards ergonomics, not a security
  // or correctness boundary, so a stray failure must never wedge an Agent spawn.
  process.exit(0);
}
