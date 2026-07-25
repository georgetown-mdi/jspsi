import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HOOK = fileURLToPath(
  new URL("./require-clean-tree-for-review.mjs", import.meta.url),
);

// Run the hook as a real subprocess with a synthesized PreToolUse payload on
// stdin. Exit 0 allows the Workflow call, exit 2 blocks it and feeds stderr back
// to Claude, so both are expected outcomes and neither may throw.
function runHook(payload) {
  const { status, stderr } = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { status, stderr };
}

function workflowIn(cwd) {
  return runHook({
    tool_name: "Workflow",
    tool_input: { workflow: "light-review" },
    cwd,
  });
}

// A throwaway repo with one commit and `untracked` extra files left uncommitted.
function makeRepo(untracked = 0) {
  const dir = mkdtempSync(join(tmpdir(), "clean-tree-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "feature");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "file.txt"), "base\n");
  git("add", "file.txt");
  git("commit", "-q", "-m", "Base commit");
  for (let i = 0; i < untracked; i++) {
    writeFileSync(join(dir, `extra-${i}.txt`), "uncommitted\n");
  }
  return dir;
}

describe("require-clean-tree-for-review hook", () => {
  const dirs = [];
  afterEach(() => {
    while (dirs.length > 0)
      rmSync(dirs.pop(), { recursive: true, force: true });
  });

  it("ignores tools other than Workflow", () => {
    const dir = makeRepo(1);
    dirs.push(dir);
    const { status } = runHook({
      tool_name: "Agent",
      tool_input: { prompt: "review this", model: "opus" },
      cwd: dir,
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

  it("allows a Workflow call on a clean tree", () => {
    const dir = makeRepo();
    dirs.push(dir);
    expect(workflowIn(dir).status).toBe(0);
  });

  it("blocks a Workflow call on a dirty tree and names the entries", () => {
    const dir = makeRepo(2);
    dirs.push(dir);
    const { status, stderr } = workflowIn(dir);
    expect(status).toBe(2);
    expect(stderr).toContain("the working tree is not clean");
    expect(stderr).toContain("extra-0.txt");
    expect(stderr).toContain("extra-1.txt");
  });

  it("truncates a long dirty list with a remainder count", () => {
    const dir = makeRepo(13);
    dirs.push(dir);
    const { stderr } = workflowIn(dir);
    expect(stderr).toContain("...and 3 more");
  });

  it("blocks when the tree cannot be confirmed clean", () => {
    // Every unconfirmable state fails CLOSED: nothing backstops a review that
    // returns a false clean.
    const notARepo = mkdtempSync(join(tmpdir(), "clean-tree-bare-"));
    dirs.push(notARepo);
    for (const event of [
      { tool_name: "Workflow", tool_input: {}, cwd: notARepo },
      { tool_name: "Workflow", tool_input: {} },
      { tool_name: "Workflow", tool_input: {}, cwd: "" },
      { tool_name: "Workflow", tool_input: {}, cwd: 7 },
    ]) {
      const { status, stderr } = runHook(event);
      expect(status, JSON.stringify(event)).toBe(2);
      expect(stderr).toContain("commit and retry");
    }
  });

  it("reports a dirty tree from a subdirectory of the repo", () => {
    const dir = makeRepo(1);
    dirs.push(dir);
    const sub = join(dir, "nested");
    mkdirSync(sub);
    writeFileSync(join(sub, "kept.txt"), "x\n");
    const { status } = workflowIn(sub);
    expect(status).toBe(2);
  });
});
