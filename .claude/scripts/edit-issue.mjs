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
// The <itemId> may be EITHER a numeric ID (the `?itemId=N` value) OR a
// `PVTI_...` global node ID as printed by `list-issues.mjs`; the node ID is
// decoded back to its numeric ID, so a listed item can be edited without
// hand-decoding it. A node ID from a different board than <project-number> is
// rejected rather than silently remapped.
//
// Usage:
//   node edit-issue.mjs <project-number> <itemId|PVTI_...> [edits...]
//
// Edits (any combination, applied in one run):
//   --title "..."                 set the draft title
//   --body  "..."                 set the draft body
//   --body-file PATH              set the draft body from a file
//   --status "In Progress"        shortcut for --field Status --value "In Progress"
//   --field NAME --value VALUE     set a field by name (repeatable)
//   --diff                         print a unified diff of the body, then apply
//                                  (body edits only; ignored without --body/--body-file)
//   --dry-run, -n                  resolve and report what would change, but make no
//                                  edits; implies a body diff when a body edit is given
//
// Title/body edits are round-trip-safe: an edit whose new value is identical to
// the stored value (ignoring trailing newlines) is skipped (no API call), and
// after an edit actually runs the stored value is re-fetched and verified
// against what was sent. This guards against silent no-op "successes" on
// unchanged content.
//
// Field/option names are matched case-insensitively. Supported field types:
// single-select (option resolved by name), text, number, and date. Iteration
// and other field types are reported as unsupported rather than guessed at.

import { readFileSync } from "node:fs";
import {
  fetchItems,
  fieldValueInput,
  graphql,
  OWNER,
  pvtiNodeId,
  toNumericId,
} from "./lib/projectItems.mjs";

/** Parse argv into { projectNumber, numericId, title?, body?, fields: [{name, value}] }. */
function parseArgs(argv) {
  const projectNumber = Number(argv[0]);
  // The item argument is a numeric ID or a PVTI_ node ID; resolve both to
  // numeric, passing the project so a node ID from another board is rejected.
  // A malformed/mismatched PVTI_ id throws (a clearer signal than the NaN below).
  const itemArg = argv[1] ?? "";
  const numericId = toNumericId(itemArg, projectNumber);
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
      case "--dry-run":
      case "-n":
        out.dryRun = true;
        i += 1;
        break;
      default:
        usage(`unknown flag: ${flag}`);
    }
  }

  if (
    out.title === undefined &&
    out.body === undefined &&
    out.fields.length === 0
  ) {
    usage("no edits given");
  }
  return out;
}

function usage(msg) {
  if (msg) process.stderr.write(`error: ${msg}\n`);
  process.stderr.write(
    "Usage: node edit-issue.mjs <project-number> <itemId|PVTI_...> " +
      "[--title T] [--body B | --body-file PATH] [--status S] [--field NAME --value VAL]... [--diff] [--dry-run|-n]\n",
  );
  process.exit(2);
}

/**
 * Resolve a draft item's DI_ content node ID from its PVTI_ item ID. Title/body
 * edits target the DraftIssue content object, not the project item.
 */
async function draftContentId(pvti) {
  const query = `{ node(id: "${pvti}") { ... on ProjectV2Item { content { __typename ... on DraftIssue { id } } } } }`;
  const content = (await graphql(query)).data.node?.content;
  if (!content || content.__typename !== "DraftIssue") {
    throw new Error(
      `item is not a draft issue (content type ${content?.__typename ?? "unknown"}); title/body editing is only supported for drafts`,
    );
  }
  return content.id;
}

/**
 * Compare a sent value against the value GitHub stored. GitHub may append or
 * normalize trailing newlines on a draft body, and round-trips can vary the
 * count of trailing blank lines, so a difference confined to trailing newlines
 * is tolerated; any difference in interior or non-blank trailing content is a
 * real mismatch. Matches the trailing-newline normalization in printBodyDiff so
 * the apply/skip decision and the rendered diff agree on what "unchanged" means.
 */
