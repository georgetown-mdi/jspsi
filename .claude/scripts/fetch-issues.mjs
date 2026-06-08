#!/usr/bin/env node
//
// Fetch GitHub Projects v2 draft-issue (or issue) bodies by their numeric item
// ID -- the value shown as `?itemId=N` in the project web UI URL.
//
// This is the single source of truth for project-item lookup. It removes the
// language-model guessing that comes from hand-writing the gh/GraphQL each time:
// the PVTI node-ID derivation, the aliased multi-fetch, and the gh flag rules
// are all encoded here. Output is only the item payload, so callers (CLAUDE.md,
// the start-issue command, an agent) pay no context cost for the mechanism.
//
// A numeric item ID is the big-endian uint32 in the last 4 bytes of the item's
// `PVTI_` global node ID, preceded by a fixed per-project byte prefix. Deriving
// the node ID lets us address each item directly -- one round-trip for any
// number of IDs, returning only those items, with no scan-and-filter.
//
// Each item argument may be EITHER a numeric ID (the `?itemId=N` value) OR a
// `PVTI_...` global node ID as printed by `gh project item-list` -- the latter
// is decoded back to its numeric ID, so a listed item can be looked up without
// hand-decoding the node ID. The two forms mix freely in one invocation.
//
// Usage:
//   node fetch-issues.mjs <project-number> <itemId|PVTI_...> [more...]
//   node fetch-issues.mjs --json <project-number> <itemId|PVTI_...> [more...]
//   node fetch-issues.mjs --out-dir DIR <project-number> <itemId|PVTI_...> [more...]
//
// Default output is human-readable (title, url, populated field values, and body
// per item). --json emits a compact array of
// { id, type, title, body, url, fields } for programmatic consumers. --out-dir
// writes each body to DIR/<id>.md (creating DIR) and prints one summary line per
// file, which composes with edit-issue.mjs --body-file for a fetch-edit-push loop.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// fetchItems lives in lib/projectItems.mjs so lint-issues.mjs can reuse the same
// aliased multi-fetch for resolving cross-references. numericIdFromNodeId lets a
// PVTI_ node ID argument be accepted alongside the numeric form.
import { fetchItems, numericIdFromNodeId } from "./lib/projectItems.mjs";

// Fields surfaced first, in this order, in human-readable output; any other
// populated field is printed afterward in encounter order. These three are the
// board's primary triage axes, so they lead.
const LEAD_FIELDS = ["Status", "Epic", "Implementation Order"];

/**
 * Resolve one item argument to its numeric ID. A `PVTI_...` value is decoded via
 * numericIdFromNodeId; anything else is parsed as a base-10 integer. Returns NaN
 * for an unparseable numeric argument so the caller's Number.isInteger check
 * still rejects it. A malformed PVTI_ id throws (a clearer signal than NaN).
 */
function toNumericId(arg) {
  return arg.startsWith("PVTI_") ? numericIdFromNodeId(arg) : Number(arg);
}

function main() {
  const argv = process.argv.slice(2);
  // Leading option flags, in any order: --json, --out-dir DIR.
  let asJson = false;
  let outDir;
  let i = 0;
  while (argv[i] !== undefined && argv[i].startsWith("--")) {
    if (argv[i] === "--json") {
      asJson = true;
      i += 1;
    } else if (argv[i] === "--out-dir") {
      outDir = argv[i + 1];
      if (outDir === undefined) {
        process.stderr.write("error: --out-dir requires a value\n");
        process.exit(2);
      }
      i += 2;
    } else {
      break;
    }
  }
  const rest = argv.slice(i);

  const projectNumber = Number(rest[0]);
  // Each argument is a numeric ID or a PVTI_ node ID; resolve both to numeric.
  const numericIds = rest.slice(1).map(toNumericId);
  if (
    !Number.isInteger(projectNumber) ||
    numericIds.length === 0 ||
    numericIds.some((n) => !Number.isInteger(n))
  ) {
    process.stderr.write(
      "Usage: node fetch-issues.mjs [--json] [--out-dir DIR] <project-number> <itemId|PVTI_...> [more...]\n",
    );
    process.exit(2);
  }

  const items = fetchItems(projectNumber, numericIds);

  if (asJson) {
    // Compact, not pretty-printed: --json feeds programmatic/agent consumers,
    // where indentation is dead weight in the reader's context.
    process.stdout.write(JSON.stringify(items) + "\n");
    return;
  }

  if (outDir !== undefined) {
    mkdirSync(outDir, { recursive: true });
    for (const item of items) {
      if (item.type === "missing" || item.body == null) {
        process.stdout.write(`${item.id}: not found, skipped\n`);
        continue;
      }
      const path = join(outDir, `${item.id}.md`);
      writeFileSync(path, item.body);
      process.stdout.write(`${item.id}: ${path} (${item.body.length} bytes)\n`);
    }
    return;
  }

  for (const item of items) {
    process.stdout.write(`=== ${item.id} ===\n`);
    if (item.type === "missing") {
      process.stdout.write(`(not found on project ${projectNumber})\n\n`);
      continue;
    }
    process.stdout.write(`TITLE: ${item.title}\n`);
    process.stdout.write(
      `TYPE:  ${item.type}${item.url ? ` (${item.url})` : ""}\n`,
    );
    // Print populated project-field values: the lead fields first in a fixed
    // order, then any other populated field in encounter order. Title is a field
    // too but already shown above, so drop it here to avoid the duplicate.
    const fields = item.fields ?? {};
    const printed = new Set(["Title"]);
    for (const name of LEAD_FIELDS) {
      if (name in fields) {
        process.stdout.write(`${name}: ${fields[name]}\n`);
        printed.add(name);
      }
    }
    for (const [name, value] of Object.entries(fields)) {
      if (printed.has(name)) continue;
      process.stdout.write(`${name}: ${value}\n`);
    }
    process.stdout.write(`---\n${item.body}\n\n`);
  }
}

main();
