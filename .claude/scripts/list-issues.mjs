#!/usr/bin/env node
//
// List every item on a GitHub Projects v2 board with its triage fields, fully
// paginated. Companion to fetch-issues.mjs (read one item by ID), list-epic.mjs
// (this listing filtered to one Epic), and edit-issue.mjs (write).
//
// A board-hygiene pass needs the whole inventory in one round-trip: every item
// with its numeric `?itemId=N` id, its `PVTI_` node id, status, Epic, and
// Order. `gh project item-list` cannot supply that -- its JSON
// omits the numeric id and the custom fields, and it silently caps at `--limit`
// (board 9 already holds more than one 100-item page), so a too-low limit drops
// items with no warning. This script goes through the same paginated GraphQL
// path as list-epic.mjs (shared fetchAllItems), which pages until the board is
// exhausted, so no item is ever dropped.
//
// Usage:
//   node list-issues.mjs [--json] [--status NAME]... <project-number>
//   node list-issues.mjs [--json] --open <project-number>
//
// Default output is human-readable: one tab-separated line per item with numeric
// id, node id, status, [Order], Epic, and title, in board order.
// --json emits a compact array of { id, nodeId, status, epic, order, title } for
// programmatic consumers, consistent with fetch-issues.mjs and list-epic.mjs.
//
// With neither --status nor --open, every item is listed. Each --status NAME
// (repeatable) keeps only items whose Status equals NAME (case-insensitive);
// e.g. `--status Todo --status "In Progress"` is the common non-Done hygiene
// view. --open is shorthand for "every item whose Status is not Done" -- the
// cheap default for a backlog or orchestration session that does not need Done
// rows -- and is rejected together with --status rather than combined; pass the
// non-Done statuses you want explicitly instead.

import { fileURLToPath } from "node:url";
import { fetchAllItems } from "./lib/projectItems.mjs";

const USAGE =
  "Usage: node list-issues.mjs [--json] [--status NAME]... <project-number>\n" +
  "       node list-issues.mjs [--json] --open <project-number>\n";

/**
 * Parse the leading option flags (--json, --status NAME repeatable, --open) plus
 * the trailing project-number positional. Returns { ok: true, asJson, open,
 * statuses, projectNumber } on success or { ok: false, message } (a
 * newline-terminated string ready to write straight to stderr) on any malformed
 * input, including --open combined with --status. Pure, so a test can drive it
 * without touching argv or the network.
 */
export function parseArgs(argv) {
  let asJson = false;
  let open = false;
  const statuses = [];
  let i = 0;
  while (argv[i] !== undefined && argv[i].startsWith("--")) {
    if (argv[i] === "--json") {
      asJson = true;
      i += 1;
    } else if (argv[i] === "--open") {
      open = true;
      i += 1;
    } else if (argv[i] === "--status") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ok: false, message: "error: --status requires a value\n" };
      }
      statuses.push(value.toLowerCase());
      i += 2;
    } else {
      break;
    }
  }
  const rest = argv.slice(i);

  if (open && statuses.length > 0) {
    return {
      ok: false,
      message:
        "error: --open cannot be combined with --status -- list the non-Done statuses you want explicitly instead\n",
    };
  }

  const projectNumber = Number(rest[0]);
  if (!Number.isInteger(projectNumber) || rest.length !== 1) {
    return { ok: false, message: USAGE };
  }

  return { ok: true, asJson, open, statuses, projectNumber };
}

/**
 * Filter mapped items ({ id, nodeId, status, epic, order, title }) by the parsed
 * --status / --open options. With neither given, every item passes. --open keeps
 * every item whose Status is not Done (case-insensitive), including one with no
 * Status at all. Pure, so a test can drive it with synthetic items.
 */
export function filterItems(items, { statuses, open }) {
  if (open) {
    return items.filter(
      (item) => item.status === null || item.status.toLowerCase() !== "done",
    );
  }
  const wanted = new Set(statuses);
  if (wanted.size === 0) return items;
  return items.filter(
    (item) => item.status !== null && wanted.has(item.status.toLowerCase()),
  );
}

async function main() {
  // A whole-board dump is routinely piped to `head`/`grep`, which closes the
  // read end early; exit quietly on the resulting EPIPE instead of crashing.
  process.stdout.on("error", (err) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });

  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(parsed.message);
    process.exit(2);
  }
  const { asJson, open, statuses, projectNumber } = parsed;

  const items = filterItems(
    (await fetchAllItems(projectNumber)).map((item) => ({
      id: item.id,
      nodeId: item.nodeId,
      status: item.fields.Status ?? null,
      epic: item.fields.Epic ?? null,
      order: item.fields["Order"],
      title: item.title,
    })),
    { statuses, open },
  );

  if (asJson) {
    // Compact, not pretty-printed: --json feeds programmatic/agent consumers,
    // where indentation is dead weight in the reader's context.
    process.stdout.write(JSON.stringify(items) + "\n");
    return;
  }

  if (items.length === 0) {
    const filter = open
      ? " matching --open (Status != Done)"
      : statuses.length === 0
        ? ""
        : ` matching status ${[...new Set(statuses)].join(", ")}`;
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

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err.message ?? err}\n`);
    process.exit(1);
  });
}
