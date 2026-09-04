// The count bound every acceptance surface paints a partner-declared name list
// under, and the sentence a bounded list closes on. Lives in packages/core,
// not either app, because apps/ consumes packages/ and never the reverse, and
// the CLI accept prompt and both web surfaces share this constant.

/**
 * How many of an invitation's declared payload column names a consent
 * surface paints before it stops and counts the rest. The names are the
 * partner's and unbounded in practice, so the cap keeps a flooded
 * declaration off the screen; it bounds what is PAINTED only, and every
 * refusal, remedy, label, or count derived from the declaration still reads
 * it whole. Exported so the checks on each surface's rendered size read the
 * same number the renders do.
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
