import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HOOK = fileURLToPath(
  new URL("./require-declared-worktree-isolation.mjs", import.meta.url),
);

// Run the hook as a real subprocess with a synthesized PreToolUse payload on
// stdin. Exit 0 allows the spawn, exit 2 blocks it and feeds stderr back to
// Claude; the hook touches no filesystem, so no fixture is needed.
function runHook(payload) {
  const { status, stderr } = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { status, stderr };
}

function spawnWith(prompt, extra = {}) {
  return runHook({
    tool_name: "Agent",
    tool_input: { model: "opus", prompt, ...extra },
  });
}

describe("require-declared-worktree-isolation hook", () => {
  it("ignores tools other than Agent", () => {
    const { status } = runHook({
      tool_name: "Bash",
      tool_input: { command: "echo you are in an isolated worktree" },
    });
    expect(status).toBe(0);
  });

  it("ignores an unparseable event", () => {
    const { status } = spawnSync("node", [HOOK], {
      input: "not json",
      encoding: "utf8",
    });
    expect(status).toBe(0);
  });

  it("blocks a prompt claiming isolation the call did not request", () => {
    for (const prompt of [
      "You are in an isolated worktree; run worktree-init.sh first.",
      "You are working inside your own fresh worktree.",
      "Land the change in this worktree, then report.",
      "Commit everything to your git worktree before reporting.",
    ]) {
      const { status, stderr } = spawnWith(prompt);
      expect(status, prompt).toBe(2);
      expect(stderr).toContain('isolation:"worktree"');
    }
  });

  it("allows the same prompt when the call passes the flag", () => {
    const { status } = spawnWith("You are in an isolated worktree.", {
      isolation: "worktree",
    });
    expect(status).toBe(0);
  });

  it("allows an instruction to create a worktree by hand", () => {
    for (const prompt of [
      "Rebase in a detached /tmp worktree: git worktree add --detach /tmp/wt.",
      "Remove the worktree when you are done.",
    ]) {
      expect(spawnWith(prompt).status, prompt).toBe(0);
    }
  });

  it("allows a prompt that never mentions isolation", () => {
    expect(spawnWith("Fix the SFTP idle release and report.").status).toBe(0);
  });

  it("allows a spawn with no prompt to inspect", () => {
    expect(
      runHook({ tool_name: "Agent", tool_input: { model: "opus" } }).status,
    ).toBe(0);
    expect(spawnWith("").status).toBe(0);
  });

  it("matches the claim regardless of case", () => {
    expect(spawnWith("You Are In An Isolated Worktree.").status).toBe(2);
  });
});
