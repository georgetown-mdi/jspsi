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
// (http/https/mailto) links are not fetched; fenced code blocks are skipped so
// a `](` inside a code sample is not mistaken for a link.

import { execSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { stripFences } from "./lib/markdownFences.mjs";

const root = process.cwd();

// Tracked + untracked-but-not-gitignored .md files (so newly added docs are
// checked before they are committed, while node_modules/.worktrees/scratch
// stay excluded by .gitignore).
function listMarkdown() {
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

// Map of file path -> Set of available anchor slugs (with GitHub's -1/-2
// disambiguation suffixes for repeated headings).
const anchorCache = new Map();
function anchorsFor(absPath) {
  if (anchorCache.has(absPath)) return anchorCache.get(absPath);
  const anchors = new Set();
  if (existsSync(absPath) && statSync(absPath).isFile()) {
    const lines = readFileSync(absPath, "utf8").split("\n");
    let inFence = false;
    const counts = new Map();
    for (const line of lines) {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
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

const linkRe = /\]\(([^)]+)\)/g;
const failures = [];
const mdFiles = listMarkdown();

for (const file of mdFiles) {
  const abs = resolve(root, file);
  const raw = readFileSync(abs, "utf8");
  // Drop HTML comments (example link syntax in PR/issue templates lives there)
  // then fenced code, before scanning for real links.
  const text = stripFences(raw.replace(/<!--[\s\S]*?-->/g, ""));
  let match;
  while ((match = linkRe.exec(text)) !== null) {
    let target = match[1].trim();
    // A link target may carry a title: [x](path "title"); drop the title.
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
        ? abs
        : resolve(dirname(abs), decodeURIComponent(pathPart));

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
