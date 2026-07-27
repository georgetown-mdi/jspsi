import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HOOK = fileURLToPath(
  new URL("./block-git-identity-override.mjs", import.meta.url),
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

function verdict(command) {
  return runHook({ tool_name: "Bash", tool_input: { command } });
}

function expectBlocked(commands) {
  for (const command of commands) {
    const { status, stderr } = verdict(command);
    expect(status, command).toBe(2);
    expect(stderr, command).toContain("block-git-identity-override");
    expect(stderr, command).toContain(".git/config");
  }
}

function expectAllowed(commands) {
  for (const command of commands) {
    expect(verdict(command).status, command).toBe(0);
  }
}

describe("block-git-identity-override hook", () => {
  it("ignores tools other than Bash", () => {
    const { status } = runHook({
      tool_name: "Agent",
      tool_input: { prompt: "git -c user.email=a@b.c commit -m x" },
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

  it("ignores an event whose command is missing or not a string", () => {
    expect(runHook({ tool_name: "Bash", tool_input: {} }).status).toBe(0);
    expect(
      runHook({ tool_name: "Bash", tool_input: { command: 42 } }).status,
    ).toBe(0);
  });

  it("blocks a -c identity override", () => {
    expectBlocked([
      "git -c user.email=agent@example.com commit -m 'Fix it'",
      "git -c user.name=Agent commit -m 'Fix it'",
      "git -C /repo -c user.name=Agent -c user.email=a@b.c commit -m x",
      "git -c USER.EMAIL=agent@example.com commit -m x",
    ]);
  });

  it("blocks a --config-env identity override in either spelling", () => {
    expectBlocked([
      "git --config-env=user.email=ADDRESS commit -m x",
      "git --config-env user.name=WHO commit -m x",
    ]);
  });

  it("blocks quoted identity values", () => {
    expectBlocked([
      "git -c user.name=\"Vincent Dorie\" -c user.email='v@example.edu' commit -m x",
      "git commit -m x --author='Vincent Dorie <v@example.edu>'",
    ]);
  });

  it("blocks git commit --author in both argument forms", () => {
    expectBlocked([
      "git commit --author=Agent -m x",
      "git commit --author Agent -m x",
    ]);
  });

  it("blocks an identity environment assignment", () => {
    expectBlocked([
      "GIT_AUTHOR_NAME=Agent git commit -m x",
      "GIT_AUTHOR_EMAIL=agent@example.com git commit -m x",
      "GIT_COMMITTER_NAME=Agent git commit -m x",
      "GIT_COMMITTER_EMAIL=agent@example.com git commit -m x",
      "env GIT_AUTHOR_EMAIL=agent@example.com git commit -m x",
      "export GIT_COMMITTER_EMAIL=agent@example.com",
    ]);
  });

  it("blocks a git config identity write at every scope", () => {
    expectBlocked([
      "git config user.email agent@example.com",
      "git config --local user.name Agent",
      "git config --global user.email agent@example.com",
      "git config --system user.name Agent",
      "git config --file /tmp/other user.email agent@example.com",
      "git config --add user.email agent@example.com",
      "git config --replace-all user.name Agent",
      "git config --rename-section user agent",
      "git config set user.email agent@example.com",
    ]);
  });

  it("blocks an override hidden in a compound command", () => {
    expectBlocked([
      "npm test && git -c user.email=agent@example.com commit -m x",
      "echo hi; GIT_AUTHOR_EMAIL=agent@example.com git commit -m x",
      "git add -A && git config user.name Agent",
    ]);
  });

  it("allows reading the configured identity", () => {
    expectAllowed([
      "git config --get user.email",
      "git config --get-all user.email",
      "git config --get-regexp '^user\\.'",
      "git config user.email",
      "git config --list",
      "git config --show-origin --get user.email",
      "git config --global --get user.name",
      "git config get user.email",
    ]);
  });

  it("allows clearing the configured identity", () => {
    expectAllowed([
      "git config --unset user.email",
      "git config --unset user.email agent@example.com",
      "git config --unset-all user.name",
      "git config --global --unset user.email",
      "git config --remove-section user",
      "git config unset user.email",
      "git config remove-section user",
    ]);
  });

  it("allows an amend that adopts the configured identity", () => {
    expectAllowed([
      "git commit --amend --reset-author --no-edit",
      "git commit --amend --no-edit",
      "git commit -m 'Add the author column'",
    ]);
  });

  it("allows a -c that is not an identity key", () => {
    expectAllowed([
      "git -c core.pager=cat log -1",
      "git -c protocol.version=2 fetch origin",
      "git -c user.signingkey=ABC123 log -1",
    ]);
  });

  it("allows --author where it filters rather than records", () => {
    expectAllowed([
      "git log --author=vdorie",
      "git shortlog -sn --author='Vincent Dorie'",
    ]);
  });

  it("allows an unrelated config write", () => {
    expectAllowed([
      "git config core.editor vim",
      "git config --global push.default simple",
    ]);
  });

  it("does not mistake a mention of an override for an invocation", () => {
    expectAllowed([
      "echo git -c user.email=agent@example.com commit",
      "grep -rn 'git config user.email' docs",
    ]);
  });

  it("allows commands unrelated to git", () => {
    expectAllowed(["npm run lint", "ls -la", "node scripts/check-pr.mjs"]);
  });
});
