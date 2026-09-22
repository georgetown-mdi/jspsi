import YAML from "yaml";

/**
 * Render guidance lines as the comment body the `yaml` writer takes: one
 * leading space per non-empty line, so each is written as `# <line>` and a
 * blank line stays blank.
 */
export function commentBlock(lines: Array<string>): string {
  return lines.map((line) => (line.length > 0 ? ` ${line}` : "")).join("\n");
}

/**
 * Attach a block comment before the key at `path` in the document. A no-op when
 * the path's parent is not a mapping or the key is absent -- a caller's paths
 * track the shape it builds, so a miss means that shape changed and the caller
 * should be updated, not that the render should fail.
 */
export function commentKey(
  doc: YAML.Document,
  path: Array<string>,
  lines: Array<string>,
): void {
  const parentPath = path.slice(0, -1);
  const key = path[path.length - 1];
  const parent =
    parentPath.length === 0 ? doc.contents : doc.getIn(parentPath, true);
  if (!YAML.isMap(parent)) return;
  for (const pair of parent.items) {
    if (YAML.isScalar(pair.key) && pair.key.value === key) {
      pair.key.commentBefore = commentBlock(lines);
      return;
    }
  }
}
