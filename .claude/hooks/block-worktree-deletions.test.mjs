import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

// A tree a session was pointed at rather than given, and the id such a session
// holds: the harness names a tree after an agent only when it gave that agent
// one, so a spawn briefed to work in an existing tree resolves to a tree that
// was never created.
const HANDED = `${ROOT}/agent-handed`;
const SPAWNED_WITHOUT_A_TREE = "spawned-without-a-tree";

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

// A throwaway repo containing a real linked worktree with uncommitted work in it,
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
  return { dir, git, tree, own, precious: join(tree, "uncommitted.txt") };
}

// A home directory holding a git config file that sets clean.requireForce, for
// the inline environment spellings that move which files git reads for a single
// command.
function makeGitConfigHome(requireForce) {
  const home = mkdtempSync(join(tmpdir(), "block-worktree-deletions-home-"));
  fixtures.push(home);
  writeFileSync(
    join(home, ".gitconfig"),
    `[clean]\n\trequireForce = ${requireForce}\n`,
  );
  return home;
}

// The two ways an agent worktree goes orphaned in practice: its superproject's
// admin directory removed, and its gitlink left pointing at a gitdir that is
// gone. Either one stops real git reading the tree as a repository to skip.
function orphan(state, dir, tree) {
  if (state === "adminDirRemoved") {
    rmSync(join(dir, ".git", "worktrees", basename(tree)), {
      recursive: true,
      force: true,
    });
  }
  if (state === "danglingGitlink") {
    writeFileSync(
      join(tree, ".git"),
      `gitdir: ${join(dir, ".git", "worktrees", "gone")}\n`,
    );
  }
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
      `cd ${ROOT}/agent-other/apps && rm -rf ../../agent-third`,
      `cd ${ROOT}/agent-other; rm -rf .`,
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

  // The shapes the header records as unread, pinned so the record is a check
  // rather than a claim. Each one destroys the sibling tree if it runs; each is
  // allowed here because closing it means a shell-syntax-aware parser, which is
  // a larger and more fragile thing than the accident this hook guards against.
  // A row that starts failing means the hook grew to see that shape, and the
  // header's stated limit has to go with it.
  it("records the command shapes it does not read", () => {
    expectAllowed([
      // A command substitution keeps its brackets inside the stage that holds it,
      // so the deletion inside one is never the stage's command word.
      `echo $(rm -rf ${SIBLING})`,
      // A target that only exists at runtime stands nowhere on the line.
      `rm -rf $(cat /tmp/tree-path)`,
    ]);
  });

  it("catches a quoted command word its deletion pre-filter would skip", () => {
    // The pre-filter strips quotes the same way the tokenizer does, so a quote
    // buried in the command word cannot hide the deletion from the gate.
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
      // A clean of the tree the shell is standing in is that session's own
      // cleanup, whichever tree its agent id names.
      `cd ${SIBLING} && git clean -fd`,
    ]);
    expectAllowed(["git clean -fdx", "git clean -ffx", "git clean -ffd"], {
      cwd: LIVE_TREE,
      projectDir: PROJECT,
      agentId: "live",
    });
  });

  // The measured false-positive class this hook cost the most on: a session
  // working in a branch worktree its agent id does not name -- a non-isolated
  // spawn, or one pointed at an existing tree -- clearing the probes, artifacts
  // and screenshots it wrote itself. Every shape here is one a real session met a
  // refusal on.
  it("allows a session to clear its own scratch in the tree it is standing in", () => {
    expectAllowed(
      [
        "rm apps/cli/test/unit/zzOrderProbe.test.ts",
        "rm review_findings.md",
        "rm -rf apps/web/test/browser/__screenshots__",
        "mv apps/cli/test/unit/probe.test.ts /tmp/probe.test.ts.bak",
        "rm -f scratch/commit-msg.txt; git status --short",
        `rm ${SIBLING}/review_findings.md`,
        `cd ${SIBLING}/apps/web && rm -f test/browser/probe.test.ts`,
        `cd ${SIBLING}/apps/web && cat > /tmp/probe.test.ts <<'EOF'\nimport { rm } from "node:fs";\nEOF`,
        "git clean -fd",
      ],
      { cwd: SIBLING, agentId: SPAWNED_WITHOUT_A_TREE },
    );
  });

  it("works in the tree it is standing in, and in no other", () => {
    expectAllowed(["rm -rf packages/core/src", "rm -rf ./dist"], {
      cwd: SIBLING,
    });
    // Standing in one tree buys nothing in another, and nothing in the tree
    // itself: both are the loss this hook exists for.
    expectBlocked(
      [`rm ${ROOT}/agent-third/probe.test.ts`, "rm -rf .", `rm -rf ${SIBLING}`],
      { cwd: SIBLING },
    );
    expect(
      verdict(`rm ${ROOT}/agent-third/probe.test.ts`, { cwd: SIBLING }).stderr,
    ).toContain(`working in '${SIBLING}'`);
    // Standing in a tree is not owning it, so the refusal on the tree taken
    // whole says which of the two answers it read rather than calling a tree the
    // session merely walked into its own.
    expect(verdict(`rm -rf ${SIBLING}`, { cwd: SIBLING }).stderr).toContain(
      "is the worktree this session is working in, taken whole",
    );
  });

  it("has nothing when the event names no agent and the shell stands outside", () => {
    expectBlocked([`rm -rf ${SIBLING}/dist`, `rm -rf ${OWN}/dist`], {
      cwd: "/repo",
      agentId: null,
    });
    expect(
      verdict(`rm -rf ${OWN}/dist`, { cwd: "/repo", agentId: null }).stderr,
    ).toContain("owns no agent worktree");
  });

  // The cases the model turns on, driven together so the answer each one ships
  // stands in a single place: the tree this session's agent id names, reached from
  // outside it; a tree it was handed and is standing in; a tree it is neither
  // standing in nor owns; and the tree itself, which neither answer ever buys.
  it("resolves the ownership cases from the agent id and the standing tree", () => {
    expectAllowed([`rm ${OWN}/probe.test.ts`, `rm -rf ${OWN}/dist`], {
      cwd: ROOT,
    });

    const handed = { cwd: HANDED, agentId: SPAWNED_WITHOUT_A_TREE };
    expectAllowed([`rm ${HANDED}/probe.test.ts`, "rm probe.test.ts"], handed);
    expectBlocked([`rm -rf ${HANDED}`, `rm ${SIBLING}/probe.test.ts`], handed);

    // A refusal has to state the procedure that clears a stranded tree without a
    // deletion, or a session with one to retire has nothing to do next -- and it
    // has to say plainly that a tree another session is working in gets no
    // cleanup at all.
    const refusal = verdict(`rm ${SIBLING}/probe.test.ts`, handed).stderr;
    expect(refusal).toContain("stash push -u -- <path>");
    expect(refusal).toContain("STRANDED tree");
    expect(refusal).toContain("gets no cleanup of any kind");

    expectBlocked([`rm ${HANDED}/probe.test.ts`], {
      cwd: "/repo",
      agentId: null,
    });

    // A session standing in one tree while its agent id names another may work
    // in both, so a refusal reporting one of them sends it to the wrong place.
    const bothTrees = verdict(`rm ${SIBLING}/probe.test.ts`, {
      cwd: HANDED,
    }).stderr;
    expect(bothTrees).toContain(`working in '${HANDED}'`);
    expect(bothTrees).toContain(`owns '${OWN}'`);
  });

  // The cost the ownership model states plainly, pinned so the header's stated
  // limit cannot go stale: a `cd` into a tree makes it the tree the shell stands
  // in, contents and all. What no `cd` reaches is the tree itself, the root they
  // all live under, or any tree other than the one it lands in.
  it("takes a cd into a tree for standing in it, never for taking it", () => {
    expectAllowed([`cd ${SIBLING} && rm -rf src`], { cwd: "/repo" });
    expectBlocked(
      [
        `cd ${SIBLING} && rm -rf .`,
        `cd ${SIBLING}/.. && rm -rf agent-other`,
        `cd ${SIBLING} && rm -rf ${ROOT}/agent-third/src`,
        `cd /repo && rm -rf ${SIBLING}/src`,
      ],
      { cwd: "/repo" },
    );
  });

  // The 'incidental mention' class: a worktree path standing on a line that
  // deletes something else. Only the operands the deleting command removes are
  // read, so none of these is a deletion of the tree it names -- while the
  // removal itself is read wherever it stands.
  it("reads only the operands the deleting command removes", () => {
    expectAllowed([
      `grep -n 'DELETING|"rm"|clean' ${SIBLING}/hook.mjs | head -40`,
      `mv /tmp/probe.test.ts ${SIBLING}/apps/web/probe.test.ts`,
      `find ${OWN}/dist -newer ${SIBLING}/marker -delete`,
      `find ${OWN}/dist -name '${SIBLING}' -delete`,
      `rm -rf ${OWN}/dist | tee ${SIBLING}/log.txt`,
      `git -C ${SIBLING} status --short | rm -rf ${OWN}/dist`,
      // A short flag that is not `-t` names no destination, so the last operand
      // is still the one mv writes rather than one it takes away.
      `mv -v /tmp/probe.test.ts ${SIBLING}/apps/web/probe.test.ts`,
    ]);
    expectBlocked([
      `mv ${SIBLING}/probe.test.ts /tmp/probe.test.ts`,
      `mv -t /tmp ${SIBLING}/a.ts ${SIBLING}/b.ts`,
      `mv --target-directory=/tmp ${SIBLING}/a.ts`,
      `mv --target-directory /tmp ${SIBLING}/a.ts`,
      // getopt reads a bundled `-t` exactly as a lone one, taking the directory
      // from the next argument or from the letters after the `t` itself, so each
      // of these leaves the sibling path a source mv takes away.
      `mv -vt /tmp ${SIBLING}/a.ts`,
      `mv -fvt /tmp ${SIBLING}/a.ts`,
      `mv -vt/tmp ${SIBLING}/a.ts`,
      `find ${SIBLING} -newer ${OWN}/marker -delete`,
      `find -L ${SIBLING} -name '*.ts' -delete`,
      `grep -rn x ${OWN} | head -3 && rm -rf ${SIBLING}/dist`,
    ]);
  });

  // A `find -exec` hands its command the arguments written after the command
  // word, so a path standing there is one the line takes away even though find
  // never walked it: the start points name only `/tmp`. Each terminator spelling
  // is read, and the arguments are read by the rules of the command they belong
  // to -- an `mv` destination inside an `-exec` is no more a removal than one on
  // a stage of its own, and a command that deletes nothing takes its paths with
  // it.
  it("reads the paths a `find -exec` hands its deleting command", () => {
    expectBlocked([
      `find /tmp -maxdepth 0 -exec rm -rf ${SIBLING} +`,
      `find /tmp -maxdepth 0 -exec rm -rf ${SIBLING} \\;`,
      `find /tmp -maxdepth 0 -exec rm -rf ${SIBLING} ';'`,
      `find /tmp -maxdepth 0 -execdir rm -rf ${SIBLING} +`,
      `find /tmp -maxdepth 0 -ok rm -rf ${SIBLING} \\;`,
      `find /tmp -maxdepth 0 -okdir rm -rf ${SIBLING} \\;`,
      `find /tmp -maxdepth 0 -exec \\rm -rf ${SIBLING} +`,
      `find ${OWN}/dist -name '*.map' -exec rm {} + -exec rm -rf ${SIBLING} +`,
      `find /tmp -maxdepth 0 -exec mv ${SIBLING}/a.ts /tmp/parked \\;`,
    ]);
    expectAllowed([
      `find /tmp -maxdepth 0 -exec ls ${SIBLING} +`,
      `find /tmp -maxdepth 0 -exec cp {} ${SIBLING}/backup \\;`,
      `find /tmp -maxdepth 0 -exec mv {} ${SIBLING}/parked \\;`,
      `find ${OWN}/dist -name '*.map' -exec rm {} +`,
    ]);
  });

  // The procedure the refusal names is a claim about real git, so every step of
  // it is driven rather than asserted: an untracked leftover holds the plain
  // retirement back, the scoped stash takes it off disk without any deletion this
  // hook refuses, the tree then retires with an ignored leftover still sitting in
  // it, and the stashed content is still there once the tree is gone. A failure
  // means git's behavior moved and the header's stated procedure has to move too.
  it("clears and retires a tree nobody owns by the procedure its refusal names", () => {
    const { dir, own } = makeRepoWithWorktree();
    const options = {
      cwd: dir,
      projectDir: dir,
      agentId: SPAWNED_WITHOUT_A_TREE,
    };
    const leftover = join(own, "probe.txt");
    writeFileSync(leftover, "left behind\n");
    // An exclude in the common directory reaches every worktree of the repo,
    // which a .gitignore committed after the tree was cut would not.
    writeFileSync(join(dir, ".git", "info", "exclude"), "build.log\n");
    writeFileSync(join(own, "build.log"), "ignored output\n");

    expectBlocked(
      [
        `rm ${leftover}`,
        `git -C ${own} clean -fd`,
        `git worktree remove --force ${own}`,
      ],
      options,
    );

    const held = spawnSync("git", ["worktree", "remove", own], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(held.status).not.toBe(0);
    expect(held.stderr).toContain("untracked files");

    const stash = `git -C ${own} stash push -u -- probe.txt`;
    expectAllowed([stash], options);
    execFileSync("bash", ["-c", stash], { cwd: dir });
    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(join(own, "build.log"))).toBe(true);

    execFileSync("git", ["worktree", "remove", own], { cwd: dir });
    expect(existsSync(own)).toBe(false);
    expect(
      execFileSync("git", ["show", "stash@{0}^3:probe.txt"], {
        cwd: dir,
        encoding: "utf8",
      }),
    ).toContain("left behind");
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
  // this hook's, so it is determined by running git against a real linked worktree
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

  // What holds a nested worktree back from a holder's single-force clean is git
  // skipping a REPOSITORY, not a path, and an orphaned tree has stopped being
  // one -- so the spelling that leaves a healthy tree alone takes an orphaned
  // tree and the uncommitted work in it. That is git's behavior rather than this
  // hook's reading of it, so every row is put to a real repo whose sibling tree
  // holds work that exists nowhere else, in the state named: the hook must refuse
  // exactly the rows that destroy it, and leave a holder clean over healthy trees
  // alone. A failure means git's behavior moved and the hook's reading of it has
  // to move too.
  it("blocks exactly the holder cleans real git takes an orphaned tree with", () => {
    for (const { state, spelling } of [
      { state: "healthy", spelling: "git clean -df" },
      { state: "healthy", spelling: "git clean -dfx" },
      { state: "adminDirRemoved", spelling: "git clean -df" },
      { state: "adminDirRemoved", spelling: "git clean -dfx" },
      { state: "adminDirRemoved", spelling: "git clean --force -d" },
      { state: "danglingGitlink", spelling: "git clean -df" },
      // No -d leaves every untracked directory standing, a dry run reports
      // rather than deletes, and an unforced clean is one git refuses outright:
      // real git spares the orphan through all three, so the hook must too.
      { state: "adminDirRemoved", spelling: "git clean -f" },
      { state: "adminDirRemoved", spelling: "git clean -fx" },
      { state: "adminDirRemoved", spelling: "git clean -dfn" },
      { state: "adminDirRemoved", spelling: "git clean -d" },
    ]) {
      const { dir, tree, precious } = makeRepoWithWorktree();
      orphan(state, dir, tree);
      const label = `${state}: ${spelling}`;
      const blocked =
        verdict(spelling, { cwd: dir, projectDir: dir }).status === 2;
      spawnSync("bash", ["-c", spelling], { cwd: dir });
      expect(existsSync(precious), label).toBe(!blocked);
    }
  });

  it("names the orphaned tree it refused", () => {
    const { dir, tree } = makeRepoWithWorktree();
    orphan("adminDirRemoved", dir, tree);
    const { status, stderr } = verdict("git clean -df", {
      cwd: dir,
      projectDir: dir,
    });
    expect(status).toBe(2);
    expect(stderr).toContain(tree);
    expect(stderr).toContain("no longer resolves as a repository");
  });

  // A `clean.requireForce` turned off in a config file lifts git's own refusal
  // exactly as the `-c` spelling does, and a command-line `-c` wins over the file.
  // Which value git ends up with is git's own resolution, asked of it rather than
  // reimplemented here, so each row is put to a real repo whose sibling tree holds
  // uncommitted work: the hook must refuse exactly the rows that destroy it. The
  // one row whose live-git outcome moves across the git 2.44/2.45 force-counting
  // boundary is held to the one-sided property instead -- never destroyed under a
  // command the hook allowed, and blocked whichever side of that boundary runs.
  it("blocks exactly the cleans a persisted clean.requireForce turns destructive", () => {
    for (const {
      spelling,
      from,
      persisted,
      versionDependentForceCount = false,
    } of [
      // Off in the repo's own config file: on git <= 2.44 the holder's single -f
      // then reaches the doubled force that takes a healthy nested tree, while
      // git >= 2.45 no longer feeds that counter from the config (the boundary
      // the hook's header records) and skips the tree. Reaching into an unowned
      // tree needs no flag at all, on either side of it.
      {
        spelling: "git clean -df",
        from: "dir",
        persisted: "false",
        versionDependentForceCount: true,
      },
      { spelling: "git -C SIBLING clean -d", from: "own", persisted: "false" },
      { spelling: "git -C SIBLING clean", from: "own", persisted: "false" },
      // A `-c` on the command line determines the value either way round.
      {
        spelling: "git -C SIBLING -c clean.requireForce=true clean -d",
        from: "own",
        persisted: "false",
      },
      {
        spelling: "git -C SIBLING -c clean.requireForce=false clean -d",
        from: "own",
        persisted: "true",
      },
      // Left on in the file, git refuses the unforced clean and skips the
      // healthy nested trees, so neither row is a deletion to refuse.
      { spelling: "git -C SIBLING clean -d", from: "own", persisted: "true" },
      { spelling: "git clean -df", from: "dir", persisted: "true" },
    ]) {
      const { dir, git, tree, own, precious } = makeRepoWithWorktree();
      git("config", "clean.requireForce", persisted);
      const cwd = from === "dir" ? dir : own;
      const spelt = spelling.replaceAll("SIBLING", tree);
      const label = `${spelling} from ${from}, persisted ${persisted}`;
      const blocked = verdict(spelt, { cwd, projectDir: dir }).status === 2;
      spawnSync("bash", ["-c", spelt], { cwd });
      // The fail-closed property, which holds whatever git runs it: work
      // destroyed by a command the hook allowed is the one outcome no version
      // may produce.
      expect(blocked || existsSync(precious), label).toBe(true);
      if (versionDependentForceCount) {
        // The hook models no git version, so its verdict is the same on both
        // sides of the boundary while live git's effect is not: that verdict is
        // what this row can assert.
        expect(blocked, label).toBe(true);
      } else {
        expect(existsSync(precious), label).toBe(!blocked);
      }
    }
  });

  // An inline `GIT_CONFIG_GLOBAL=` or `HOME=` moves which files git resolves
  // clean.requireForce from for the command alone, and the hook's probe runs
  // under the same assignments, so both read the key from the same file. Which
  // value git ends up with is git's own resolution, asked of it rather than
  // reimplemented here, so each row is put to a real repo whose sibling tree
  // holds uncommitted work: the hook must refuse exactly the rows that destroy
  // it. A failure means git's behavior moved and the hook's reading of it has to
  // move too.
  it("blocks exactly the cleans an inline config environment turns destructive", () => {
    for (const { spelling, requireForce } of [
      {
        spelling: "GIT_CONFIG_GLOBAL=CONFIG_FILE git -C SIBLING clean -d",
        requireForce: "false",
      },
      {
        spelling: "HOME=HOME_DIR git -C SIBLING clean -d",
        requireForce: "false",
      },
      {
        spelling:
          "export GIT_CONFIG_GLOBAL=CONFIG_FILE; git -C SIBLING clean -d",
        requireForce: "false",
      },
      // A file that leaves requireForce on leaves git's refusal in place, and a
      // command-line `-c` wins over whichever file the assignment points at.
      {
        spelling: "GIT_CONFIG_GLOBAL=CONFIG_FILE git -C SIBLING clean -d",
        requireForce: "true",
      },
      {
        spelling: "HOME=HOME_DIR git -C SIBLING clean -d",
        requireForce: "true",
      },
      {
        spelling:
          "GIT_CONFIG_GLOBAL=CONFIG_FILE git -C SIBLING -c clean.requireForce=true clean -d",
        requireForce: "false",
      },
    ]) {
      const { dir, tree, own, precious } = makeRepoWithWorktree();
      const home = makeGitConfigHome(requireForce);
      const command = spelling
        .replaceAll("HOME_DIR", home)
        .replaceAll("CONFIG_FILE", join(home, ".gitconfig"))
        .replaceAll("SIBLING", tree);
      const label = `${spelling}, requireForce ${requireForce}`;
      const blocked =
        verdict(command, { cwd: own, projectDir: dir }).status === 2;
      spawnSync("bash", ["-c", command], { cwd: own });
      expect(existsSync(precious), label).toBe(!blocked);
    }
  });

  // The config probe reads the environment assignments a command contains, and a
  // spawn resolves its program from the child's PATH, so a collected PATH would
  // have this hook execute a git the inspected command line named. A logging shim
  // that answers every question with git's force-disabling value turns "the probe
  // is answered by the git this hook runs" into a check: a hook that reached the
  // shim would block on its answer and leave the shim's log behind it.
  it("answers the config probe with its own git, not one a PATH assignment names", () => {
    const shim = mkdtempSync(join(tmpdir(), "block-worktree-deletions-path-"));
    fixtures.push(shim);
    const log = join(shim, "calls.log");
    writeFileSync(
      join(shim, "git"),
      `#!/bin/sh\necho "$@" >> "${log}"\necho false\n`,
      { mode: 0o755 },
    );
    const { dir, tree, own } = makeRepoWithWorktree();
    const { status } = verdict(`PATH=${shim} git -C ${tree} clean -d`, {
      cwd: own,
      projectDir: dir,
    });
    expect(status).toBe(0);
    expect(existsSync(log)).toBe(false);
  });

  // One holder `git clean` spelling is version-dependent, so it cannot join the
  // live-git differential above: `clean.requireForce=false` plus a single real -f
  // reaches git's nested-repo removal threshold on git <= 2.44 (where a disabled
  // requireForce feeds the same force counter a real -f does) and is skipped on
  // git >= 2.45 (which stopped feeding it). That boundary was determined by driving
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
    // the root it would delete rather than fall through on a doubled slash.
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
  // it. A failure means the hook catches one of these and the header is stale.
  it("allows the shapes its header states it does not read", () => {
    expectAllowed([
      `(cd ${ROOT} && rm -rf agent-other)`,
      `{ cd ${ROOT}; rm -rf agent-other; }`,
      `bash -c "rm -rf ${SIBLING}"`,
      `timeout 5 rm -rf ${SIBLING}`,
      `TREE=${SIBLING}; rm -rf "$TREE"`,
    ]);
  });

  it("keeps a `&` inside a redirect joined to the deletion it belongs to", () => {
    // Whichever side of the operands the redirect stands on: a split at the `&`
    // would sever the command word from the target that follows the redirect.
    expectBlocked([
      `ls && rm -rf ${SIBLING}`,
      `rm -rf ${SIBLING} 2>&1`,
      `rm -rf ${SIBLING} &> /dev/null`,
      `rm -rf 2>&1 -- ${SIBLING}`,
      `find ${SIBLING} 2>&1 -delete`,
    ]);
    // Backgrounded composition is a stated limit: the deletion behind a lone
    // `&` is not seen, pinned here so the header cannot go stale.
    expectAllowed([
      `ls & rm -rf ${SIBLING}`,
      `cd ${ROOT} & rm -rf agent-other`,
      `ls && rm -rf dist`,
    ]);
  });

  // The header claims the real-git probes run only while their answer can still
  // change the verdict; with no guarded root under the cleaned directory the
  // verdict is null at any force, so no probe may spawn. A logging git on PATH
  // turns that claim into a check.
  it("spawns no git while no guarded root sits under the cleaned directory", () => {
    const shim = mkdtempSync(join(tmpdir(), "block-worktree-deletions-shim-"));
    fixtures.push(shim);
    const log = join(shim, "calls.log");
    writeFileSync(join(shim, "git"), `#!/bin/sh\necho "$@" >> "${log}"\n`, {
      mode: 0o755,
    });
    const plain = mkdtempSync(
      join(tmpdir(), "block-worktree-deletions-plain-"),
    );
    fixtures.push(plain);
    const { status } = spawnSync("node", [HOOK], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "git clean -fd" },
        cwd: plain,
        agent_id: AGENT_ID,
      }),
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: PROJECT,
        PATH: `${shim}:${process.env.PATH}`,
      },
    });
    expect(status).toBe(0);
    expect(existsSync(log)).toBe(false);
  });

  it("reads past the prefix words it peels, and stops at the ones it does not", () => {
    expectBlocked([
      `nohup rm -rf ${SIBLING}`,
      `setsid rm -rf ${SIBLING}`,
      `doas rm -rf ${SIBLING}`,
      `doas -u vdorie rm -rf ${SIBLING}`,
      `stdbuf -oL rm -rf ${SIBLING}`,
      `stdbuf -o 0 rm -rf ${SIBLING}`,
      `nohup setsid rm -rf ${SIBLING}`,
    ]);
    expectAllowed([`nohup ls ${SIBLING}`, `timeout 5 rm -rf ${SIBLING}`]);
  });

  it("reads the backslashed spellings the shell strips to the same program", () => {
    expectBlocked([
      `\\rm -rf ${SIBLING}`,
      `r\\m -rf ${SIBLING}`,
      `\\mv ${SIBLING} /tmp/parked`,
      `sudo \\rm -rf ${SIBLING}`,
      `find ${SIBLING} -print0 | xargs -0 \\rm -rf`,
      `find ${SIBLING} -name '*.ts' -exec \\rm {} +`,
    ]);
  });

  it("allows a malformed or absent payload rather than stalling Bash", () => {
    const { status } = spawnSync("node", [HOOK], {
      input: "not json",
      encoding: "utf8",
    });
    expect(status).toBe(0);
    expect(runHook({ tool_name: "Bash", tool_input: {} }).status).toBe(0);
  });
});
