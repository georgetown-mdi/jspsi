import { DISPLAY_TRUNCATION_MARKER, MAX_NAME_LENGTH } from "@psilink/core";

/**
 * How the acceptor's confirm-columns screen shows one of the operator's column
 * names: verbatim, inside a bidi isolate. Every column-name sink on that screen
 * goes through this module -- the grid's row header and its two control labels,
 * the quick-fix mapper's options, the disclosed-columns panel, the alert naming
 * the operator's own columns in the payload-declaration conflict notice (whose
 * declaration-sourced names take the escape instead), the grid's live regions, and the
 * ledger's "You will send" row -- so one name reads the same wherever the screen
 * puts it. That last notice is the one place two provenances meet, and its split
 * costs a collision this accepts: a declared name the operator's file also holds
 * reaches them escaped in the notice and verbatim here in the grid row the notice
 * sends them to, so the two forms are the same string only for a name of printable
 * ASCII holding no backslash. Escaping the half the operator cannot inspect costs
 * reading one name in two forms.
 *
 * These names are the operator's OWN CSV header, read from the file they chose,
 * not the partner-controlled text `sanitizeForDisplay` exists for, so they do not
 * take its escape. What they do need is layout containment: a header holding a
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
 * screen. The names are the operator's own file's, so the cost of that is the
 * legibility of their own header, and no longer a mis-directed disclosure: a name
 * long enough to be cut here is past the ceiling on the UTF-16 count too, so marking
 * either twin to send closes the launch gate rather than sending the column the
 * operator did not mean. Nothing here decides what is sent; it decides only how the
 * name reads.
 */

/**
 * A column name cut to what paints: {@link MAX_NAME_LENGTH} code points, then
 * {@link DISPLAY_TRUNCATION_MARKER}. Nothing bounds a CSV header at intake and
 * isolation escapes nothing, so without this an arbitrarily long header paints
 * whole over the screen that holds the launch gate. The ceiling matches the
 * wire's -- the partner's parse of the payload frame refuses a longer name, as
 * does `ColumnMetadata.name` wherever metadata is parsed rather than inferred
 * -- so the cut never reaches a name an exchange completes on. This screen's
 * metadata comes from `inferMetadata` over the file's own unbounded header, so
 * an oversized name still renders cut here; what it cannot do is leave the
 * machine, since marking it to send closes the launch gate
 * (`acceptorOverlongDisclosedColumns`, over the predicate core's prepare-time
 * `assertDisclosedNamesCarriable` reads).
 *
 * The cut counts code points -- so it never splits a surrogate pair, and an
 * override it leaves open is closed by the isolate around it -- while the wire's
 * ceilings count UTF-16 units. The two disagree in one direction only: a name
 * long enough to cut is always past the wire ceiling too, so the mark never
 * elides a name that transmits. The reverse is silent: the absence of a mark is
 * no verdict on what the wire will accept -- a header of {@link MAX_NAME_LENGTH}
 * astral characters is twice that many units, renders whole and unmarked here,
 * and is still refused on the wire.
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
 * anything outside. PDI also terminates any embedding or override (RLE, LRE, RLO,
 * LRO, a missing PDF) the isolated text left open, bounding an unbalanced name of
 * that class.
 *
 * The isolate class itself is the residual, and BOTH forms hold it: a name whose
 * unmatched PDI closes the wrapper early leaves an override running over the copy
 * that follows, in the characters {@link isolatedColumnName} composes and equally
 * in the `<bdi>` {@link ColumnName} renders. What holds it off a sink is the
 * arrangement rather than the wrapper: a name given a block of its own has no
 * copy beside it for the leak to run over, while a sink that puts literal copy in
 * one text block with a wrapped name can have that copy reordered.
 * test/browser/inviterSharing.test.ts and test/browser/accept.test.ts
 * measure which sinks are of which shape; a sink no check drives is not asserted
 * to contain the residual. The trust basis is the module note above: these are
 * the operator's own CSV headers.
 *
 * The one hole no check here covers, stated as UAX #9 states it rather than as a
 * measurement: a name holding an unmatched RLI, LRI, or FSI consumes the closing
 * PDI, so the wrapper opens and never closes. The same trust basis bounds it.
 */
const FIRST_STRONG_ISOLATE = "\u2068";
const POP_DIRECTIONAL_ISOLATE = "\u2069";

/**
 * One column name for a STRING sink -- an `aria-label`, a native `<option>`
 * label, a live-region sentence -- where the surrounding copy is one string and
 * no element can hold the isolation. {@link ColumnName} is the same treatment
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
 * element holds the isolation, so the name the operator selects and copies out
 * of the page is their own header and nothing more.
 */
export function ColumnName({ name }: { name: string }) {
  return <bdi>{boundedName(name)}</bdi>;
}
