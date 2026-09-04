import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  isInside,
  isStrictlyInside,
  owningWorktree,
  parseWorktreeRecords,
  worktreeRecords,
} from "./worktrees.mjs";

const temporary = [];

afterEach(() => {
  while (temporary.length > 0) {
    rmSync(temporary.pop(), { recursive: true, force: true });
  }
});

// A repository with a linked worktree nested under its own root, the layout the
// agent worktrees use, so the ordering and the nesting are read from real git
// rather than from a fixture that assumes them.
function makeRepoWithNestedWorktree() {
  const root = mkdtempSync(join(tmpdir(), "hook-worktrees-"));
  temporary.push(root);
  const run = (...args) => execFileSync("git", args, { cwd: root });
  run("init", "-q", "-b", "primary");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("commit", "-q", "--allow-empty", "-m", "Base commit");
  mkdirSync(join(root, "nested"), { recursive: true });
  const linked = join(root, "nested", "tree");
  run("worktree", "add", "-q", "-b", "linked", linked);
  return { root, linked };
}

describe("parseWorktreeRecords", () => {
  it("reads each worktree's path, head and branch", () => {
    expect(
      parseWorktreeRecords(
        "worktree /repo\nHEAD abc123\nbranch refs/heads/primary\n\n" +
          "worktree /repo/nested/tree\nHEAD def456\nbranch refs/heads/linked\n",
      ),
    ).toEqual([
      { path: "/repo", head: "abc123", branch: "refs/heads/primary" },
      {
        path: "/repo/nested/tree",
        head: "def456",
        branch: "refs/heads/linked",
      },
    ]);
  });

  it("leaves branch null for a detached worktree", () => {
    expect(
      parseWorktreeRecords("worktree /repo\nHEAD abc123\ndetached\n"),
    ).toEqual([{ path: "/repo", head: "abc123", branch: null }]);
  });

  it("leaves head and branch null for a bare repository", () => {
    expect(parseWorktreeRecords("worktree /repo\nbare\n")).toEqual([
      { path: "/repo", head: null, branch: null },
    ]);
  });

  it("skips a field standing before any worktree line", () => {
    expect(parseWorktreeRecords("HEAD abc123\nworktree /repo\n")).toEqual([
      { path: "/repo", head: null, branch: null },
    ]);
  });

  it("reads an empty listing as no records", () => {
    expect(parseWorktreeRecords("")).toEqual([]);
  });
});

describe("worktreeRecords", () => {
  it("lists the main worktree first from either tree", () => {
    const { root, linked } = makeRepoWithNestedWorktree();
    for (const directory of [root, linked]) {
      const records = worktreeRecords(directory);
      expect(records.map((record) => record.path)).toEqual([root, linked]);
      expect(records[1].branch).toBe("refs/heads/linked");
      expect(records[1].head).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("returns nothing outside a repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "hook-worktrees-bare-"));
    temporary.push(dir);
    expect(worktreeRecords(dir)).toBeNull();
  });
});

describe("isInside", () => {
  it("holds for the directory itself and for a path under it", () => {
    expect(isInside("/repo", "/repo")).toBe(true);
    expect(isInside("/repo/src/main.ts", "/repo")).toBe(true);
  });

  it("does not hold for a sibling whose name starts the same way", () => {
    expect(isInside("/repo-other/file", "/repo")).toBe(false);
  });

  it("holds for every path at the filesystem root", () => {
    expect(isInside("/repo", "/")).toBe(true);
    expect(isInside("/", "/")).toBe(true);
  });
});

describe("isStrictlyInside", () => {
  it("holds for a path under the directory but not for the directory", () => {
    expect(isStrictlyInside("/repo/src", "/repo")).toBe(true);
    expect(isStrictlyInside("/repo", "/repo")).toBe(false);
  });

  it("holds for every path at the filesystem root, the root included", () => {
    expect(isStrictlyInside("/repo", "/")).toBe(true);
    expect(isStrictlyInside("/", "/")).toBe(true);
  });

  it("does not hold for a sibling whose name starts the same way", () => {
    expect(isStrictlyInside("/repo-other/file", "/repo")).toBe(false);
  });
});

describe("owningWorktree", () => {
  const paths = ["/repo", "/repo/.claude/worktrees/agent-one"];

  it("gives a nested worktree the paths inside it, not the main root", () => {
    expect(owningWorktree("/repo/.claude/worktrees/agent-one/src", paths)).toBe(
      "/repo/.claude/worktrees/agent-one",
    );
  });

  it("gives the main root a path no linked worktree contains", () => {
    expect(owningWorktree("/repo/src/main.ts", paths)).toBe("/repo");
  });

  it("names no worktree for a path outside every one of them", () => {
    expect(owningWorktree("/elsewhere/file", paths)).toBeUndefined();
  });
});