function equalsStored(sent, stored) {
  if (sent === stored) return true;
  const strip = (s) => s.replace(/\n+$/, "");
  return strip(sent) === strip(stored);
}

/**
 * Print a minimal line-based diff of old vs new. Not a true LCS diff: it trims
 * the common leading and trailing lines and shows the differing middle as a
 * deletion block followed by an addition block, framed by a few lines of
 * context. This renders a contiguous block replacement, insertion, or deletion
 * cleanly -- the common shapes for a body edit -- instead of cascading every
 * line after an offset as changed, and needs no diff dependency.
 */
function printBodyDiff(label, oldText, newText) {
  // Normalize trailing newlines before splitting. GitHub may append a newline to
  // a stored body and round-trips can vary the count of trailing blank lines; an
  // asymmetric tail would make the last lines differ and defeat the common-suffix
  // trim, collapsing a localized edit into a whole-body replacement. Trailing
  // blank lines are not meaningful to show, so strip them from both sides. This
  // is display-only; the apply/skip decision still uses equalsStored.
  const strip = (s) => s.replace(/\n+$/, "");
  const oldLines = strip(oldText).split("\n");
  const newLines = strip(newText).split("\n");

  let start = 0;
  const maxStart = Math.min(oldLines.length, newLines.length);
  while (start < maxStart && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  process.stdout.write(`--- ${label} (old)\n+++ ${label} (new)\n`);
  if (start === oldEnd && start === newEnd) {
    process.stdout.write("  (no line-level changes)\n");
    return;
  }

  // Common prefix/suffix lines are identical in both, so either array serves as
  // the source for the surrounding context.
  const CONTEXT = 3;
  for (let i = Math.max(0, start - CONTEXT); i < start; i += 1)
    process.stdout.write(`  ${oldLines[i]}\n`);
  for (let i = start; i < oldEnd; i += 1)
    process.stdout.write(`- ${oldLines[i]}\n`);
  for (let i = start; i < newEnd; i += 1)
    process.stdout.write(`+ ${newLines[i]}\n`);
  for (let i = oldEnd; i < Math.min(oldLines.length, oldEnd + CONTEXT); i += 1)
    process.stdout.write(`  ${oldLines[i]}\n`);
}

/**
 * Fetch a project's node ID and its field list in one GraphQL call, returning
 * { projectId, fields } where each field carries { id, name, dataType,
 * options? }. `dataType` (TEXT / NUMBER / DATE / SINGLE_SELECT / ...) is the
 * precise field kind; the old `gh project field-list` porcelain collapsed text,
 * number, and date all to one type, forcing a value-shape guess at write time.
 * Replaces both `gh project view` (project id) and `gh project field-list`.
 */
async function projectMeta(projectNumber) {
  const query = `{ organization(login: "${OWNER}") { projectV2(number: ${projectNumber}) { id fields(first: 50) { nodes { __typename ... on ProjectV2FieldCommon { id name dataType } ... on ProjectV2SingleSelectField { options { id name } } } } } } }`;
  const project = (await graphql(query)).data?.organization?.projectV2;
  if (!project) {
    throw new Error(`project ${projectNumber} not found under owner ${OWNER}`);
  }
  return { projectId: project.id, fields: project.fields.nodes };
}

/** Find a field (case-insensitive) in a fetched field list. */
function findField(fields, name) {
  const field = fields.find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (!field) {
    const names = fields.map((f) => f.name).join(", ");
    throw new Error(`field "${name}" not found; available: ${names}`);
  }
  return field;
}

/** Set one project-item field value via a GraphQL mutation. */
async function setItemFieldValue(projectId, itemId, fieldId, value) {
  const mutation = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) { updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }) { projectV2Item { id } } }`;
  const res = await graphql(mutation, { projectId, itemId, fieldId, value });
  if (res.errors) {
    throw new Error(`failed to set field: ${JSON.stringify(res.errors)}`);
  }
}

/**
 * Set a draft issue's title and/or body via a GraphQL mutation. Only the keys
 * present in `edits` are sent: an omitted field is left untouched, whereas an
 * explicit null would clear it.
 */
async function setDraftFields(draftId, edits) {
  const varDecls = ["$draftId: ID!"];
  const inputParts = ["draftIssueId: $draftId"];
  const variables = { draftId };
  if (edits.title !== undefined) {
    varDecls.push("$title: String!");
    inputParts.push("title: $title");
    variables.title = edits.title;
  }
  if (edits.body !== undefined) {
    varDecls.push("$body: String!");
    inputParts.push("body: $body");
    variables.body = edits.body;
  }
  const mutation = `mutation(${varDecls.join(", ")}) { updateProjectV2DraftIssue(input: { ${inputParts.join(", ")} }) { draftIssue { id } } }`;
  const res = await graphql(mutation, variables);
  if (res.errors) {
    throw new Error(`failed to update draft: ${JSON.stringify(res.errors)}`);
  }
}

async function main() {
  // A long diff is often piped to head/less; exit quietly when the reader closes
  // the pipe rather than crashing with an EPIPE stack trace.
  process.stdout.on("error", (err) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });

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
    const before = (await fetchItems(args.projectNumber, [args.numericId]))[0];
    if (before.type === "missing") {
      throw new Error(
        `item ${args.numericId} not found on project ${args.projectNumber}`,
      );
    }

    // Decide what actually changes; skip byte-identical edits so an unchanged
    // push does not masquerade as a success.
    const wantTitle =
      args.title !== undefined && !equalsStored(args.title, before.title ?? "");
    const wantBody =
      args.body !== undefined && !equalsStored(args.body, before.body ?? "");

    // --dry-run implies a body diff so the preview shows what would change.
    if ((args.diff || args.dryRun) && args.body !== undefined) {
      printBodyDiff("body", before.body ?? "", args.body);
    }
    if (args.title !== undefined && !wantTitle) {
      process.stdout.write("title unchanged, skipping\n");
    }
    if (args.body !== undefined && !wantBody) {
      process.stdout.write("body unchanged, skipping\n");
    }

    if (wantTitle || wantBody) {
      const changed = [];
      if (wantTitle) changed.push("title");
      if (wantBody) changed.push("body");

      if (args.dryRun) {
        process.stdout.write(`dry-run: would set ${changed.join(", ")}\n`);
      } else {
        await setDraftFields(await draftContentId(itemId), {
          ...(wantTitle ? { title: args.title } : {}),
          ...(wantBody ? { body: args.body } : {}),
        });
        process.stdout.write(`set ${changed.join(", ")}\n`);

        // Verify: re-fetch and assert the store matches what we sent. Tolerates
        // trailing-newline-only differences GitHub may introduce (see
        // equalsStored); anything else is a real failure.
        const after = (
          await fetchItems(args.projectNumber, [args.numericId])
        )[0];
        if (wantTitle && !equalsStored(args.title, after.title ?? "")) {
          throw new Error(
            "post-push verify failed: stored title differs from sent title",
          );
        }
        if (wantBody && !equalsStored(args.body, after.body ?? "")) {
          throw new Error(
            "post-push verify failed: stored body differs from sent body",
          );
        }
        process.stdout.write("verified\n");
      }
    }
  }

  // Field edits each need the project node ID and the field list; fetch both
  // once if any are requested.
  if (args.fields.length > 0) {
    const { projectId, fields } = await projectMeta(args.projectNumber);
    for (const { name, value } of args.fields) {
      const field = findField(fields, name);
      // Resolve (and validate) the field/option name even in a dry run, so a
      // bad field or option name is reported without making any edit.
      const valueInput = fieldValueInput(field, value);
      if (args.dryRun) {
        process.stdout.write(`dry-run: would set ${field.name} = ${value}\n`);
      } else {
        await setItemFieldValue(projectId, itemId, field.id, valueInput);
        process.stdout.write(`set ${field.name} = ${value}\n`);
      }
    }
  }
}

main().catch((err) => {
  process.stderr.write(`${err.message ?? err}\n`);
  process.exit(1);
});
