import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HOOK = fileURLToPath(
  new URL("./require-fable-approval.mjs", import.meta.url),
);

// Run the hook as a real subprocess with a synthesized PreToolUse payload on
// stdin, the way Claude Code invokes it, and return its stdout. The hook always
// exits 0 (fail-safe: it asks via stdout JSON or emits nothing), so a nonzero exit
// here is itself a test failure. `env` overrides are merged onto the real
// environment so CLAUDE_PROJECT_DIR points at a controlled fixture, never the real
// repo's agent definitions.
function runHook(payload, env = {}) {
  return execFileSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

// Build a throwaway CLAUDE_PROJECT_DIR whose .claude/agents holds one <name>.md
// per entry, each pinning the given model in frontmatter.
function makeProject(agents) {
  const dir = mkdtempSync(join(tmpdir(), "fable-approval-"));
  const agentsDir = join(dir, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const [name, model] of Object.entries(agents)) {
    writeFileSync(
      join(agentsDir, `${name}.md`),
      `---\nname: ${name}\nmodel: ${model}\n---\nbody\n`,
    );
  }
  return dir;
}

function assertAsks(out) {
  const parsed = JSON.parse(out);
  expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  expect(parsed.hookSpecificOutput.permissionDecision).toBe("ask");
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toMatch(/Fable/);
}

describe("require-fable-approval hook", () => {
  const dirs = [];
  afterEach(() => {
    while (dirs.length > 0)
      rmSync(dirs.pop(), { recursive: true, force: true });
  });

  it("asks for approval on an explicit Fable model", () => {
    const out = runHook({
      tool_name: "Agent",
      tool_input: { model: "fable", prompt: "x" },
    });
    assertAsks(out);
  });

  it("passes through an explicit non-Fable model", () => {
    for (const model of ["opus", "sonnet", "haiku"]) {
      const out = runHook({
        tool_name: "Agent",
        tool_input: { model, prompt: "x" },
      });
      expect(out).toBe("");
    }
  });

  it("ignores tools other than Agent", () => {
    const out = runHook({
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
    });
    expect(out).toBe("");
  });

  it("asks when a bare spawn's subagent_type pins Fable", () => {
    const dir = makeProject({ deep: "fable", worker: "opus" });
    dirs.push(dir);
    const out = runHook(
      {
        tool_name: "Agent",
        tool_input: { subagent_type: "deep", prompt: "x" },
      },
      { CLAUDE_PROJECT_DIR: dir },
    );
    assertAsks(out);
  });

  it("passes through a bare spawn whose subagent_type pins a non-Fable tier", () => {
    const dir = makeProject({ deep: "fable", worker: "opus" });
    dirs.push(dir);
    const out = runHook(
      {
        tool_name: "Agent",
        tool_input: { subagent_type: "worker", prompt: "x" },
      },
      { CLAUDE_PROJECT_DIR: dir },
    );
    expect(out).toBe("");
  });

  it("fails open (passes through) when the agents dir cannot be read", () => {
    const dir = mkdtempSync(join(tmpdir(), "fable-approval-noagents-"));
    dirs.push(dir);
    const out = runHook(
      {
        tool_name: "Agent",
        tool_input: { subagent_type: "whatever", prompt: "x" },
      },
      { CLAUDE_PROJECT_DIR: dir },
    );
    expect(out).toBe("");
  });
});
