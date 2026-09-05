#!/usr/bin/env node
// Workflow agent model-pin check, run by static_checks.yaml on every PR.
//
// A Workflow script's `agent(prompt, {...})` call that omits `model` does not
// fall back to the agent definition's pinned tier -- it inherits the session
// model, silently, wherever the script happens to be run from. The tiering rule
// in CLAUDE.md is therefore only as good as the pins written into the scripts
// themselves, and prose cannot assert that every call has one.
//
// The PreToolUse hooks that gate the Agent tool see none of this: the model lives
// inside a script string, not a top-level tool input. So the pin is encoded as a
// check over the committed scripts. Those come in two shapes, both scanned here:
// a fenced js block under .claude/commands/, .claude/agents/, or .claude/skills/,
// and a checked-in Workflow script a command invokes by path
// (.claude/scripts/*-workflow.mjs, whose whole file is the block -- it is a script
// body, not a module, so it is not linted and cannot be imported). Every `agent(`
// call in either must pass a literal `model:` from the tier set in its own options
// object, and Fable (which requires the owner's per-spawn approval and is never
// inherited) may not be pinned in a committed script at all. That options object
// is spelled out in the call: a spread into it can include a `model` of its own and
// decide the tier at run time, so the spread is itself a violation whether or not
// a literal sits beside it.
//
// The block reader is the shared one in scripts/lib/markdownFences.mjs; the
// lexer below is shared with check-workflow-args-resolve.mjs, which imports it
// to scan the same two script shapes for its own rule.
//
// The scan lexes a block rather than pattern-matching it: strings, template
// literals, regex literals, and comments are read as tokens, so a `model: 'opus'`
// sitting in a prompt template or a comment is not a pin, and a parenthesis inside
// a string cannot run one call's extent into the next. A pin counts only at the
// top level of the call's own options object, so a nested call's pin cannot stand
// in for its caller's.
//
// What the scan cannot see, exactly:
//   - a computed model value (`model: tier`) resolves only at run time; it is
//     treated as no pin at all and is reported as one. A hoisted options const is
//     treated the same way, by design -- the convention is an inline literal in
//     the call.
//   - `agent` reached under another name. A non-call use of the identifier is
//     itself reported, because the scan cannot follow it; but a binding taken off
//     a property (`const spawn = deps.agent`) is a member access, which this check
//     leaves alone, and a call through that binding is invisible -- as is a call
//     made straight through the member access (`deps.agent(...)`).
//   - a js fence nested inside another fence. The outer fence's info string decides
//     the block, so js nested in a markdown block -- documentation whose examples
//     are themselves Workflow scripts -- is not scanned at all.
//   - a script that is neither shape: an ad-hoc inline Workflow script, or a file
//     passed by scriptPath from outside .claude/scripts/*-workflow.mjs. The
//     require-workflow-fable-approval.mjs hook covers the inline form for Fable.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { jsBlocks } from "./lib/markdownFences.mjs";

const SOURCE_DIRS = [".claude/commands", ".claude/agents", ".claude/skills"];
const SCRIPT_DIR = ".claude/scripts";
const SCRIPT_SUFFIX = "-workflow.mjs";
const ALLOWED_TIERS = ["opus", "sonnet", "haiku"];
const SUMMARY_LENGTH = 100;

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

// Keywords a regex literal may directly follow; after any other identifier, a
// number, or a closing bracket, `/` is division.
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

function regexAllowed(previous) {
  if (!previous) return true;
  switch (previous.kind) {
    case "ident":
      return REGEX_PRECEDING_KEYWORDS.has(previous.text);
    case "punct":
      return !")]}".includes(previous.text);
    case "templateStart":
    case "templateMiddle":
      return true;
    default:
      return false;
  }
}

