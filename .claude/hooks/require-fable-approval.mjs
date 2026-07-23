#!/usr/bin/env node
// PreToolUse hook: route any Agent spawn on the Fable tier to a user-approval
// prompt. Fable is the most expensive tier, reserved for deliberate hard cases (a
// complicated plan, a high-stakes security/protocol review); the owner approves
// each such spawn rather than letting the agent choose it autonomously. This hook
// returns permissionDecision "ask" for a Fable spawn so the harness prompts the
// owner; every other tier passes through untouched.
//
// Detection covers both Fable spellings the Agent tool admits: an explicit
// `model: "fable"`, and a bare spawn whose subagent_type's .claude/agents/*.md
// pins `model: fable`. The full id "claude-fable-5" is not a concern here -- the
// sibling require-agent-model hook blocks any model outside the {opus, sonnet,
// haiku, fable} alias set, so "fable" is the only spelling that reaches a spawn.
//
// This gates the Agent tool. Fable requested inside a Workflow script's own
// agent() call is a separate, unhooked vector (the model is buried in the script,
// not a top-level tool input); it is tracked separately, not covered here.
//
// Fail-open on any error EXCEPT the directly-detected explicit Fable model, which
// needs no filesystem and always asks. The pinned-Fable path reads the agents dir
// and fails open on an I/O error, because require-agent-model already fails CLOSED
// on an unverifiable bare spawn, so an unresolvable pin is blocked upstream before
// it could reach a live spawn.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ASK_REASON =
  "This spawn runs on the Fable tier, which requires your explicit approval " +
  "(per the model-tiering rule in CLAUDE.md): Fable is reserved for deliberate " +
  "hard cases and is never chosen autonomously. Approve to run it on Fable, or " +
  "deny and it will be re-issued on a cheaper tier.";

function ask(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

// Return the pinned `model:` value of the .claude/agents/<name>.md whose leading
// frontmatter names `subagentType`, or null. Mirrors require-agent-model.mjs's
// frontmatter read, but keeps the model value so a Fable pin is detectable.
function pinnedModelFor(agentsDir, subagentType) {
  for (const entry of readdirSync(agentsDir)) {
    if (!entry.endsWith(".md")) continue;
    const lines = readFileSync(join(agentsDir, entry), "utf8").split("\n");
    if (lines[0].trim() !== "---") continue;
    let name = null;
    let model = null;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") break;
      const nameMatch = lines[i].match(/^name:\s*(.+?)\s*$/);
      if (nameMatch) name = nameMatch[1];
      const modelMatch = lines[i].match(/^model:\s*(.+?)\s*$/);
      if (modelMatch) model = modelMatch[1];
    }
    if (name === subagentType) return model;
  }
  return null;
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0); // unreadable event -- do not interfere
  }
  if (event.tool_name !== "Agent") process.exit(0);

  // Explicit-model path: no filesystem, always decisive.
  const model = event?.tool_input?.model;
  if (model === "fable") ask(ASK_REASON);
  if (typeof model === "string" && model.length > 0) process.exit(0);

  // Bare spawn: catch a subagent_type that pins Fable. Fail open on a read error
  // -- require-agent-model fails closed on an unverifiable bare spawn, so an
  // unresolvable pin never reaches a live spawn.
  const subagentType = event?.tool_input?.subagent_type;
  if (typeof subagentType !== "string" || subagentType.length === 0) {
    process.exit(0);
  }
  try {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || event.cwd;
    const agentsDir = join(projectDir, ".claude", "agents");
    if (pinnedModelFor(agentsDir, subagentType) === "fable") ask(ASK_REASON);
  } catch {
    process.exit(0); // fail open; require-agent-model backstops unverifiable pins
  }
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never wedge a spawn on an unexpected error
}
