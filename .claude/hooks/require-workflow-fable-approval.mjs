#!/usr/bin/env node
// PreToolUse hook: route a Workflow call whose inline script names Fable to a
// user-approval prompt. It is the sibling of require-fable-approval.mjs, which
// gates the Agent tool; a Workflow script reaches the same tier through its own
// agent() options, where no top-level tool input carries the model.
//
// Detection is textual and literal, over both halves of the call the model can
// arrive in: the inline `script` and the serialized `args` it reads (a script can
// pass `model: args.model` and carry the spelling in the args object of the same
// event). A `model:` key, quoted or bare, assigned a Fable spelling, or a quoted
// string that is itself a Fable spelling, asks.
//
// That is the whole of what a text scan can see, and the limits follow from it --
// all of them fail OPEN: a model value computed at run time (`model: tier` with
// the tier derived, `...options`) is invisible here; a `scriptPath` invocation
// passes a file, not script text; and a resume of an earlier run replays a script
// this hook never sees. The load-bearing half for committed scripts is the static
// check (`npm run check:workflow-agent-models`), which fails any agent() call in a
// fenced js block under .claude/commands/, .claude/agents/, or .claude/skills/, or
// in a checked-in Workflow script (.claude/scripts/*-workflow.mjs), that does not
// pin a literal non-Fable tier -- within its own stated limits, a computed model
// value and a call reached through an alias. This hook covers the ad-hoc inline
// script, which no committed-file check can reach.
//
// Every path but a positive match exits 0 and allows the call: an unreadable or
// unparseable event, a tool other than Workflow, a call carrying neither script
// nor args, a script and args with no Fable spelling in them, and any unexpected
// throw (the outer catch). Fable's real gate for the Agent tool is
// require-fable-approval.mjs; a false negative here costs an unprompted Workflow
// spawn, while a hook that wedged every Workflow call would cost far more.

import { eventForTools } from "./lib/event.mjs";

// `model: 'fable'` / `"model": "claude-fable-5"` in any quote style (the key is
// quoted when the option rides in a JSON args object), plus a quoted string that
// is nothing but a Fable spelling, which reaches the option by another name.
const FABLE_PATTERNS = [
  /(?<![\w$])(?:model|(['"`])model\1)\s*:\s*(['"`])\s*(?:claude-)?fable[a-z0-9-]*\s*\2/i,
  /(['"`])\s*(?:claude-)?fable[a-z0-9-]*\s*\1/i,
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
  const event = eventForTools("Workflow");
  if (event === null) process.exit(0); // unreadable, or another tool

  const script = event?.tool_input?.script;
  const args = event?.tool_input?.args;
  const texts = [];
  if (typeof script === "string" && script.length > 0) texts.push(script);
  if (args !== undefined && args !== null) {
    texts.push(typeof args === "string" ? args : JSON.stringify(args));
  }
  const namesFable = (text) =>
    typeof text === "string" &&
    FABLE_PATTERNS.some((pattern) => pattern.test(text));
  if (texts.some(namesFable)) ask(ASK_REASON);
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never wedge a workflow on an unexpected error
}
