// The count bound every acceptance surface paints a partner-declared name list
// under, and the sentence a bounded list closes on.
//
// It lives beside the shared invitation summary for the reason the summary itself
// does: the CLI accept prompt and the two web surfaces render the same
// partner-declared lists, and a reader who meets a truncated declaration on one of
// them must meet the same cut and the same sentence on the next. Held here rather
// than in either app because `apps/` consumes `packages/` and never the reverse, so
// a constant two app workspaces share has no home inside one of them.

/**
 * How many of an invitation's declared payload column names a consent surface paints
 * before it stops and counts the rest.
 *
 * Those names are the partner's, bounded only by `MAX_PAYLOAD_ENTRIES` times
 * the escaped display ceiling each one takes at its sink, so painting a list whole
 * puts around a megabyte of text onto the screen or terminal holding it -- usability
 * denial rather than injection, the names being escaped. Every surface applying the
 * cap bounds what is PAINTED only: the refusals, remedies, labels, and counts each
 * derives from a declaration keep reading the whole set, so what the cap costs is
 * legibility of the tail, never the accuracy of what the reader is told.
 *
 * Sized to show a realistic declaration entire -- a payload set is a handful of
 * columns -- while leaving the flooded case a fixed height. Exported so the checks
 * that hold each surface's rendered size read the same number the renders do.
 */
export const MAX_DECLARED_NAMES_SHOWN = 10;

/**
 * The line a bounded list ends on, stating how many names it did not paint. Shared
 * by every surface that applies {@link MAX_DECLARED_NAMES_SHOWN}, so a reader meeting
 * a truncated declaration on one screen reads the same sentence on the next.
 *
 * A count, never a name: what it reports is the length of a partner-controlled list,
 * so no free text of theirs enters it.
 */
export function unshownDeclaredNamesLine(unshownCount: number): string {
  return `and ${unshownCount} more not shown here.`;
}
