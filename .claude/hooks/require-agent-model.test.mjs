import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HOOK = fileURLToPath(
  new URL("./require-agent-model.mjs", import.meta.url),
);

// Run the hook as a real subprocess with a synthesized PreToolUse payload on
// stdin. Exit 0 allows the spawn, exit 2 blocks it and feeds stderr back to
// Claude. CLAUDE_PROJECT_DIR is always pinned at a fixture so the bare-spawn
// path reads a controlled agents dir, never this repo's real definitions.
function runHook(payload, projectDir) {
  const { status, stderr } = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir ?? tmpdir() },
  });
  return { status, stderr };
}

// Build a throwaway CLAUDE_PROJECT_DIR whose .claude/agents holds one <name>.md
// per entry, each with the given `model:` value in frontmatter (null writes a
// definition with no model line at all).
function makeProject(agents) {
  const dir = mkdtempSync(join(tmpdir(), "agent-model-"));
  const agentsDir = join(dir, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const [name, model] of Object.entries(agents)) {
    const modelLine = model === null ? "" : `model: ${model}\n`;
    writeFileSync(
      join(agentsDir, `${name}.md`),
      `---\nname: ${name}\n${modelLine}---\nbody\n`,
    );
  }
  return dir;
}

describe("require-agent-model hook", () => {
  const dirs = [];
  afterEach(() => {
    while (dirs.length > 0)
      rmSync(dirs.pop(), { recursive: true, force: true });
  });

  it("ignores tools other than Agent", () => {
    const { status } = runHook({
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
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

  it("allows every known tier passed explicitly", () => {
    for (const model of ["opus", "sonnet", "haiku", "fable"]) {
      const { status } = runHook({
        tool_name: "Agent",
        tool_input: { model, prompt: "x" },
      });
      expect(status, model).toBe(0);
    }
  });

  it("blocks an unknown model tier", () => {
    const { status, stderr } = runHook({
      tool_name: "Agent",
      tool_input: { model: "opuss", prompt: "x" },
    });
    expect(status).toBe(2);
    expect(stderr).toContain("unknown model tier 'opuss'");
  });

  it("allows a bare spawn of a definition that pins a model", () => {
    const dir = makeProject({ worker: "opus", deep: "fable" });
    dirs.push(dir);
    const { status } = runHook(
      {
        tool_name: "Agent",
        tool_input: { subagent_type: "worker", prompt: "x" },
      },
      dir,
    );
    expect(status).toBe(0);
  });

  it("blocks a bare spawn whose definition pins no model", () => {
    const dir = makeProject({ worker: "opus", drifter: null });
    dirs.push(dir);
    const { status, stderr } = runHook(
      {
        tool_name: "Agent",
        tool_input: { subagent_type: "drifter", prompt: "x" },
      },
      dir,
    );
    expect(status).toBe(2);
    expect(stderr).toContain("spawn of 'drifter'");
    expect(stderr).toContain("{worker}");
  });

  it("does not treat a mistyped tier in frontmatter as a pin", () => {
    const dir = makeProject({ typo: "opuss" });
    dirs.push(dir);
    const { status } = runHook(
      {
        tool_name: "Agent",
        tool_input: { subagent_type: "typo", prompt: "x" },
      },
      dir,
    );
    expect(status).toBe(2);
  });

  // The platform discards a fork's `model` and runs it on the parent's, so the
  // requirement has nothing to bite on there: the spawn the hook must let through
  // is the bare one, and the spawn it must still stop is every other bare spawn.
  it("exempts a fork, whose model the platform discards", () => {
    const dir = makeProject({ worker: "opus" });
    dirs.push(dir);
    for (const tool_input of [
      { subagent_type: "fork", prompt: "x" },
      { subagent_type: "fork", model: "", prompt: "x" },
      { subagent_type: "fork", model: "sonnet", prompt: "x" },
    ]) {
      const { status } = runHook({ tool_name: "Agent", tool_input }, dir);
      expect(status, JSON.stringify(tool_input)).toBe(0);
    }
    const { status, stderr } = runHook(
      {
        tool_name: "Agent",
        tool_input: { subagent_type: "general-purpose", prompt: "x" },
      },
      dir,
    );
    expect(status).toBe(2);
    expect(stderr).toContain("spawn of 'general-purpose'");
  });

  it("treats the exemption as an exact subagent_type, not a substring", () => {
    const dir = makeProject({ worker: "opus" });
    dirs.push(dir);
    for (const subagent_type of ["forked-reviewer", "Fork", "fork "]) {
      const { status } = runHook(
        { tool_name: "Agent", tool_input: { subagent_type, prompt: "x" } },
        dir,
      );
      expect(status, subagent_type).toBe(2);
    }
  });

  it("blocks a bare spawn that names no subagent_type", () => {
    const dir = makeProject({ worker: "opus" });
    dirs.push(dir);
    const { status, stderr } = runHook(
      { tool_name: "Agent", tool_input: { prompt: "x" } },
      dir,
    );
    expect(status).toBe(2);
    expect(stderr).toContain("spawn of '(none)'");
  });

  it("blocks an empty-string model rather than reading it as explicit", () => {
    const dir = makeProject({ worker: "opus" });
    dirs.push(dir);
    const { status } = runHook(
      { tool_name: "Agent", tool_input: { model: "", prompt: "x" } },
      dir,
    );
    expect(status).toBe(2);
  });

  it("fails closed when the agent definitions cannot be read", () => {
    // The bare-spawn path has no downstream safety check, so an unreadable
    // allowlist blocks rather than allows.
    const empty = mkdtempSync(join(tmpdir(), "agent-model-noagents-"));
    dirs.push(empty);
    const { status, stderr } = runHook(
      {
        tool_name: "Agent",
        tool_input: { subagent_type: "worker", prompt: "x" },
      },
      empty,
    );
    expect(status).toBe(2);
    expect(stderr).toContain("could not read agent definitions");
  });
});
