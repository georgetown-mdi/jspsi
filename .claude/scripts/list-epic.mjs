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

import {
  extractFields,
  FIELD_VALUES_FRAGMENT,
  gh,
  numericIdFromNodeId,
  OWNER,
} from "./lib/projectItems.mjs";

// GitHub's projectV2 items connection caps `first` at 100, so this is also the
// per-page size: fetchAllItems pages through the connection 100 at a time rather
// than relying on a single page covering the whole board.
const PAGE_SIZE = 100;

/**
 * Fetch all items of a project with their field values and node IDs, returning
 * [{ id, title, fields }] where id is the numeric item ID and fields is the
 * { name -> value } map (see extractFields). Pages through the items connection
 * with a cursor until hasNextPage is false, so no item is dropped however large
 * the board grows.
 */
function fetchAllItems(projectNumber) {
  const nodes = [];
  let cursor = null;
  do {
    // Inline the cursor into the query the same way the other args are inlined;
    // GitHub's endCursor is an opaque base64 token with no quote/backslash chars
    // to escape. Omit `after` entirely on the first page.
    const after = cursor === null ? "" : `, after: "${cursor}"`;
    const query = `{ organization(login: "${OWNER}") { projectV2(number: ${projectNumber}) { items(first: ${PAGE_SIZE}${after}) { pageInfo { hasNextPage endCursor } nodes { id ${FIELD_VALUES_FRAGMENT} content { __typename ... on DraftIssue { title } ... on Issue { title } } } } } } }`;
    const data = JSON.parse(
      gh(["api", "graphql", "-f", `query=${query}`]),
    ).data;
    const project = data?.organization?.projectV2;
    if (!project) {
      throw new Error(
        `project ${projectNumber} not found under owner ${OWNER}`,
      );
    }
    const conn = project.items;
    nodes.push(...conn.nodes);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor !== null);
  return nodes.map((node) => ({
    id: numericIdFromNodeId(node.id),
    title: node.content?.title ?? null,
    fields: extractFields(node.fieldValues),
  }));
}

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

function main() {
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
  const matches = fetchAllItems(projectNumber)
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

main();