// An unterminated string ends at the newline rather than running to the end of
// the block, so one stray quote cannot swallow every call after it.
function readString(code, start) {
  const quote = code[start];
  let i = start + 1;
  let value = "";
  while (i < code.length) {
    const ch = code[i];
    if (ch === "\\") {
      value += code[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (ch === quote) return { end: i + 1, value };
    if (ch === "\n") return { end: i, value };
    value += ch;
    i++;
  }
  return { end: code.length, value };
}

// One run of template text, from a backtick or from the `}` that closes a
// substitution, up to the closing backtick (`closed`) or the next `${`.
function readTemplateChunk(code, start) {
  let i = start + 1;
  let raw = "";
  while (i < code.length) {
    const ch = code[i];
    if (ch === "\\") {
      raw += code[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (ch === "`") return { end: i + 1, raw, closed: true };
    if (ch === "$" && code[i + 1] === "{") {
      return { end: i + 2, raw, closed: false };
    }
    raw += ch;
    i++;
  }
  return { end: code.length, raw, closed: true };
}

function readRegex(code, start) {
  let i = start + 1;
  let inClass = false;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "\n") return null;
    if (inClass) {
      if (ch === "]") inClass = false;
    } else if (ch === "[") {
      inClass = true;
    } else if (ch === "/") {
      i++;
      while (i < code.length && IDENT_PART.test(code[i])) i++;
      return { end: i };
    }
    i++;
  }
  return null;
}

/**
 * Lex a block of JavaScript into `{kind, text?, value?, start}` tokens, skipping
 * whitespace and comments. A string or a substitution-free template has its
 * `value`; a template with substitutions is split into templateStart /
 * templateMiddle / templateEnd around the tokens of each substitution, so braces
 * and parentheses inside template TEXT never reach the structural scan.
 */
export function tokenize(code) {
  const tokens = [];
  const braces = [];
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "/" && code[i + 1] === "/") {
      const newline = code.indexOf("\n", i);
      i = newline === -1 ? code.length : newline;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end === -1 ? code.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const { end, value } = readString(code, i);
      tokens.push({ kind: "string", value, start: i });
      i = end;
      continue;
    }
    if (ch === "`") {
      const chunk = readTemplateChunk(code, i);
      if (chunk.closed) {
        tokens.push({ kind: "template", value: chunk.raw, start: i });
      } else {
        tokens.push({ kind: "templateStart", start: i });
        braces.push("template");
      }
      i = chunk.end;
      continue;
    }
    if (ch === "}" && braces[braces.length - 1] === "template") {
      braces.pop();
      const chunk = readTemplateChunk(code, i);
      tokens.push({
        kind: chunk.closed ? "templateEnd" : "templateMiddle",
        start: i,
      });
      if (!chunk.closed) braces.push("template");
      i = chunk.end;
      continue;
    }
    if (ch === "{") {
      braces.push("brace");
      tokens.push({ kind: "punct", text: ch, start: i });
      i++;
      continue;
    }
    if (ch === "}") {
      if (braces[braces.length - 1] === "brace") braces.pop();
      tokens.push({ kind: "punct", text: ch, start: i });
      i++;
      continue;
    }
    if (ch === "/" && regexAllowed(tokens[tokens.length - 1])) {
      const regex = readRegex(code, i);
      if (regex) {
        tokens.push({ kind: "regex", start: i });
        i = regex.end;
        continue;
      }
    }
    if (IDENT_START.test(ch)) {
      let end = i + 1;
      while (end < code.length && IDENT_PART.test(code[end])) end++;
      tokens.push({ kind: "ident", text: code.slice(i, end), start: i });
      i = end;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let end = i + 1;
      while (end < code.length && /[0-9a-zA-Z_.]/.test(code[end])) end++;
      tokens.push({ kind: "number", start: i });
      i = end;
      continue;
    }
    tokens.push({ kind: "punct", text: ch, start: i });
    i++;
  }
  return tokens;
}

/** Whether a token is the given punctuator. */
export const isPunct = (token, text) =>
  token?.kind === "punct" && token.text === text;

