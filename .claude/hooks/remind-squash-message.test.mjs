import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HOOK = fileURLToPath(
  new URL("./remind-squash-message.mjs", import.meta.url),
);
const REPO_ROOT = join(dirname(HOOK), "..", "..");

// Run the hook as a real subprocess, piping a synthesized PostToolUse payload on
// stdin the way Claude Code itself invokes it, and returning its stdout. The hook
// always exits 0 (fail-safe), so a nonzero exit here is itself a test failure.
function runHook(payload) {
  return execFileSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}

/** The additionalContext the hook emitted, or null when it emitted nothing. */
function context(payload) {
  const out = runHook(payload);
  if (out === "") return null;
  const parsed = JSON.parse(out);
  expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
  return parsed.hookSpecificOutput.additionalContext;
}

const prCreateEvent = (dir, toolResponse) => ({
  tool_name: "Bash",
  tool_input: { command: "gh pr create --base staging --title x" },
  tool_response: toolResponse,
  cwd: dir,
});

const ghOutput = (number) =>
  "Creating pull request for feature into staging in georgetown-mdi/jspsi\n\n" +
  `https://github.com/georgetown-mdi/jspsi/pull/${number}\n`;

// Build a throwaway git repo with a `refs/remotes/origin/staging` ref pinned at
// its first commit, then `commitsAheadOfBase` further commits on top -- so
// `git rev-list --count origin/staging..HEAD` resolves deterministically to
// `commitsAheadOfBase`, independent of this repo's own real branch state.
function makeRepo(commitsAheadOfBase, branch = null) {
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
  if (branch !== null) git("checkout", "-q", "-b", branch);
  for (let i = 0; i < commitsAheadOfBase; i++) {
    writeFileSync(join(dir, "file.txt"), `change ${i}\n`);
    git("commit", "-q", "-am", `Change ${i}`);
  }
  return dir;
}

// A linked worktree nested under .claude/worktrees/ the way the harness places
// them, carrying the same commits over the base as the main checkout.
function addWorktree(main, branch) {
  const path = join(main, ".claude", "worktrees", `agent-${branch}`);
  mkdirSync(join(main, ".claude", "worktrees"), { recursive: true });
  execFileSync("git", [
    "-C",
    main,
    "worktree",
    "add",
    "-q",
    "-b",
    branch,
    path,
  ]);
  return path;
}

describe("remind-squash-message hook", () => {
  const dirs = [];
  const track = (path) => {
    dirs.push(path);
    return path;
  };

  afterEach(() => {
    while (dirs.length > 0) {
      rmSync(dirs.pop(), { recursive: true, force: true });
    }
  });

  it("directs the message to a PR-numbered file, not the transcript", () => {
    const dir = track(makeRepo(2));
    const additionalContext = context(prCreateEvent(dir, ghOutput(1234)));
    expect(additionalContext).toContain("2 commits");
    expect(additionalContext).toContain("origin/staging");
    expect(additionalContext).toContain(
      join(dir, "scratch", "squash-messages", "1234.txt"),
    );
    expect(additionalContext).toContain("Report only");
    expect(additionalContext).not.toContain("Print a ready-to-use");
  });

  it("finds the PR URL in a string tool_response and in stderr", () => {
    const dir = track(makeRepo(2));
    const expected = join(dir, "scratch", "squash-messages", "77.txt");
    expect(context(prCreateEvent(dir, ghOutput(77)))).toContain(expected);
    expect(context(prCreateEvent(dir, { stderr: ghOutput(77) }))).toContain(
      expected,
    );
  });

  it("keys on the created PR when the output quotes another one", () => {
    const dir = track(makeRepo(2));
    const additionalContext = context(
      prCreateEvent(dir, {
        stdout:
          "Depends on https://github.com/georgetown-mdi/jspsi/pull/11\n" +
          ghOutput(12),
      }),
    );
    expect(additionalContext).toContain(
      join(dir, "scratch", "squash-messages", "12.txt"),
    );
  });

  it("keys on the sanitized branch name when no PR URL is parseable", () => {
    const dir = track(makeRepo(2, "feature/odd.name"));
    const additionalContext = context(prCreateEvent(dir, { stdout: "" }));
    expect(additionalContext).toContain(
      join(dir, "scratch", "squash-messages", "branch-feature-odd.name.txt"),
    );
  });

  it("writes into the main checkout from a linked worktree", () => {
    const main = track(makeRepo(2));
    const worktree = addWorktree(main, "branch-under-review");
    const additionalContext = context(prCreateEvent(worktree, ghOutput(42)));
    expect(additionalContext).toContain(
      join(main, "scratch", "squash-messages", "42.txt"),
    );
    expect(additionalContext).not.toContain(worktree);
  });

  it("falls back to printing when no key can be determined", () => {
    const dir = track(makeRepo(2));
    execFileSync("git", ["-C", dir, "checkout", "-q", "--detach"]);
    const additionalContext = context(prCreateEvent(dir, { stdout: "" }));
    expect(additionalContext).toContain("Print a ready-to-use");
    expect(additionalContext).not.toContain("squash-messages");
  });

  it("names the message rules whichever reminder it emits", () => {
    const dir = track(makeRepo(2));
    const rules = "50 characters or fewer";
    expect(context(prCreateEvent(dir, ghOutput(5)))).toContain(rules);
    execFileSync("git", ["-C", dir, "checkout", "-q", "--detach"]);
    expect(context(prCreateEvent(dir, { stdout: "" }))).toContain(rules);
  });

  it("names a directory this repository's gitignore covers", () => {
    const { status } = spawnSync(
      "git",
      [
        "-C",
        REPO_ROOT,
        "check-ignore",
        "-q",
        join("scratch", "squash-messages", "1.txt"),
      ],
      { encoding: "utf8" },
    );
    expect(status).toBe(0);
  });

  it("emits nothing for gh pr create on a single-commit branch", () => {
    const dir = track(makeRepo(1));
    expect(context(prCreateEvent(dir, ghOutput(1)))).toBeNull();
  });

  it("emits nothing for a command that is not gh pr create", () => {
    const dir = track(makeRepo(2));
    const out = runHook({
      tool_name: "Bash",
      tool_input: { command: "git status" },
      cwd: dir,
    });
    expect(out).toBe("");
  });

  it("emits nothing for a tool other than Bash", () => {
    const dir = track(makeRepo(2));
    const out = runHook({
      tool_name: "Read",
      tool_input: { command: "gh pr create" },
      cwd: dir,
    });
    expect(out).toBe("");
  });

  it("exits cleanly with no output when git cannot resolve the base", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "remind-squash-nogit-")));
    expect(context(prCreateEvent(dir, ghOutput(3)))).toBeNull();
  });

  it("exits cleanly with no output on an unparseable event", () => {
    const { status, stdout } = spawnSync("node", [HOOK], {
      input: "not json",
      encoding: "utf8",
    });
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });
});
