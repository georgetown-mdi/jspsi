#!/usr/bin/env node
//
// Lint GitHub Projects v2 draft-issue bodies, addressed by their numeric item ID
// (the `?itemId=N` value from the project web UI URL) or, equivalently, their
// `PVTI_...` global node ID -- the two forms mix freely, matching fetch-issues.mjs
// and edit-issue.mjs. Companion to fetch-issues.mjs and edit-issue.mjs.
//
// Draft bodies are written and revised by humans and language models that do not
// share a stable address space: an LLM may cite an opaque GraphQL node ID it
// cannot reopen, a typo'd item ID that resolves to nothing, or a source-file
// line anchor that has since drifted. None of these are caught by a normal read.
// This script fetches the given drafts and prints a grouped review report that
// flags those reference hazards so they can be fixed before the next reader
// trusts them.
//
// Usage:
//   node lint-issues.mjs <project-number> <itemId|PVTI_...> [more...] [--strict]
//
// Default exit is 0. With --strict, exit non-zero if any error-severity finding
// exists, so the linter can gate a workflow.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchItems, toNumericId } from "./lib/projectItems.mjs";

// Repo root: line-anchor staleness is checked against files here. This file
// lives at <root>/.claude/scripts/lint-issues.mjs, so the working tree root is
// two levels up. Derive it (not hardcode) so the linter resolves anchors
// against the checkout it actually runs in -- including git worktrees.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Opaque global node IDs (DraftIssue, ProjectV2Item, Project, Issue, PR). These
// cannot be opened through the numeric-itemId workflow, so citing one is a dead
// end for the next reader.
const NODE_ID_RE = /\b(DI|PVTI|PVT|I|PR)_[A-Za-z0-9_-]{6,}/g;

// Nine-digit board item IDs. Wide enough to be distinctive; the board's IDs are
// all in this range.
const ITEM_ID_RE = /\b\d{9}\b/g;

// Source-file line anchors like exchange.ts:142 -- fragile because line numbers
// drift as the file is edited.
const LINE_ANCHOR_RE = /\b[\w./-]+\.(?:ts|tsx|js|mjs|md):(\d+)/g;

// Review residue: phrases that only made sense in the conversation that produced
// the edit, not to a cold reader. Matched case-insensitively, per line.
const RESIDUE_PATTERNS = [
  /\brev \d+\b/i,
  /\bthe submitter\b/i,
  /\bas discussed\b/i,
  /\bwe discussed\b/i,
  /\bthe previous (?:approach|fix|item|body)\b/i,
  /\bthe other issue\b/i,
];

/**
 * A finding is { severity, message } where severity is one of
 * "error" | "warning" | "info". Severity drives the --strict exit code and the
 * printed tag; nothing else branches on it.
 */
function finding(severity, message) {
  return { severity, message };
}

/**
 * Collect distinct 9-digit IDs that appear in a body, and which of those appear
 * "bare" -- not in the `name (NNN)` / `(NNN, "...")` citation style the issues
 * otherwise use. A bare ID is heuristically defined as one not immediately
 * followed by `)` and not immediately preceded by `(`; that catches the two
 * citation shapes without trying to fully parse prose.
 */
function scanItemIds(body) {
  const all = new Set();
  const bare = new Set();
  for (const m of body.matchAll(ITEM_ID_RE)) {
    const id = m[0];
    all.add(id);
    const before = body[m.index - 1];
    const after = body[m.index + id.length];
    const cited = before === "(" || after === ")";
    if (!cited) bare.add(id);
  }
  return { all: [...all], bare: [...bare] };
}

/** Find opaque node-id references and turn each distinct one into an error finding. */
function checkNodeIds(body) {
  const out = [];
  const seen = new Set();
  for (const m of body.matchAll(NODE_ID_RE)) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push(
      finding(
        "error",
        `opaque node id "${m[0]}" cannot be opened by numeric itemId; cite the numeric itemId or the title instead`,
      ),
    );
  }
  return out;
}

/** Find review-residue / context-free phrases and report the offending line. */
function checkResidue(body) {
  const out = [];
  const lines = body.split("\n");
  for (const line of lines) {
    for (const re of RESIDUE_PATTERNS) {
      if (re.test(line)) {
        out.push(finding("warning", `context-free phrase: ${line.trim()}`));
        break; // one finding per line is enough to draw a reviewer's eye
      }
    }
  }
  return out;
}

/**
 * Check source-file line anchors. Returns { findings, files } where files is the
 * distinct set of referenced source paths. An anchor whose file exists locally
 * but has fewer lines than the cited number is flagged as likely-stale (error);
 * everything else contributes only to the per-issue fragility count (info).
 */
function checkLineAnchors(body) {
  const out = [];
  const files = new Set();
  let count = 0;
  // Cache line counts so repeated anchors into the same file read it once.
  const lineCounts = new Map();
  for (const m of body.matchAll(LINE_ANCHOR_RE)) {
    count += 1;
    const anchor = m[0];
    const path = anchor.slice(0, anchor.lastIndexOf(":"));
    const lineNo = Number(m[1]);
    files.add(path);

    const abs = resolve(REPO_ROOT, path);
    let total = lineCounts.get(abs);
    if (total === undefined) {
      // Only count lines for files inside the repo. A `..`-bearing anchor can
      // resolve outside REPO_ROOT; treat those as not-local and skip the check
      // rather than stat an arbitrary local file. REPO_ROOT keeps its trailing
      // slash, so this is a clean path-prefix test.
      total =
        abs.startsWith(REPO_ROOT) && existsSync(abs)
          ? readFileSync(abs, "utf8").split("\n").length
          : null; // null -> not local (outside repo or missing); skip the check
      lineCounts.set(abs, total);
    }
    if (total !== null && lineNo > total) {
      out.push(
        finding(
          "error",
          `line anchor "${anchor}" is past end of file (${path} has ${total} lines); likely stale`,
        ),
      );
    }
  }
  if (count > 0) {
    out.push(
      finding(
        "info",
        `${count} source-file line anchor(s) referenced (fragile to edits): ${[...files].join(", ")}`,
      ),
    );
  }
  return out;
}

