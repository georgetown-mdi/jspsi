import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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

// A Workflow that names no ref: a panel, which reviews nothing branch-keyed and
// is gated on the caller's own tree alone.
const PANEL = { scriptPath: ".claude/scripts/panel-workflow.mjs" };

// A review round, which must name the ref it reviews and takes the round lock.
const review = (targetRef, rest = {}) => ({
  scriptPath: ".claude/scripts/light-review-workflow.mjs",
  args: { targetRef, docs: [], role: null, claims: [], ...rest },
});

function workflowIn(cwd, tool_input = PANEL) {
  return runHook({ tool_name: "Workflow", tool_input, cwd });
}

// A throwaway repo with `untracked` extra files left uncommitted, and `scratch`
// gitignored the way the real repository ignores it -- the round lock is written
// under it, and a lock that showed up in `git status` would block the next round.
function makeRepo(untracked = 0) {
  const dir = mkdtempSync(join(tmpdir(), "clean-tree-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "primary");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "file.txt"), "base\n");
  writeFileSync(join(dir, ".gitignore"), "scratch\n");
  git("add", "file.txt", ".gitignore");
  git("commit", "-q", "-m", "Base commit");
  for (let i = 0; i < untracked; i++) {
    writeFileSync(join(dir, `extra-${i}.txt`), "uncommitted\n");
  }
  return dir;
}

// A linked worktree on `branch`, holding a commit of its own so the branch's
// tip differs from every other worktree's HEAD.
function addWorktree(main, branch) {
  const path = `${main}-wt-${branch}`;
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
  writeFileSync(join(path, `${branch}.txt`), "work\n");
  execFileSync("git", ["-C", path, "add", `${branch}.txt`]);
  execFileSync("git", ["-C", path, "commit", "-q", "-m", `Work on ${branch}`]);
  return path;
}

function dirty(tree) {
  writeFileSync(join(tree, "uncommitted.txt"), "in progress\n");
}

const lockFor = (main, branch) =>
  join(main, "scratch", "review-rounds", `${branch}.lock`);

function writeLockAgedMinutes(main, branch, minutes) {
  const path = lockFor(main, branch);
  mkdirSync(join(main, "scratch", "review-rounds"), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      ref: branch,
      startedAt: new Date(Date.now() - minutes * 60_000).toISOString(),
    })}\n`,
  );
  return path;
}

describe("require-clean-tree-for-review hook", () => {
  const dirs = [];
  const track = (...paths) => {
    dirs.push(...paths);
    return paths[0];
  };
  afterEach(() => {
    while (dirs.length > 0)
      rmSync(dirs.pop(), { recursive: true, force: true });
  });

  it("ignores tools other than Workflow", () => {
    const dir = track(makeRepo(1));
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

  it("blocks a payload that parses to something other than an object", () => {
    const { status, stderr } = spawnSync("node", [HOOK], {
      input: "null",
      encoding: "utf8",
    });
    expect(status).toBe(2);
    expect(stderr).toContain("could not confirm a clean tree");
  });

  it("allows a target-less Workflow call on a clean tree", () => {
    const dir = track(makeRepo());
    expect(workflowIn(dir).status).toBe(0);
  });

  it("blocks a target-less Workflow call on a dirty tree and names the entries", () => {
    const dir = track(makeRepo(2));
    const { status, stderr } = workflowIn(dir);
    expect(status).toBe(2);
    expect(stderr).toContain("is not clean");
    expect(stderr).toContain("extra-0.txt");
    expect(stderr).toContain("extra-1.txt");
  });

  it("truncates a long dirty list with a remainder count", () => {
    const dir = track(makeRepo(13));
    expect(workflowIn(dir).stderr).toContain("...and 3 more");
  });

  it("blocks when the tree cannot be confirmed clean", () => {
    // Every unconfirmable state fails CLOSED: nothing backstops a review that
    // returns a false clean.
    const notARepo = track(mkdtempSync(join(tmpdir(), "clean-tree-bare-")));
    for (const event of [
      { tool_name: "Workflow", tool_input: PANEL, cwd: notARepo },
      { tool_name: "Workflow", tool_input: PANEL },
      { tool_name: "Workflow", tool_input: PANEL, cwd: "" },
      { tool_name: "Workflow", tool_input: PANEL, cwd: 7 },
    ]) {
      const { status, stderr } = runHook(event);
      expect(status, JSON.stringify(event)).toBe(2);
      expect(stderr).toContain("commit and retry");
    }
  });

  it("reports a dirty tree from a subdirectory of the repo", () => {
    const dir = track(makeRepo(1));
    const sub = join(dir, "nested");
    mkdirSync(sub);
    writeFileSync(join(sub, "kept.txt"), "x\n");
    expect(workflowIn(sub).status).toBe(2);
  });

  it("allows a round whose target worktree is clean", () => {
    const main = track(makeRepo());
    track(addWorktree(main, "feature"));
    expect(workflowIn(main, review("feature")).status).toBe(0);
  });

  it("blocks a round whose target worktree is dirty, from a clean caller", () => {
    // The critical case: the orchestrating session sits in a clean primary
    // checkout while the branch under review is uncommitted in its own tree.
    const main = track(makeRepo());
    const tree = track(addWorktree(main, "feature"));
    dirty(tree);
    const { status, stderr } = workflowIn(main, review("feature"));
    expect(status).toBe(2);
    expect(stderr).toContain("the tree holding 'feature'");
    expect(stderr).toContain("uncommitted.txt");
    expect(existsSync(lockFor(main, "feature"))).toBe(false);
  });

  it("statuses the target tree under a fully qualified ref too", () => {
    const main = track(makeRepo());
    const tree = track(addWorktree(main, "feature"));
    dirty(tree);
    expect(workflowIn(main, review("refs/heads/feature")).status).toBe(2);
  });

  it("allows a target ref no worktree holds", () => {
    // No working tree means no uncommitted state to hide: the ref's commits are
    // the whole of it, so this is a confirmation rather than a gap.
    const main = track(makeRepo());
    const tree = track(addWorktree(main, "feature"));
    execFileSync("git", ["-C", tree, "branch", "unheld"]);
    execFileSync("git", [
      "-C",
      tree,
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "Move on",
    ]);
    dirty(tree);
    expect(workflowIn(main, review("unheld")).status).toBe(0);
  });

  it("blocks a target ref that does not resolve", () => {
    const main = track(makeRepo());
    const { status, stderr } = workflowIn(main, review("no-such-branch"));
    expect(status).toBe(2);
    expect(stderr).toContain("does not resolve to a commit");
  });

  it("blocks a multi-target round when any one target is dirty, and locks none", () => {
    const main = track(makeRepo());
    track(addWorktree(main, "clean-one"));
    const messy = track(addWorktree(main, "messy-one"));
    dirty(messy);
    const { status, stderr } = workflowIn(
      main,
      review(["clean-one", "messy-one"]),
    );
    expect(status).toBe(2);
    expect(stderr).toContain("the tree holding 'messy-one'");
    expect(existsSync(lockFor(main, "clean-one"))).toBe(false);
  });

  it("locks every target of a multi-target round that passes", () => {
    const main = track(makeRepo());
    track(addWorktree(main, "one"));
    track(addWorktree(main, "two"));
    expect(workflowIn(main, review(["one", "two"])).status).toBe(0);
    for (const branch of ["one", "two"]) {
      expect(JSON.parse(readFileSync(lockFor(main, branch), "utf8")).ref).toBe(
        branch,
      );
    }
  });

  it("rolls back the locks it wrote when a later one cannot be written", () => {
    // A directory where the second lock file belongs makes its write fail, aged
    // past the TTL so the round reaches the write rather than being refused as
    // in flight; the first target's lock must not survive the refused call.
    const main = track(makeRepo());
    track(addWorktree(main, "one"));
    track(addWorktree(main, "two"));
    mkdirSync(lockFor(main, "two"), { recursive: true });
    const aged = new Date(Date.now() - 24 * 60 * 60_000);
    utimesSync(lockFor(main, "two"), aged, aged);
    const { status, stderr } = workflowIn(main, review(["one", "two"]));
    expect(status).toBe(2);
    expect(stderr).toContain("could not write the in-flight round lock");
    expect(existsSync(lockFor(main, "one"))).toBe(false);
  });

  it("gates a round named by a saved workflow's name", () => {
    // The requirement and the lock ride on any field that can hold the script:
    // scriptPath, workflow, or the name a saved workflow is invoked by.
    const main = track(makeRepo());
    track(addWorktree(main, "feature"));
    const named = { name: "light-review", args: { targetRef: "feature" } };
    expect(workflowIn(main, named).status).toBe(0);
    expect(existsSync(lockFor(main, "feature"))).toBe(true);
    expect(workflowIn(main, named).status).toBe(2);
    expect(
      workflowIn(main, { name: "light-review", args: { docs: [] } }).stderr,
    ).toContain("must name the ref it reviews");
  });

  it("blocks a review round that names no target ref", () => {
    const main = track(makeRepo());
    const { status, stderr } = workflowIn(main, {
      scriptPath: ".claude/scripts/light-review-workflow.mjs",
      args: { docs: [] },
    });
    expect(status).toBe(2);
    expect(stderr).toContain("must name the ref it reviews");
  });

  it("blocks a call whose args or target ref cannot be read", () => {
    const main = track(makeRepo());
    track(addWorktree(main, "feature"));
    for (const tool_input of [
      {
        scriptPath: ".claude/scripts/light-review-workflow.mjs",
        args: "{not json",
      },
      {
        scriptPath: ".claude/scripts/light-review-workflow.mjs",
        args: ["feature"],
      },
      { scriptPath: ".claude/scripts/light-review-workflow.mjs", args: 7 },
      review(""),
      review(["feature", 7]),
      review({ ref: "feature" }),
    ]) {
      const { status } = runHook({
        tool_name: "Workflow",
        tool_input,
        cwd: main,
      });
      expect(status, JSON.stringify(tool_input)).toBe(2);
    }
  });

  it("reads a target ref delivered as the JSON text of the args", () => {
    const main = track(makeRepo());
    const tree = track(addWorktree(main, "feature"));
    dirty(tree);
    const { status } = workflowIn(main, {
      scriptPath: ".claude/scripts/light-review-workflow.mjs",
      args: JSON.stringify({ targetRef: "feature" }),
    });
    expect(status).toBe(2);
  });

  it("refuses a second round against a branch whose round is still in flight", () => {
    const main = track(makeRepo());
    track(addWorktree(main, "feature"));
    expect(workflowIn(main, review("feature")).status).toBe(0);
    const { status, stderr } = workflowIn(main, review("feature"));
    expect(status).toBe(2);
    expect(stderr).toContain("has not booked its result yet");
    expect(stderr).toContain(lockFor(main, "feature"));
  });

  it("lets a round through once its predecessor's lock has aged past the TTL", () => {
    const main = track(makeRepo());
    track(addWorktree(main, "feature"));
    const path = writeLockAgedMinutes(main, "feature", 24 * 60);
    expect(workflowIn(main, review("feature")).status).toBe(0);
    // The stale lock is replaced by this round's own, not merely ignored.
    const age =
      Date.now() - Date.parse(JSON.parse(readFileSync(path, "utf8")).startedAt);
    expect(age).toBeLessThan(60_000);
  });

  it("expires a lock whose contents are corrupt by its mtime", () => {
    const main = track(makeRepo());
    track(addWorktree(main, "feature"));
    const path = writeLockAgedMinutes(main, "feature", 24 * 60);
    writeFileSync(path, "not json at all\n");
    // Freshly written, so its mtime is now: a corrupt lock still refuses while
    // it is young, and still expires later rather than wedging the branch.
    expect(workflowIn(main, review("feature")).status).toBe(2);
  });

  it("takes no lock for a Workflow that is not a review round", () => {
    const main = track(makeRepo());
    const tree = track(addWorktree(main, "feature"));
    const targeted = {
      scriptPath: ".claude/scripts/panel-workflow.mjs",
      args: { targetRef: "feature" },
    };
    expect(workflowIn(main, targeted).status).toBe(0);
    expect(existsSync(lockFor(main, "feature"))).toBe(false);
    dirty(tree);
    expect(workflowIn(main, targeted).status).toBe(2);
  });

  it("still blocks on the caller's own dirty tree when a target is named", () => {
    const main = track(makeRepo(1));
    track(addWorktree(main, "feature"));
    expect(workflowIn(main, review("feature")).status).toBe(2);
  });
});
