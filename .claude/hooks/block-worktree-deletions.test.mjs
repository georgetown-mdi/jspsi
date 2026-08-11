import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

const fixtures = [PROJECT];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

// A throwaway repo carrying a real linked worktree with uncommitted work in it,
// for the cases that let real git decide rather than modelling what it does.
function makeRepoWithWorktree() {
  const dir = mkdtempSync(join(tmpdir(), "block-worktree-deletions-repo-"));
  fixtures.push(dir);
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "file.txt"), "base\n");
  git("add", "file.txt");
  git("commit", "-q", "-m", "Base commit");
  const tree = join(dir, ".claude", "worktrees", "agent-live");
  git("worktree", "add", "-q", "--detach", tree, "HEAD");
  writeFileSync(join(tree, "uncommitted.txt"), "exists nowhere else\n");
  return { dir, tree };
}

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

  it("reads past a prefix word whose flag takes a value", () => {
    expectBlocked([
      `sudo -u vdorie rm -rf ${SIBLING}`,
      `nice -n 10 rm -rf ${SIBLING}`,
      `env -i rm -rf ${SIBLING}`,
      `sudo --preserve-env -u vdorie mv ${SIBLING} /tmp/parked`,
    ]);
    expectAllowed([`sudo -u vdorie ls ${SIBLING}`]);
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

  it("refuses a `git clean` reaching into a tree this session does not own", () => {
    expectBlocked([`git -C ${SIBLING} clean -ffdx`]);
    expectAllowed(["git clean -fdx", "git clean -ffx", "git clean -ffd"], {
      cwd: LIVE_TREE,
      projectDir: PROJECT,
    });
  });

  // Which `git clean` spelling takes a worktree with it is git's behavior, not
  // this hook's, so it is settled by running git against a real linked worktree
  // rather than by modelling the force/-d rule here. The hook must refuse
  // exactly the spellings that destroy the tree: a failure means git's behavior
  // moved and the hook's reading of it has to move too.
  it("blocks exactly the `git clean` spellings real git deletes a worktree with", () => {
    for (const spelling of [
      "-fd",
      "-fdx",
      "-ffx",
      "-ffd",
      "-ffdx",
      "--force --force -dx",
    ]) {
      const { dir, tree } = makeRepoWithWorktree();
      const blocked =
        verdict(`git clean ${spelling}`, { cwd: dir, projectDir: dir })
          .status === 2;
      execFileSync("git", ["clean", ...spelling.split(" ")], { cwd: dir });
      expect(existsSync(tree), `git clean ${spelling}`).toBe(!blocked);
    }
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
    // The filesystem root is the degenerate case of "above", and it has to name
    // the root it would carry off rather than fall through on a doubled slash.
    const fromRoot = verdict("rm -rf /", { cwd: PROJECT, projectDir: PROJECT });
    expect(fromRoot.status).toBe(2);
    expect(fromRoot.stderr).toContain(join(PROJECT, ".claude", "worktrees"));
    expectAllowed([`rm -rf ${join(PROJECT, "apps")}`], {
      cwd: PROJECT,
      projectDir: PROJECT,
    });
  });

  it("guards every tree from a session that owns none of them", () => {
    expectBlocked([`rm -rf ${SIBLING}`, `rm -rf ${OWN}`], { cwd: "/repo" });
  });

  // The hook's header states the shapes it does not read. A stated limit is a
  // claim about runtime, so it is pinned here rather than left to prose that
  // cannot fail: each of these reaches a sibling worktree and this hook allows
  // it. A failure means one of them is now caught and the header is stale.
  it("allows the shapes its header states it does not read", () => {
    expectAllowed([
      `(cd ${ROOT} && rm -rf agent-other)`,
      `{ cd ${ROOT}; rm -rf agent-other; }`,
      `ls & rm -rf ${SIBLING}`,
      `bash -c "rm -rf ${SIBLING}"`,
      `\\rm -rf ${SIBLING}`,
      `timeout 5 rm -rf ${SIBLING}`,
      `TREE=${SIBLING}; rm -rf "$TREE"`,
    ]);
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
