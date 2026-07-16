#!/usr/bin/env node
// PreToolUse hook: refuse a SendMessage that continues an agent, because
// delivering a message switches the recipient to this session's model on its next
// turn -- a resumed or steered agent silently loses its pinned tier.
//
// Dated basis: observed 2026-07-15, re-verified 2026-07-16 -- a SendMessage drops
// the recipient's model pin to the session model on its next turn. This is a dated
// platform-behavior guard, not eternal law.
//
// Re-verification method: spawn an agent pinned to a tier different from the session
// (e.g. a sonnet-pinned agent from an opus session), resume it via SendMessage, and
// read its next assistant message.model under
// ~/.claude/projects/<project>/subagents/agent-<id>.jsonl. If the resumed turn still
// shows the session model, the drop reproduces and this hook stays.
//
// Removal criterion: delete this hook and its settings.json entry when that check
// shows the resumed turn KEEPS the recipient's pin (message.model resolves to the
// agent's tier, not the session's).
//
// Design: MARKER-GATED, no file I/O. There is no transcript read and nothing that
// can fail open on I/O. The allow paths are: a non-SendMessage or unparseable event;
// a send to "main" (a background subagent reporting up, with no pinned recipient to
// drop); or a message carrying the literal [accept-model-drop] marker. Every other
// SendMessage -- resuming or steering a spawned agent -- blocks. The only throwing
// operation is JSON.parse, which has its
// own inner catch that exits 0 (an unreadable event must not interfere). The outer
// try/catch is therefore purely defensive: no expected path reaches it, but if an
// unexpected error ever does on a SendMessage event, it blocks (exit 2) to match the
// fail-closed posture the other guards take for their enforced tool.
//
// Exit 0 allows the call; exit 2 blocks it and feeds stderr back to Claude.

import { readFileSync } from "node:fs";

const OVERRIDE_MARKER = "[accept-model-drop]";

function block(reason) {
  process.stderr.write(
    `Blocked by block-model-drop-sendmessage hook: ${reason}\n`,
  );
  process.exit(2);
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0); // unparseable event -- do not interfere
  }
  if (event.tool_name !== "SendMessage") process.exit(0);

  // A background subagent reporting to the main conversation (to: "main") has no
  // spawned, model-pinned recipient to drop, so it is not gated.
  if (event?.tool_input?.to === "main") process.exit(0);

  const message = event?.tool_input?.message;
  const text = typeof message === "string" ? message : "";
  if (text.includes(OVERRIDE_MARKER)) process.exit(0);

  block(
    "delivering a message switches the agent to this session's model on its next " +
      "turn, so a resumed or steered agent loses its pinned tier. For substantive " +
      "continuation, TaskStop the agent and make a FRESH spawn with an explicit " +
      "model carrying the context forward; fix rounds are fresh spawns. To send " +
      `anyway and accept the model change, include the literal ${OVERRIDE_MARKER} ` +
      "in the message.",
  );
}

try {
  main();
} catch {
  // Defensive fail-closed backstop: the two exit-0 cases (unparseable event,
  // non-SendMessage tool) are decided before this can be reached, and JSON.parse
  // has its own inner catch, so any error arriving here is on a SendMessage event
  // that must block, not allow.
  block(
    "could not confirm the message; TaskStop and make a fresh spawn instead",
  );
}
