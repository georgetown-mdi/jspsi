import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const HOOK = fileURLToPath(
  new URL("./block-worktree-deletions.mjs", import.meta.url),
);

const ROOT = "/repo/.claude/worktrees";
const OWN = `${ROOT}/agent-own`;
const SIBLING = `${ROOT}/agent-other`;

// A real tree on disk for the cases whose verdict depends on what is actually
// there: a deletion aimed above the worktree root, which names no worktree, and
// `git clean`, whose target is a directory rather than an argument.
const PROJECT = mkdtempSync(join(tmpdir(), "block-worktree-deletions-"));
const LIVE_TREE = join(PROJECT, ".claude", "worktrees", "agent-live");
mkdirSync(LIVE_TREE, { recursive: true });

afterAll(() => rmSync(PROJECT, { recursive: true, force: true }));

// Run the hook as a real subprocess with a synthesized PreToolUse payload on
// stdin, the way Claude Code invokes it. Exit 0 allows the Bash call, exit 2
// blocks it and feeds stderr back to Claude, so both are expected outcomes here
// and neither may throw. CLAUDE_PROJECT_DIR is dropped unless a case sets it, so
// the ambient session's own worktrees never reach a verdict.
function runHook(payload, projectDir) {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  if (projectDir !== undefined) env.CLAUDE_PROJECT_DIR = projectDir;
  const { status, stderr } = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env,
  });
  return { status, stderr };
}

function verdict(command, { cwd = OWN, projectDir } = {}) {
  return runHook(
    { tool_name: "Bash", tool_input: { command }, cwd },
    projectDir,
  );
}

function expectBlocked(commands, options) {
  for (const command of commands) {
    const { status, stderr } = verdict(command, options);
    expect(status, command).toBe(2);
    expect(stderr, command).toContain("block-worktree-deletions");
  }
}

function expectAllowed(commands, options) {
  for (const command of commands) {
    expect(verdict(command, options).status, command).toBe(0);
  }
}

describe("block-worktree-deletions hook", () => {
  it("ignores tools other than Bash", () => {
    const { status } = runHook({
      tool_name: "Agent",
      tool_input: { prompt: `rm -rf ${SIBLING}` },
      cwd: OWN,
    });
    expect(status).toBe(0);
  });

  it("refuses a deletion inside a worktree this session does not own", () => {
    expectBlocked([
      `rm -rf ${SIBLING}`,
      `rm -rf ${SIBLING}/packages/core/src`,
      `rm ${SIBLING}/notes.md`,
      `rmdir ${SIBLING}/dist`,
    ]);
  });

  it("names the tree it refused and why the loss is unrecoverable", () => {
    const { stderr } = verdict(`rm -rf ${SIBLING}`);
    expect(stderr).toContain(SIBLING);
    expect(stderr).toContain("another session's worktree");
    expect(stderr).toContain("exists nowhere else until it is committed");
  });

  it("refuses a worktree taken whole, including this session's own", () => {
    expectBlocked([
      `rm -rf ${OWN}`,
      `rm -rf ${ROOT}`,
      `rm -rf ${ROOT}/agent-*`,
    ]);
    expect(verdict(`rm -rf ${OWN}`).stderr).toContain(
      "this session's own worktree",
    );
  });

  it("allows a deletion strictly inside this session's own worktree", () => {
    expectAllowed([
      "rm -rf node_modules",
      "rm -rf ./apps/web/dist",
      `rm -rf ${OWN}/packages/core/dist`,
      "find dist -name '*.map' -delete",
    ]);
  });

  it("allows a deletion with no worktree anywhere near it", () => {
    expectAllowed([
      "rm -rf /tmp/scratch",
      "rm -rf /repo/apps/web/dist",
      "rm -f /repo/.claude/settings.local.json",
    ]);
  });

  it("reads the destructive forms that are not a bare rm", () => {
    expectBlocked([
      `mv ${SIBLING} /tmp/parked`,
      `find ${SIBLING} -type f -delete`,
      `find ${SIBLING} -name '*.ts' -exec rm {} +`,
      `find ${SIBLING} -print0 | xargs -0 rm -rf`,
      `sudo rm -rf ${SIBLING}`,
      `shred -u ${SIBLING}/.psilink.key`,
    ]);
  });

  it("resolves a relative target against a cd earlier in the line", () => {
    expectBlocked([
      `cd ${ROOT} && rm -rf agent-other`,
      `cd ${ROOT}/agent-other; rm -rf src`,
    ]);
  });

  it("allows a command that only mentions a worktree path", () => {
    expectAllowed([
      `ls ${SIBLING}`,
      `echo rm -rf ${SIBLING}`,
      `git -C ${SIBLING} log --oneline -1`,
      `grep -rn 'rm -rf' ${SIBLING}/docs`,
    ]);
  });

  it("refuses `git worktree remove --force`, which defeats git's own guard", () => {
    expectBlocked([
      `git worktree remove --force ${SIBLING}`,
      `git worktree remove -f ${OWN}`,
    ]);
    expectAllowed([
      `git worktree remove ${SIBLING}`,
      "git worktree remove --force /tmp/detached-rebase",
      "git worktree prune",
    ]);
  });

  it("refuses the `git clean` spelling that removes a nested worktree", () => {
    expectBlocked([`git clean -ffd`, `git clean --force --force -dx`], {
      cwd: PROJECT,
      projectDir: PROJECT,
    });
    expectBlocked([`git -C ${SIBLING} clean -ffdx`]);
    expectAllowed(["git clean -fdx", "git clean -ffx", "git clean -ffd"], {
      cwd: LIVE_TREE,
      projectDir: PROJECT,
    });
    expectAllowed(["git clean -fdx", "git clean -ffx"], {
      cwd: PROJECT,
      projectDir: PROJECT,
    });
  });

  it("refuses a deletion aimed above the worktree root", () => {
    const { status, stderr } = verdict(`rm -rf ${PROJECT}`, {
      cwd: PROJECT,
      projectDir: PROJECT,
    });
    expect(status).toBe(2);
    expect(stderr).toContain("1 live worktree");
    expectBlocked([`rm -rf ${join(PROJECT, ".claude")}`], {
      cwd: PROJECT,
      projectDir: PROJECT,
    });
    expectAllowed([`rm -rf ${join(PROJECT, "apps")}`], {
      cwd: PROJECT,
      projectDir: PROJECT,
    });
  });

  it("guards every tree from a session that owns none of them", () => {
    expectBlocked([`rm -rf ${SIBLING}`, `rm -rf ${OWN}`], { cwd: "/repo" });
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
