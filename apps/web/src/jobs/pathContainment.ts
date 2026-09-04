import path from "node:path";

/**
 * Whether a path equal to the parent counts as contained by it: `"at-or-under"`
 * admits the parent itself, `"strictly-under"` admits only a path nested inside
 * it.
 */
export type PathContainmentBound = "at-or-under" | "strictly-under";

/**
 * Whether `child` is contained by `parent` over resolved absolute paths, with
 * `bound` deciding whether `parent` itself counts.
 *
 * Segment-aware in both directions: a sibling whose basename merely starts with
 * `..` (`/x/..data` under `/x`) is within, while a genuine `../` escape
 * (`/x/../y`) is not, and a child on another root or drive is never within.
 * Purely lexical -- it follows no symlink, so a caller that must not be fooled by
 * one resolves both paths through `realpath` before asking.
 */
export function isPathWithin(
  parent: string,
  child: string,
  bound: PathContainmentBound,
): boolean {
  const relative = path.relative(parent, child);
  if (relative === "") return bound === "at-or-under";
  return !(
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}
