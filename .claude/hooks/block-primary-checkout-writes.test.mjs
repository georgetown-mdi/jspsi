import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HOOK = fileURLToPath(
  new URL("./block-primary-checkout-writes.mjs", import.meta.url),
);

// Run the hook as a real subprocess with a synthesized PreToolUse payload on
// stdin. Exit 0 allows the write, exit 2 blocks it and feeds stderr back to
// Claude, so both are expected outcomes and neither may throw.
function runHook(payload) {
  const { status, stderr } = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { status, stderr };
}

const write = (file_path, cwd, tool_name = "Write") =>
  runHook({ tool_name, tool_input: { file_path, content: "x" }, cwd });

// A throwaway repo containing one tracked file, a gitignored scratch/, a source
// directory holding no file yet, and room for a linked worktree nested under
// .claude/worktrees/ the way the harness places them.
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "primary-writes-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "primary");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "tracked.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, ".gitignore"), "scratch\n.claude/worktrees/\n");
  mkdirSync(join(dir, "scratch"), { recursive: true });
  mkdirSync(join(dir, "apps", "web", "src"), { recursive: true });
  git("add", "tracked.ts", ".gitignore");
  git("commit", "-q", "-m", "Base commit");
  return dir;
}

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

describe("block-primary-checkout-writes hook", () => {
  const dirs = [];
  const track = (path) => {
    dirs.push(path);
    return path;
  };
  afterEach(() => {
    while (dirs.length > 0)
      rmSync(dirs.pop(), { recursive: true, force: true });
  });

  it("ignores tools it does not gate", () => {
    const dir = track(makeRepo());
    const { status } = runHook({
      tool_name: "Bash",
      tool_input: { command: `echo x > ${join(dir, "tracked.ts")}` },
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

  it("ignores a call that names no path", () => {
    const dir = track(makeRepo());
    const { status } = runHook({
      tool_name: "Write",
      tool_input: { content: "x" },
      cwd: dir,
    });
    expect(status).toBe(0);
  });

  it("blocks every gated tool writing a tracked main-worktree file", () => {
    const dir = track(makeRepo());
    const tracked = join(dir, "tracked.ts");
    for (const tool_name of ["Write", "Edit"]) {
      const { status, stderr } = write(tracked, dir, tool_name);
      expect(status, tool_name).toBe(2);
      expect(stderr).toContain("repository content of the main worktree");
    }
    const notebook = runHook({
      tool_name: "NotebookEdit",
      tool_input: { notebook_path: tracked },
      cwd: dir,
    });
    expect(notebook.status).toBe(2);
  });

  it("resolves a relative path against the calling directory", () => {
    const dir = track(makeRepo());
    expect(write("tracked.ts", dir).status).toBe(2);
  });

  it("allows a gitignored path in the main worktree", () => {
    const dir = track(makeRepo());
    for (const path of [
      join(dir, "scratch", "notes.md"),
      join(dir, "scratch", "briefs", "deep", "brief.md"),
    ]) {
      expect(write(path, dir).status, path).toBe(0);
    }
  });

  it("blocks a brand-new untracked file in the main worktree", () => {
    // The by-ref model writes no branch content here, so a file git neither
    // tracks nor ignores is as much a mistake as an edit to a tracked one --
    // and tracked-ness alone cannot see it, since nothing has added it yet.
    const dir = track(makeRepo());
    for (const path of [
      join(dir, "apps", "web", "src", "newComponent.tsx"),
      join(dir, "brand-new.ts"),
    ]) {
      expect(write(path, dir).status, path).toBe(2);
    }
  });

  it("allows a tracked or brand-new file inside a linked worktree nested under the main root", () => {
    // The prefix trap: .claude/worktrees/<tree> sits under the main root's path,
    // so a plain prefix test would refuse every fix implementer's edits. The
    // main-checkout cwd is the dispatch shape -- a session in the primary
    // checkout writing into the tree it was pointed at -- which the sibling rule
    // must leave alone.
    const dir = track(makeRepo());
    const tree = addWorktree(dir, "feature");
    expect(write(join(tree, "tracked.ts"), dir).status).toBe(0);
    expect(write(join(tree, "tracked.ts"), tree).status).toBe(0);
    const fresh = join(tree, "apps", "web", "src", "newComponent.tsx");
    expect(write(fresh, dir).status).toBe(0);
    expect(write(fresh, tree).status).toBe(0);
  });

  it("allows a worktree write when the session directory places it in no tree", () => {
    const dir = track(makeRepo());
    const tree = addWorktree(dir, "feature");
    const outside = track(mkdtempSync(join(tmpdir(), "primary-writes-away-")));
    expect(write(join(tree, "tracked.ts"), outside).status).toBe(0);
    expect(
      runHook({
        tool_name: "Write",
        tool_input: { file_path: join(tree, "tracked.ts"), content: "x" },
      }).status,
    ).toBe(0);
  });

  it("blocks a write into a sibling worktree from a session inside another one", () => {
    const dir = track(makeRepo());
    const own = addWorktree(dir, "feature");
    const sibling = addWorktree(dir, "other");
    const { status, stderr } = write(join(sibling, "tracked.ts"), own);
    expect(status).toBe(2);
    // The refusal names both trees and the corrected path, as git spells them:
    // the temp root is reached through a symlink on macOS.
    expect(stderr).toContain(realpathSync(sibling));
    expect(stderr).toContain(realpathSync(own));
    expect(stderr).toContain(join(realpathSync(own), "tracked.ts"));
    const fresh = runHook({
      tool_name: "NotebookEdit",
      tool_input: { notebook_path: join(sibling, "apps", "web", "new.ipynb") },
      cwd: own,
    });
    expect(fresh.status).toBe(2);
  });

  it("still blocks main-worktree content from a session inside a worktree", () => {
    const dir = track(makeRepo());
    const own = addWorktree(dir, "feature");
    const { status, stderr } = write(join(dir, "tracked.ts"), own);
    expect(status).toBe(2);
    expect(stderr).toContain("repository content of the main worktree");
  });

  it("allows a gitignored path in a sibling worktree", () => {
    const dir = track(makeRepo());
    const own = addWorktree(dir, "feature");
    const sibling = addWorktree(dir, "other");
    expect(write(join(sibling, "scratch", "notes.md"), own).status).toBe(0);
  });

  it("allows a sibling-worktree write while that tree contains the sentinel", () => {
    const dir = track(makeRepo());
    const own = addWorktree(dir, "feature");
    const sibling = addWorktree(dir, "other");
    const sentinel = join(
      sibling,
      ".claude",
      "allow-primary-checkout-writes.local",
    );
    mkdirSync(join(sibling, ".claude"), { recursive: true });
    expect(write(join(sibling, "tracked.ts"), own).status).toBe(2);
    writeFileSync(sentinel, "");
    expect(write(join(sibling, "tracked.ts"), own).status).toBe(0);
  });

  it("allows a path outside any repository", () => {
    const dir = track(makeRepo());
    const outside = track(mkdtempSync(join(tmpdir(), "primary-writes-bare-")));
    expect(write(join(outside, "file.ts"), outside).status).toBe(0);
    expect(write("/tmp/probe-script.mjs", dir).status).toBe(0);
  });

  it("allows the write while the override sentinel is present", () => {
    const dir = track(makeRepo());
    const sentinel = join(
      dir,
      ".claude",
      "allow-primary-checkout-writes.local",
    );
    mkdirSync(join(dir, ".claude"), { recursive: true });
    expect(write(join(dir, "tracked.ts"), dir).status).toBe(2);
    writeFileSync(sentinel, "");
    expect(write(join(dir, "tracked.ts"), dir).status).toBe(0);
    rmSync(sentinel);
    expect(write(join(dir, "tracked.ts"), dir).status).toBe(2);
  });

  it("names the sentinel and the worktree route in its refusal", () => {
    const dir = track(makeRepo());
    const { stderr } = write(join(dir, "tracked.ts"), dir);
    expect(stderr).toContain(".claude/allow-primary-checkout-writes.local");
    expect(stderr).toContain(".claude/worktrees/");
  });
});
