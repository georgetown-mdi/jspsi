#!/usr/bin/env node
// Markdown link/anchor checker run by static_checks.yaml on every PR.
//
// It walks every tracked-or-untracked-but-not-ignored Markdown file, and for
// each inline link `](target)` asserts that the target resolves: a relative
// file/directory target must exist on disk, and a `#anchor` (into another file
// or the same one) must match a heading slug in the target document. A dead
// path or dead anchor fails the build. This is the mechanical forcing function
// that keeps the two-tier docs (docs/ overview, docs/spec/ technical) from
// drifting into stale cross-references on a future move or rename. External
// (http/https/mailto) links are not fetched; fenced code blocks and inline
// code spans are skipped so a `](` inside a code sample is not mistaken for a
// link.

import { execSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  stripCodeSpans,
  stripFences,
  UnterminatedFenceError,
} from "./lib/markdownFences.mjs";

// Tracked + untracked-but-not-gitignored .md files (so newly added docs are
// checked before they are committed, while node_modules/.worktrees/scratch
// stay excluded by .gitignore).
function listMarkdown(root) {
  const out = execSync(
    'git ls-files --cached --others --exclude-standard "*.md"',
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  return out.split("\n").filter(Boolean);
}

// GitHub-style heading slug: lowercase, drop characters that are not word
// characters (letters, digits, underscore), whitespace, or hyphen, then turn
// each remaining whitespace character into a hyphen without collapsing runs
// (so "ssh2 / ssh2" -> "ssh2--ssh2"). Inline links and code spans in a heading
// are reduced to their text first.
function slugify(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) -> text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "") // drop punctuation; \w keeps underscores, as GitHub does
    .trim()
    .replace(/\s/g, "-"); // each whitespace char -> hyphen, runs not collapsed
}

// A fence error names the document it read, so a target reached by absolute
// path is named the way a reader would type it.
const relativeToCwd = (absPath) => relative(process.cwd(), absPath) || absPath;

// Map of file path -> Set of available anchor slugs (with GitHub's -1/-2
// disambiguation suffixes for repeated headings).
const anchorCache = new Map();
function anchorsFor(absPath) {
  if (anchorCache.has(absPath)) return anchorCache.get(absPath);
  const anchors = new Set();
  if (existsSync(absPath) && statSync(absPath).isFile()) {
    const lines = stripFences(
      readFileSync(absPath, "utf8"),
      relativeToCwd(absPath),
    ).split("\n");
    const counts = new Map();
    for (const line of lines) {
      const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (!m) continue;
      const base = slugify(m[2]);
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      anchors.add(n === 0 ? base : `${base}-${n}`);
    }
  }
  anchorCache.set(absPath, anchors);
  return anchors;
}

/**
 * Scan `raw` (the content of `file`, read from `absPath`) for dead relative
 * link targets and dead in-file/cross-file anchors. Returns an array of
 * "file:line  reason" strings, empty when the document is clean. Throws
 * UnterminatedFenceError when this document, or one it links an anchor into,
 * opens a fenced code block that never closes: which lines are prose is then
 * unknown, and the links read out of them would be too.
 */
export function findFailures(file, absPath, raw) {
  const failures = [];
  // Drop HTML comments (example link syntax in PR/issue templates lives
  // there), then fenced code, then inline code spans, before scanning for
  // real links -- each stripping preserves line structure so a line number
  // derived from `match.index` below stays correct.
  const text = stripCodeSpans(
    stripFences(
      raw.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " ")),
      file,
    ),
  );
  const linkRe = /\]\(([^)]+)\)/g;
  let match;
  while ((match = linkRe.exec(text)) !== null) {
    let target = match[1].trim();
    // A link target may have a title: [x](path "title"); drop the title.
    const sp = target.indexOf(" ");
    if (sp !== -1) target = target.slice(0, sp);
    if (
      !target ||
      target.startsWith("http://") ||
      target.startsWith("https://") ||
      target.startsWith("mailto:")
    ) {
      continue;
    }
    const line = text.slice(0, match.index).split("\n").length;
    const hashIdx = target.indexOf("#");
    const pathPart = hashIdx === -1 ? target : target.slice(0, hashIdx);
    const anchor = hashIdx === -1 ? "" : target.slice(hashIdx + 1);

    const targetAbs =
      pathPart === ""
        ? absPath
        : resolve(dirname(absPath), decodeURIComponent(pathPart));

    if (pathPart !== "" && !existsSync(targetAbs)) {
      failures.push(`${file}:${line}  dead path -> ${pathPart}`);
      continue;
    }
    if (anchor) {
      // Only resolve anchors into Markdown documents.
      const anchorTargetIsMd = pathPart === "" || pathPart.endsWith(".md");
      if (anchorTargetIsMd) {
        const anchors = anchorsFor(targetAbs);
        if (!anchors.has(anchor.toLowerCase())) {
          failures.push(`${file}:${line}  dead anchor -> ${target}`);
        }
      }
    }
  }
  return failures;
}

// CLI entry: only runs when invoked directly, so the test can import
// findFailures without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const mdFiles = listMarkdown(root);
  const failures = [];
  for (const file of mdFiles) {
    const abs = resolve(root, file);
    const raw = readFileSync(abs, "utf8");
    try {
      failures.push(...findFailures(file, abs, raw));
    } catch (error) {
      if (!(error instanceof UnterminatedFenceError)) throw error;
      console.error(`Markdown link check failed: ${error.message}`);
      process.exit(1);
    }
  }

  if (failures.length > 0) {
    console.error(
      `Markdown link check failed (${failures.length} dead reference${failures.length === 1 ? "" : "s"}):\n`,
    );
    for (const f of failures.sort()) console.error("  " + f);
    console.error(
      "\nFix the path/anchor, or update the reference if a doc moved or was renamed.",
    );
    process.exit(1);
  }

  console.log(`Markdown link check passed (${mdFiles.length} files scanned).`);
}
