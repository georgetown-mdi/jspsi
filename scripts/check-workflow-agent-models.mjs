#!/usr/bin/env node
// Workflow agent model-pin check, run by static_checks.yaml on every PR.
//
// A Workflow script's `agent(prompt, {...})` call that omits `model` does not
// fall back to the agent definition's pinned tier -- it inherits the session
// model, silently, wherever the script happens to be run from. The tiering rule
// in CLAUDE.md is therefore only as good as the pins written into the scripts
// themselves, and prose cannot assert that every call carries one.
//
// The PreToolUse hooks that gate the Agent tool see none of this: the model lives
// inside a script string, not a top-level tool input. So the pin is encoded as a
// check over the committed scripts -- every `agent(` call in a fenced ```js block
// under .claude/commands/ must pass a literal `model:` from the tier set, and
// Fable (which requires the owner's per-spawn approval and is never inherited)
// may not be pinned in a committed script at all.
//
// A literal is required because that is the whole enforceable surface: a computed
// or spread model value reads as absent here, and is treated as absent.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMMANDS_DIR = ".claude/commands";
const ALLOWED_TIERS = ["opus", "sonnet", "haiku"];

/**
 * The fenced ```js blocks of a Markdown source, as `{code, startLine}` where
 * startLine is the 1-based line of the block's first code line.
 */
export function jsBlocks(source) {
  const blocks = [];
  const lines = source.split("\n");
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(/^```(\w*)\s*$/);
    if (!fence) continue;
    if (open === null) {
      if (fence[1] === "js" || fence[1] === "javascript") {
        open = { language: fence[1], start: i + 1 };
      } else {
        open = { language: fence[1], start: i + 1, ignore: true };
      }
      continue;
    }
    if (!open.ignore) {
      blocks.push({
        code: lines.slice(open.start, i).join("\n"),
        startLine: open.start + 1,
      });
    }
    open = null;
  }
  return blocks;
}

/**
 * Every `agent(...)` call in a block of code, as `{text, line}` where text spans
 * the call's balanced parentheses and line is 1-based within the block. An
 * unbalanced call (a stray parenthesis inside a template literal) runs to the end
 * of the block rather than being dropped, so a malformed script still gets read.
 */
export function agentCalls(code) {
  const calls = [];
  for (const match of code.matchAll(/(?<![\w.$])agent\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = code.length;
    for (let i = open; i < code.length; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    calls.push({
      text: code.slice(match.index, end),
      line: code.slice(0, match.index).split("\n").length,
    });
  }
  return calls;
}

/** The quoted `model:` values of a call, in source order. */
export function pinnedModels(callText) {
  return [...callText.matchAll(/\bmodel\s*:\s*['"`]([^'"`]*)['"`]/g)].map(
    (m) => m[1],
  );
}

/** One-line rendering of a call for an error message: its first line, trimmed. */
function callSummary(callText) {
  const firstLine = callText.split("\n")[0].trim();
  return firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
}

/**
 * Every way a command file's Workflow agent spawns can be off the tiering rule,
 * as `{file, line, problem}` triples. Empty means every call pins a literal tier.
 */
export function modelViolations(file, source) {
  const violations = [];
  for (const block of jsBlocks(source)) {
    for (const call of agentCalls(block.code)) {
      const where = `${file}:${block.startLine + call.line - 1}`;
      const models = pinnedModels(call.text);
      if (models.length === 0) {
        violations.push({
          file,
          line: block.startLine + call.line - 1,
          problem: `${where}: \`${callSummary(call.text)}\` passes no literal \`model:\`, so it inherits the session model rather than the tier the round intended -- pin one of ${ALLOWED_TIERS.join(", ")}`,
        });
        continue;
      }
      for (const model of models) {
        if (ALLOWED_TIERS.includes(model)) continue;
        const fable = /fable/i.test(model)
          ? " -- Fable needs the owner's explicit per-spawn approval and is never pinned in a committed script"
          : "";
        violations.push({
          file,
          line: block.startLine + call.line - 1,
          problem: `${where}: \`${callSummary(call.text)}\` pins \`model: '${model}'\`, which is not one of ${ALLOWED_TIERS.join(", ")}${fable}`,
        });
      }
    }
  }
  return violations;
}

/** Count the `agent(` calls a source carries, for the pattern-rot guard. */
export function agentCallCount(source) {
  return jsBlocks(source).reduce(
    (total, block) => total + agentCalls(block.code).length,
    0,
  );
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const commands = readdirSync(resolve(root, COMMANDS_DIR)).filter((entry) =>
    entry.endsWith(".md"),
  );
  const violations = [];
  let calls = 0;
  for (const command of commands) {
    const file = `${COMMANDS_DIR}/${command}`;
    const source = readFileSync(resolve(root, file), "utf8");
    calls += agentCallCount(source);
    violations.push(...modelViolations(file, source));
  }
  if (calls === 0) {
    console.error(
      `${COMMANDS_DIR}: no \`agent(\` calls matched in any fenced js block -- the extraction pattern rotted; fix scripts/check-workflow-agent-models.mjs`,
    );
    process.exit(1);
  }
  if (violations.length > 0) {
    for (const { problem } of violations) console.error(problem);
    process.exit(1);
  }
  console.log(
    `Workflow agent model check passed: ${calls} agent() calls across ${commands.length} command files in ${COMMANDS_DIR}/ each pin a literal ${ALLOWED_TIERS.join("/")} model.`,
  );
}