// Index of the `)` balancing the `(` at openIndex, or -1 when the call never
// closes (a truncated block).
function matchingParen(tokens, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i++) {
    if (isPunct(tokens[i], "(")) depth++;
    else if (isPunct(tokens[i], ")")) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function argumentSpans(tokens, openIndex, closeIndex) {
  const spans = [];
  let depth = 0;
  let start = openIndex + 1;
  for (let i = start; i < closeIndex; i++) {
    const token = tokens[i];
    if (token.kind !== "punct") continue;
    if ("([{".includes(token.text)) depth++;
    else if (")]}".includes(token.text)) depth--;
    else if (token.text === "," && depth === 0) {
      spans.push({ start, end: i });
      start = i + 1;
    }
  }
  if (start < closeIndex) spans.push({ start, end: closeIndex });
  return spans;
}

const literalValue = (token) =>
  token?.kind === "string" || token?.kind === "template"
    ? token.value
    : undefined;

// What a call's options object -- its second argument, and only when that
// argument is an object literal spelled out in the call -- pins at its top level:
// the `model` literals it writes, and whether it spreads anything in. A key may be
// quoted; a value that is not a string or a substitution-free template is not a
// literal and yields nothing, so the call is treated as unpinned. A spread nested
// deeper cannot reach the top-level `model` key, so only a top-level one counts.
function optionsPins(tokens, openIndex, closeIndex) {
  const options = argumentSpans(tokens, openIndex, closeIndex)[1];
  if (
    !options ||
    !isPunct(tokens[options.start], "{") ||
    !isPunct(tokens[options.end - 1], "}")
  ) {
    return { models: [], spread: false };
  }

  const models = [];
  let spread = false;
  let depth = 0;
  for (let i = options.start + 1; i < options.end - 1; i++) {
    const token = tokens[i];
    if (token.kind === "punct") {
      if ("([{".includes(token.text)) depth++;
      else if (")]}".includes(token.text)) depth--;
      else if (
        depth === 0 &&
        token.text === "." &&
        isPunct(tokens[i + 1], ".") &&
        isPunct(tokens[i + 2], ".")
      ) {
        spread = true;
      }
      continue;
    }
    if (depth !== 0) continue;
    const key = token.kind === "ident" ? token.text : literalValue(token);
    if (key !== "model" || !isPunct(tokens[i + 1], ":")) continue;
    const value = literalValue(tokens[i + 2]);
    if (value !== undefined) models.push(value);
  }
  return { models, spread };
}

/** The 1-based line a character index falls on. */
export const lineOf = (code, index) => code.slice(0, index).split("\n").length;

function summarize(text) {
  const firstLine = text.split("\n")[0].trim();
  return firstLine.length > SUMMARY_LENGTH
    ? `${firstLine.slice(0, SUMMARY_LENGTH - 3)}...`
    : firstLine;
}

/**
 * Every appearance of the injected `agent` binding in a block, in source order,
 * as `{kind: "call" | "alias", text, line}`; a call also has the literal
 * `models` its options object pins and whether that object `spread`s anything in.
 * A member access (`runner.agent`) is somebody else's method and is not an
 * appearance at all.
 */
export function agentUses(code) {
  const tokens = tokenize(code);
  const uses = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== "ident" || token.text !== "agent") continue;
    if (isPunct(tokens[i - 1], ".")) continue;
    const line = lineOf(code, token.start);
    if (!isPunct(tokens[i + 1], "(")) {
      const lineStart = code.lastIndexOf("\n", token.start) + 1;
      uses.push({
        kind: "alias",
        text: summarize(code.slice(lineStart)),
        line,
      });
      continue;
    }
    const close = matchingParen(tokens, i + 1);
    const end = close === -1 ? code.length : tokens[close].start + 1;
    uses.push({
      kind: "call",
      text: code.slice(token.start, end),
      line,
      ...optionsPins(tokens, i + 1, close === -1 ? tokens.length : close),
    });
  }
  return uses;
}

/** Every `agent(...)` call in a block of code, in source order. */
export function agentCalls(code) {
  return agentUses(code).filter((use) => use.kind === "call");
}

/** The literal `model` values a single call's options object pins. */
export function pinnedModels(callText) {
  return agentCalls(callText)[0]?.models ?? [];
}

