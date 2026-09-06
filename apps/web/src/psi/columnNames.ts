import { MAX_NAME_LENGTH } from "@psilink/core";

/**
 * The 1-based positions of columns with an empty (zero-length) name, in column
 * order. Under PapaParse `header: true` a trailing comma, a blank cell, or a
 * leading delimiter in a CSV header row yields an unnamed (`""`) column, which
 * core's {@link inferMetadata} rejects at intake (`UsageError`) since every name
 * field floors at `.min(1)`. Each web intake surface calls this to refuse the
 * file EARLY, with the clear, actionable {@link unnameableColumnsAlert}, before
 * that throw reaches a render crash or a raw ZodError at invitation encode. An
 * empty result means every column is nameable.
 */
export function emptyColumnPositions(
  columns: ReadonlyArray<string>,
): Array<number> {
  return columns
    .map((name, index) => (name.length === 0 ? index + 1 : 0))
    .filter((position) => position > 0);
}

/**
 * The operator-facing alert for a file whose header has unnamed column(s),
 * shared by every web intake surface so the wording cannot drift: the inviter
 * console's file entry (and its create/save gates, rendered from an
 * {@link InvitationFileError} `unnameable` failure raised by the mint-time
 * re-parse) and the acceptor's file acquire. `positions` are
 * the 1-based column positions from {@link emptyColumnPositions} and are not
 * operator-controlled content, so they are shown directly. The return shape is
 * the structural {@link AlertContent} (`{ title, message }`) every caller assigns
 * it to, restated inline so this leaf helper does not depend on the component layer.
 *
 * `sanitizedPositions` are the positions the parse removed bidi control
 * characters from (`meta.bidiStrippedColumns`). An unnamed position among them
 * held nothing but those characters, so the trailing-comma cause is wrong for it
 * and the removal is stated instead -- the operator's header was neither blank
 * nor trailing, and the remedy differs.
 */
export function unnameableColumnsAlert(
  positions: ReadonlyArray<number>,
  sanitizedPositions: ReadonlyArray<number> = [],
): {
  title: string;
  message: string;
} {
  const plural = positions.length > 1;
  const sanitized = new Set(sanitizedPositions);
  const strippedEmpty = positions.filter((position) => sanitized.has(position));
  const strippedPlural = strippedEmpty.length > 1;
  const cause =
    strippedEmpty.length === 0
      ? `A trailing comma, a blank cell, or a leading delimiter in the header ` +
        `row produces an unnamed column, which cannot be used for matching or ` +
        `sent to your partner. Fix the header row -- name the ` +
        `column${plural ? "s" : ""} or remove the empty ` +
        `field${plural ? "s" : ""} -- and choose the file again.`
      : strippedEmpty.length === positions.length
        ? `${plural ? "Those names held" : "That name held"} nothing but ` +
          `invisible text-direction characters, which this read removes, ` +
          `leaving no name to match on or send to your partner. Fix the header ` +
          `row -- give ${plural ? "those columns names" : "that column a name"} ` +
          `made of ordinary characters -- and choose the file again.`
        : `Column${strippedPlural ? "s" : ""} ${strippedEmpty.join(", ")} held ` +
          `nothing but invisible text-direction characters, which this read ` +
          `removes; a trailing comma, a blank cell, or a leading delimiter in ` +
          `the header row produces the rest. An unnamed column cannot be used ` +
          `for matching or sent to your partner. Fix the header row -- give ` +
          `every column a name made of ordinary characters -- and choose the ` +
          `file again.`;
  return {
    title: plural
      ? "This file has unnamed columns"
      : "This file has an unnamed column",
    message:
      `Column${plural ? "s" : ""} ${positions.join(", ")} in your CSV ` +
      `${plural ? "have" : "has"} no name. ${cause}`,
  };
}

/**
 * The operator-facing notice for a file whose header held bidi control
 * characters, shared by every intake seat so the wording cannot drift. Core's
 * CSV parse removes them from the name before anything matches on it or sends
 * it, and reports the 1-based positions it changed (`meta.bidiStrippedColumns`,
 * `packages/core/src/file.ts`); this is how the operator is told.
 *
 * A notice, not a refusal: the header is the operator's own, an operator who
 * cannot edit a vendor export would lose the exchange over it, and the removal
 * has already made the name safe to show and to send. `positions` are not
 * operator-controlled content and are shown directly, while the offending name
 * never is -- echoing it would put the reordering characters back into the copy
 * the notice is written to keep readable.
 *
 * The copy states the collision case rather than claiming the name kept is the
 * rest of the header: where the removal leaves two columns sharing one name, the
 * parser numbers the later one (`name`, `name_1`), which is neither position's
 * header and can be the untouched column's.
 */
export function sanitizedColumnsAlert(positions: ReadonlyArray<number>): {
  title: string;
  message: string;
} {
  const plural = positions.length > 1;
  return {
    title: plural
      ? "Formatting characters removed from column names"
      : "A formatting character was removed from a column name",
    message:
      `Column${plural ? "s" : ""} ${positions.join(", ")} in your CSV ` +
      `${plural ? "had names that held" : "had a name that held"} invisible ` +
      `text-direction characters. The characters were removed from the ` +
      `name${plural ? "s" : ""} used for matching, shown on this screen, and ` +
      `sent to your partner. Where that left two columns with the same name, ` +
      `the later one was numbered to keep the two apart. Check that ` +
      `${plural ? "those columns" : "the column"} still ` +
      `${plural ? "read" : "reads"} the way your file names ` +
      `${plural ? "them" : "it"}; if not, edit the header row and choose the ` +
      `file again.`,
  };
}

/**
 * The operator-facing alert for a file marked to send a column whose name is
 * longer than {@link MAX_NAME_LENGTH}, shared by every seat that gates on it -- the
 * acceptor's confirm-columns notice, the inviter's create/save surfaces (rendered
 * from an {@link InvitationFileError} `overlong` failure raised at the mint
 * boundary), and the direct-exchange confirm screen -- so the wording cannot drift.
 * `positions` are the 1-based column positions from core's
 * `overlongDisclosedColumnPositions`; like {@link unnameableColumnsAlert}'s, they
 * are not operator-controlled content and are shown directly, while the
 * offending NAME never is (it is longer than the message that would hold it).
 *
 * Both remedies are named because the seats differ in which they offer: a seat
 * with a disclosure control clears it by unmarking the column, one without it by
 * shortening the header. Neither remedy is the file's rejection -- an oversized
 * name still matches, identifies, and is ignorable.
 */
export function overlongColumnsAlert(positions: ReadonlyArray<number>): {
  title: string;
  message: string;
} {
  const plural = positions.length > 1;
  return {
    title: plural
      ? "These column names are too long to send"
      : "This column name is too long to send",
    message:
      `Column${plural ? "s" : ""} ${positions.join(", ")} in your CSV ` +
      `${plural ? "are" : "is"} set to be sent to your partner, but ` +
      `${plural ? "their names are" : "its name is"} longer than ` +
      `${MAX_NAME_LENGTH} characters (a character outside the basic set, such as ` +
      `an emoji, counts as two). A column's name travels with its values, and ` +
      `your partner's copy of psilink refuses a name that long, so the exchange ` +
      `cannot start. Shorten the header${plural ? "s" : ""} in your file, or set ` +
      `${plural ? "those columns" : "that column"} so ${plural ? "they are" : "it is"} not sent.`,
  };
}
