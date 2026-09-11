#!/usr/bin/env node
// PreToolUse hook: refuse a session's first Agent spawn or Workflow call until
// that session has read .claude/orchestration/ruleset.md.
//
// Why this exists: the ruleset holds the rules for CONDUCTING an orchestration --
// the review contracts and round caps, how a fix is dispatched, the spawn and
// SendMessage mechanics, where a decision goes. A prose pointer in CLAUDE.md and
// five front doors load it, and nothing else confirms the session doing the
// conducting has it: a session that starts spawning without it runs the flow
// from whatever it remembers of an earlier one, and the rules it skips are
// exactly the ones no later check catches -- a round dispatched wrongly is a
// wasted round, not a red test.
//
// NOTHING IS ADDED TO A SPAWN'S CONTEXT. The refusal is the whole mechanism.
// The ruleset's text never enters a spawn prefix or an agent's prompt, which is
// the point: a spawned agent is told not to read this file, and paying for its
// rules on every spawn is the cost this gate exists to avoid, not to impose.
//
// A SUBAGENT'S OWN SPAWNS ARE NOT GATED. The read is keyed on the session id the
// payload carries, so a subagent spawning under the session's id finds the
// session's own record. What a payload carries inside a subagent could not be
// observed from within a session, so a subagent transcript path is an explicit
// pass as well: on this harness (measured 2026-09-11) a subagent's transcript is
// <project>/<session-id>/subagents/agent-<agent-id>.jsonl, beside the session's
// own <session-id>.jsonl, and a payload naming one of those is a spawned agent's
// call whatever session id it came with. Gating it would demand of that agent
// the read the ruleset's own text forbids it.
//
// FAIL OPEN, the direction require-agent-model.mjs takes and the opposite of
// require-clean-tree-for-review.mjs: what this gate holds is a reading
// discipline, so a miss costs a session that reasons from memory, while a
// refusal that fires wrongly stops every spawn in every session at once. So an
// unreadable event, a payload naming no session, and any unexpected error allow
// the call; only a readable Agent or Workflow call under a session with no fresh
// record is refused.
//
// The marker path, the session key and the freshness window: lib/rulesetRead.mjs.
// The read is recorded by record-orchestration-ruleset-read.mjs.
//
// Exit 0 allows the call; exit 2 blocks it and feeds stderr back to Claude.

import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { eventForTools } from "./lib/event.mjs";
import {
  markerPath,
  READ_TTL_MS,
  recordedReadAgeMs,
  RULESET_PATH,
} from "./lib/rulesetRead.mjs";

// The ruleset beside this hook, so the refusal names a file that exists in the
// checkout whose settings registered the hook rather than a path built from a
// directory the payload may not carry.
const RULESET_FILE = fileURLToPath(
  new URL("../orchestration/ruleset.md", import.meta.url),
);

const SUBAGENT_TRANSCRIPT_DIR = "/subagents/";
const SUBAGENT_TRANSCRIPT_PREFIX = "agent-";

function block(reason) {
  process.stderr.write(
    `Blocked by require-orchestration-ruleset-read hook: ${reason}.\n`,
  );
  process.exit(2);
}

function isSubagentCall(event) {
  const transcript = event?.transcript_path;
  if (typeof transcript !== "string") return false;
  const path = transcript.replace(/\\/g, "/");
  return (
    path.includes(SUBAGENT_TRANSCRIPT_DIR) ||
    basename(path).startsWith(SUBAGENT_TRANSCRIPT_PREFIX)
  );
}

function describeHours(ms) {
  return `${Math.round(ms / 3600000)} hours`;
}

function readInstruction() {
  return `read it with \`cat '${RULESET_FILE}'\`, then repeat this call`;
}

function main() {
  const event = eventForTools("Agent", "Workflow");
  if (event === null) process.exit(0); // unreadable, or another tool
  if (isSubagentCall(event)) process.exit(0);

  const path = markerPath(event.session_id);
  if (path === null) process.exit(0); // no session to key a read on

  const ageMs = recordedReadAgeMs(path);
  if (ageMs === null) {
    block(
      `this session has not read ${RULESET_PATH}, which holds the rules for ` +
        `conducting a session that spawns agents and runs review rounds -- ` +
        readInstruction(),
    );
  }
  if (ageMs >= READ_TTL_MS) {
    block(
      `this session read ${RULESET_PATH} ${describeHours(ageMs)} ago, past the ` +
        `${describeHours(READ_TTL_MS)} a recorded read stands for -- ` +
        readInstruction(),
    );
  }
  process.exit(0);
}

try {
  main();
} catch {
  // Fail open on any unexpected error; see the header. The refusals above exit
  // inside main and never reach here.
  process.exit(0);
}
