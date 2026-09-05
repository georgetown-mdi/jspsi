#!/usr/bin/env node
// PreToolUse hook: refuse a direct Agent spawn of `security-reviewer` or
// `adversarial-verifier`. Those roles run only inside
// `/light-review --role <name> --claims <file>`, whose Workflow form is what
// puts the round behind the clean-tree gate and into the branch's rounds
// ledger.
//
// Why this exists: a bare Agent spawn of either role bypasses three guarantees
// at once -- the refutation contract (with nothing to refute the role returns a
// CLEAR artifact for a round that tested nothing), the clean-tree gate
// (require-clean-tree-for-review.mjs matches only the Workflow tool), and the
// rounds ledger, so the round never counts against the review-tier ceiling.
// The block is unconditional rather than claims-sniffing: a prompt that pastes
// a claims list still evades the gate and the ledger, so prompt content is not
// a tell.
//
// Dated basis (2026-07-26, harness 2.1.220), not a checkable invariant: a
// Workflow-internal agent() call raised no Agent PreToolUse event, so the
// sanctioned /light-review --role path does not reach this hook. Re-verify
// after a harness upgrade by re-running the probe -- a throwaway Workflow
// whose agent() prompt matches require-declared-worktree-isolation's block
// regex without the isolation flag; if that probe is blocked, internal spawns
// have become visible and this hook must exempt by spawn origin or it wedges
// /light-review --role.
//
// Fail-open scaffolding follows block-protected-push.mjs: JSON event on stdin,
// exit 0 allows, exit 2 blocks and feeds stderr back to Claude. A missed block
// costs an ungated review round, not a security boundary, so every unexpected
// error fails OPEN rather than wedge Agent spawns.

import { eventForTools } from "./lib/event.mjs";

const CONTRACTED_ROLES = ["security-reviewer", "adversarial-verifier"];

function main() {
  const event = eventForTools("Agent");
  if (event === null) process.exit(0); // unreadable, or another tool

  const role = event?.tool_input?.subagent_type;
  if (typeof role !== "string" || !CONTRACTED_ROLES.includes(role)) {
    process.exit(0);
  }

  process.stderr.write(
    `Blocked by require-review-contract hook: a ${role} round runs only as ` +
      `/light-review --role ${role} --claims <file> -- the Workflow form is ` +
      "what gates it on a clean tree and records it in the branch's rounds " +
      "ledger; a direct Agent spawn does neither. For a question with no " +
      "claims to refute, use a lens-scoped general-purpose reviewer or plain " +
      "/light-review instead.\n",
  );
  process.exit(2);
}

try {
  main();
} catch {
  // Fail open: this gate guards review-process integrity, not a security
  // boundary, so a stray failure must never wedge Agent spawns.
  process.exit(0);
}
