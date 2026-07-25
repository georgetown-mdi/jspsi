#!/usr/bin/env node
// PreToolUse hook: refuse a review-role Agent spawn once this branch's rounds
// ledger already records two rounds, and record every round it allows.
//
// Why this exists: a review round whose findings come out of the previous round's
// own fix is a sequence that does not converge, and another blind round costs more
// than it closes. Two rounds is the stop. Past it the branch takes one of two
// exits: merge with the outstanding finding filed as its own item, or bring the
// structural change that removes the defect class forward and rebase onto it.
//
// Dated basis: measured 2026-07-24 across one line of work -- six of six checkable
// fix rounds introduced the defect the next round found, on branches that ran four
// rounds each while typical branches here run one or two. This is a dated
// process guard sized to that measurement, not eternal law.
//
// The ledger is the same `scratch/review-rounds/<branch>.jsonl` light-review
// writes. This hook appends to it on every spawn it ALLOWS, because a review round
// that leaves no trace cannot be counted: the bespoke review spawns this hook gates
// wrote nothing, so no rule keyed on the ledger could fire for them. A record
// written here marks that a round happened and carries no findings -- the hook
// cannot know them.
//
// A round is identified by the HEAD commit it reviewed, so reviewers spawned in
// parallel against the same commit are one round, and only a spawn against a new
// HEAD -- one that follows a fix -- extends the sequence. A spawn joining a round
// already recorded is allowed unmarked: that round was admitted once already, and
// its admission is not re-litigated per reviewer.
//
// Fail posture: fail CLOSED, like require-clean-tree-for-review and for the same
// reason -- nothing downstream catches a round that went uncounted. A ledger that
// cannot be read, a branch that cannot be named, and a record that cannot be
// written all block. The override marker short-circuits every one of those paths,
// so an adjudicated round is never wedged by the ledger's own I/O.
//
// Exit 0 allows the call; exit 2 blocks it and feeds stderr back to Claude.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

/** Spawns gated by this hook. Other subagent types pass through untouched. */
const REVIEW_ROLES = new Set([
  "security-reviewer",
  "adversarial-verifier",
  "ux-reviewer",
]);

const ROUND_LIMIT = 2;

// The override, spelled like block-model-drop-sendmessage's [accept-model-drop]
// but carrying a reason: the stop rule is a judgment call the owner adjudicates,
// and an unexplained bypass records nothing anyone can read later.
const OVERRIDE_PATTERN = /\[step-back-adjudicated:([^\]]*)\]/;

function block(reason) {
  process.stderr.write(`Blocked by block-third-review-round hook: ${reason}\n`);
  process.exit(2);
}

// Run git with the given args, returning trimmed stdout, or null on any failure
// (non-zero exit, missing binary, non-git directory). Every null is a block.
function git(args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** True when the text carries the override marker with a non-empty reason. */
function isAdjudicated(text) {
  const match = OVERRIDE_PATTERN.exec(text);
  return match !== null && /\w/.test(match[1]);
}

// One identity per round already in the ledger. A record written here is keyed by
// the HEAD it reviewed; a light-review record predates that field and is keyed by
// its own round number. A line that parses as neither still counts as a round --
// an unreadable ledger must not read as an empty one.
function recordedRounds(ledgerText) {
  const identities = new Set();
  const lines = ledgerText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    let identity = `line:${i}`;
    try {
      const record = JSON.parse(line);
      if (typeof record.head === "string" && record.head.length > 0) {
        identity = `head:${record.head}`;
      } else if (Number.isFinite(record.round)) {
        identity = `round:${record.round}`;
      }
    } catch {
      // keep the line-index identity
    }
    identities.add(identity);
  }
  return identities;
}

// Resolve the branch's ledger and what it already records, or null when any part
// of that cannot be established.
function ledgerState(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  const root = git(["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (!root) return null;
  const branch = git(["-C", root, "branch", "--show-current"]);
  if (!branch) return null;
  const head = git(["-C", root, "rev-parse", "HEAD"]);
  if (!head) return null;

  const path = join(root, "scratch", "review-rounds", `${branch}.jsonl`);
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") return null;
  }
  const rounds = recordedRounds(text);
  return {
    path,
    branch,
    head,
    priorRounds: rounds.size,
    isNewRound: !rounds.has(`head:${head}`),
    roundNumber: rounds.size + (rounds.has(`head:${head}`) ? 0 : 1),
  };
}

function appendRound(state, role) {
  mkdirSync(dirname(state.path), { recursive: true });
  const record = {
    round: state.roundNumber,
    date: new Date().toISOString().slice(0, 10),
    source: "review-agent-spawn",
    role,
    head: state.head,
  };
  appendFileSync(state.path, `${JSON.stringify(record)}\n`);
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0); // unparseable event -- do not interfere
  }
  if (event.tool_name !== "Agent") process.exit(0);

  const role = event?.tool_input?.subagent_type;
  if (typeof role !== "string" || !REVIEW_ROLES.has(role)) process.exit(0);

  const prompt = event?.tool_input?.prompt;
  const adjudicated = isAdjudicated(typeof prompt === "string" ? prompt : "");

  let state = null;
  try {
    state = ledgerState(event.cwd);
  } catch {
    state = null;
  }
  if (state === null) {
    if (adjudicated) process.exit(0);
    block(
      "could not locate the branch's review-rounds ledger, so the rounds already " +
        "run cannot be counted; run this from the branch's working tree, or " +
        "include the literal [step-back-adjudicated: <reason>] in the prompt",
    );
  }

  if (!adjudicated && state.isNewRound && state.priorRounds >= ROUND_LIMIT) {
    block(
      `this branch has already had ${state.priorRounds} review rounds ` +
        `(${state.path}), and a round that finds what the last round's fix ` +
        "introduced does not converge by repeating. Take one of the two exits: " +
        "merge with the outstanding finding filed as its own item, or pull the " +
        "structural item that removes the defect class forward and rebase this " +
        "branch onto it. To run this round anyway once that call is made, " +
        "include the literal [step-back-adjudicated: <reason>] in the prompt.",
    );
  }

  try {
    appendRound(state, role);
  } catch {
    if (adjudicated) process.exit(0);
    block(
      "could not record this review round in " +
        `${state.path}; an unrecorded round leaves the next one uncounted, so ` +
        "make the ledger writable, or include the literal " +
        "[step-back-adjudicated: <reason>] in the prompt",
    );
  }
  process.exit(0);
}

try {
  main();
} catch {
  // Structural fail-closed backstop: the exit-0 cases (unparseable event, a
  // non-Agent tool, a non-review role) are decided before any throwing code, so
  // any error reaching here is on a gated spawn that must block, not allow.
  block(
    "could not confirm how many review rounds this branch has already had; " +
      "include the literal [step-back-adjudicated: <reason>] in the prompt to " +
      "run it anyway",
  );
}
