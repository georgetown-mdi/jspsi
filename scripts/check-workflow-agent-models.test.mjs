import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  agentCallCount,
  agentCalls,
  jsBlocks,
  modelViolations,
  pinnedModels,
} from "./check-workflow-agent-models.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const COMMANDS_DIR = ".claude/commands";

const readCommands = () =>
  readdirSync(resolve(root, COMMANDS_DIR))
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => ({
      file: `${COMMANDS_DIR}/${entry}`,
      source: readFileSync(resolve(root, COMMANDS_DIR, entry), "utf8"),
    }));

// A code fence written as a value so the fixture strings below can hold one
// without terminating this file's own Markdown-free source awkwardly.
const FENCE = "```";
const block = (code, language = "js") =>
  `text before\n${FENCE}${language}\n${code}\n${FENCE}\ntext after\n`;

describe("workflow agent model check", () => {
  it("passes on the real .claude/commands scripts", () => {
    for (const { file, source } of readCommands()) {
      expect(modelViolations(file, source)).toEqual([]);
    }
  });

  it("finds the real agent() calls, so the pattern has not rotted", () => {
    const total = readCommands().reduce(
      (sum, { source }) => sum + agentCallCount(source),
      0,
    );
    expect(total).toBeGreaterThanOrEqual(3);
  });

  it("reads only js fences, and reports their line numbers", () => {
    const source = `intro\n${FENCE}sh\nnpm test\n${FENCE}\nmid\n${FENCE}js\nconst a = 1\n${FENCE}\n`;
    expect(jsBlocks(source)).toEqual([{ code: "const a = 1", startLine: 7 }]);
  });

  it("spans a call across lines to its balancing parenthesis", () => {
    const calls = agentCalls(
      "const r = await agent(prompt, {\n  label: 'x',\n  model: 'opus',\n})\n",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].line).toBe(1);
    expect(calls[0].text).toContain("model: 'opus'");
    expect(calls[0].text.endsWith(")")).toBe(true);
  });

  it("ignores an identifier that merely ends in agent", () => {
    expect(agentCalls("subagent(x, {model: 'opus'})")).toEqual([]);
    expect(agentCalls("runner.agent(x, {model: 'opus'})")).toEqual([]);
  });

  it("reads every quoted model literal in a call", () => {
    expect(pinnedModels("agent(p, { model: 'sonnet' })")).toEqual(["sonnet"]);
    expect(pinnedModels('agent(p, { model: "haiku" })')).toEqual(["haiku"]);
    expect(pinnedModels("agent(p, { model: someTier })")).toEqual([]);
  });

  it("flags a call that passes no literal model", () => {
    const violations = modelViolations(
      "cmd.md",
      block("const r = await agent(prompt, { label: 'x' })"),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe("cmd.md");
    expect(violations[0].line).toBe(3);
    expect(violations[0].problem).toContain("no literal `model:`");
    expect(violations[0].problem).toContain("agent(prompt, { label: 'x' })");
  });

  it("flags a computed model as absent", () => {
    const violations = modelViolations(
      "cmd.md",
      block("agent(prompt, { model: args.model })"),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].problem).toContain("no literal `model:`");
  });

  it("flags both Fable spellings and names Fable in the message", () => {
    for (const model of ["fable", "claude-fable-5"]) {
      const violations = modelViolations(
        "cmd.md",
        block(`agent(prompt, { model: '${model}' })`),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].problem).toContain(`model: '${model}'`);
      expect(violations[0].problem).toContain("Fable");
    }
  });

  it("flags a model outside the tier set without naming Fable", () => {
    const violations = modelViolations(
      "cmd.md",
      block("agent(prompt, { model: 'gpt-4' })"),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].problem).toContain("not one of opus, sonnet, haiku");
    expect(violations[0].problem).not.toContain("Fable");
  });

  it("accepts every allowed tier, in either quote style", () => {
    const violations = modelViolations(
      "cmd.md",
      block(
        "agent(a, { model: 'opus' })\nagent(b, { model: \"sonnet\" })\nagent(c, { model: `haiku` })",
      ),
    );
    expect(violations).toEqual([]);
  });

  it("ignores an agent() call outside a js fence", () => {
    const source = `${FENCE}sh\nagent(prompt, {})\n${FENCE}\n`;
    expect(modelViolations("cmd.md", source)).toEqual([]);
    expect(agentCallCount(source)).toBe(0);
  });
});
