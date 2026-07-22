/**
 * The pure navigation model behind the secrets-mount browser: descending into a
 * subdirectory, the breadcrumb trail back up, and the full subPath a picked file
 * yields. No React, no I/O -- the tested boundary for "the picker navigates and
 * selects the right path segments". Every segment is a single admissible name (the
 * server re-admits each and re-confines the realpath to the mount, so nothing here
 * is trusted as a path).
 */

/** Descend into `name` from the current `subPath`, appending one segment. */
export function enterSubdir(
  subPath: ReadonlyArray<string>,
  name: string,
): Array<string> {
  return [...subPath, name];
}

/** The subPath of a picked file: the current directory plus the file's name. */
export function fileSubPath(
  subPath: ReadonlyArray<string>,
  name: string,
): Array<string> {
  return [...subPath, name];
}

/** One breadcrumb: the label to show and the subPath navigating to it lands on. */
export interface MountBreadcrumb {
  label: string;
  subPath: Array<string>;
}

/**
 * The breadcrumb trail for `subPath`: the mount root (labeled `rootLabel`, an
 * empty subPath) followed by one crumb per segment, each carrying the subPath that
 * navigates back to it. So `["a", "b"]` yields root, `a` ([a]), `b` ([a, b]).
 */
export function breadcrumbTrail(
  rootLabel: string,
  subPath: ReadonlyArray<string>,
): Array<MountBreadcrumb> {
  const trail: Array<MountBreadcrumb> = [{ label: rootLabel, subPath: [] }];
  subPath.forEach((segment, index) => {
    trail.push({ label: segment, subPath: subPath.slice(0, index + 1) });
  });
  return trail;
}
