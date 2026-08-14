/**
 * How the acceptor's confirm-columns screen shows one of the operator's column
 * names: verbatim, inside a bidi isolate. Every column-name sink on that screen
 * goes through this module -- the grid's row header and its two control labels,
 * the quick-fix mapper's options, the disclosed-columns panel, the alert naming
 * the columns the invitation will not accept, and the grid's live regions -- so
 * one name reads the same wherever the screen puts it.
 *
 * These names are the operator's OWN CSV header, read from the file they chose,
 * not the partner-controlled text `sanitizeForDisplay` exists for, so they do not
 * take its escape. What they do need is layout containment: a header carrying a
 * right-to-left override, or an embedding it never closes, otherwise reorders the
 * sentence, label, or table row it is interpolated into -- and this is the screen
 * where the operator decides what leaves their machine, so the copy around a name
 * has to mean what it says. Isolation buys exactly that and spends nothing else:
 * an accented or non-Latin header renders as itself rather than as escapes on the
 * operator's own authoring surface, and two long headers sharing a prefix stay
 * distinct because nothing is truncated.
 *
 * The boundary, because it does not show in the rendering: a homoglyph
 * (Cyrillic U+0430 for Latin "a") or a zero-width character inside a name is
 * shown as it is, so two headers differing only by one read alike here. Escaping
 * would tell those apart, at the price of the two costs above -- and the names are
 * the operator's own file's, so what the boundary costs is legibility of their own
 * header, never a disclosure. Nothing here decides what is sent; it decides only
 * how the name reads.
 */

/**
 * FIRST STRONG ISOLATE and POP DIRECTIONAL ISOLATE (Unicode UAX #9). Text between
 * them is laid out on its own resolved direction, and the whole isolate counts as
 * a single neutral character to the text around it, so nothing inside can reorder
 * anything outside. PDI also terminates any embedding or override the isolated
 * text left open, which is what bounds an unbalanced name.
 */
const FIRST_STRONG_ISOLATE = "\u2068";
const POP_DIRECTIONAL_ISOLATE = "\u2069";

/**
 * One column name for a STRING sink -- an `aria-label`, a native `<option>`
 * label, a live-region sentence -- where the surrounding copy is one string and
 * no element can carry the isolation. {@link ColumnName} is the same treatment
 * where the sink takes JSX; prefer it, since it leaves the isolation in the
 * markup rather than in the text the operator can select and copy.
 *
 * Applied to every name unconditionally: whether a given name can reorder its
 * surroundings is a question about Unicode bidi classes, and an unconditional
 * wrap is a property a reader can check by looking at the call site.
 */
export function isolatedColumnName(name: string): string {
  return FIRST_STRONG_ISOLATE + name + POP_DIRECTIONAL_ISOLATE;
}

/**
 * One column name as rendered text: the name verbatim inside a `<bdi>`, whose
 * `unicode-bidi: isolate` is the markup form of {@link isolatedColumnName}. The
 * element carries the isolation, so the name the operator selects and copies out
 * of the page is their own header and nothing more.
 */
export function ColumnName({ name }: { name: string }) {
  return <bdi>{name}</bdi>;
}
