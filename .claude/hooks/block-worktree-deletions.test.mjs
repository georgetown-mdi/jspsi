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

// The harness names an isolated agent's worktree after its agent id, and the
// hook reads ownership from that id rather than from the directory the session
// happens to be sitting in, so a payload's agent id and its own tree's basename
// are the same fact stated twice.
const AGENT_ID = "own";
const ROOT = "/repo/.claude/worktrees";
const OWN = `${ROOT}/agent-${AGENT_ID}`;
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
  const own = join(dir, ".claude", "worktrees", `agent-${AGENT_ID}`);
  git("worktree", "add", "-q", "--detach", own, "HEAD");
  return { dir, tree, own, precious: join(tree, "uncommitted.txt") };
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

function verdict(command, { cwd = OWN, projectDir, agentId = AGENT_ID } = {}) {
  const payload = { tool_name: "Bash", tool_input: { command }, cwd };
  if (agentId !== null) payload.agent_id = agentId;
  return runHook(payload, projectDir);
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
      // Every unambiguous abbreviation of --force git accepts on remove.
      `git worktree remove --f ${SIBLING}`,
      `git worktree remove --fo ${OWN}`,
      `git worktree remove --forc ${SIBLING}`,
    ]);
    expectAllowed([
      `git worktree remove ${SIBLING}`,
      "git worktree remove --force /tmp/detached-rebase",
      "git worktree prune",
    ]);
  });

  it("reads a GIT_WORK_TREE redirect an export stage sets, not a bare one", () => {
    expectBlocked([
      `export GIT_WORK_TREE=${SIBLING}; git clean -fd`,
      `export GIT_WORK_TREE=${SIBLING} && git clean -fd`,
      `export GIT_WORK_TREE=${ROOT}; git worktree remove -f agent-other`,
    ]);
    // A bare `GIT_WORK_TREE=` standing as its own stage is a shell variable git
    // never sees, and a leading assignment overrides an earlier export the way
    // real git resolves it, so both leave the cleaned directory the owned cwd.
    expectAllowed([
      `GIT_WORK_TREE=${SIBLING}; git clean -fd`,
      `export GIT_WORK_TREE=${SIBLING}; GIT_WORK_TREE=${OWN} git clean -fd`,
    ]);
  });

  it("catches a quoted command word its deletion pre-filter would skip", () => {
    // The pre-filter strips quotes the same way the tokenizer does, so a quote
    // buried in the command word no longer hides the deletion from the gate.
    expectBlocked([
      `r"m" -rf ${SIBLING}`,
      `m"v" ${SIBLING} /tmp/parked`,
      `"rm" -rf ${SIBLING}`,
    ]);
  });

  it("refuses a `git clean` reaching into a tree this session does not own", () => {
    expectBlocked([
      `git -C ${SIBLING} clean -ffdx`,
      `git -C ${SIBLING} clean -fd`,
      `git -C ${SIBLING} clean -f`,
      `git -C ${SIBLING} clean --force`,
      // Any unambiguous abbreviation of --force git accepts is still a force.
      `git -C ${SIBLING} clean --forc`,
      `git -C ${SIBLING} clean --fo`,
      `git -C ${SIBLING} clean --f`,
      // A -c that turns clean.requireForce off removes git's own force
      // requirement, so the reach-in deletes with no flag at all.
      `git -C ${SIBLING} -c clean.requireForce=false clean -d`,
      `git -C ${SIBLING} -c clean.requireForce=no clean`,
      `git -C ${SIBLING} -c clean.requireForce=off clean -d`,
      `git -C ${SIBLING} -c clean.requireForce=0 clean -d`,
      `git -C ${SIBLING} -c clean.requireForce= clean -d`,
      `git -C ${SIBLING} -c clean.requireForce=FALSE clean -d`,
      `git -C ${SIBLING} -c CLEAN.REQUIREFORCE=false clean -d`,
      `git -C ${SIBLING} -c clean.requireForce=true -c clean.requireForce=false clean -d`,
      `cd ${SIBLING} && git clean -fd`,
      `git -C ${SIBLING} -C . clean -ffdx`,
      `git -C ${ROOT} -C agent-other clean -fd`,
      `git --work-tree=${SIBLING} clean -fd`,
      `git --work-tree ${SIBLING} --git-dir ${SIBLING}/.git clean -ffdx`,
      `GIT_WORK_TREE=${SIBLING} git clean -fd`,
    ]);
    // A clean with no force deletes nothing (git refuses it outright) and a dry
    // run reports rather than deletes, so neither is a deletion to refuse.
    expectAllowed([
      `git -C ${SIBLING} clean -d`,
      `git -C ${SIBLING} clean -fdn`,
      `git -C ${SIBLING} clean --dry-run -fdx`,
      // requireForce left on (its default, a bare key, or a last-winning true)
      // and a config that is not requireForce leave git's refusal in place.
      `git -C ${SIBLING} -c clean.requireForce=true clean -d`,
      `git -C ${SIBLING} -c clean.requireForce clean -d`,
      `git -C ${SIBLING} -c clean.requireForce=false -c clean.requireForce=true clean -d`,
      `git -C ${SIBLING} -c clean.requireForce=false clean -dn`,
      `git -C ${SIBLING} -c user.name=x clean -d`,
    ]);
    expectAllowed(["git clean -fdx", "git clean -ffx", "git clean -ffd"], {
      cwd: LIVE_TREE,
      projectDir: PROJECT,
      agentId: "live",
    });
  });

  it("owns the tree its agent id names, not the one its cwd drifted into", () => {
    // The everyday non-adversarial shape: a session that cd'ed into a sibling
    // tree earlier in the run, whose cwd persists into every later Bash call.
    expectBlocked(["rm -rf packages/core/src", "rm -rf *", "rm -rf ./dist"], {
      cwd: SIBLING,
    });
    expectAllowed(["rm -rf packages/core/src", "rm -rf node_modules"], {
      cwd: OWN,
    });
    expect(verdict("rm -rf src", { cwd: SIBLING }).stderr).toContain(
      `owns only '${OWN}'`,
    );
  });

  it("owns nothing when the event names no agent", () => {
    expectBlocked(["rm -rf node_modules", `rm -rf ${SIBLING}/dist`], {
      cwd: OWN,
      agentId: null,
    });
    expect(
      verdict("rm -rf node_modules", { cwd: OWN, agentId: null }).stderr,
    ).toContain("owns no agent worktree");
  });

  it("allows the plain `git worktree remove` that retires a finished tree", () => {
    const { dir, tree } = makeRepoWithWorktree();
    const options = { cwd: dir, projectDir: dir };
    expectAllowed(
      [
        `git worktree remove ${tree}`,
        `cd ${dir} && git worktree remove .claude/worktrees/agent-live`,
        `git -C ${dir} worktree remove .claude/worktrees/agent-live`,
      ],
      options,
    );
    // What makes the plain form safe to allow is git's own refusal, so that is
    // driven here rather than assumed: it will not take a tree holding work.
    const { status, stderr } = spawnSync("git", ["worktree", "remove", tree], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(status).not.toBe(0);
    expect(stderr).toContain("use --force");
    expect(existsSync(tree)).toBe(true);
    expectBlocked(
      [
        `git worktree remove --force ${tree}`,
        `git --work-tree=${join(dir, ".claude", "worktrees")} worktree remove --force agent-live`,
        `GIT_WORK_TREE=${join(dir, ".claude", "worktrees")} git worktree remove -f agent-live`,
      ],
      options,
    );
  });

  // Which directory a git option redirects to is git's behavior, not this hook's
  // reading of it, so every spelling below is put to a real repo holding a live
  // sibling worktree with uncommitted work in it: the hook must refuse exactly
  // the spellings that destroy that work, and leave the rest alone. A failure
  // means git's behavior moved and the hook's reading of it has to move too.
  it("blocks exactly the git redirects that reach a real sibling tree", () => {
    for (const spelling of [
      "git -C SIBLING clean -f",
      "git -C SIBLING clean -fd",
      "git -C SIBLING -C . clean -ffdx",
      "git --work-tree=SIBLING clean -fd",
      "git --work-tree SIBLING --git-dir SIBLING/.git clean -ffdx",
      "GIT_WORK_TREE=SIBLING git clean -fd",
      "git -C SIBLING clean -fdn",
      "git -c core.worktree=SIBLING clean -fd",
      "git --git-dir=SIBLING/.git clean -fd",
      "git -C ROOT worktree remove --force agent-live",
      "git --work-tree=ROOT worktree remove --force agent-live",
      "GIT_WORK_TREE=ROOT git worktree remove -f agent-live",
      "git -C ROOT worktree remove agent-live",
    ]) {
      const { dir, tree, own, precious } = makeRepoWithWorktree();
      const command = spelling
        .replaceAll("SIBLING", tree)
        .replaceAll("ROOT", join(dir, ".claude", "worktrees"));
      const blocked =
        verdict(command, { cwd: own, projectDir: dir }).status === 2;
      spawnSync("bash", ["-c", command], { cwd: own });
      expect(existsSync(precious), command).toBe(!blocked);
    }
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

  // How much force a spelling asks for -- a --force abbreviation, or a -c that
  // turns clean.requireForce off -- is git's behavior, so each spelling is put to
  // a real repo holding a live sibling worktree with uncommitted work. The hook
  // must refuse exactly the spellings that destroy that work. `own` is the tree
  // this session owns; `dir` (the repo root) merely holds the trees. A failure
  // means git's behavior moved and the hook's reading of it has to move too.
  // Every spelling here is version-stable -- its live-git outcome is identical on
  // git <= 2.44 and >= 2.45 -- so it is safe to tie the expectation to that
  // outcome. The one holder spelling whose outcome flips at that boundary is
  // asserted separately in the test that follows.
  it("blocks exactly the force abbreviations and requireForce config git deletes a sibling with", () => {
    for (const { spelling, from } of [
      { spelling: "git -C SIBLING clean --f", from: "own" },
      { spelling: "git -C SIBLING clean --fo", from: "own" },
      { spelling: "git -C SIBLING clean --forc", from: "own" },
      { spelling: "git worktree remove --fo SIBLING", from: "own" },
      {
        spelling: "git -C ROOT worktree remove --forc agent-live",
        from: "own",
      },
      {
        spelling: "git -C SIBLING -c clean.requireForce=false clean -d",
        from: "own",
      },
      {
        spelling: "git -C SIBLING -c clean.requireForce=no clean",
        from: "own",
      },
      { spelling: "export GIT_WORK_TREE=SIBLING; git clean -fd", from: "own" },
      // Not enough force, a dry run, a last-winning true, and a bare -c are all
      // left alone: real git deletes nothing, so neither must the hook.
      { spelling: "git -c clean.requireForce=false clean -d", from: "dir" },
      {
        spelling: "git -C SIBLING -c clean.requireForce=false clean -dn",
        from: "own",
      },
      {
        spelling:
          "git -C SIBLING -c clean.requireForce=false -c clean.requireForce=true clean -d",
        from: "own",
      },
      { spelling: "git -C SIBLING -c user.name=x clean -d", from: "own" },
      { spelling: "GIT_WORK_TREE=SIBLING; git clean -fd", from: "own" },
    ]) {
      const { dir, tree, own, precious } = makeRepoWithWorktree();
      const cwd = from === "own" ? own : dir;
      const command = spelling
        .replaceAll("SIBLING", tree)
        .replaceAll("ROOT", join(dir, ".claude", "worktrees"));
      const blocked = verdict(command, { cwd, projectDir: dir }).status === 2;
      spawnSync("bash", ["-c", command], { cwd });
      expect(existsSync(precious), command).toBe(!blocked);
    }
  });

  // One holder `git clean` spelling is version-dependent, so it cannot join the
  // live-git differential above: `clean.requireForce=false` plus a single real -f
  // reaches git's nested-repo removal threshold on git <= 2.44 (where a disabled
  // requireForce feeds the same force counter a real -f does) and is skipped on
  // git >= 2.45 (which stopped feeding it). That boundary was settled by driving
  // real git across it, not by reading git. Tying the expectation to live git's
  // effect therefore holds on one side of the boundary and fails on the other, so
  // this asserts the guard's own contract instead: it BLOCKS the shape either
  // way -- the conservative choice, since a false block is recoverable while a
  // false allow destroys uncommitted work, and the block is accurate for the git
  // this container runs (<= 2.44). git is never invoked here, which is what makes
  // the assertion version-robust by construction.
  it("conservatively blocks the version-dependent requireForce holder clean", () => {
    const { dir } = makeRepoWithWorktree();
    expectBlocked(["git -c clean.requireForce=false clean -df"], {
      cwd: dir,
      projectDir: dir,
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

  // A `.claude` taken whole holds the worktree root one level down, not two, and
  // nothing else names that root when the session is outside the project and
  // CLAUDE_PROJECT_DIR is unset.
  it("counts the worktrees under a `.claude` directory taken whole", () => {
    const { status, stderr } = verdict(`rm -rf ${join(PROJECT, ".claude")}`, {
      cwd: "/repo",
    });
    expect(status).toBe(2);
    expect(stderr).toContain(join(PROJECT, ".claude", "worktrees"));
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
