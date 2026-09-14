import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HOOK = fileURLToPath(
  new URL("./block-tmp-symlink-worktree-writes.mjs", import.meta.url),
);

// Run the hook as a real subprocess with a synthesized PreToolUse payload on
// stdin, the way Claude Code invokes it. Exit 0 allows the Bash call, exit 2
// blocks it and feeds stderr back to Claude, so both are expected outcomes here
// and neither may throw.
function runHook(payload) {
  const { status, stderr } = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { status, stderr };
}

const verdict = (command, cwd) =>
  runHook({ tool_name: "Bash", tool_input: { command }, cwd });

// A throwaway repository with a linked worktree under .claude/worktrees/, and a
// scratch directory under the real /tmp holding the links a command reaches it
// through. The scratch directory stands for the fixed /tmp name of the incident;
// it is made with mkdtemp here so parallel runs of this file do not collide on
// one, which is the same reason the convention the hook names exists.
function makeScene() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tmp-symlink-repo-")));
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "primary");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "tracked.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, ".gitignore"), "scratch\n.claude/worktrees/\n");
  mkdirSync(join(repo, "scratch"));
  git("add", "tracked.ts", ".gitignore");
  git("commit", "-q", "-m", "Base commit");

  const tree = join(repo, ".claude", "worktrees", "agent-branch");
  mkdirSync(join(repo, ".claude", "worktrees"), { recursive: true });
  git("worktree", "add", "-q", "-b", "branch", tree);

  const scratch = mkdtempSync(join(tmpdir(), "tmp-symlink-scratch-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "tmp-symlink-elsewhere-"));
  mkdirSync(join(scratch, "real"));
  symlinkSync(repo, join(scratch, "into-repo"));
  symlinkSync(tree, join(scratch, "into-tree"));
  symlinkSync(elsewhere, join(scratch, "into-tmp"));
  symlinkSync(join(elsewhere, "gone"), join(scratch, "dangling"));

  return { repo, tree, scratch, elsewhere };
}

describe("block-tmp-symlink-worktree-writes hook", () => {
  const dirs = [];
  const scene = () => {
    const built = makeScene();
    dirs.push(built.repo, built.scratch, built.elsewhere);
    return built;
  };
  afterEach(() => {
    while (dirs.length > 0)
      rmSync(dirs.pop(), { recursive: true, force: true });
  });

  function expectBlocked(commands, cwd) {
    for (const command of commands) {
      const { status, stderr } = verdict(command, cwd);
      expect(status, command).toBe(2);
      expect(stderr, command).toContain("block-tmp-symlink-worktree-writes");
    }
  }

  function expectAllowed(commands, cwd) {
    for (const command of commands) {
      expect(verdict(command, cwd).status, command).toBe(0);
    }
  }

  it("ignores tools other than Bash", () => {
    const { scratch, repo } = scene();
    const { status } = runHook({
      tool_name: "Write",
      tool_input: { file_path: join(scratch, "into-repo", "tracked.ts") },
      cwd: repo,
    });
    expect(status).toBe(0);
  });

  it("blocks a redirect through a /tmp path that resolves into a worktree", () => {
    const { scratch, repo } = scene();
    const through = join(scratch, "into-repo", "tracked.ts");
    expectBlocked(
      [
        `echo x > ${through}`,
        `echo x >${through}`,
        `echo x >> ${through}`,
        `npm run build 2> ${through}`,
        `echo x >| ${through}`,
        `cat <<'EOF' > ${through}\nx\nEOF`,
      ],
      repo,
    );
  });

  it("blocks a writing command whose operand resolves into a worktree", () => {
    const { scratch, repo } = scene();
    const through = join(scratch, "into-repo", "tracked.ts");
    expectBlocked(
      [
        `cp report.md ${through}`,
        `mv report.md ${through}`,
        `cat report.md | tee ${through}`,
        `touch ${through}`,
        `sed -i s/a/b/ ${through}`,
        `dd if=/dev/zero of=${through}`,
        `install -m 644 report.md ${through}`,
        `mkdir -p ${join(scratch, "into-repo", "fresh", "deeper")}`,
        `env FOO=1 cp report.md ${through}`,
        `mkdir -p /tmp/keep && cp report.md ${through}`,
      ],
      repo,
    );
  });

  it("reads the link ln creates, not the target it is pointed at", () => {
    const { scratch, repo } = scene();
    const through = join(scratch, "into-repo", "tracked.ts");
    const intoRepo = join(scratch, "into-repo");
    const intoRepoDir = join(intoRepo, "scratch");
    expectAllowed(
      [
        `ln -s ${through} ${join(scratch, "real", "link.ts")}`,
        `ln ${through} ${join(scratch, "real", "hard.ts")}`,
        `ln -s ${through}`,
      ],
      repo,
    );
    expectBlocked(
      [
        `ln -s report.md ${join(intoRepo, "link.ts")}`,
        `ln -s ${through} ${join(intoRepo, "link.ts")}`,
        `ln -s report.md ${intoRepoDir}`,
        `ln -st ${intoRepoDir} report.md`,
        `ln -s --target-directory=${intoRepoDir} report.md`,
      ],
      repo,
    );
    expectBlocked([`ln -s ${join(scratch, "real", "notes.md")}`], intoRepo);
  });

  it("blocks a write into the main worktree and into a linked one alike", () => {
    const { scratch, tree, repo } = scene();
    const intoTree = join(scratch, "into-tree", "tracked.ts");
    expectBlocked([`echo x > ${intoTree}`], repo);
    expect(verdict(`echo x > ${intoTree}`, repo).stderr).toContain(tree);
  });

  it("blocks a file the write would create, not only one that exists", () => {
    const { scratch, repo } = scene();
    expectBlocked(
      [
        `echo x > ${join(scratch, "into-repo", "new.ts")}`,
        `echo x > ${join(scratch, "into-repo", "src", "new.ts")}`,
      ],
      repo,
    );
  });

  it("names the mktemp convention and where the path really went", () => {
    const { scratch, repo } = scene();
    const { stderr } = verdict(
      `echo x > ${join(scratch, "into-repo", "tracked.ts")}`,
      repo,
    );
    expect(stderr).toContain("mktemp -d");
    expect(stderr).toContain(join(repo, "tracked.ts"));
  });

  it("allows a write under a directory mktemp -d made", () => {
    const { repo } = scene();
    const made = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
    dirs.push(made);
    expectAllowed(
      [
        `echo x > ${join(made, "notes.md")}`,
        `cp report.md ${join(made, "report.md")}`,
        `mkdir -p ${join(made, "out")} && echo x > ${join(made, "out", "a")}`,
      ],
      repo,
    );
  });

  it("allows ordinary scratch that resolves nowhere near a worktree", () => {
    const { scratch, repo, elsewhere } = scene();
    expectAllowed(
      [
        `echo x > ${join(scratch, "real", "notes.md")}`,
        `echo x > ${join(scratch, "into-tmp", "notes.md")}`,
        `echo x > ${join(scratch, "dangling", "notes.md")}`,
        `echo x > ${join(elsewhere, "notes.md")}`,
        `cp report.md ${join(scratch, "real")}`,
      ],
      repo,
    );
  });

  it("allows a detached worktree that lives under /tmp, where a rebase runs", () => {
    const { repo } = scene();
    const detached = mkdtempSync(join(tmpdir(), "tmp-symlink-rebase-"));
    rmSync(detached, { recursive: true, force: true });
    execFileSync("git", [
      "-C",
      repo,
      "worktree",
      "add",
      "-q",
      "--detach",
      detached,
    ]);
    dirs.push(detached);
    expectAllowed(
      [
        `echo x > ${join(detached, "tracked.ts")}`,
        `cp report.md ${join(detached, "tracked.ts")}`,
      ],
      repo,
    );
  });

  it("allows a repository path the command names outright", () => {
    const { repo, scratch } = scene();
    expectAllowed(
      [
        `cp ${join(scratch, "real", "report.md")} ${join(repo, "report.md")}`,
        `echo x > ${join(repo, "tracked.ts")}`,
      ],
      repo,
    );
  });

  it("allows reading through such a path, and clearing the link itself", () => {
    const { scratch, repo } = scene();
    const link = join(scratch, "into-repo");
    expectAllowed(
      [
        `rm ${link}`,
        `ls -l ${link}`,
        `readlink -f ${link}`,
        `cat ${join(link, "tracked.ts")}`,
        `grep -rn x ${join(link, "tracked.ts")}`,
      ],
      repo,
    );
  });

  it("allows a descriptor duplication and a command that only mentions a path", () => {
    const { scratch, repo } = scene();
    const through = join(scratch, "into-repo", "tracked.ts");
    expectAllowed(
      [
        `npm run build > /dev/null 2>&1`,
        `echo ${through}`,
        `sed s/a/b/ ${through}`,
      ],
      repo,
    );
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
