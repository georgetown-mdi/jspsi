import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HOOK = fileURLToPath(
  new URL("./block-protected-push.mjs", import.meta.url),
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

// A push command inspected from a directory with no git repo, so only the
// refspec parsing decides the verdict (the bare-push paths get their own repos).
function verdict(command) {
  return runHook({ tool_name: "Bash", tool_input: { command }, cwd: tmpdir() });
}

// A throwaway repo on `branch`, optionally with an upstream resolving @{push} to
// `origin/<pushTarget>` -- built with plumbing so nothing contacts a network. It
// lands at `at` when the caller needs a known path, and in a fresh temporary
// directory otherwise.
function makeRepo({ branch, pushTarget, at }) {
  const dir = at ?? mkdtempSync(join(tmpdir(), "protected-push-"));
  mkdirSync(dir, { recursive: true });
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", branch);
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "file.txt"), "base\n");
  git("add", "file.txt");
  git("commit", "-q", "-m", "Base commit");
  if (pushTarget) {
    // push.default=upstream so @{push} resolves even when the upstream branch
    // name differs from the local one (the default `simple` leaves it undefined).
    git("config", "push.default", "upstream");
    git("remote", "add", "origin", join(dir, "..", "unused-remote"));
    git(
      "update-ref",
      `refs/remotes/origin/${pushTarget}`,
      git("rev-parse", "HEAD").trim(),
    );
    git("config", `branch.${branch}.remote`, "origin");
    git("config", `branch.${branch}.merge`, `refs/heads/${pushTarget}`);
  }
  return dir;
}

