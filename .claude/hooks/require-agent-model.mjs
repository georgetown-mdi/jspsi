#!/usr/bin/env node
// PreToolUse hook: refuse an Agent spawn that neither passes an explicit model nor
// names a subagent_type whose .claude/agents/ definition pins one.
//
// Why this exists: an Agent spawn with no `model` silently inherits the session
// model, with no error and no tell. That leak is exactly what this hook forbids --
// every spawn must choose its model, either inline or through a pinned definition.
//
// ONE SUBAGENT TYPE IS EXEMPT: `fork`. A fork inherits the parent session and runs
// on the parent's model, and the platform DISCARDS a `model` passed with it, so the
// inheritance this hook exists to stop is the documented and unavoidable behavior of
// that spawn rather than a leak an author could have closed. Requiring a model there
// refuses a correct call and teaches nothing: the value it demands changes no
// outcome. So a fork passes with whatever model it was given, and the tier check does not
// run on it either -- validating a string the platform discards is theater, and this
// hook has nothing to say about a model that was never a choice.
//
// Dated basis: 2026-08-31, the Agent tool's own parameter contract -- `"fork"` forks
// yourself, "the fork inherits your full conversation context and always runs on
// your model -- a `model` override is ignored". This is a dated platform-behavior
// exemption, not eternal law.
//
// Re-verification method: from a session on one tier, spawn a fork passing `model`
// set to a DIFFERENT tier, and read `message.model` on the fork's first assistant
// turn in its transcript (`agent-<id>.jsonl` beside the session transcript). The
// exemption holds while that resolves to the PARENT's tier. If it ever resolves to
// the passed tier, a fork's model is a real choice again: delete the exemption
// below, its test, and this note.
//
// Fail-open scaffolding follows block-protected-push.mjs: JSON event on stdin, exit
// 0 allows, exit 2 blocks and feeds stderr back to Claude. An unexpected failure
// falls through to exit 0 -- EXCEPT the bare-spawn path (no explicit model), which
// fails CLOSED: a bare spawn is the risky call with no downstream safety check, so if
// the allowlist read throws we exit 2 rather than let an unverifiable pin through.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { eventForTools } from "./lib/event.mjs";

const TIERS = new Set(["opus", "sonnet", "haiku", "fable"]);

// The subagent type whose model the platform discards; see the header's dated basis.
const INHERITING_SUBAGENT_TYPE = "fork";

function block(reason) {
  process.stderr.write(`Blocked by require-agent-model hook: ${reason}.\n`);
  process.exit(2);
}

// Collect the frontmatter `name` of every .claude/agents/*.md whose leading
// `---`...`---` block pins a `model:` in the tier set. A value outside the set
// (whitespace-only, a typo like "opuss") is not a valid pin, matching the
// explicit-model path, so a bare spawn of that definition stays blocked until the
// value is fixed. Throws on any read/parse failure; the bare-spawn caller turns
// that throw into a fail-closed block.
function pinnedDefinitions(agentsDir) {
  const pinned = new Set();
  for (const entry of readdirSync(agentsDir)) {
    if (!entry.endsWith(".md")) continue;
    const text = readFileSync(join(agentsDir, entry), "utf8");
    const fm = leadingFrontmatter(text);
    if (!fm) continue;
    let name = null;
    let modelPinned = false;
    for (const line of fm.split("\n")) {
      const nameMatch = line.match(/^name:\s*(.+?)\s*$/);
      if (nameMatch) name = nameMatch[1];
      const modelMatch = line.match(/^model:\s*(.+?)\s*$/);
      if (modelMatch && TIERS.has(modelMatch[1])) modelPinned = true;
    }
    if (name && modelPinned) pinned.add(name);
  }
  return pinned;
}

// Return the body between the leading `---` fence and the next `---`, or null when
// the file does not open with a frontmatter fence.
function leadingFrontmatter(text) {
  const lines = text.split("\n");
  if (lines[0].trim() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return lines.slice(1, i).join("\n");
  }
  return null;
}

function main() {
  const event = eventForTools("Agent");
  if (event === null) process.exit(0); // unreadable, or another tool

  const subagentType = event?.tool_input?.subagent_type;
  if (subagentType === INHERITING_SUBAGENT_TYPE) process.exit(0);

  const model = event?.tool_input?.model;
  if (typeof model === "string" && model.length > 0) {
    // Explicit-model spawn: validate the tier and never touch the filesystem.
    if (!TIERS.has(model)) {
      block(
        `unknown model tier '${model}'; pass one of opus, sonnet, haiku, fable`,
      );
    }
    process.exit(0);
  }

  // Bare spawn (no explicit model). This path fails CLOSED: any error in resolving
  // the project dir or reading the allowlist blocks rather than allows, so the path
  // construction stays inside the try (an event missing both CLAUDE_PROJECT_DIR and
  // cwd would otherwise throw out here and reach the fail-open outer catch).
  let pinned;
  try {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || event.cwd;
    const agentsDir = join(projectDir, ".claude", "agents");
    pinned = pinnedDefinitions(agentsDir);
  } catch {
    block(
      "could not read agent definitions to verify a pin; pass an explicit model",
    );
  }
  // Structural fail-closed: block again regardless of how block() is later
  // implemented, so a refactor that stops block() from exiting cannot let an
  // unverifiable bare spawn through.
  if (!pinned) {
    block(
      "could not read agent definitions to verify a pin; pass an explicit model",
    );
  }

  if (typeof subagentType === "string" && pinned.has(subagentType)) {
    process.exit(0);
  }

  const allowlist = [...pinned].sort().join(", ") || "(none)";
  block(
    `spawn of '${subagentType ?? "(none)"}' passes no explicit model and is not a ` +
      `pinned definition. Pass an explicit model (opus, sonnet, haiku, fable), or ` +
      `use a pinned subagent_type from {${allowlist}}`,
  );
}

try {
  main();
} catch {
  // Fail open on any error outside the bare-spawn read (that path exits inside
  // main before returning here); never stall Agent spawns on an unexpected error.
  process.exit(0);
}
