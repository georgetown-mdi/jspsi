#!/usr/bin/env node
// Agent-enforcement claim check, run by static_checks.yaml on every PR.
//
// CLAUDE.md tells agents a convention is "Enforced by `<hook>.mjs`". That is a
// claim about what the harness does, and prose cannot assert it reliably: a hook
// can be renamed, dropped from .claude/settings.json, or registered on a matcher
// that never covers the tool the convention is about, and the sentence is still
// treated as a guarantee. An agent that believes an ungated rule is gated stops
// holding it itself. So the claim is encoded as a check.
//
// A claim is accurate when the named hook exists in .claude/hooks/, is registered
// in .claude/settings.json, and the claiming line names at least one tool the
// registration actually matches -- "Enforced by X" with no tool named is treated as
// enforcement everywhere, which no single matcher delivers. The naming
// convention this leans on: an enforcement claim citing a `.mjs` file means a
// hook; a CI check is cited by its `npm run` name instead.
//
// Two structural claims ride along: every hook script has a colocated test
// (a hook is the repo's only unreviewed executable, and a broken one fails
// silent), and every registration in settings.json points at a file that exists.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLAUDE_MD = "CLAUDE.md";
const SETTINGS = ".claude/settings.json";
const HOOKS_DIR = ".claude/hooks";

/**
 * Enforcement claims in CLAUDE.md prose: each `Enforced by \`<file>.mjs\`` with
 * the line that holds it, so the tool-naming rule can read the surrounding
 * sentence.
 */
export function enforcementClaims(source) {
  const claims = [];
  source.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/[Ee]nforced by `([^`]+\.mjs)`/g)) {
      claims.push({ hook: match[1], line, lineNumber: index + 1 });
    }
  });
  return claims;
}

/** Hook registrations in settings.json as `{file, event, matcher}` triples. */
export function registeredHooks(settings) {
  const registrations = [];
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    for (const entry of entries ?? []) {
      for (const hook of entry.hooks ?? []) {
        const file = /hooks\/([\w.-]+\.mjs)/.exec(hook.command ?? "")?.[1];
        if (file) {
          registrations.push({ file, event, matcher: entry.matcher ?? "*" });
        }
      }
    }
  }
  return registrations;
}

/** Split a .claude/hooks listing into hook scripts and the tests beside them. */
export function hookInventory(entries) {
  return {
    scripts: entries.filter(
      (e) =>
        e.endsWith(".mjs") &&
        !e.endsWith(".test.mjs") &&
        e !== "vitest.config.mjs",
    ),
    tests: entries.filter((e) => e.endsWith(".test.mjs")),
  };
}

/**
 * Every way a claim, a registration, or a hook script can be out of step, as
 * `{hook, problem}` pairs. Empty means CLAUDE.md's enforcement prose is true.
 */
export function enforcementViolations({ claims, registrations, inventory }) {
  const violations = [];
  const scripts = new Set(inventory.scripts);
  const tested = new Set(
    inventory.tests.map((t) => t.replace(/\.test\.mjs$/, ".mjs")),
  );

  for (const { hook, line, lineNumber } of claims) {
    if (!scripts.has(hook)) {
      violations.push({
        hook,
        problem: `${CLAUDE_MD}:${lineNumber} claims enforcement by \`${hook}\`, which is not a hook script in ${HOOKS_DIR}/ -- fix the name, or cite a CI check by its \`npm run\` name instead`,
      });
      continue;
    }
    const matched = registrations.filter((r) => r.file === hook);
    if (matched.length === 0) {
      violations.push({
        hook,
        problem: `${CLAUDE_MD}:${lineNumber} claims enforcement by \`${hook}\`, but ${SETTINGS} does not register it, so it never runs`,
      });
      continue;
    }
    const tools = matched.map((r) => r.matcher);
    if (!tools.some((tool) => tool === "*" || line.includes(tool))) {
      violations.push({
        hook,
        problem: `${CLAUDE_MD}:${lineNumber} claims enforcement by \`${hook}\` without naming the tool it gates; ${SETTINGS} registers it on ${tools.join(", ")} only, so the line must say so rather than imply a general guarantee`,
      });
    }
  }

  for (const file of inventory.scripts) {
    if (!tested.has(file)) {
      violations.push({
        hook: file,
        problem: `${HOOKS_DIR}/${file} has no colocated ${file.replace(/\.mjs$/, ".test.mjs")} -- a hook nobody runs in a test fails silently`,
      });
    }
  }

  for (const { file, event, matcher } of registrations) {
    if (!scripts.has(file)) {
      violations.push({
        hook: file,
        problem: `${SETTINGS} registers ${HOOKS_DIR}/${file} on ${event}/${matcher}, but that file does not exist`,
      });
    }
  }

  return violations;
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const claims = enforcementClaims(
    readFileSync(resolve(root, CLAUDE_MD), "utf8"),
  );
  if (claims.length === 0) {
    console.error(
      `${CLAUDE_MD}: no \`Enforced by \`<hook>.mjs\`\` claims matched -- the extraction pattern rotted; fix scripts/check-enforcement-claims.mjs`,
    );
    process.exit(1);
  }
  const registrations = registeredHooks(
    JSON.parse(readFileSync(resolve(root, SETTINGS), "utf8")),
  );
  const inventory = hookInventory(readdirSync(resolve(root, HOOKS_DIR)));
  const violations = enforcementViolations({
    claims,
    registrations,
    inventory,
  });
  if (violations.length > 0) {
    for (const { problem } of violations) console.error(problem);
    process.exit(1);
  }
  console.log(
    `Enforcement claim check passed: ${claims.length} claims in ${CLAUDE_MD} resolve to registered hooks, ${inventory.scripts.length} hooks carry a colocated test, ${registrations.length} registrations name a file that exists.`,
  );
}
