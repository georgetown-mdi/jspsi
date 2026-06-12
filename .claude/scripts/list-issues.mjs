#!/usr/bin/env node
//
// List every item on a GitHub Projects v2 board with its triage fields, fully
// paginated. Companion to fetch-issues.mjs (read one item by ID), list-epic.mjs
// (this listing filtered to one Epic), and edit-issue.mjs (write).
//
// A board-hygiene pass needs the whole inventory in one round-trip: every item
// with its numeric `?itemId=N` id, its `PVTI_` node id, status, Epic, and
// Implementation Order. `gh project item-list` cannot supply that -- its JSON
// omits the numeric id and the custom fields, and it silently caps at `--limit`
// (board 9 already holds more than one 100-item page), so a too-low limit drops
// items with no warning. This script goes through the same paginated GraphQL
// path as list-epic.mjs (shared fetchAllItems), which pages until the board is
// exhausted, so no item is ever dropped.
//
// Usage:
//   node list-issues.mjs [--json] [--status NAME]... <project-number>
//
// Default output is human-readable: one tab-separated line per item with numeric
// id, node id, status, [Implementation Order], Epic, and title, in board order.
// --json emits a compact array of { id, nodeId, status, epic, order, title } for
// programmatic consumers, consistent with fetch-issues.mjs and list-epic.mjs.
//
// With no --status, every item is listed. Each --status NAME (repeatable) keeps
// only items whose Status equals NAME (case-insensitive); e.g. `--status Todo
// --status "In Progress"` is the common non-Done hygiene view.

import { fetchAllItems } from "./lib/projectItems.mjs";

function main() {
  // A whole-board dump is routinely piped to `head`/`grep`, which closes the
  // read end early; exit quietly on the resulting EPIPE instead of crashing.
  process.stdout.on("error", (err) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });

  const argv = process.argv.slice(2);
  // Leading option flags, in any order: --json, --status NAME (repeatable).
  let asJson = false;
  const statuses = [];
  let i = 0;
  while (argv[i] !== undefined && argv[i].startsWith("--")) {
    if (argv[i] === "--json") {
      asJson = true;
      i += 1;
    } else if (argv[i] === "--status") {
      const value = argv[i + 1];
      if (value === undefined) {
        process.stderr.write("error: --status requires a value\n");
        process.exit(2);
      }
      statuses.push(value.toLowerCase());
      i += 2;
    } else {
      break;
    }
  }
  const rest = argv.slice(i);

  const projectNumber = Number(rest[0]);
  if (!Number.isInteger(projectNumber) || rest.length !== 1) {
    process.stderr.write(
      "Usage: node list-issues.mjs [--json] [--status NAME]... <project-number>\n",
    );
    process.exit(2);
  }

  const wanted = new Set(statuses);
  const items = fetchAllItems(projectNumber)
    .map((item) => ({
      id: item.id,
      nodeId: item.nodeId,
      status: item.fields.Status ?? null,
      epic: item.fields.Epic ?? null,
      order: item.fields["Implementation Order"],
      title: item.title,
    }))
    .filter(
      (item) =>
        wanted.size === 0 ||
        (item.status !== null && wanted.has(item.status.toLowerCase())),
    );

  if (asJson) {
    // Compact, not pretty-printed: --json feeds programmatic/agent consumers,
    // where indentation is dead weight in the reader's context.
    process.stdout.write(JSON.stringify(items) + "\n");
    return;
  }

  if (items.length === 0) {
    const filter =
      wanted.size === 0 ? "" : ` matching status ${[...wanted].join(", ")}`;
    process.stdout.write(`no items on project ${projectNumber}${filter}\n`);
    return;
  }

  for (const m of items) {
    const order = typeof m.order === "number" ? String(m.order) : "-";
    process.stdout.write(
      `${m.id}\t${m.nodeId}\t${m.status ?? "-"}\t[${order}]\t${m.epic ?? "-"}\t${m.title}\n`,
    );
  }
}

main();
