import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HOOK = fileURLToPath(
  new URL("./require-review-contract.mjs", import.meta.url),
);

// Run the hook as a real subprocess with a synthesized PreToolUse payload on
// stdin. Exit 0 allows the spawn, exit 2 blocks it and feeds stderr back to
// Claude.
function runHook(payload) {
  const { status, stderr } = spawnSync("node", [HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
  });
  return { status, stderr };
}

describe("require-review-contract hook", () => {
  it("ignores tools other than Agent", () => {
    const { status } = runHook({
      tool_name: "Workflow",
      tool_input: { script: "export const meta = {}" },
    });
    expect(status).toBe(0);
  });

  it("ignores an unparseable event", () => {
    const { status } = runHook("not json");
    expect(status).toBe(0);
  });

  it("allows an Agent spawn with no subagent_type", () => {
    const { status } = runHook({
      tool_name: "Agent",
      tool_input: { prompt: "explore the repo", model: "sonnet" },
    });
    expect(status).toBe(0);
  });

  it("allows uncontracted subagent types", () => {
    for (const type of ["general-purpose", "implementer", "project-manager"]) {
      const { status } = runHook({
        tool_name: "Agent",
        tool_input: { subagent_type: type, prompt: "task", model: "opus" },
      });
      expect(status).toBe(0);
    }
  });

  it("blocks a direct security-reviewer spawn", () => {
    const { status, stderr } = runHook({
      tool_name: "Agent",
      tool_input: {
        subagent_type: "security-reviewer",
        prompt: "review this diff",
        model: "opus",
      },
    });
    expect(status).toBe(2);
    expect(stderr).toContain("security-reviewer");
    expect(stderr).toContain("/light-review --role");
  });

  it("blocks a direct adversarial-verifier spawn even when the prompt includes claims", () => {
    const { status, stderr } = runHook({
      tool_name: "Agent",
      tool_input: {
        subagent_type: "adversarial-verifier",
        prompt: "Refute these claims:\n- claim one\n- claim two",
        model: "opus",
      },
    });
    expect(status).toBe(2);
    expect(stderr).toContain("adversarial-verifier");
  });

  it("allows a non-string subagent_type without crashing", () => {
    const { status } = runHook({
      tool_name: "Agent",
      tool_input: { subagent_type: 7, prompt: "task", model: "opus" },
    });
    expect(status).toBe(0);
  });
});
