/**
 * The 1-based positions of columns with an empty (zero-length) name, in column
 * order. Under PapaParse `header: true` a trailing comma, a blank cell, or a
 * leading delimiter in a CSV header row yields an unnamed (`""`) column; such a
 * column cannot be used for linkage, identification, or payload -- every name
 * field floors at `.min(1)`, and core's {@link inferMetadata} rejects it at intake
 * (throwing a `UsageError`). Each web intake surface calls this to refuse the file
 * EARLY -- with the clear, actionable {@link unnameableColumnsAlert} -- rather than
 * letting the throw bubble out of `inferMetadata` (a render crash in the editors)
 * or dead-end in the raw `PayloadColumnSchema.name` ZodError at invitation encode.
 * An empty result means every column is nameable.
 */
export function emptyColumnPositions(
  columns: ReadonlyArray<string>,
): Array<number> {
  return columns
    .map((name, index) => (name.length === 0 ? index + 1 : 0))
    .filter((position) => position > 0);
}

/**
 * The operator-facing alert for a file whose header carries unnamed column(s),
 * shared by every web intake surface so the wording cannot drift: the inviter
 * bench's file entry (and its create/save gates, rendered from an
 * {@link InvitationFileError} `unnameable` failure raised by the mint-time
 * re-parse) and the acceptor's file acquire. `positions` are
 * the 1-based column positions from {@link emptyColumnPositions} and are not
 * operator-controlled content, so they are surfaced directly. The return shape is
 * the structural {@link AlertContent} (`{ title, message }`) every caller assigns
 * it to, restated inline so this leaf helper does not depend on the component layer.
 */
export function unnameableColumnsAlert(positions: ReadonlyArray<number>): {
  title: string;
  message: string;
} {
  const plural = positions.length > 1;
  return {
    title: plural
      ? "This file has unnamed columns"
      : "This file has an unnamed column",
    message:
      `Column${plural ? "s" : ""} ${positions.join(", ")} in your CSV ` +
      `${plural ? "have" : "has"} no name. A trailing comma, a blank cell, or a ` +
      `leading delimiter in the header row produces an unnamed column, which ` +
      `cannot be used for matching or sent to your partner. Fix the header row -- ` +
      `name the column${plural ? "s" : ""} or remove the empty field${plural ? "s" : ""} -- and choose the file again.`,
  };
}
