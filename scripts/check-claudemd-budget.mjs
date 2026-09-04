#!/usr/bin/env node
// CLAUDE.md byte budget, run by static_checks.yaml on every PR.
//
// The budget forces one-in, one-out: a pull request that pushes CLAUDE.md past
// the ceiling must relocate its own weight into the file that owns the mechanism
// it describes.
//
// Why a length gate here, when check-contributing-scope.mjs refuses, by design,
// to be one: the two files fail differently. CONTRIBUTING.md degrades by growing
// the WRONG KIND of section, which a heading allowlist names directly, so a
// length threshold there would reward padding a permitted section while a
// reference-depth one crept in. CLAUDE.md is loaded into every agent session, so
// its cost is its size whatever the sections are called, and the failure mode is
// uniform regrowth: each rule restates mechanics that already live in a command
// file or a hook header, and every restatement is billed on every session. Size
// is the thing to bound, and it is the one property of this file no shape check
// can see.
//
// The ceiling is not a target to fill. It is set at the size of a deliberate
// strip pass, so a PR that lands under it has no license to grow up to it.
//
// A rule is never deleted to make room. The move is to leave the one-line rule
// plus a pointer here and put the mechanics where they are already enforced:
// `.claude/commands/` for the review and panel flows, a hook's own header for
// what that hook does, `docs/` for anything a human reader also needs.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Ceiling in bytes. Raising it is a deliberate edit a reviewer sees. */
export const BUDGET_BYTES = 21487;

/**
 * The budget violation for a CLAUDE.md of `byteLength` bytes, or null when it
 * fits. Bytes rather than characters or lines: the size of the file on disk is
 * what a session pays for, and it is what a strip pass is measured against.
 */
export function budgetViolation(byteLength) {
  if (byteLength <= BUDGET_BYTES) return null;
  return `CLAUDE.md is ${byteLength} bytes, over the ${BUDGET_BYTES}-byte budget by ${byteLength - BUDGET_BYTES}. Relocate that much detail into the file that owns the mechanism -- a command file under .claude/commands/, the header of the hook that enforces it, or the matching docs/ tier -- keeping the one-line rule and a pointer here. Do not delete a rule to make room.`;
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// function without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const abs = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "CLAUDE.md",
  );
  const bytes = Buffer.byteLength(readFileSync(abs));
  const violation = budgetViolation(bytes);
  if (violation) {
    console.error(violation);
    process.exit(1);
  }
  console.log(
    `CLAUDE.md budget check passed: ${bytes} of ${BUDGET_BYTES} bytes.`,
  );
}
