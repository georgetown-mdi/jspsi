import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HOOK = fileURLToPath(new URL("./block-worktree-cd.mjs", import.meta.url));

const PROJECT = "/repo";
const ROOT = `${PROJECT}/.claude/worktrees`;
const OWN = `${ROOT}/agent-own`;
const SIBLING = `${ROOT}/agent-sibling`;

// Run the hook as a real subprocess with a synthesized PreToolUse payload on
// stdin, the way Claude Code invokes it. Exit 0 allows the Bash call, exit 2
// blocks it and feeds stderr back to Claude, so both are expected outcomes here
// and neither may throw.
function runHook(payload) {
  const { status, stderr } = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
  });
  return { status, stderr };
}

function verdict(command, cwd = PROJECT) {
  return runHook({ tool_name: "Bash", tool_input: { command }, cwd });
}

function expectBlocked(commands, cwd = PROJECT) {
  for (const command of commands) {
    const { status, stderr } = verdict(command, cwd);
    expect(status, command).toBe(2);
    expect(stderr, command).toContain("block-worktree-cd");
    expect(stderr, command).toContain("env -C");
  }
}

function expectAllowed(commands, cwd = PROJECT) {
  for (const command of commands) {
    expect(verdict(command, cwd).status, command).toBe(0);
  }
}

describe("block-worktree-cd hook", () => {
  it("ignores tools other than Bash", () => {
    const { status } = runHook({
      tool_name: "Agent",
      tool_input: { prompt: `cd ${SIBLING} && npm test` },
    });
    expect(status).toBe(0);
  });

  it("blocks a leading cd into a worktree, whatever follows it", () => {
    expectBlocked([
      `cd ${SIBLING}`,
      `cd ${SIBLING} && npm test`,
      `cd ${SIBLING}; git log`,
      `cd ${SIBLING}/packages/core && npm run build`,
      `cd '${SIBLING}' && npm test`,
      `cd "${SIBLING}/apps/cli"`,
      `cd ${SIBLING}/ && npm test`,
      `cd -- ${SIBLING} && npm test`,
      `cd -P ${SIBLING}`,
    ]);
  });

  it("resolves a relative target against the directory of the call", () => {
    expectBlocked([
      "cd .claude/worktrees/agent-sibling && npm test",
      "cd ./.claude/worktrees/agent-sibling",
    ]);
    expectBlocked([`cd ../agent-sibling && npm test`], OWN);
  });

  it("names the tree and both scoped spellings in the refusal", () => {
    const { stderr } = verdict(`cd ${SIBLING} && npm test`);
    expect(stderr).toContain(SIBLING);
    expect(stderr).toContain(`env -C ${SIBLING} <command>`);
    expect(stderr).toContain(`git -C ${SIBLING} <args>`);
  });

  it("allows the scoped spellings the refusal names", () => {
    expectAllowed([
      `env -C ${SIBLING} npm test`,
      `git -C ${SIBLING} log --oneline -5`,
      `git -C ${SIBLING} diff "staging...HEAD" --stat`,
    ]);
  });

  it("allows a cd into the tree the call is already made from", () => {
    expectAllowed([`cd ${OWN} && npm test`, `cd ${OWN}/packages/core`], OWN);
  });

  it("allows a cd that leaves every worktree, or reaches none", () => {
    expectAllowed([
      "cd /workspace && npm test",
      "cd /tmp/rebase-tree && git rebase staging",
      `cd ${ROOT}`,
      "cd",
      "cd -",
      "cd packages/core && npm run build",
    ]);
  });

  it("reads only the command's first token", () => {
    expectAllowed([
      `echo cd ${SIBLING}`,
      `grep -rn "cd ${SIBLING}" scripts`,
      `npm test && cd ${SIBLING}`,
      `(cd ${SIBLING} && git log)`,
    ]);
  });

  // zsh's `cd <old> <new>` substitutes the first occurrence of <old> in the
  // pathname of the directory of the call with <new> and moves there, which
  // hops between sibling worktrees without naming either. Every destination
  // asserted here was measured against real zsh.
  it("blocks a two-argument cd that hops to a sibling worktree", () => {
    expectBlocked(
      ["cd agent-own agent-sibling && npm test", "cd own sibling"],
      OWN,
    );
    const { stderr } = verdict("cd agent-own agent-sibling", OWN);
    expect(stderr).toContain(SIBLING);
  });

  it("allows a two-argument cd whose destination leaves every worktree", () => {
    expectAllowed(
      [
        "cd .claude/worktrees/agent-own packages/core && npm test",
        `cd ${ROOT}/agent-own /tmp/rebase-tree`,
      ],
      OWN,
    );
  });

  it("allows a two-argument cd that stays in the tree of the call", () => {
    expectAllowed(
      ["cd apps/cli packages/core && npm run build"],
      `${OWN}/apps/cli`,
    );
    expectAllowed(["cd agent-own agent-own"], OWN);
  });

  it("allows a two-argument cd whose destination it cannot compute", () => {
    expectAllowed(
      [
        "cd agent-absent agent-sibling && npm test",
        "cd $SOURCE agent-sibling",
        "cd agent-own ~/agent-sibling",
        `cd agent-own agent-sibling ${SIBLING}`,
      ],
      OWN,
    );
  });

  it("allows a target it cannot resolve rather than guessing", () => {
    expectAllowed([`cd "$TREE" && npm test`, "cd ~/worktrees/agent-sibling"]);
  });

  it("allows a malformed or absent payload rather than wedging Bash", () => {
    const { status } = spawnSync("node", [HOOK], {
      input: "not json",
      encoding: "utf8",
    });
    expect(status).toBe(0);
    expect(runHook({ tool_name: "Bash", tool_input: {} }).status).toBe(0);
  });
});
