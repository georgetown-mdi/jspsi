import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

const prCreateEvent = (
  dir,
  toolResponse,
  command = "gh pr create --base staging --title x",
) => ({
  tool_name: "Bash",
  tool_input: { command },
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

// Another branch off the base carrying `commitsAheadOfBase` commits of its own,
// leaving the checkout on the branch it was already on -- the shape a main
// checkout is in when the by-ref flow opens a PR for a branch it is not on.
function addBranch(dir, branch, commitsAheadOfBase) {
  const git = (...args) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  const checkedOut = git("rev-parse", "--abbrev-ref", "HEAD").trim();
  git("checkout", "-q", "-b", branch, "origin/staging");
  for (let i = 0; i < commitsAheadOfBase; i++) {
    writeFileSync(join(dir, `${branch}-${i}.txt`), `change ${i}\n`);
    git("add", "--all");
    git("commit", "-q", "-m", `Change ${i} on ${branch}`);
  }
  git("checkout", "-q", checkedOut);
  return branch;
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

  it("counts the --head branch when the checkout sits at the base", () => {
    const dir = track(makeRepo(0, "staging"));
    const branch = addBranch(dir, "branch-under-review", 3);
    const additionalContext = context(
      prCreateEvent(
        dir,
        ghOutput(1191),
        `gh pr create --base staging --head ${branch} --title x`,
      ),
    );
    expect(additionalContext).toContain("3 commits");
    expect(additionalContext).toContain(
      join(dir, "scratch", "squash-messages", "1191.txt"),
    );
  });

  it("counts the branch a fork-style --head=owner:branch names", () => {
    const dir = track(makeRepo(0, "staging"));
    const branch = addBranch(dir, "branch-under-review", 3);
    const additionalContext = context(
      prCreateEvent(
        dir,
        ghOutput(1192),
        `gh pr create --base staging --head=someone:${branch} --title x`,
      ),
    );
    expect(additionalContext).toContain("3 commits");
    expect(additionalContext).toContain(
      join(dir, "scratch", "squash-messages", "1192.txt"),
    );
  });

  it("resolves the --head branch from a linked worktree", () => {
    const main = track(makeRepo(0, "staging"));
    const branch = addBranch(main, "branch-under-review", 3);
    const worktree = addWorktree(main, "another-branch");
    const additionalContext = context(
      prCreateEvent(
        worktree,
        ghOutput(43),
        `gh pr create --base staging --head ${branch} --title x`,
      ),
    );
    expect(additionalContext).toContain("3 commits");
    expect(additionalContext).toContain(
      join(main, "scratch", "squash-messages", "43.txt"),
    );
  });

  it("counts the --head branch rather than the cwd HEAD", () => {
    const dir = track(makeRepo(2, "feature"));
    const branch = addBranch(dir, "single-commit-branch", 1);
    const additionalContext = context(
      prCreateEvent(
        dir,
        ghOutput(44),
        `gh pr create --base staging --head ${branch} --title x`,
      ),
    );
    expect(additionalContext).toBeNull();
  });

  it("falls back to the cwd HEAD when the --head ref does not resolve", () => {
    const dir = track(makeRepo(2, "feature"));
    const additionalContext = context(
      prCreateEvent(
        dir,
        ghOutput(45),
        "gh pr create --base staging --head no-such-branch --title x",
      ),
    );
    expect(additionalContext).toContain("2 commits");
    expect(additionalContext).toContain(
      join(dir, "scratch", "squash-messages", "45.txt"),
    );
  });

  it("counts the cwd HEAD when the command carries no --head", () => {
    const dir = track(makeRepo(0, "staging"));
    addBranch(dir, "branch-under-review", 3);
    expect(context(prCreateEvent(dir, ghOutput(46)))).toBeNull();
  });

  // Two `gh pr create` calls chained into one Bash command -- the shape whose
  // count and file key come from different creates unless the two are paired.
  const twoCreates = (firstBranch, secondBranch) =>
    `gh pr create --base staging --head ${firstBranch} --title x && ` +
    `gh pr create --base staging --head ${secondBranch} --title y`;

  it("reminds only for the created PR whose branch qualifies", () => {
    const dir = track(makeRepo(0, "staging"));
    const many = addBranch(dir, "three-commit-branch", 3);
    const one = addBranch(dir, "single-commit-branch", 1);
    const additionalContext = context(
      prCreateEvent(
        dir,
        ghOutput(1265) + ghOutput(1266),
        twoCreates(many, one),
      ),
    );
    expect(additionalContext.split("\n")).toHaveLength(1);
    expect(additionalContext).toContain("3 commits");
    expect(additionalContext).toContain(
      join(dir, "scratch", "squash-messages", "1265.txt"),
    );
    expect(additionalContext).not.toContain("1266.txt");
  });

  it("pairs each created PR with its own --head branch's count", () => {
    const dir = track(makeRepo(0, "staging"));
    const first = addBranch(dir, "first-branch", 2);
    const second = addBranch(dir, "second-branch", 3);
    const lines = context(
      prCreateEvent(
        dir,
        ghOutput(1265) + ghOutput(1266),
        twoCreates(first, second),
      ),
    ).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("2 commits");
    expect(lines[0]).toContain(
      join(dir, "scratch", "squash-messages", "1265.txt"),
    );
    expect(lines[1]).toContain("3 commits");
    expect(lines[1]).toContain(
      join(dir, "scratch", "squash-messages", "1266.txt"),
    );
  });

  it("emits nothing when two creates leave one PR URL", () => {
    const dir = track(makeRepo(0, "staging"));
    const first = addBranch(dir, "first-branch", 2);
    const second = addBranch(dir, "second-branch", 3);
    const additionalContext = context(
      prCreateEvent(dir, ghOutput(1266), twoCreates(first, second)),
    );
    expect(additionalContext).toBeNull();
  });

  // Deliberate divergence from singleCreateReminder, which falls back to
  // counting the cwd's HEAD when a --head ref does not resolve: within a
  // pair that fallback would misattribute another PR's commit count, so an
  // unresolvable ref drops its pair instead. Pin that by giving the cwd HEAD
  // enough commits that the fallback, if it fired, would produce a reminder.
  it("drops a pair whose --head ref does not resolve, without falling back to the cwd HEAD count", () => {
    const dir = track(makeRepo(2, "feature"));
    const single = addBranch(dir, "single-commit-branch", 1);
    const additionalContext = context(
      prCreateEvent(
        dir,
        ghOutput(200) + ghOutput(201),
        twoCreates("no-such-branch", single),
      ),
    );
    expect(additionalContext).toBeNull();
  });

  // Deliberate divergence from singleCreateReminder, which falls back to
  // printReminder when no file path can be named. multiCreateReminder
  // resolves the main checkout root once, up front, and returns null the
  // moment that fails -- before it ever looks at a single pair -- rather
  // than falling back to printing whatever counts it could still gather.
  it("returns nothing for a multi-create when the main checkout root cannot be determined, without falling back to printing", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "remind-squash-nogit-")));
    const additionalContext = context(
      prCreateEvent(
        dir,
        ghOutput(202) + ghOutput(203),
        twoCreates("branch-a", "branch-b"),
      ),
    );
    expect(additionalContext).toBeNull();
  });

  it("falls back to printing when no key can be determined", () => {
    const dir = track(makeRepo(2));
    execFileSync("git", ["-C", dir, "checkout", "-q", "--detach"]);
    const additionalContext = context(prCreateEvent(dir, { stdout: "" }));
    expect(additionalContext).toContain("Print a ready-to-use");
    expect(additionalContext).not.toContain("squash-messages");
  });

  // The subject budget is the rule most easily lost in a later edit of the copy:
  // GitHub appends " (#NNNN)" when it squash-merges, so a subject drafted to the
  // full 50 characters lands over the limit.
  it("names the message rules whichever reminder it emits", () => {
    const dir = track(makeRepo(2));
    const rules = ["CONTRIBUTING.md", "50-character", '" (#NNNN)"'];
    const fileContext = context(prCreateEvent(dir, ghOutput(5)));
    execFileSync("git", ["-C", dir, "checkout", "-q", "--detach"]);
    const printContext = context(prCreateEvent(dir, { stdout: "" }));
    for (const rule of rules) {
      expect(fileContext).toContain(rule);
      expect(printContext).toContain(rule);
    }
  });

  it("keeps the subject budget the hook cites in CONTRIBUTING.md", () => {
    const contributing = readFileSync(
      join(REPO_ROOT, "CONTRIBUTING.md"),
      "utf8",
    );
    expect(contributing).toContain("roughly 42 characters");
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
