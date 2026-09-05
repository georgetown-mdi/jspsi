import path from "node:path";

/**
 * Whether a path equal to the parent counts as contained by it: `"at-or-under"`
 * admits the parent itself, `"strictly-under"` admits only a path nested inside
 * it.
 */
export type PathContainmentBound = "at-or-under" | "strictly-under";

/**
 * Whether `child` is contained by `parent`, with `bound` deciding whether
 * `parent` itself counts. Both must be absolute; a relative one throws, because
 * `path.relative` would silently resolve it against the process working
 * directory and answer about a path the caller never named.
 *
 * Segment-aware in both directions: a sibling whose basename merely starts with
 * `..` (`/x/..data` under `/x`) is within, while a genuine `../` escape
 * (`/x/../y`) is not, and a child on another root or drive is never within.
 * Purely lexical -- it follows no symlink, so a caller that must not be fooled by
 * one resolves both paths through `realpath` before asking.
 *
 * @throws {Error} if `parent` or `child` is not an absolute path.
 */
export function isPathWithin(
  parent: string,
  child: string,
  bound: PathContainmentBound,
): boolean {
  if (!path.isAbsolute(parent))
    throw new Error(
      "isPathWithin: parent must be an absolute path; resolve it before asking",
    );
  if (!path.isAbsolute(child))
    throw new Error(
      "isPathWithin: child must be an absolute path; resolve it before asking",
    );
  const relative = path.relative(parent, child);
  if (relative === "") return bound === "at-or-under";
  return !(
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}
