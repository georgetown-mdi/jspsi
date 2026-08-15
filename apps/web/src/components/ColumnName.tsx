import { DISPLAY_TRUNCATION_MARKER, MAX_NAME_LENGTH } from "@psilink/core";

/**
 * How the acceptor's confirm-columns screen shows one of the operator's column
 * names: verbatim, inside a bidi isolate. Every column-name sink on that screen
 * goes through this module -- the grid's row header and its two control labels,
 * the quick-fix mapper's options, the disclosed-columns panel, the alert naming
 * the operator's own columns in the payload-declaration conflict notice (whose
 * declaration-sourced names take the escape instead), the grid's live regions, and the
 * ledger's "You will send" row -- so one name reads the same wherever the screen
 * puts it.
 *
 * These names are the operator's OWN CSV header, read from the file they chose,
 * not the partner-controlled text `sanitizeForDisplay` exists for, so they do not
 * take its escape. What they do need is layout containment: a header carrying a
 * right-to-left override, or an embedding it never closes, otherwise reorders the
 * sentence, label, or table row it is interpolated into -- and this is the screen
 * where the operator decides what leaves their machine, so the copy around a name
 * has to mean what it says. Isolation buys exactly that and spends almost nothing
 * else: an accented or non-Latin header renders as itself rather than as escapes
 * on the operator's own authoring surface, and two headers sharing a long prefix
 * stay distinct as far as {@link MAX_NAME_LENGTH}, the ceiling past which no name
 * completes an exchange anyway.
 *
 * The boundary, because it does not show in the rendering: a homoglyph (Cyrillic
 * U+0430 for Latin "a"), a zero-width character, or a tab or newline (HTML folds
 * either into the space beside it) makes two headers differing only by that read
 * alike here, and escaping is what would tell them apart. One such pair no treatment
 * tells apart: two headers past {@link MAX_NAME_LENGTH} code points sharing their
 * first {@link MAX_NAME_LENGTH} render as the same cut string in every sink on this
 * screen. The names are the operator's own file's, so the usual cost of that is the
 * legibility of their own header -- but this screen is where the disclosure is set,
 * one mark per grid row, so a crafted twin pair costs a row marked for the column
 * the operator did not mean: a mis-directed disclosure, not legibility alone.
 * Nothing here decides what is sent; it decides only how the name reads.
 */

/**
 * A column name cut to what paints: {@link MAX_NAME_LENGTH} code points, then
 * {@link DISPLAY_TRUNCATION_MARKER}. Nothing bounds a CSV header at intake and
 * isolation escapes nothing, so without this an arbitrarily long header paints
 * whole over the screen that holds the launch gate. The ceiling is the wire's --
 * the partner's parse of the payload frame refuses a longer name, as does
 * `ColumnMetadata.name` wherever metadata is parsed rather than inferred -- so the
 * cut can never reach a name an exchange completes on, and two carryable headers
 * sharing a prefix stay distinct. It does reach longer ones: this screen's metadata
 * comes from `inferMetadata` over the file's own header, which no schema bounds, so
 * an oversized header renders cut here and is refused only by the partner, after the
 * frame is sent.
 *
 * The cut counts code points -- so it never splits a surrogate pair, and an override
 * it leaves open is closed by the isolate around it -- while both of those ceilings
 * count UTF-16 units. The two disagree in one direction only: a name long enough to
 * cut is past the ceiling on either count, so the mark never elides a name that
 * transmits. The other direction is silent, and the absence of a mark is no verdict
 * on what can be carried -- a header of {@link MAX_NAME_LENGTH} astral characters is
 * twice that many units, renders whole and unmarked here, and is still refused on
 * the wire.
 */
function boundedName(name: string): string {
  const codePoints = [...name];
  if (codePoints.length <= MAX_NAME_LENGTH) return name;
  return (
    codePoints.slice(0, MAX_NAME_LENGTH).join("") + DISPLAY_TRUNCATION_MARKER
  );
}

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
  return FIRST_STRONG_ISOLATE + boundedName(name) + POP_DIRECTIONAL_ISOLATE;
}

/**
 * One column name as rendered text: the name inside a `<bdi>`, whose
 * `unicode-bidi: isolate` is the markup form of {@link isolatedColumnName}. The
 * element carries the isolation, so the name the operator selects and copies out
 * of the page is their own header and nothing more.
 */
export function ColumnName({ name }: { name: string }) {
  return <bdi>{boundedName(name)}</bdi>;
}
