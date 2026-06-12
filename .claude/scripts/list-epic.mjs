#!/usr/bin/env node
//
// List every GitHub Projects v2 item whose `Epic` field equals a given name,
// sorted by `Implementation Order`. Companion to fetch-issues.mjs and
// edit-issue.mjs.
//
// Addressing a listed item, and seeing its Epic / Implementation Order, used to
// require `gh project item-list` plus hand-decoding the PVTI_ node IDs it prints
// and guessing the camelized jq key names it derives (e.g. "implementation
// Order"). This script removes both: it pulls all items with their field values
// over GraphQL, converts each node ID to a numeric ID via numericIdFromNodeId
// (the inverse used by fetch/edit), and prints the numeric IDs so the output
// pipes straight into fetch-issues.mjs / edit-issue.mjs.
//
// Usage:
//   node list-epic.mjs <project-number> <epic-name>
//   node list-epic.mjs --json <project-number> <epic-name>
//
// The epic name is matched case-insensitively but otherwise exactly (no
// substring match). Default output is human-readable: one line per item with
// numeric ID, Implementation Order, Status, and title, sorted by Implementation
// Order ascending with unset orders last. --json emits a compact array of
// { id, order, status, title } for programmatic consumers, consistent with
// fetch-issues.mjs.

// fetchAllItems (the paginated, field-rich whole-project fetch) lives in
// lib/projectItems.mjs so list-issues.mjs shares the exact same pagination and
// field extraction; this script is just that listing filtered to one Epic.
import { fetchAllItems } from "./lib/projectItems.mjs";

/**
 * Sort comparator: by Implementation Order ascending, with unset orders last.
 * An unset order sorts as +Infinity so it falls after every numbered item; ties
 * (including two unset) keep input order via the stable Array.prototype.sort.
 */
function byOrder(a, b) {
  const oa = typeof a.order === "number" ? a.order : Infinity;
  const ob = typeof b.order === "number" ? b.order : Infinity;
  return oa - ob;
}

async function main() {
  const argv = process.argv.slice(2);
  let asJson = false;
  let i = 0;
  if (argv[i] === "--json") {
    asJson = true;
    i += 1;
  }
  const rest = argv.slice(i);

  const projectNumber = Number(rest[0]);
  const epicName = rest[1];
  if (!Number.isInteger(projectNumber) || epicName === undefined) {
    process.stderr.write(
      "Usage: node list-epic.mjs [--json] <project-number> <epic-name>\n",
    );
    process.exit(2);
  }

  const wanted = epicName.toLowerCase();
  const matches = (await fetchAllItems(projectNumber))
    .filter((item) => (item.fields.Epic ?? "").toLowerCase() === wanted)
    .map((item) => ({
      id: item.id,
      order: item.fields["Implementation Order"],
      status: item.fields.Status ?? null,
      title: item.title,
    }))
    .sort(byOrder);

  if (asJson) {
    // Compact, not pretty-printed: --json feeds programmatic/agent consumers,
    // where indentation is dead weight in the reader's context.
    process.stdout.write(JSON.stringify(matches) + "\n");
    return;
  }

  if (matches.length === 0) {
    process.stdout.write(
      `no items with Epic "${epicName}" on project ${projectNumber}\n`,
    );
    return;
  }

  for (const m of matches) {
    const order = typeof m.order === "number" ? String(m.order) : "-";
    process.stdout.write(
      `${m.id}\t[${order}]\t${m.status ?? "-"}\t${m.title}\n`,
    );
  }
}

main().catch((err) => {
  process.stderr.write(`${err.message ?? err}\n`);
  process.exit(1);
});
