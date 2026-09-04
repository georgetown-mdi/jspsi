import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HOOK = fileURLToPath(
  new URL("./require-workflow-fable-approval.mjs", import.meta.url),
);

// Run the hook as a real subprocess with a synthesized PreToolUse payload on
// stdin, the way Claude Code invokes it, and return its stdout. The hook always
// exits 0 (it asks via stdout JSON or emits nothing), so a nonzero exit here is
// itself a test failure.
function runHook(payload) {
  return execFileSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}

function assertAsks(out) {
  const parsed = JSON.parse(out);
  expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  expect(parsed.hookSpecificOutput.permissionDecision).toBe("ask");
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toMatch(/Fable/);
}

describe("require-workflow-fable-approval hook", () => {
  it("asks for approval on every Fable spelling in the script", () => {
    const scripts = [
      "await agent(p, { model: 'fable' })",
      'await agent(p, { model: "claude-fable-5" })',
      "await agent(p, { model: `fable` })",
      "await agent(p, { \"model\": 'fable' })",
      "await agent(p, { 'model': 'claude-fable-5' })",
      "const tier = 'claude-fable-5'\nawait agent(p, { model: tier })",
    ];
    for (const script of scripts) {
      assertAsks(
        runHook({ tool_name: "Workflow", tool_input: { script, args: {} } }),
      );
    }
  });

  it("asks when the script reads the tier out of Fable-naming args", () => {
    const argsObjects = [
      { model: "fable" },
      { model: "claude-fable-5" },
      { tier: "fable" },
    ];
    for (const args of argsObjects) {
      assertAsks(
        runHook({
          tool_name: "Workflow",
          tool_input: {
            script: "await agent(p, { model: args.model ?? args.tier })",
            args,
          },
        }),
      );
    }
  });

  it("passes through a script pinning a non-Fable tier", () => {
    const out = runHook({
      tool_name: "Workflow",
      tool_input: {
        script:
          "await agent(p, { model: 'opus' })\nawait agent(q, { model: 'sonnet' })",
        args: {},
      },
    });
    expect(out).toBe("");
  });

  it("passes through args that merely discuss Fable in prose", () => {
    const out = runHook({
      tool_name: "Workflow",
      tool_input: {
        script: "await agent(p, { model: 'opus' })",
        args: { claims: ["The hook asks before a Workflow runs on Fable"] },
      },
    });
    expect(out).toBe("");
  });

  it("passes through a Workflow call holding no inline script", () => {
    const out = runHook({
      tool_name: "Workflow",
      tool_input: { scriptPath: ".claude/workflows/whatever.mjs" },
    });
    expect(out).toBe("");
  });

  it("ignores tools other than Workflow", () => {
    const out = runHook({
      tool_name: "Agent",
      tool_input: { model: "fable", prompt: "x" },
    });
    expect(out).toBe("");
  });
});