/** Report whether the body has an `## Open questions` section. */
function checkOpenQuestions(body) {
  const has = /^#{1,6}\s+open questions\b/im.test(body);
  return [
    finding(
      "info",
      has
        ? "has an Open questions section (unresolved decisions to review)"
        : "no Open questions section",
    ),
  ];
}

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

async function main() {
  const argv = process.argv.slice(2);
  const strict = argv.includes("--strict");
  const positional = argv.filter((a) => a !== "--strict");

  const projectNumber = Number(positional[0]);
  // Each item argument is a numeric ID or a PVTI_ node ID; resolve both to
  // numeric so a node ID lints the same item as its numeric form.
  const numericIds = positional.slice(1).map(toNumericId);
  if (
    !Number.isInteger(projectNumber) ||
    numericIds.length === 0 ||
    numericIds.some((n) => !Number.isInteger(n))
  ) {
    process.stderr.write(
      "Usage: node lint-issues.mjs <project-number> <itemId|PVTI_...> [more...] [--strict]\n",
    );
    process.exit(2);
  }

  const items = await fetchItems(projectNumber, numericIds);
  const inSet = new Set(numericIds.map(String));

  // First pass: collect every distinct referenced 9-digit ID across all bodies
  // so they can be resolved in one extra round-trip (those not already in set).
  const referencedIds = new Set();
  const perItem = new Map();
  for (const item of items) {
    if (item.type === "missing" || item.body == null) continue;
    const ids = scanItemIds(item.body);
    perItem.set(item.id, ids);
    for (const id of ids.all) referencedIds.add(id);
  }
  const outsideSetIds = [...referencedIds].filter((id) => !inSet.has(id));
  // Batch-resolve only the referenced IDs that are not already in the given set;
  // ones in the set are known-good by construction.
  const resolved = new Map(); // string id -> { type, title } | null (unresolved)
  if (outsideSetIds.length > 0) {
    for (const r of await fetchItems(
      projectNumber,
      outsideSetIds.map(Number),
    )) {
      resolved.set(
        String(r.id),
        r.type === "missing" ? null : { type: r.type, title: r.title },
      );
    }
  }

  // Cross-issue edges: "A references B" where both A and B are in the set.
  const edges = [];
  let totalErrors = 0;
  let totalWarnings = 0;
  let totalInfos = 0;

  for (const item of items) {
    process.stdout.write(`=== ${item.id} ===\n`);
    if (item.type === "missing" || item.body == null) {
      process.stdout.write(`(not found on project ${projectNumber})\n\n`);
      continue;
    }
    process.stdout.write(`TITLE: ${item.title}\n`);

    const findings = [];
    findings.push(...checkNodeIds(item.body));

    // Item-ID cross-references.
    const ids = perItem.get(item.id);
    for (const refId of ids.all) {
      if (refId === String(item.id)) continue; // self-reference is not an edge
      if (inSet.has(refId)) {
        edges.push([String(item.id), refId]);
        findings.push(
          finding("info", `references item ${refId} (in this set)`),
        );
      } else {
        const r = resolved.get(refId);
        if (r === null || r === undefined) {
          findings.push(
            finding(
              "error",
              `item ${refId} does not resolve on the board; likely a typo'd or dead ID`,
            ),
          );
        } else {
          findings.push(
            finding(
              "info",
              `references item ${refId} (outside this set: ${r.type} "${r.title}")`,
            ),
          );
        }
      }
    }
    for (const bareId of ids.bare) {
      findings.push(
        finding(
          "warning",
          `item ID ${bareId} appears bare (not in "name (${bareId})" citation style)`,
        ),
      );
    }

    findings.push(...checkResidue(item.body));
    findings.push(...checkLineAnchors(item.body));
    findings.push(...checkOpenQuestions(item.body));

    // Stable order: errors first, then warnings, then info.
    findings.sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
    );
    for (const f of findings) {
      process.stdout.write(`  [${f.severity}] ${f.message}\n`);
      if (f.severity === "error") totalErrors += 1;
      else if (f.severity === "warning") totalWarnings += 1;
      else totalInfos += 1;
    }
    if (findings.length === 0) process.stdout.write("  (no findings)\n");
    process.stdout.write("\n");
  }

  // Cross-issue dependency summary.
  process.stdout.write("=== cross-issue summary ===\n");
  if (edges.length === 0) {
    process.stdout.write("  no intra-set dependency edges\n");
  } else {
    for (const [a, b] of edges) {
      process.stdout.write(`  ${a} references ${b}\n`);
    }
  }
  if (outsideSetIds.length > 0) {
    process.stdout.write(
      `  referenced IDs outside this set: ${outsideSetIds.join(", ")}\n`,
    );
  }
  process.stdout.write("\n");

  process.stdout.write(
    `total: ${totalErrors} error(s), ${totalWarnings} warning(s), ${totalInfos} info\n`,
  );

  if (strict && totalErrors > 0) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`${err.message ?? err}\n`);
  process.exit(1);
});
