// Resolving a path a tool was handed into the path the filesystem will use.
//
// Two hooks decide whether a write lands somewhere it must not, and both have to
// answer for a path that does not exist yet: a fresh Write names a file nobody
// created, and a redirect creates one. `realpathSync` refuses such a path
// outright, so each walks up to the part that does exist, resolves that, and
// puts the rest back -- the same walk, and the same off-by-one to get wrong.
// It lives here rather than in two copies for that reason.

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * The path with symlinks resolved through the part of it that exists on disk, so
 * a file reached through a symlinked parent matches the absolute paths git and
 * the filesystem report. Components below the deepest existing ancestor are
 * appended unresolved, which is what a path being created has. A path nothing of
 * which resolves comes back unchanged.
 */
export function canonicalPath(path) {
  const trailing = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...trailing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      trailing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * The deepest existing directory above `path`, the directory a question about
 * `path` can be put to git or the filesystem from; null when not even the root
 * of it exists.
 */
export function nearestExistingDirectory(path) {
  let current = dirname(path);
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
