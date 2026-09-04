import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  agentCallCount,
  agentCalls,
  agentUses,
  jsBlocks,
  modelViolations,
  pinnedModels,
  sourceFiles,
  workflowScriptFiles,
} from "./check-workflow-agent-models.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const readSources = () =>
  [...sourceFiles(root), ...workflowScriptFiles(root)].map((file) => ({
    file,
    source: readFileSync(resolve(root, file), "utf8"),
  }));

const FENCE = "```";
const block = (code, fence = `${FENCE}js`, close = FENCE) =>
  `text before\n${fence}\n${code}\n${close}\ntext after\n`;

describe("workflow agent model check", () => {
  it("passes on the real scanned command, agent, skill, and script files", () => {
    for (const { file, source } of readSources()) {
      expect(modelViolations(file, source)).toEqual([]);
    }
  });

  it("finds the real agent() calls, so the pattern has not rotted", () => {
    const total = readSources().reduce(
      (sum, { file, source }) => sum + agentCallCount(file, source),
      0,
    );
    expect(total).toBeGreaterThanOrEqual(3);
  });

  it("scans commands, agent definitions, and skills", () => {
    const files = sourceFiles(root);
    expect(files).toContain(".claude/commands/light-review.md");
    expect(files.some((f) => f.startsWith(".claude/agents/"))).toBe(true);
    expect(files.some((f) => f.startsWith(".claude/skills/"))).toBe(true);
  });

  it("scans the checked-in Workflow scripts the commands invoke by path", () => {
    const files = workflowScriptFiles(root);
    expect(files).toContain(".claude/scripts/light-review-workflow.mjs");
    expect(files).toContain(".claude/scripts/panel-workflow.mjs");
    expect(files.every((f) => f.endsWith("-workflow.mjs"))).toBe(true);
  });

  it("reads a Workflow script whole, with no fence to open a block", () => {
    const source = "const a = 1\nagent(prompt, { label: 'x' })\n";
    expect(agentCallCount("scripts/x-workflow.mjs", source)).toBe(1);
    const violations = modelViolations("scripts/x-workflow.mjs", source);
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(2);
    expect(violations[0].problem).toContain("no literal `model:`");
  });

  it("reads only js fences, and reports their line numbers", () => {
    const source = `intro\n${FENCE}sh\nnpm test\n${FENCE}\nmid\n${FENCE}js\nconst a = 1\n${FENCE}\n`;
    expect(jsBlocks(source)).toEqual([{ code: "const a = 1", startLine: 7 }]);
  });

  it("reads the CommonMark fence forms a plain ```js pattern misses", () => {
    const forms = [
      [`${FENCE}js title="review.js"`, FENCE],
      [`${FENCE}\`js`, `${FENCE}\``],
      ["~~~js", "~~~"],
      [`   ${FENCE}javascript`, `   ${FENCE}`],
    ];
    for (const [fence, close] of forms) {
      const violations = modelViolations(
        "cmd.md",
        block("agent(prompt, { label: 'x' })", fence, close),
      );
      expect(violations, fence).toHaveLength(1);
      expect(violations[0].problem).toContain("no literal `model:`");
    }
  });

  it("reads an unclosed js fence to the end of the file", () => {
    const source = `${FENCE}js\nagent(prompt, { label: 'x' })\n`;
    expect(agentCallCount("cmd.md", source)).toBe(1);
    expect(modelViolations("cmd.md", source)).toHaveLength(1);
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
    expect(agentUses("subagent(x, {model: 'opus'})")).toEqual([]);
    expect(agentUses("runner.agent(x, {model: 'opus'})")).toEqual([]);
  });

  it("reads every quoted model literal in a call", () => {
    expect(pinnedModels("agent(p, { model: 'sonnet' })")).toEqual(["sonnet"]);
    expect(pinnedModels('agent(p, { model: "haiku" })')).toEqual(["haiku"]);
    expect(pinnedModels("agent(p, { 'model': 'haiku' })")).toEqual(["haiku"]);
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

  it("flags a hoisted options object, which carries no inline pin", () => {
    const violations = modelViolations(
      "cmd.md",
      block("const options = { model: 'opus' }\nagent(prompt, options)"),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].problem).toContain("no literal `model:`");
  });

  it("flags a spread into the options object, pinned or not", () => {
    for (const code of [
      "agent(prompt, { model: 'opus', ...override })",
      "agent(prompt, { ...override })",
    ]) {
      const violations = modelViolations("cmd.md", block(code));
      expect(violations, code).toHaveLength(1);
      expect(violations[0].problem).toContain(
        "spreads into its options object",
      );
    }
  });

  it("does not read a member access or a nested spread as a spread", () => {
    const violations = modelViolations(
      "cmd.md",
      block(
        "agent(a, { model: 'opus', label: names.first })\nagent(b, { model: 'opus', extra: { ...more } })",
      ),
    );
    expect(violations).toEqual([]);
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
    expect(agentCallCount("cmd.md", source)).toBe(0);
  });

  it("does not read a pin out of a string, template, or comment", () => {
    const phantoms = [
      "agent('spawn it with model: \\'opus\\'', { label: 'x' })",
      "agent(`the prompt says model: 'opus'`, { label: 'x' })",
      "agent(prompt, { label: 'x' }) // model: 'opus'",
      "/* model: 'opus' */ agent(prompt, { label: 'x' })",
    ];
    for (const code of phantoms) {
      const violations = modelViolations("cmd.md", block(code));
      expect(violations, code).toHaveLength(1);
      expect(violations[0].problem).toContain("no literal `model:`");
    }
  });

  it("does not let an unbalanced parenthesis in a template absorb the next call", () => {
    const violations = modelViolations(
      "cmd.md",
      block(
        "agent(`a stray ( in prose`, { label: 'x' })\nagent(b, {model: 'opus'})",
      ),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(3);
    expect(violations[0].problem).toContain("no literal `model:`");
  });

  it("is not desynchronized by a quote inside a regex literal", () => {
    const violations = modelViolations(
      "cmd.md",
      block("const q = /'[a-z]'/\nagent(p, { model: 'opus' })"),
    );
    expect(violations).toEqual([]);
  });

  it("does not accept a nested call's pin for the outer call", () => {
    const violations = modelViolations(
      "cmd.md",
      block("agent(await agent(inner, { model: 'sonnet' }), { label: 'x' })"),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].problem).toContain("no literal `model:`");
    expect(violations[0].problem).toContain("agent(await agent(inner");
  });

  it("flags every use of agent as a value, which the scan cannot follow", () => {
    for (const code of [
      "const spawn = agent\nawait spawn(p, { model: 'opus' })",
      "await parallel([() => (agent)(p, { model: 'opus' })])",
    ]) {
      const violations = modelViolations("cmd.md", block(code));
      expect(violations, code).toHaveLength(1);
      expect(violations[0].problem).toContain("aliasing defeats this check");
    }
  });
});
