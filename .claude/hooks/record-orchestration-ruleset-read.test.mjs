import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HOOK = fileURLToPath(
  new URL("./record-orchestration-ruleset-read.mjs", import.meta.url),
);

const MARKER_SUBDIR = "psilink-orchestration-reads";
const SESSION = "8f2b1c66-0000-4000-8000-0123456789ab";
const RULESET = "/workspace/.claude/orchestration/ruleset.md";

const dirs = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

// The marker directory is derived from the temp dir, so a throwaway TMPDIR both
// isolates each run and leaves the directory missing until the hook creates it.
function makeMarkerRoot() {
  const dir = mkdtempSync(join(tmpdir(), "ruleset-record-"));
  dirs.push(dir);
  return dir;
}

function runHook(payload, markerRoot) {
  const { status } = spawnSync("node", [HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, TMPDIR: markerRoot },
  });
  return status;
}

function markerPath(markerRoot, session = SESSION) {
  return join(markerRoot, MARKER_SUBDIR, session);
}

const shell = (command, session_id = SESSION) => ({
  tool_name: "Bash",
  tool_input: { command },
  session_id,
});

const read = (file_path, session_id = SESSION) => ({
  tool_name: "Read",
  tool_input: { file_path },
  session_id,
});

describe("record-orchestration-ruleset-read hook", () => {
  it("records a Read of the ruleset, creating the marker directory", () => {
    const root = makeMarkerRoot();
    expect(existsSync(join(root, MARKER_SUBDIR))).toBe(false);
    expect(runHook(read(RULESET), root)).toBe(0);
    expect(existsSync(markerPath(root))).toBe(true);
  });

  it("records the time of the read for whoever lists the directory", () => {
    const root = makeMarkerRoot();
    runHook(read(RULESET), root);
    expect(readFileSync(markerPath(root), "utf8").trim()).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });

  it("records a read of a linked worktree's own copy", () => {
    const root = makeMarkerRoot();
    runHook(
      read(
        "/workspace/.claude/worktrees/agent-one/.claude/orchestration/ruleset.md",
      ),
      root,
    );
    expect(existsSync(markerPath(root))).toBe(true);
  });

  it("records every shell form an orchestrating session reads it with", () => {
    for (const command of [
      `cat ${RULESET}`,
      `cat '${RULESET}'`,
      "sed -n '1,40p' .claude/orchestration/ruleset.md",
      "head -50 .claude/orchestration/ruleset.md",
      "less .claude/orchestration/ruleset.md",
      "bat .claude/orchestration/ruleset.md",
      "cat orchestration/ruleset.md",
      `cat CLAUDE.md && cat ${RULESET} | head -20`,
    ]) {
      const root = makeMarkerRoot();
      expect(runHook(shell(command), root), command).toBe(0);
      expect(existsSync(markerPath(root)), command).toBe(true);
    }
  });

  it("records nothing for a command that does not name the ruleset", () => {
    for (const command of [
      "ls .claude/orchestration",
      "cat CLAUDE.md",
      "cat .claude/commands/light-review.md",
      "cat ruleset.md",
    ]) {
      const root = makeMarkerRoot();
      expect(runHook(shell(command), root), command).toBe(0);
      expect(existsSync(markerPath(root)), command).toBe(false);
    }
  });

  it("records nothing for a Read of another file", () => {
    const root = makeMarkerRoot();
    expect(runHook(read("/workspace/CLAUDE.md"), root)).toBe(0);
    expect(existsSync(markerPath(root))).toBe(false);
  });

  it("records nothing for a tool it does not watch", () => {
    const root = makeMarkerRoot();
    const status = runHook(
      {
        tool_name: "Edit",
        tool_input: { file_path: RULESET, old_string: "a", new_string: "b" },
        session_id: SESSION,
      },
      root,
    );
    expect(status).toBe(0);
    expect(existsSync(markerPath(root))).toBe(false);
  });

  it("records nothing for an event that cannot be read", () => {
    const root = makeMarkerRoot();
    for (const payload of ["not json", "", "null", "7"]) {
      expect(runHook(payload, root), payload).toBe(0);
    }
    expect(existsSync(join(root, MARKER_SUBDIR))).toBe(false);
  });

  it("records nothing when the event names no session", () => {
    const root = makeMarkerRoot();
    expect(
      runHook(
        { tool_name: "Bash", tool_input: { command: `cat ${RULESET}` } },
        root,
      ),
    ).toBe(0);
    expect(existsSync(join(root, MARKER_SUBDIR))).toBe(false);
  });
});
