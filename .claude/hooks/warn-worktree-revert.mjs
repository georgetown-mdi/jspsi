#!/usr/bin/env node
// UserPromptSubmit and SessionStart hook: warn when a session that entered a git
// worktree is no longer working in it.
//
// Why this exists: EnterWorktree switches the session's working directory at the
// harness level, and that switch does not reliably survive a turn boundary, a
// session restart, or a context re-injection. Nothing errors when it reverts --
// the transcript still shows the successful entry, so the session believes it is
// in the worktree while bare shell commands run in whatever checkout the cwd
// landed in. A worktree and its main checkout hold byte-identical copies of every
// unmodified tracked file, so `git status`, a build, and a test suite all look
// green in the wrong tree; the mistake surfaces later, as work committed to the
// wrong branch or a review round that reads a diff nobody wrote there.
// block-primary-checkout-writes.mjs covers the file tools, which take an absolute
// path and do not care about the cwd; this covers the bare-Bash exposure, at the
// two events where the revert lands.
//
// Intent comes from the TRANSCRIPT rather than any harness field: the last
// EnterWorktree whose result confirmed the entry and which no later ExitWorktree
// released. Location comes from git in the current directory. One line of
// additionalContext is emitted only when those two disagree; the happy path is
// silent and costs no context.
//
// STATED LIMITS.
//   - Best effort, and silent on every unanswerable state: no transcript, no
//     entry recorded, a path that no longer exists, a cwd outside any repository.
//     A missed warning degrades to the current no-warning behavior; a spurious
//     one would train sessions to ignore the line, so uncertainty stays quiet.
//   - The transcript is read whole on each of the two events, behind a substring
//     pre-filter and a size ceiling, so a session that never entered a worktree
//     pays a read and no parsing.
//   - It reports where the cwd is, not what any command did with it: a session
//     that scopes every command with `git -C` or an absolute path is warned all
//     the same, since the hook cannot tell those apart from bare ones.

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, normalize, resolve } from "node:path";

import { eventCwd, readEvent } from "./lib/event.mjs";

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

// Run git, returning trimmed stdout, or null on any failure -- which is silence.
function git(cwd, ...args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** A tool_result block's content flattened to text. */
function resultText(block) {
  const content = block.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

/**
 * The path of the last EnterWorktree that succeeded and was not later exited, or
 * null. Entries are matched to their results by tool_use id, so a refused or
 * failed entry never counts as intent.
 */
function intendedWorktree(transcript) {
  const requested = new Map();
  let intended = null;
  for (const line of transcript.split("\n")) {
    if (!line.toLowerCase().includes("worktree")) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use") {
        if (block.name === "EnterWorktree") {
          const path = block.input?.path;
          if (typeof path === "string" && path.length > 0) {
            requested.set(block.id, path);
          }
        } else if (block.name === "ExitWorktree") {
          intended = null;
        }
      } else if (block?.type === "tool_result") {
        const path = requested.get(block.tool_use_id);
        if (
          path !== undefined &&
          resultText(block).includes("Entered worktree")
        ) {
          intended = path;
        }
      }
    }
  }
  return intended;
}

function readTranscript(path) {
  try {
    if (statSync(path).size > MAX_TRANSCRIPT_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// The path with symlinks resolved, so a tree reached through a symlinked segment
// (/tmp on macOS) still matches what git reports, which is always the physical
// path. A path that cannot be resolved keeps its normalized spelling; the caller
// treats a tree that is not there as retired rather than reverted.
function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return normalize(path);
  }
}

// The transcript's EnterWorktree path made absolute. It may be recorded relative,
// resolved at call time against the main checkout root, which --git-common-dir
// yields from any worktree of the repository.
function resolveIntended(cwd, intended) {
  if (isAbsolute(intended)) return canonical(intended);
  const common = git(
    cwd,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  return common === null
    ? null
    : canonical(resolve(dirname(normalize(common)), intended));
}

function warning(intended, current, branch) {
  return (
    `This session entered the worktree ${intended}, but its working directory is now ` +
    `${current} (branch ${branch}) -- the harness worktree switch reverted, which is a ` +
    "turn-boundary and restart race rather than anything this session did. A bare shell " +
    "command (git commit, git rebase, npm test, a relative path) will run in the WRONG " +
    `checkout and look green. Re-enter ${intended} before any command this turn, or scope ` +
    "each one to it explicitly (`git -C <tree> ...`, absolute paths), and verify with " +
    "`pwd && git branch --show-current`."
  );
}

function main() {
  const event = readEvent();
  if (event === null) process.exit(0); // unreadable event -- do not interfere

  const cwd = eventCwd(event) ?? process.cwd();
  const transcriptPath = event.transcript_path;
  if (typeof transcriptPath !== "string") process.exit(0);
  const transcript = readTranscript(transcriptPath);
  if (transcript === null) process.exit(0);

  const recorded = intendedWorktree(transcript);
  if (recorded === null) process.exit(0);

  const reported = git(cwd, "rev-parse", "--show-toplevel");
  if (reported === null) process.exit(0); // not in a repository -- nothing to compare
  const current = canonical(reported);

  const intended = resolveIntended(cwd, recorded);
  if (intended === null) process.exit(0);
  try {
    if (!statSync(intended).isDirectory()) process.exit(0);
  } catch {
    process.exit(0); // the entered tree is gone -- retired, not reverted
  }
  if (current === intended) process.exit(0); // still there

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event.hook_event_name ?? "UserPromptSubmit",
        additionalContext: warning(
          intended,
          current,
          git(cwd, "branch", "--show-current") || "?",
        ),
      },
    }),
  );
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never disrupt a turn on an unexpected error
}
