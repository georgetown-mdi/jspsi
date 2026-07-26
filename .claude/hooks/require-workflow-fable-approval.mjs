#!/usr/bin/env node
// PreToolUse hook: route a Workflow call whose inline script names Fable to a
// user-approval prompt. It is the sibling of require-fable-approval.mjs, which
// gates the Agent tool; a Workflow script reaches the same tier through its own
// agent() options, where no top-level tool input carries the model.
//
// Detection is textual and literal: a `model:` assigned a quoted Fable spelling,
// or a quoted canonical Fable id anywhere in the script. That is the whole of what
// a text scan can see, and the limits follow from it -- all of them fail OPEN:
//   - a computed or spread model value (`model: tier`, `...options`) resolves only
//     at run time and is invisible here;
//   - a `scriptPath` invocation passes a file, not script text;
//   - a resume of an earlier run replays a script this hook never sees.
// The load-bearing half for committed scripts is the static check
// (`npm run check:workflow-agent-models`), which fails any agent() call in
// .claude/commands/ that does not pin a literal non-Fable tier. This hook covers
// the ad-hoc inline script, which no committed-file check can reach.

import { readFileSync } from "node:fs";

// `model: 'fable'` / `model: "claude-fable-5"` in any quote style, plus a bare
// quoted canonical Fable id that reaches the option by another name.
const FABLE_PATTERNS = [
  /\bmodel\s*:\s*(['"`])\s*(?:claude-)?fable[a-z0-9-]*\s*\1/i,
  /(['"`])\s*claude-fable[a-z0-9-]*\s*\1/i,
];

const ASK_REASON =
  "This Workflow's script requests the Fable tier for one of its agents, which " +
  "requires your explicit approval (per the model-tiering rule in CLAUDE.md): " +
  "Fable is reserved for deliberate hard cases and is never chosen " +
  "autonomously. Approve to run it on Fable, or deny and it will be re-issued on " +
  "a cheaper tier.";

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

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0); // unreadable event -- do not interfere
  }
  if (event.tool_name !== "Workflow") process.exit(0);

  const script = event?.tool_input?.script;
  if (typeof script !== "string" || script.length === 0) process.exit(0);
  if (FABLE_PATTERNS.some((pattern) => pattern.test(script))) ask(ASK_REASON);
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never wedge a workflow on an unexpected error
}
