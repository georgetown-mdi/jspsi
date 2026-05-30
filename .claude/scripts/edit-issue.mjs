#!/usr/bin/env node
//
// Edit a GitHub Projects v2 draft issue by its numeric item ID (the `?itemId=N`
// value from the project web UI URL). Companion to fetch-issues.mjs.
//
// Editing items by hand through gh is the highest opaque-ID operation in the
// Projects API: setting a field value needs the item node ID, the project node
// ID, the field ID, and (for single-selects) the option ID -- none of which are
// the numeric ID you have from the URL. This script resolves all of them from
// the numeric ID plus human-readable field/option names, so callers never juggle
// node IDs or look up option IDs by hand.
//
// Usage:
//   node edit-issue.mjs <project-number> <itemId> [edits...]
//
// Edits (any combination, applied in one run):
//   --title "..."                 set the draft title
//   --body  "..."                 set the draft body
//   --body-file PATH              set the draft body from a file
//   --status "In Progress"        shortcut for --field Status --value "In Progress"
//   --field NAME --value VALUE     set a field by name (repeatable)
//   --diff                         print a unified diff of the body before applying
//                                  (body edits only; a no-op without --body/--body-file)
//
// Title/body edits are round-trip-safe: an edit whose new value is byte-
// identical to the stored value is skipped (no API call), and after an edit
// actually runs the stored value is re-fetched and verified against what was
// sent. This guards against silent no-op "successes" on unchanged content.
//
// Field/option names are matched case-insensitively. Supported field types:
// single-select (option resolved by name), text, number, and date. Iteration
// and other field types are reported as unsupported rather than guessed at.

import { readFileSync } from "node:fs";
import { fetchItems, gh, OWNER, pvtiNodeId } from "./lib/projectItems.mjs";

/** Parse argv into { projectNumber, numericId, title?, body?, fields: [{name, value}] }. */
function parseArgs(argv) {
  const projectNumber = Number(argv[0]);
  const numericId = Number(argv[1]);
  if (!Number.isInteger(projectNumber) || !Number.isInteger(numericId)) {
    usage();
  }

  const out = { projectNumber, numericId, fields: [] };
  let i = 2;
  while (i < argv.length) {
    const flag = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) usage(`${flag} requires a value`);
      i += 2;
      return v;
    };
    switch (flag) {
      case "--title":
        out.title = next();
        break;
      case "--body":
        out.body = next();
        break;
      case "--body-file":
        out.body = readFileSync(next(), "utf8");
        break;
      case "--status":
        out.fields.push({ name: "Status", value: next() });
        break;
      case "--field": {
        const name = next();
        if (argv[i] !== "--value") usage("--field must be followed by --value");
        const value = next();
        out.fields.push({ name, value });
        break;
      }
      case "--diff":
        out.diff = true;
        i += 1;
        break;
      default:
        usage(`unknown flag: ${flag}`);
    }
  }

  if (out.title === undefined && out.body === undefined && out.fields.length === 0) {
    usage("no edits given");
  }
  return out;
}

function usage(msg) {
  if (msg) process.stderr.write(`error: ${msg}\n`);
  process.stderr.write(
    "Usage: node edit-issue.mjs <project-number> <itemId> " +
      "[--title T] [--body B | --body-file PATH] [--status S] [--field NAME --value VAL]... [--diff]\n",
  );
  process.exit(2);
}

/**
 * Resolve a draft item's DI_ content node ID from its PVTI_ item ID. Title/body
 * edits target the DraftIssue content object, not the project item.
 */
function draftContentId(pvti) {
  const query = `{ node(id: "${pvti}") { ... on ProjectV2Item { content { __typename ... on DraftIssue { id } } } } }`;
  const content = JSON.parse(gh(["api", "graphql", "-f", `query=${query}`])).data.node?.content;
  if (!content || content.__typename !== "DraftIssue") {
    throw new Error(
      `item is not a draft issue (content type ${content?.__typename ?? "unknown"}); title/body editing is only supported for drafts`,
    );
  }
  return content.id;
}

/**
 * Compare a sent value against the value GitHub stored. GitHub may append a
 * single trailing newline to a draft body, so a lone trailing-newline
 * difference is tolerated; any other difference (including interior content or
 * more than one trailing newline) is treated as a real mismatch.
 */
function equalsStored(sent, stored) {
  if (sent === stored) return true;
  const strip = (s) => s.replace(/\n$/, "");
  return strip(sent) === strip(stored);
}

/**
 * Print a minimal line-based unified diff of old vs new. Not a true LCS diff:
 * lines present in both at the same position are context, others are shown as a
 * deletion block followed by an addition block. Adequate for an at-a-glance
 * review of a body edit without pulling in a diff dependency.
 */
