#!/usr/bin/env node
// CONTRIBUTING.md scope guard, run by static_checks.yaml on every PR.
//
// CONTRIBUTING.md is the pre-contribution quickstart, not a reference (see its
// "Scope of this document" section). This is a mechanical BACKSTOP for two tells
// that deeper material has crept back in; it is not a complete guard -- doc-tier
// placement is otherwise a review call, and the charter plus the CLAUDE.md rule
// are the primary mechanism.
//
//   1. Heading allowlist. A `##`/`###` section not on ALLOWED_HEADINGS fails the
//      build. A reintroduced "Upgrading the SFTP Stack" or "Coverage rationale"
//      section is caught by its shape regardless of wording -- the weakness a
//      keyword scan cannot cover. Adding a genuine quickstart section is then a
//      deliberate edit to this list that a reviewer sees, the same allowlist
//      discipline as apps/cli/test/integration/consoleAllowlist.ts; deep material
//      goes to the doc named in CONTRIBUTING's "Scope of this document" instead.
//      An allowlist entry that no longer appears also fails, so it cannot rot.
//   2. Dependency source-path citation. A `node_modules/<pkg>/...` path is the
//      tell of dependency-internal spelunking, which belongs in
//      docs/spec/DEPENDENCY_PINS.md. Requiring a segment AFTER the package name
//      keeps a single-package reinstall command (`rm -rf node_modules/ssh2`)
//      from tripping it; fenced code blocks are skipped so a command example is
//      never scanned.
//
// This is deliberately structural, not a line-count gate: a length threshold
// rewards gaming, these name the actual smells.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { stripFences } from "./lib/markdownFences.mjs";

/** The `##`/`###` sections a pre-contribution quickstart is expected to hold. */
export const ALLOWED_HEADINGS = [
  "Scope of this document",
  "Repository Structure",
  "Prerequisites",
  "Development Setup",
  "Building",
  "Testing",
  "Integration and browser tests",
  "Coverage",
  "Code Conventions",
  "Documentation",
  "Changelog",
  "Commit Messages",
  "Pull Request Process",
  "Pull Request Description",
  "Dependency Policy",
  "Export Control",
  "Reporting Security Issues",
  "Reporting Other Issues",
];

// A path INTO a dependency's source: `node_modules/` + package + at least one
// more segment. The trailing segment is what distinguishes a source citation
// (`node_modules/ssh2/lib/client.js`) from a bare package path in a reinstall
// command (`node_modules/ssh2`).
const SOURCE_PATH = /node_modules\/[\w@.-]+\//;

/** Return the list of scope violations in CONTRIBUTING.md `text` (empty = clean). */
export function scopeViolations(text) {
  const violations = [];
  const lines = stripFences(text).split("\n");

  const seen = new Set();
  lines.forEach((line, i) => {
    const m = /^(#{2,3})\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) {
      const heading = m[2].trim();
      seen.add(heading);
      if (!ALLOWED_HEADINGS.includes(heading)) {
        violations.push(
          `line ${i + 1}: unexpected section "${heading}" -- if it is quickstart material, add it to ALLOWED_HEADINGS in scripts/check-contributing-scope.mjs; otherwise route it per "Scope of this document"`,
        );
      }
    }
    if (SOURCE_PATH.test(line)) {
      violations.push(
        `line ${i + 1}: dependency source-path citation -- move it to docs/spec/DEPENDENCY_PINS.md`,
      );
    }
  });

  for (const heading of ALLOWED_HEADINGS) {
    if (!seen.has(heading)) {
      violations.push(
        `allowlist entry "${heading}" no longer appears in CONTRIBUTING.md -- remove it from ALLOWED_HEADINGS`,
      );
    }
  }

  return violations;
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// function without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = "CONTRIBUTING.md";
  const abs = resolve(dirname(fileURLToPath(import.meta.url)), "..", file);
  const violations = scopeViolations(readFileSync(abs, "utf8"));
  if (violations.length > 0) {
    console.error(
      `CONTRIBUTING.md scope check failed (${violations.length} issue${violations.length === 1 ? "" : "s"}):\n`,
    );
    for (const v of violations) console.error("  " + file + ":" + v);
    console.error('\nSee CONTRIBUTING.md, "Scope of this document".');
    process.exit(1);
  }
  console.log("CONTRIBUTING.md scope check passed.");
}
