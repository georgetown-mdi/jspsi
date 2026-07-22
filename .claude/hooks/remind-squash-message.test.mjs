import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HOOK = fileURLToPath(
  new URL("./remind-squash-message.mjs", import.meta.url),
);

// Run the hook as a real subprocess, piping a synthesized PostToolUse payload on
// stdin the way Claude Code itself invokes it, and returning its stdout. The hook
// always exits 0 (fail-safe), so a nonzero exit here is itself a test failure.
function runHook(payload) {
  return execFileSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}

// Build a throwaway git repo with a `refs/remotes/origin/staging` ref pinned at
// its first commit, then `commitsAheadOfBase` further commits on top -- so
// `git rev-list --count origin/staging..HEAD` resolves deterministically to
// `commitsAheadOfBase`, independent of this repo's own real branch state.
function makeRepo(commitsAheadOfBase) {
  const dir = mkdtempSync(join(tmpdir(), "remind-squash-repo-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "file.txt"), "base\n");
  git("add", "file.txt");
  git("commit", "-q", "-m", "Base commit");
  const baseSha = git("rev-parse", "HEAD").trim();
  git("update-ref", "refs/remotes/origin/staging", baseSha);
  for (let i = 0; i < commitsAheadOfBase; i++) {
    writeFileSync(join(dir, "file.txt"), `change ${i}\n`);
    git("commit", "-q", "-am", `Change ${i}`);
  }
  return dir;
}

describe("remind-squash-message hook", () => {
  const dirs = [];

  afterEach(() => {
    while (dirs.length > 0) {
      rmSync(dirs.pop(), { recursive: true, force: true });
    }
  });

  it("emits a reminder for gh pr create on a multi-commit branch", () => {
    const dir = makeRepo(2);
    dirs.push(dir);
    const out = runHook({
      tool_name: "Bash",
      tool_input: { command: "gh pr create --base staging --title x" },
      cwd: dir,
    });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("2 commits");
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      "origin/staging",
    );
  });

  it("emits nothing for gh pr create on a single-commit branch", () => {
    const dir = makeRepo(1);
    dirs.push(dir);
    const out = runHook({
      tool_name: "Bash",
      tool_input: { command: "gh pr create" },
      cwd: dir,
    });
    expect(out).toBe("");
  });

  it("emits nothing for a command that is not gh pr create", () => {
    const dir = makeRepo(2);
    dirs.push(dir);
    const out = runHook({
      tool_name: "Bash",
      tool_input: { command: "git status" },
      cwd: dir,
    });
    expect(out).toBe("");
  });

  it("exits cleanly with no output when git cannot resolve the base", () => {
    const dir = mkdtempSync(join(tmpdir(), "remind-squash-nogit-"));
    dirs.push(dir);
    const out = runHook({
      tool_name: "Bash",
      tool_input: { command: "gh pr create" },
      cwd: dir,
    });
    expect(out).toBe("");
  });
});
