import { readFileSync, readdirSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// How a check here finds, reads, and parses a TypeScript source of this
// repository. Every check that reads source comes through it, so a correction to
// how one of them reads source lands once instead of in one copy and silently
// not the others. What a check DECIDES about the tree it is handed -- which tree
// to walk, which shapes it refuses to read, what it concludes -- is that check's
// own claim and stays with it; nothing here reads a predicate of any of them.
//
// Two parse decisions, made the same way for every caller.
//
// The script kind follows the file name's extension. A .tsx source parsed as
// plain TypeScript loses its JSX: a call written inside an element is not in the
// tree at all, so a walk over it finds nothing to report and the check passes a
// file it never read. Nothing fails closed on that, which is why the extension
// decides rather than the caller.
//
// Parent pointers are always set. The tree is otherwise identical, so a caller
// that never walks upward pays the pointers and nothing else, while the
// alternative -- a per-caller flag -- hands a later ancestor walk a tree that
// cannot answer it, at the point where someone is reading a check's verdict
// rather than writing it.
//
// Everything here is syntactic and single-file: no program is built, so nothing
// resolves an import, a type, or a symbol. A check that needs to know what a
// name refers to decides that itself, and states what its decision reaches.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Read a repository-relative source file as this checkout ships it. */
export function readSource(file) {
  return readFileSync(resolve(root, file), "utf8");
}

/**
 * Parse source text under the file name a failure will name it by, which is
 * also what selects the script kind -- a synthetic `.tsx` fixture parses as one.
 */
export function parseSource(fileName, text) {
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Parse a repository-relative source file as this checkout ships it. */
export function parseFile(file) {
  return parseSource(file, readSource(file));
}

/** Every descendant of `node`, in source order. */
export function descendants(node) {
  const found = [];
  const visit = (child) => {
    found.push(child);
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

/**
 * Every file under a repository-relative `dir`, whatever its extension, itself
 * repository-relative and sorted -- the whole tree {@link sourceModules}
 * filters. A check that reads one extension holds that scope against the tree it
 * was pointed at by comparing the two, rather than stating in a comment which
 * extensions the tree holds. An absolute `dir` is taken as it stands, so a
 * fixture can point the same walk at a temporary tree.
 */
export function filesUnder(dir) {
  const found = [];
  for (const entry of readdirSync(resolve(root, dir), {
    withFileTypes: true,
  })) {
    const path = posix.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else found.push(path);
  }
  return found.sort();
}

/**
 * Every TypeScript source under a repository-relative `dir`, itself
 * repository-relative and sorted. Which tree to walk, and what else to fold into
 * the reading, is the calling check's own claim.
 */
export function sourceModules(dir) {
  return filesUnder(dir).filter((path) => /\.tsx?$/.test(path));
}