function printBodyDiff(label, oldText, newText) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  process.stdout.write(`--- ${label} (old)\n+++ ${label} (new)\n`);
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i += 1) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === n) {
      if (o !== undefined) process.stdout.write(`  ${o}\n`);
      continue;
    }
    if (o !== undefined) process.stdout.write(`- ${o}\n`);
    if (n !== undefined) process.stdout.write(`+ ${n}\n`);
  }
}

/** Find a field (case-insensitive) in the project's field list. */
function findField(projectNumber, name) {
  const fields = JSON.parse(
    gh(["project", "field-list", String(projectNumber), "--owner", OWNER, "--format", "json"]),
  ).fields;
  const field = fields.find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (!field) {
    const names = fields.map((f) => f.name).join(", ");
    throw new Error(`field "${name}" not found on project ${projectNumber}; available: ${names}`);
  }
  return field;
}

/** Build the gh item-edit args that set one field value, resolving option IDs as needed. */
function fieldEditArgs(field, value, itemId, projectId) {
  const base = ["--id", itemId, "--project-id", projectId, "--field-id", field.id];
  switch (field.type) {
    case "ProjectV2SingleSelectField": {
      const option = field.options.find((o) => o.name.toLowerCase() === value.toLowerCase());
      if (!option) {
        const names = field.options.map((o) => o.name).join(", ");
        throw new Error(`option "${value}" not valid for "${field.name}"; choices: ${names}`);
      }
      return [...base, "--single-select-option-id", option.id];
    }
    case "ProjectV2Field":
      // Plain field: text, number, or date. gh picks the column by which flag
      // is set, but the API does not tell us which of the three this field is,
      // so we infer from the value's shape. Caveat: an all-digit or YYYY-MM-DD
      // value bound for a *text* field is misrouted to --number / --date. No
      // board field in use hits this; revisit if a text field needs such a value.
      if (/^\d+$/.test(value)) return [...base, "--number", value];
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return [...base, "--date", value];
      return [...base, "--text", value];
    default:
      throw new Error(
        `field "${field.name}" has unsupported type ${field.type}; extend edit-issue.mjs to handle it`,
      );
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const itemId = pvtiNodeId(args.projectNumber, args.numericId);

  // --diff only renders a body diff; warn rather than silently ignore it when
  // there is no body edit to diff against.
  if (args.diff && args.body === undefined) {
    process.stderr.write(
      "note: --diff applies to body edits only; no --body/--body-file given, nothing to diff\n",
    );
  }

  // Title/body are draft-content edits: they target the DI_ content node, not
  // the PVTI_ item node, and go in one call.
  if (args.title !== undefined || args.body !== undefined) {
    // Fetch current values once: needed for no-op detection, --diff, and the
    // post-push verification re-fetch below.
    const before = fetchItems(args.projectNumber, [args.numericId])[0];
    if (before.type === "missing") {
      throw new Error(`item ${args.numericId} not found on project ${args.projectNumber}`);
    }

    // Decide what actually changes; skip byte-identical edits so an unchanged
    // push does not masquerade as a success.
    const wantTitle =
      args.title !== undefined && !equalsStored(args.title, before.title ?? "");
    const wantBody =
      args.body !== undefined && !equalsStored(args.body, before.body ?? "");

    if (args.diff && args.body !== undefined) {
      printBodyDiff("body", before.body ?? "", args.body);
    }
    if (args.title !== undefined && !wantTitle) {
      process.stdout.write("title unchanged, skipping\n");
    }
    if (args.body !== undefined && !wantBody) {
      process.stdout.write("body unchanged, skipping\n");
    }

    if (wantTitle || wantBody) {
      const edit = ["project", "item-edit", "--id", draftContentId(itemId)];
      const changed = [];
      if (wantTitle) {
        edit.push("--title", args.title);
        changed.push("title");
      }
      if (wantBody) {
        edit.push("--body", args.body);
        changed.push("body");
      }
      gh(edit);
      process.stdout.write(`set ${changed.join(", ")}\n`);

      // Verify: re-fetch and assert the store matches what we sent. Tolerates a
      // single trailing-newline difference GitHub may introduce (see
      // equalsStored); anything else is a real failure.
      const after = fetchItems(args.projectNumber, [args.numericId])[0];
      if (wantTitle && !equalsStored(args.title, after.title ?? "")) {
        throw new Error("post-push verify failed: stored title differs from sent title");
      }
      if (wantBody && !equalsStored(args.body, after.body ?? "")) {
        throw new Error("post-push verify failed: stored body differs from sent body");
      }
      process.stdout.write("verified\n");
    }
  }

  // Field edits each need the project node ID; resolve it once if any are requested.
  if (args.fields.length > 0) {
    const projectId = JSON.parse(
      gh(["project", "view", String(args.projectNumber), "--owner", OWNER, "--format", "json"]),
    ).id;
    for (const { name, value } of args.fields) {
      const field = findField(args.projectNumber, name);
      gh(["project", "item-edit", ...fieldEditArgs(field, value, itemId, projectId)]);
      process.stdout.write(`set ${field.name} = ${value}\n`);
    }
  }
}

main();
