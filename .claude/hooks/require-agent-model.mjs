#!/usr/bin/env node
// PreToolUse hook: refuse an Agent spawn that neither passes an explicit model nor
// names a subagent_type whose .claude/agents/ definition pins one.
//
// Why this exists: an Agent spawn with no `model` silently inherits the session
// model, with no error and no tell. That leak is exactly what this hook forbids --
// every spawn must choose its model, either inline or through a pinned definition.
//
// Fail-open scaffolding follows block-protected-push.mjs: JSON event on stdin, exit
// 0 allows, exit 2 blocks and feeds stderr back to Claude. An unexpected failure
// falls through to exit 0 -- EXCEPT the bare-spawn path (no explicit model), which
// fails CLOSED: a bare spawn is the risky call with no downstream backstop, so if
// the allowlist read throws we exit 2 rather than let an unverifiable pin through.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TIERS = new Set(["opus", "sonnet", "haiku", "fable"]);

function block(reason) {
  process.stderr.write(`Blocked by require-agent-model hook: ${reason}.\n`);
  process.exit(2);
}

// Collect the frontmatter `name` of every .claude/agents/*.md whose leading
// `---`...`---` block has a non-empty `model:`. Throws on any read/parse failure;
// the bare-spawn caller turns that throw into a fail-closed block.
function pinnedDefinitions(agentsDir) {
  const pinned = new Set();
  for (const entry of readdirSync(agentsDir)) {
    if (!entry.endsWith(".md")) continue;
    const text = readFileSync(join(agentsDir, entry), "utf8");
    const block = leadingFrontmatter(text);
    if (!block) continue;
    let name = null;
    let modelPinned = false;
    for (const line of block.split("\n")) {
      const nameMatch = line.match(/^name:\s*(.+?)\s*$/);
      if (nameMatch) name = nameMatch[1];
      const modelMatch = line.match(/^model:\s*(.+?)\s*$/);
      if (modelMatch && modelMatch[1].length > 0) modelPinned = true;
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
  let event;
  try {
    event = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0); // unreadable event -- do not interfere
  }
  if (event.tool_name !== "Agent") process.exit(0);

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

  // Bare spawn (no explicit model). This path fails CLOSED: any error in reading
  // the allowlist blocks rather than allows.
  const projectDir = process.env.CLAUDE_PROJECT_DIR || event.cwd;
  const agentsDir = join(projectDir, ".claude", "agents");
  let pinned;
  try {
    pinned = pinnedDefinitions(agentsDir);
  } catch {
    block(
      "could not read agent definitions to verify a pin; pass an explicit model",
    );
  }

  const subagentType = event?.tool_input?.subagent_type;
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
  // main before returning here); never wedge Agent spawns on an unexpected error.
  process.exit(0);
}
