import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  enforcementClaims,
  enforcementViolations,
  hookInventory,
  registeredHooks,
} from "./check-enforcement-claims.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const readRepo = () => ({
  claims: enforcementClaims(readFileSync(resolve(root, "CLAUDE.md"), "utf8")),
  registrations: registeredHooks(
    JSON.parse(readFileSync(resolve(root, ".claude/settings.json"), "utf8")),
  ),
  inventory: hookInventory(readdirSync(resolve(root, ".claude/hooks"))),
});

describe("enforcement claim check", () => {
  it("passes on the real CLAUDE.md, settings.json, and hooks dir", () => {
    expect(enforcementViolations(readRepo())).toEqual([]);
  });

  it("extracts the real claims, including a mid-sentence lowercase one", () => {
    const { claims } = readRepo();
    const hooks = claims.map((c) => c.hook);
    expect(hooks).toContain("require-agent-model.mjs");
    expect(hooks).toContain("require-fable-approval.mjs");
    expect(hooks.length).toBeGreaterThanOrEqual(4);
    expect(claims.every((c) => c.lineNumber > 0)).toBe(true);
  });

  it("reads every real registration back to an existing hook script", () => {
    const { registrations, inventory } = readRepo();
    expect(registrations.length).toBeGreaterThanOrEqual(6);
    for (const { file, event, matcher } of registrations) {
      expect(inventory.scripts).toContain(file);
      expect(event).toMatch(/^(Pre|Post)ToolUse$/);
      expect(matcher.length).toBeGreaterThan(0);
    }
  });

  it("separates hook scripts from their tests and the vitest config", () => {
    const inventory = hookInventory([
      "a-hook.mjs",
      "a-hook.test.mjs",
      "vitest.config.mjs",
      "notes.md",
    ]);
    expect(inventory).toEqual({
      scripts: ["a-hook.mjs"],
      tests: ["a-hook.test.mjs"],
    });
  });

  const inventoryOf = (...scripts) =>
    hookInventory(
      scripts.flatMap((s) => [s, s.replace(/\.mjs$/, ".test.mjs")]),
    );

  const claim = (hook, line) => [{ hook, line, lineNumber: 7 }];

  it("flags a claim naming a hook that does not exist", () => {
    const violations = enforcementViolations({
      claims: claim("gone.mjs", "Enforced by `gone.mjs` on Agent spawns."),
      registrations: [],
      inventory: inventoryOf("a-hook.mjs"),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].problem).toContain("CLAUDE.md:7");
    expect(violations[0].problem).toContain("not a hook script");
  });

  it("flags a claim whose hook exists but is never registered", () => {
    const violations = enforcementViolations({
      claims: claim("a-hook.mjs", "Enforced by `a-hook.mjs` on Agent spawns."),
      registrations: [],
      inventory: inventoryOf("a-hook.mjs"),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].problem).toContain("does not register it");
  });

  it("flags a claim that names no tool its hook is registered under", () => {
    const violations = enforcementViolations({
      claims: claim("a-hook.mjs", "Commit first. Enforced by `a-hook.mjs`."),
      registrations: [
        { file: "a-hook.mjs", event: "PreToolUse", matcher: "Workflow" },
      ],
      inventory: inventoryOf("a-hook.mjs"),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].problem).toContain("without naming the tool it gates");
    expect(violations[0].problem).toContain("Workflow");
  });

  it("accepts a claim naming any one of several registered matchers", () => {
    const violations = enforcementViolations({
      claims: claim(
        "a-hook.mjs",
        "Never SendMessage to continue. Enforced by `a-hook.mjs`.",
      ),
      registrations: [
        { file: "a-hook.mjs", event: "PreToolUse", matcher: "Agent" },
        { file: "a-hook.mjs", event: "PreToolUse", matcher: "SendMessage" },
      ],
      inventory: inventoryOf("a-hook.mjs"),
    });
    expect(violations).toEqual([]);
  });

  it("accepts a bare claim when the hook matches every tool", () => {
    const violations = enforcementViolations({
      claims: claim("a-hook.mjs", "Enforced by `a-hook.mjs`."),
      registrations: [
        { file: "a-hook.mjs", event: "PreToolUse", matcher: "*" },
      ],
      inventory: inventoryOf("a-hook.mjs"),
    });
    expect(violations).toEqual([]);
  });

  it("flags a hook script with no colocated test", () => {
    const violations = enforcementViolations({
      claims: [],
      registrations: [],
      inventory: hookInventory(["untested.mjs"]),
    });
    expect(violations).toEqual([
      {
        hook: "untested.mjs",
        problem: expect.stringContaining("untested.test.mjs"),
      },
    ]);
  });

  it("flags a registration pointing at a file that does not exist", () => {
    const violations = enforcementViolations({
      claims: [],
      registrations: [
        { file: "ghost.mjs", event: "PreToolUse", matcher: "Bash" },
      ],
      inventory: inventoryOf("a-hook.mjs"),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].problem).toContain("PreToolUse/Bash");
    expect(violations[0].problem).toContain("does not exist");
  });

  it("reads a hook file name out of the settings command string", () => {
    const registrations = registeredHooks({
      hooks: {
        PreToolUse: [
          {
            matcher: "Agent",
            hooks: [
              {
                type: "command",
                command:
                  'node "$CLAUDE_PROJECT_DIR/.claude/hooks/a-hook.mjs" --flag',
              },
            ],
          },
        ],
      },
    });
    expect(registrations).toEqual([
      { file: "a-hook.mjs", event: "PreToolUse", matcher: "Agent" },
    ]);
  });
});
