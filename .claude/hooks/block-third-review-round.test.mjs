import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HOOK = fileURLToPath(
  new URL("./block-third-review-round.mjs", import.meta.url),
);

// Run the hook as a real subprocess with a synthesized PreToolUse payload on
// stdin, the way Claude Code invokes it. Exit 0 allows, exit 2 blocks with the
// reason on stderr.
function runHook(payload) {
  try {
    execFileSync("node", [HOOK], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, stderr: "" };
  } catch (error) {
    return { status: error.status, stderr: error.stderr };
  }
}

// A throwaway git repo standing in for a branch's working tree, with a commit so
// HEAD resolves. Identity is passed per-command so the test never depends on the
// machine's git config.
function makeRepo(branch = "some-branch") {
  const dir = mkdtempSync(join(tmpdir(), "review-rounds-"));
  execFileSync("git", ["-C", dir, "init", "-b", branch], { stdio: "ignore" });
  commit(dir, "root");
  return dir;
}

function commit(dir, message) {
  execFileSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=T",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      message,
    ],
    { stdio: "ignore" },
  );
}

function ledgerPath(dir, branch = "some-branch") {
  return join(dir, "scratch", "review-rounds", `${branch}.jsonl`);
}

function ledgerLines(dir, branch = "some-branch") {
  return readFileSync(ledgerPath(dir, branch), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function spawn(dir, overrides = {}) {
  return runHook({
    tool_name: "Agent",
    cwd: dir,
    tool_input: {
      subagent_type: "security-reviewer",
      prompt: "review the diff",
      ...overrides,
    },
  });
}

describe("block-third-review-round hook", () => {
  const dirs = [];
  afterEach(() => {
    while (dirs.length > 0)
      rmSync(dirs.pop(), { recursive: true, force: true });
  });

  function repo(branch) {
    const dir = makeRepo(branch);
    dirs.push(dir);
    return dir;
  }

  it("allows the first two rounds and records each one", () => {
    const dir = repo();
    expect(spawn(dir).status).toBe(0);
    commit(dir, "fix round one findings");
    expect(spawn(dir).status).toBe(0);

    const records = ledgerLines(dir);
    expect(records.map((r) => r.round)).toEqual([1, 2]);
    expect(records[0].head).not.toBe(records[1].head);
    expect(records[0].role).toBe("security-reviewer");
    expect(records[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("blocks a third round, naming the count and both exits", () => {
    const dir = repo();
    spawn(dir);
    commit(dir, "fix round one findings");
    spawn(dir);
    commit(dir, "fix round two findings");

    const { status, stderr } = spawn(dir);
    expect(status).toBe(2);
    expect(stderr).toContain("already had 2 review rounds");
    expect(stderr).toContain("filed as its own item");
    expect(stderr).toContain("rebase");
    expect(stderr).toContain("[step-back-adjudicated: <reason>]");
    expect(ledgerLines(dir)).toHaveLength(2);
  });

  it("allows an adjudicated third round and records it", () => {
    const dir = repo();
    spawn(dir);
    commit(dir, "fix round one findings");
    spawn(dir);
    commit(dir, "fix round two findings");

    const { status } = spawn(dir, {
      prompt: "review again [step-back-adjudicated: owner pulled the rewrite]",
    });
    expect(status).toBe(0);
    expect(ledgerLines(dir).map((r) => r.round)).toEqual([1, 2, 3]);
  });

  it("still blocks when the override carries no reason", () => {
    const dir = repo();
    spawn(dir);
    commit(dir, "fix round one findings");
    spawn(dir);
    commit(dir, "fix round two findings");

    expect(
      spawn(dir, { prompt: "again [step-back-adjudicated: ]" }).status,
    ).toBe(2);
  });

  it("treats reviewers spawned against the same HEAD as one round", () => {
    const dir = repo();
    for (const role of [
      "security-reviewer",
      "ux-reviewer",
      "adversarial-verifier",
    ]) {
      expect(spawn(dir, { subagent_type: role }).status).toBe(0);
    }
    commit(dir, "fix round one findings");
    expect(spawn(dir).status).toBe(0);
    commit(dir, "fix round two findings");

    // Three parallel reviewers plus one follow-up round is two rounds, not four.
    expect(ledgerLines(dir).map((r) => r.round)).toEqual([1, 1, 1, 2]);
    expect(spawn(dir).status).toBe(2);
  });

  it("admits a reviewer joining a round already recorded", () => {
    const dir = repo();
    spawn(dir);
    commit(dir, "fix round one findings");
    spawn(dir);
    commit(dir, "fix round two findings");
    spawn(dir, { prompt: "round three [step-back-adjudicated: owner call]" });

    expect(spawn(dir, { subagent_type: "ux-reviewer" }).status).toBe(0);
    expect(ledgerLines(dir).map((r) => r.round)).toEqual([1, 2, 3, 3]);
  });

  it("counts rounds light-review recorded before this hook existed", () => {
    const dir = repo();
    mkdirSync(join(dir, "scratch", "review-rounds"), { recursive: true });
    writeFileSync(
      ledgerPath(dir),
      '{"round":1,"date":"2026-07-24","clusters":[],"simplerShapeVotes":0}\n' +
        '{"round":2,"date":"2026-07-24","clusters":[],"simplerShapeVotes":1}\n',
    );
    expect(spawn(dir).status).toBe(2);
  });

  it("counts an unparseable ledger line rather than reading it as empty", () => {
    const dir = repo();
    mkdirSync(join(dir, "scratch", "review-rounds"), { recursive: true });
    writeFileSync(ledgerPath(dir), "not json\nalso not json\n");
    expect(spawn(dir).status).toBe(2);
  });

  it("scopes the ledger to the current branch", () => {
    const dir = repo("branch-a");
    spawn(dir);
    commit(dir, "fix round one findings");
    spawn(dir);
    commit(dir, "fix round two findings");
    expect(spawn(dir).status).toBe(2);

    execFileSync("git", ["-C", dir, "checkout", "-q", "-b", "branch-b"]);
    expect(spawn(dir).status).toBe(0);
    expect(ledgerLines(dir, "branch-b")).toHaveLength(1);
  });

  it("passes through subagent types that are not review roles", () => {
    const dir = repo();
    for (const role of ["implementer", "project-manager", "general-purpose"]) {
      expect(spawn(dir, { subagent_type: role }).status).toBe(0);
    }
    expect(() => ledgerLines(dir)).toThrow();
  });

  it("ignores tools other than Agent", () => {
    const { status } = runHook({
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
    });
    expect(status).toBe(0);
  });

  it("blocks when the ledger cannot be located, unless adjudicated", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-rounds-nogit-"));
    dirs.push(dir);
    const blocked = spawn(dir);
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain("could not locate");
    expect(
      spawn(dir, { prompt: "go [step-back-adjudicated: no repo here]" }).status,
    ).toBe(0);
  });
});