describe("block-protected-push hook", () => {
  const dirs = [];
  afterEach(() => {
    while (dirs.length > 0)
      rmSync(dirs.pop(), { recursive: true, force: true });
  });

  it("ignores tools other than Bash", () => {
    const { status } = runHook({
      tool_name: "Agent",
      tool_input: { prompt: "git push origin staging" },
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

  it("allows a command that pushes nothing", () => {
    expect(verdict("git status").status).toBe(0);
    expect(verdict("git commit -m 'push the fix'").status).toBe(0);
  });

  it("allows a feature-branch push", () => {
    expect(verdict("git push -u origin some-feature").status).toBe(0);
    expect(verdict("git push origin HEAD:refs/heads/feature").status).toBe(0);
  });

  it("blocks an explicit push to a protected branch", () => {
    for (const command of [
      "git push origin staging",
      "git push origin main",
      "git push origin HEAD:main",
      "git push origin +feature:refs/heads/staging",
      "git push origin :staging",
    ]) {
      const { status, stderr } = verdict(command);
      expect(status, command).toBe(2);
      expect(stderr).toContain("block-protected-push");
    }
  });

  it("strips every quote before reading the destination", () => {
    expect(verdict("git push origin HEAD:'staging'").status).toBe(2);
    expect(verdict('git push "origin" "HEAD:staging"').status).toBe(2);
  });

  it("inspects a push hidden in a compound command", () => {
    expect(verdict("npm test && git push origin main").status).toBe(2);
    expect(verdict("echo hi; git push origin staging").status).toBe(2);
  });

  it("does not mistake a mention of git push for an invocation", () => {
    expect(verdict("echo git push origin main").status).toBe(0);
    expect(verdict("grep -r 'git push origin staging' docs").status).toBe(0);
  });

  it("reads past git global options that consume a value", () => {
    const { status } = verdict(
      "git -C /repo -c user.name=x push origin staging",
    );
    expect(status).toBe(2);
  });

  it("refuses --all and --mirror outright", () => {
    for (const command of [
      "git push --all origin",
      "git push --mirror origin",
    ]) {
      const { status, stderr } = verdict(command);
      expect(status, command).toBe(2);
      expect(stderr).toContain("every ref");
    }
  });

  it("does not read a push-option value as a refspec", () => {
    expect(verdict("git push -o staging origin feature").status).toBe(0);
    expect(verdict("git push --push-option main origin feature").status).toBe(
      0,
    );
  });

  it("blocks a bare push made from a protected branch", () => {
    const dir = makeRepo({ branch: "staging" });
    dirs.push(dir);
    const { status, stderr } = runHook({
      tool_name: "Bash",
      tool_input: { command: "git push" },
      cwd: dir,
    });
    expect(status).toBe(2);
    expect(stderr).toContain("protected branch 'staging'");
  });

  it("blocks a bare push whose upstream resolves to a protected branch", () => {
    const dir = makeRepo({ branch: "feature", pushTarget: "main" });
    dirs.push(dir);
    const { status, stderr } = runHook({
      tool_name: "Bash",
      tool_input: { command: "git push" },
      cwd: dir,
    });
    expect(status).toBe(2);
    expect(stderr).toContain("@{push}");
  });

  it("allows a bare push whose upstream resolves to a feature branch", () => {
    const dir = makeRepo({ branch: "feature", pushTarget: "feature" });
    dirs.push(dir);
    const { status } = runHook({
      tool_name: "Bash",
      tool_input: { command: "git push origin" },
      cwd: dir,
    });
    expect(status).toBe(0);
  });

  it("blocks a bare push with no resolvable upstream", () => {
    const dir = makeRepo({ branch: "feature" });
    dirs.push(dir);
    const { status, stderr } = runHook({
      tool_name: "Bash",
      tool_input: { command: "git push" },
      cwd: dir,
    });
    expect(status).toBe(2);
    expect(stderr).toContain("no resolvable upstream");
  });

  it("allows a bare push whose redirected tree is on a feature branch", () => {
    const standing = makeRepo({ branch: "staging" });
    const target = makeRepo({ branch: "feature", pushTarget: "feature" });
    dirs.push(standing, target);
    for (const command of [
      `git -C ${target} push`,
      `cd ${target} && git push`,
    ]) {
      const { status, stderr } = runHook({
        tool_name: "Bash",
        tool_input: { command },
        cwd: standing,
      });
      expect(status, `${command}: ${stderr}`).toBe(0);
    }
  });

  it("blocks a bare push whose redirected tree is on a protected branch", () => {
    const standing = makeRepo({ branch: "feature", pushTarget: "feature" });
    const target = makeRepo({ branch: "staging" });
    dirs.push(standing, target);
    for (const command of [
      `git -C ${target} push`,
      `cd ${target} && git push`,
    ]) {
      const { status, stderr } = runHook({
        tool_name: "Bash",
        tool_input: { command },
        cwd: standing,
      });
      expect(status, command).toBe(2);
      expect(stderr).toContain("protected branch 'staging'");
    }
  });

  // zsh's `cd <old> <new>` substitutes into the pathname of the directory the
  // call stands in, reaching a sibling tree without naming it.
  it("reads the substituting form of a leading cd", () => {
    const parent = mkdtempSync(join(tmpdir(), "protected-push-"));
    dirs.push(parent);
    const standing = join(parent, "staging-tree");
    makeRepo({ branch: "staging", at: standing });
    makeRepo({
      branch: "feature",
      pushTarget: "feature",
      at: join(parent, "feature-tree"),
    });
    const { status, stderr } = runHook({
      tool_name: "Bash",
      tool_input: { command: "cd staging feature && git push" },
      cwd: standing,
    });
    expect(status, stderr).toBe(0);
  });

  // Real git applies each `-C` from where the one before it landed, and an empty
  // one stays put. Both are measured here rather than modelled, along with git
  // refusing the attached `-C=<path>` spelling the hook skips -- a push written
  // that way never reaches a branch at all.
  it("chains -C redirects the way git does", () => {
    const standing = makeRepo({ branch: "staging" });
    const target = makeRepo({ branch: "feature", pushTarget: "feature" });
    dirs.push(standing, target);
    const branchOf = (args) =>
      execFileSync("git", [...args, "branch", "--show-current"], {
        cwd: standing,
        encoding: "utf8",
      }).trim();

    const chained = ["-C", dirname(target), "-C", basename(target)];
    expect(branchOf(chained)).toBe("feature");
    expect(branchOf(["-C", ""])).toBe("staging");

    const push = (args) =>
      runHook({
        tool_name: "Bash",
        tool_input: { command: `git ${args.join(" ")} push` },
        cwd: standing,
      });
    expect(push(chained).status).toBe(0);
    expect(push(["-C", "''"]).status).toBe(2);

    const attached = spawnSync(
      "git",
      [`-C=${target}`, "branch", "--show-current"],
      { cwd: standing, encoding: "utf8" },
    );
    expect(attached.status).not.toBe(0);
  });

  it("keeps the bare-push refusal when the redirected tree is unreadable", () => {
    const standing = makeRepo({ branch: "feature", pushTarget: "feature" });
    dirs.push(standing);
    const { status, stderr } = runHook({
      tool_name: "Bash",
      tool_input: { command: `git -C ${join(standing, "gone")} push` },
      cwd: standing,
    });
    expect(status).toBe(2);
    expect(stderr).toContain("no resolvable upstream");
  });
});