/**
 * The blocks of JavaScript a scanned file contains: the fenced js blocks of a
 * Markdown source, or the whole of a checked-in Workflow script, which is one
 * unfenced block of script body from its first line.
 */
export function codeBlocks(file, source) {
  return file.endsWith(".mjs")
    ? [{ code: source, startLine: 1 }]
    : jsBlocks(source);
}

/**
 * Every way a source file's Workflow agent spawns can be off the tiering rule,
 * as `{file, line, problem}` triples. Empty means every call pins a literal tier.
 */
export function modelViolations(file, source) {
  const violations = [];
  for (const block of codeBlocks(file, source)) {
    for (const use of agentUses(block.code)) {
      const line = block.startLine + use.line - 1;
      const where = `${file}:${line}`;
      if (use.kind === "alias") {
        violations.push({
          file,
          line,
          problem: `${where}: \`${use.text}\` uses \`agent\` as a value rather than calling it; the tier pin is read off the call's own options object, so aliasing defeats this check -- spawn through a direct \`agent(...)\` call`,
        });
        continue;
      }
      if (use.spread) {
        violations.push({
          file,
          line,
          problem: `${where}: \`${summarize(use.text)}\` spreads into its options object, which can carry a \`model\` of its own and decide the tier at run time -- write the options out in the call with a literal \`model:\``,
        });
        continue;
      }
      if (use.models.length === 0) {
        violations.push({
          file,
          line,
          problem: `${where}: \`${summarize(use.text)}\` passes no literal \`model:\` in its options object, so it inherits the session model rather than the tier the round intended -- pin one of ${ALLOWED_TIERS.join(", ")}`,
        });
        continue;
      }
      for (const model of use.models) {
        if (ALLOWED_TIERS.includes(model)) continue;
        const fable = /fable/i.test(model)
          ? " -- Fable needs the owner's explicit per-spawn approval and is never pinned in a committed script"
          : "";
        violations.push({
          file,
          line,
          problem: `${where}: \`${summarize(use.text)}\` pins \`model: '${model}'\`, which is not one of ${ALLOWED_TIERS.join(", ")}${fable}`,
        });
      }
    }
  }
  return violations;
}

/** Count the `agent(` calls a source contains, for the pattern-rot guard. */
export function agentCallCount(file, source) {
  return codeBlocks(file, source).reduce(
    (total, block) => total + agentCalls(block.code).length,
    0,
  );
}

/** Every Markdown file under the scanned directories, as repo-relative paths. */
export function sourceFiles(root, dirs = SOURCE_DIRS) {
  const files = [];
  const walk = (dir) => {
    const absolute = resolve(root, dir);
    if (!existsSync(absolute)) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md")) files.push(path);
    }
  };
  for (const dir of dirs) walk(dir);
  return files;
}

/** Every checked-in Workflow script, as repo-relative paths. */
export function workflowScriptFiles(root, dir = SCRIPT_DIR) {
  const absolute = resolve(root, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute)
    .filter((entry) => entry.endsWith(SCRIPT_SUFFIX))
    .map((entry) => `${dir}/${entry}`);
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const files = [...sourceFiles(root), ...workflowScriptFiles(root)];
  const scanned = `${SOURCE_DIRS.join(", ")}, ${SCRIPT_DIR}/*${SCRIPT_SUFFIX}`;
  const violations = [];
  let calls = 0;
  for (const file of files) {
    const source = readFileSync(resolve(root, file), "utf8");
    calls += agentCallCount(file, source);
    violations.push(...modelViolations(file, source));
  }
  if (calls === 0) {
    console.error(
      `${scanned}: no \`agent(\` calls matched in any scanned block -- the extraction pattern rotted; fix scripts/check-workflow-agent-models.mjs`,
    );
    process.exit(1);
  }
  if (violations.length > 0) {
    for (const { problem } of violations) console.error(problem);
    process.exit(1);
  }
  console.log(
    `Workflow agent model check passed: ${calls} agent() calls across ${files.length} files in ${scanned} each pin a literal ${ALLOWED_TIERS.join("/")} model.`,
  );
}
