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
// Usage:
//   node fetch-issues.mjs <project-number> <itemId> [itemId...]
//   node fetch-issues.mjs --json <project-number> <itemId> [itemId...]
//   node fetch-issues.mjs --out-dir DIR <project-number> <itemId> [itemId...]
//
// Default output is human-readable (title, url, body per item). --json emits an
// array of { id, type, title, body, url } for programmatic consumers. --out-dir
// writes each body to DIR/<id>.md (creating DIR) and prints one summary line per
// file, which composes with edit-issue.mjs --body-file for a fetch-edit-push loop.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// fetchItems lives in lib/projectItems.mjs so lint-issues.mjs can reuse the same
// aliased multi-fetch for resolving cross-references.
import { fetchItems } from "./lib/projectItems.mjs";

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
  const numericIds = rest.slice(1).map(Number);
  if (
    !Number.isInteger(projectNumber) ||
    numericIds.length === 0 ||
    numericIds.some((n) => !Number.isInteger(n))
  ) {
    process.stderr.write(
      "Usage: node fetch-issues.mjs [--json] [--out-dir DIR] <project-number> <itemId> [itemId...]\n",
    );
    process.exit(2);
  }

  const items = fetchItems(projectNumber, numericIds);

  if (asJson) {
    process.stdout.write(JSON.stringify(items, null, 2) + "\n");
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
    process.stdout.write(`---\n${item.body}\n\n`);
  }
}

main();
