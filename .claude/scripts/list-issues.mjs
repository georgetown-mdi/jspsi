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
//   node list-issues.mjs [--json] [--all | --status NAME...] <project-number>
//
// Flags and the project number may appear in any order.
//
// Default output is human-readable: one tab-separated line per item with numeric
// id, node id, status, [Order], Epic, and title, in board order.
// --json emits a compact array of { id, nodeId, status, epic, order, title } for
// programmatic consumers, consistent with fetch-issues.mjs and list-epic.mjs.
//
// By default every item whose Status is not Done is listed -- what a backlog or
// orchestration session needs, without paying for the board's Done history.
// --all lists every item including Done (the dedupe/hygiene view, where a Done
// item covering the work is itself the answer). Each --status NAME (repeatable)
// keeps only items whose Status equals NAME (case-insensitive); e.g.
// `--status Done` reads the history the default omits. --all and --status are
// rejected together: --all means "no filter", so pass the statuses alone.
// --open (the historical name for the default) is still accepted.

import { fileURLToPath } from "node:url";
import { fetchAllItems } from "./lib/projectItems.mjs";

const USAGE =
  "Usage: node list-issues.mjs [--json] [--all | --status NAME...] <project-number>\n" +
  "       (lists non-Done items by default; flags may appear in any order)\n";

/**
 * Parse the option flags (--json, --all, --status NAME repeatable, --open) and
 * the project-number positional, in any order. Returns { ok: true, asJson, all,
 * statuses, projectNumber } on success or { ok: false, message } (a
 * newline-terminated string ready to write straight to stderr) on any malformed
 * input, including contradictory filter flags. Pure, so a test can drive it
 * without touching argv or the network.
 */
export function parseArgs(argv) {
  let asJson = false;
  let open = false;
  let all = false;
  const statuses = [];
  const positionals = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--json") {
      asJson = true;
      i += 1;
    } else if (arg === "--open") {
      open = true;
      i += 1;
    } else if (arg === "--all") {
      all = true;
      i += 1;
    } else if (arg === "--status") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ok: false, message: "error: --status requires a value\n" };
      }
      statuses.push(value.toLowerCase());
      i += 2;
    } else if (arg.startsWith("--")) {
      return { ok: false, message: USAGE };
    } else {
      positionals.push(arg);
      i += 1;
    }
  }

  if (all && (open || statuses.length > 0)) {
    return {
      ok: false,
      message:
        "error: --all cannot be combined with --open or --status -- --all means no filter, so pass the statuses alone\n",
    };
  }
  if (open && statuses.length > 0) {
    return {
      ok: false,
      message:
        "error: --open cannot be combined with --status -- non-Done is already the default, so pass the statuses alone\n",
    };
  }

  const projectNumber = Number(positionals[0]);
  if (!Number.isInteger(projectNumber) || positionals.length !== 1) {
    return { ok: false, message: USAGE };
  }

  return { ok: true, asJson, all, statuses, projectNumber };
}

/**
 * Filter mapped items ({ id, nodeId, status, epic, order, title }) by the parsed
 * --status / --all options. --status keeps only matching Statuses
 * (case-insensitive). --all passes every item through. The default keeps every
 * item whose Status is not Done (case-insensitive), including one with no
 * Status at all. Pure, so a test can drive it with synthetic items.
 */
export function filterItems(items, { statuses, all }) {
  const wanted = new Set(statuses);
  if (wanted.size > 0) {
    return items.filter(
      (item) => item.status !== null && wanted.has(item.status.toLowerCase()),
    );
  }
  if (all) return items;
  return items.filter(
    (item) => item.status === null || item.status.toLowerCase() !== "done",
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
  const { asJson, all, statuses, projectNumber } = parsed;

  const items = filterItems(
    (await fetchAllItems(projectNumber)).map((item) => ({
      id: item.id,
      nodeId: item.nodeId,
      status: item.fields.Status ?? null,
      epic: item.fields.Epic ?? null,
      order: item.fields["Order"],
      title: item.title,
    })),
    { statuses, all },
  );

  if (asJson) {
    // Compact, not pretty-printed: --json feeds programmatic/agent consumers,
    // where indentation is dead weight in the reader's context.
    process.stdout.write(JSON.stringify(items) + "\n");
    return;
  }

  if (items.length === 0) {
    const filter =
      statuses.length > 0
        ? ` matching status ${[...new Set(statuses)].join(", ")}`
        : all
          ? ""
          : " with Status != Done (--all includes Done)";
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
