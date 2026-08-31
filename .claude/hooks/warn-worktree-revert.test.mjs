import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HOOK = fileURLToPath(
  new URL("./warn-worktree-revert.mjs", import.meta.url),
);

// Run the hook as a real subprocess. It never blocks: the outcomes are exit 0
// with a JSON additionalContext warning on stdout, or exit 0 with nothing.
function runHook(payload) {
  const { status, stdout } = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  const output = stdout.trim().length > 0 ? JSON.parse(stdout) : null;
  return {
    status,
    event: output?.hookSpecificOutput?.hookEventName ?? null,
    context: output?.hookSpecificOutput?.additionalContext ?? null,
  };
}

// A transcript line as the harness records one: the tool_use that asked to enter
// a worktree, and the tool_result that reports whether it did.
const entered = (id, path) =>
  JSON.stringify({
    message: {
      content: [
        { type: "tool_use", id, name: "EnterWorktree", input: { path } },
      ],
    },
  });
const result = (id, text) =>
  JSON.stringify({
    message: {
      content: [{ type: "tool_result", tool_use_id: id, content: text }],
    },
  });
const exited = () =>
  JSON.stringify({
    message: { content: [{ type: "tool_use", id: "x", name: "ExitWorktree" }] },
  });

describe("warn-worktree-revert hook", () => {
  const dirs = [];

  // Paths come back as git reports them: the temp root is reached through a
  // symlink on macOS, and a test comparing its own spelling to git's compares two
  // names for one directory.
  const toplevel = (cwd) =>
    execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();

  // A repository with two linked worktrees, placed under .claude/worktrees/ the
  // way the harness places them.
  function makeRepo() {
    const created = mkdtempSync(join(tmpdir(), "worktree-revert-"));
    dirs.push(created);
    const git = (...args) =>
      execFileSync("git", args, { cwd: created, encoding: "utf8" });
    git("init", "-q", "-b", "primary");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(join(created, "tracked.ts"), "export const a = 1;\n");
    git("add", "tracked.ts");
    git("commit", "-q", "-m", "Base commit");
    mkdirSync(join(created, ".claude", "worktrees"), { recursive: true });
    const worktrees = {};
    for (const branch of ["feature", "sibling"]) {
      const path = join(created, ".claude", "worktrees", branch);
      git("worktree", "add", "-q", "-b", branch, path);
      worktrees[branch] = toplevel(path);
    }
    return { main: toplevel(created), ...worktrees };
  }

  function transcript(...lines) {
    const dir = mkdtempSync(join(tmpdir(), "worktree-revert-transcript-"));
    dirs.push(dir);
    const path = join(dir, "session.jsonl");
    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
  }

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      // A repository holding linked worktrees keeps administrative files under
      // .git; removing the tree outright is what the temp dir is for.
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const enteredTranscript = (path) =>
    transcript(entered("t1", path), result("t1", `Entered worktree ${path}`));

  it("stays silent while the session is still in the entered worktree", () => {
    const repo = makeRepo();
    expect(
      runHook({
        hook_event_name: "UserPromptSubmit",
        cwd: repo.feature,
        transcript_path: enteredTranscript(repo.feature),
      }),
    ).toMatchObject({ status: 0, context: null });
  });

  it("warns when the cwd reverted to the main checkout", () => {
    const repo = makeRepo();
    const { status, event, context } = runHook({
      hook_event_name: "UserPromptSubmit",
      cwd: repo.main,
      transcript_path: enteredTranscript(repo.feature),
    });
    expect(status).toBe(0);
    expect(event).toBe("UserPromptSubmit");
    expect(context).toContain(repo.feature);
    expect(context).toContain(repo.main);
    expect(context).toContain("primary");
  });

  it("warns when the cwd landed in a sibling worktree, naming its branch", () => {
    const repo = makeRepo();
    const { context } = runHook({
      hook_event_name: "SessionStart",
      cwd: repo.sibling,
      transcript_path: enteredTranscript(repo.feature),
    });
    expect(context).toContain(repo.sibling);
    expect(context).toContain("sibling");
  });

  it("reports the event it was called for", () => {
    const repo = makeRepo();
    const { event } = runHook({
      hook_event_name: "SessionStart",
      cwd: repo.main,
      transcript_path: enteredTranscript(repo.feature),
    });
    expect(event).toBe("SessionStart");
  });

  it("stays silent when the entry was recorded through a symlinked path", () => {
    // git always reports the physical path, so an entry recorded with the
    // spelling the harness was handed -- /tmp on macOS resolves to /private/tmp
    // -- differs byte for byte from it while naming the same directory. Without
    // canonicalization that is a warning the session can never clear.
    const repo = makeRepo();
    const linkDir = mkdtempSync(join(tmpdir(), "worktree-revert-link-"));
    dirs.push(linkDir);
    const link = join(linkDir, "repo");
    symlinkSync(repo.main, link);
    const throughLink = join(link, ".claude", "worktrees", "feature");
    expect(throughLink).not.toBe(repo.feature);
    expect(
      runHook({
        cwd: throughLink,
        transcript_path: enteredTranscript(throughLink),
      }),
    ).toMatchObject({ status: 0, context: null });
    // A real revert still warns, naming the tree by its physical path.
    expect(
      runHook({
        cwd: repo.main,
        transcript_path: enteredTranscript(throughLink),
      }).context,
    ).toContain(repo.feature);
  });

  it("resolves an entry recorded relative to the main checkout", () => {
    const repo = makeRepo();
    const path = relative(repo.main, repo.feature);
    const { context } = runHook({
      cwd: repo.main,
      transcript_path: transcript(
        entered("t1", path),
        result("t1", "Entered worktree"),
      ),
    });
    expect(context).toContain(repo.feature);
  });

  it("takes the last confirmed entry and honors an exit", () => {
    const repo = makeRepo();
    const lines = [
      entered("t1", repo.feature),
      result("t1", "Entered worktree"),
      entered("t2", repo.sibling),
      result("t2", "Entered worktree"),
    ];
    expect(
      runHook({ cwd: repo.sibling, transcript_path: transcript(...lines) }),
    ).toMatchObject({ context: null });
    expect(
      runHook({
        cwd: repo.main,
        transcript_path: transcript(...lines, exited()),
      }),
    ).toMatchObject({ context: null });
  });

  it("stays silent when no entry was confirmed", () => {
    const repo = makeRepo();
    for (const path of [
      transcript(entered("t1", repo.feature)),
      transcript(
        entered("t1", repo.feature),
        result("t1", "Error: worktree is in use"),
      ),
      transcript(result("t9", `Entered worktree ${repo.feature}`)),
      transcript("{ not json", "worktree mentioned in prose"),
    ]) {
      expect(runHook({ cwd: repo.main, transcript_path: path })).toMatchObject({
        context: null,
      });
    }
  });

  it("stays silent when the entered tree is gone, or the cwd is not a repository", () => {
    const repo = makeRepo();
    const retired = join(repo.main, ".claude", "worktrees", "removed");
    expect(
      runHook({
        cwd: repo.main,
        transcript_path: enteredTranscript(retired),
      }),
    ).toMatchObject({ context: null });
    const outside = mkdtempSync(join(tmpdir(), "worktree-revert-outside-"));
    dirs.push(outside);
    expect(
      runHook({
        cwd: outside,
        transcript_path: enteredTranscript(repo.feature),
      }),
    ).toMatchObject({ context: null });
  });

  it("stays silent on an unreadable event or a missing transcript", () => {
    const repo = makeRepo();
    const { status, stdout } = spawnSync("node", [HOOK], {
      input: "not json",
      encoding: "utf8",
    });
    expect(status).toBe(0);
    expect(stdout).toBe("");
    expect(runHook({ cwd: repo.main })).toMatchObject({ context: null });
    expect(
      runHook({
        cwd: repo.main,
        transcript_path: join(repo.main, "gone.jsonl"),
      }),
    ).toMatchObject({ context: null });
  });
});
