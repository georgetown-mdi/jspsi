import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  sourceFiles,
  workflowScriptFiles,
} from "./check-workflow-agent-models.mjs";
import {
  canonicalResolveCount,
  looseArgsReads,
  resolveCount,
  resolveViolations,
} from "./check-workflow-args-resolve.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const readSources = () =>
  [...sourceFiles(root), ...workflowScriptFiles(root)].map((file) => ({
    file,
    source: readFileSync(resolve(root, file), "utf8"),
  }));

const FENCE = "```";
const block = (code, fence = `${FENCE}js`, close = FENCE) =>
  `text before\n${fence}\n${code}\n${close}\ntext after\n`;

const CANONICAL = "const input = resolveWorkflowArgs(args);";

describe("workflow args resolve check", () => {
  it("passes on the real scanned command, agent, skill, and script files", () => {
    for (const { file, source } of readSources()) {
      expect(resolveViolations(file, source), file).toEqual([]);
    }
  });

  it("finds the real canonical resolves, so the pattern has not rotted", () => {
    const total = readSources().reduce(
      (sum, { file, source }) => sum + resolveCount(file, source),
      0,
    );
    expect(total).toBeGreaterThanOrEqual(2);
  });

  it("accepts the canonical resolve and every read taken off its result", () => {
    const code = `${CANONICAL}\nconst role = input.role;\nconst {docs} = input;\nreturn {...input};`;
    expect(resolveViolations("cmd.md", block(code))).toEqual([]);
    expect(canonicalResolveCount(code)).toBe(1);
  });

  it("flags a field read straight off args", () => {
    const violations = resolveViolations(
      "cmd.md",
      block("const r = args.role;"),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe("cmd.md");
    expect(violations[0].line).toBe(3);
    expect(violations[0].problem).toContain("resolveWorkflowArgs(args)");
    expect(violations[0].problem).toContain("const r = args.role;");
  });

  it("flags a destructure of args", () => {
    const violations = resolveViolations(
      "cmd.md",
      block("const {role} = args;"),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].problem).toContain("const {role} = args;");
  });

  it("flags a spread of args, whose leading dots are not a member access", () => {
    const violations = resolveViolations(
      "cmd.md",
      block("const a = {...args};"),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].problem).toContain("{...args}");
  });

  it("flags a computed index into args", () => {
    const violations = resolveViolations("cmd.md", block("const v = args[k];"));
    expect(violations).toHaveLength(1);
    expect(violations[0].problem).toContain("args[k]");
  });

  it("flags an alias, so the binding cannot be renamed out of reach", () => {
    const violations = resolveViolations("cmd.md", block("const a = args;"));
    expect(violations).toHaveLength(1);
    expect(violations[0].problem).toContain("const a = args;");
  });

  it("flags a hand-rolled resolve, once per read it takes", () => {
    const violations = resolveViolations(
      "cmd.md",
      block(
        `const input = typeof args === "string" ? JSON.parse(args) : args;`,
      ),
    );
    expect(violations).toHaveLength(3);
  });

  it("flags a read narrowed inside the resolver's own argument list", () => {
    for (const code of [
      "const a = resolveWorkflowArgs(args.docs);",
      "const a = resolveWorkflowArgs(args, fallback);",
    ]) {
      const violations = resolveViolations("cmd.md", block(code));
      expect(violations, code).toHaveLength(1);
      expect(canonicalResolveCount(code), code).toBe(0);
    }
  });

  it("flags a member call to a function sharing the resolver's name", () => {
    for (const code of [
      "const a = obj.resolveWorkflowArgs(args);",
      "const a = deps.util.resolveWorkflowArgs(args);",
    ]) {
      const violations = resolveViolations("cmd.md", block(code));
      expect(violations, code).toHaveLength(1);
      expect(canonicalResolveCount(code), code).toBe(0);
    }
  });

  it("flags a second read even when the canonical resolve is present", () => {
    const violations = resolveViolations(
      "cmd.md",
      block(`${CANONICAL}\nconst role = args.role;`),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(4);
  });

  it("does not read a member access of somebody else's args property", () => {
    expect(looseArgsReads("const a = deps.args;\nrun(cli.args, 1);")).toEqual(
      [],
    );
  });

  it("does not read args out of a string, template, or comment", () => {
    const phantoms = [
      `const a = "args.role";`,
      "const a = `pass args.role to it`;",
      "// args.role is the role\nconst a = 1;",
      "/* const {role} = args */ const a = 1;",
    ];
    for (const code of phantoms) {
      expect(resolveViolations("cmd.md", block(code)), code).toEqual([]);
    }
  });

  it("reads only js fences, and reports their line numbers", () => {
    const source = `intro\n${FENCE}sh\nrun --args=x\n${FENCE}\nmid\n${FENCE}js\nconst a = args;\n${FENCE}\n`;
    const violations = resolveViolations("cmd.md", source);
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(7);
  });

  it("reads the CommonMark fence forms a plain ```js pattern misses", () => {
    const forms = [
      [`${FENCE}js title="review.js"`, FENCE],
      [`${FENCE}\`js`, `${FENCE}\``],
      ["~~~js", "~~~"],
      [`   ${FENCE}javascript`, `   ${FENCE}`],
    ];
    for (const [fence, close] of forms) {
      const violations = resolveViolations(
        "cmd.md",
        block("const a = args.role;", fence, close),
      );
      expect(violations, fence).toHaveLength(1);
    }
  });

  it("ignores an args read in Markdown prose outside every fence", () => {
    expect(
      resolveViolations("cmd.md", "Set `args` to args.role and run it.\n"),
    ).toEqual([]);
  });

  it("reads a Workflow script whole, with no fence to open a block", () => {
    const source = "const a = 1;\nconst role = args.role;\n";
    const violations = resolveViolations(
      ".claude/scripts/x-workflow.mjs",
      source,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(2);
    expect(resolveCount(".claude/scripts/x-workflow.mjs", CANONICAL)).toBe(1);
  });

  it("ignores an identifier that merely ends in args", () => {
    expect(looseArgsReads("const a = roleArgs.role;")).toEqual([]);
    expect(looseArgsReads("const a = {...moreArgs};")).toEqual([]);
  });
});
