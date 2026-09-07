import { MAX_NAME_LENGTH, NAME_SHAPE_PATTERN } from "@psilink/core";

import { isolatedColumnName } from "@components/ColumnName";

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
 * `sanitizedPositions` are the positions the parse removed control characters
 * from (`meta.sanitizedColumnPositions`). An unnamed position among them
 * held nothing but those characters, so the trailing-comma cause is wrong for it
 * and the removal is stated instead -- the operator's header was neither blank
 * nor trailing, and the remedy differs. Required rather than defaulted: an
 * omitted list means "blame the trailing comma", and a seat that forgot to
 * thread its parse's positions would state that wrong cause silently.
 */
export function unnameableColumnsAlert(
  positions: ReadonlyArray<number>,
  sanitizedPositions: ReadonlyArray<number>,
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
          `invisible control characters, which this read removes, leaving no ` +
          `name to match on or send to your partner. Fix the header ` +
          `row -- give ${plural ? "those columns names" : "that column a name"} ` +
          `made of ordinary characters -- and choose the file again.`
        : `Column${strippedPlural ? "s" : ""} ${strippedEmpty.join(", ")} held ` +
          `nothing but invisible control characters, which this read ` +
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
 * The operator-facing notice for a file whose header held control characters,
 * shared by every intake seat so the wording cannot drift. Core's
 * CSV parse removes them from the name before anything matches on it or sends
 * it, and reports the 1-based positions it changed (`meta.sanitizedColumnPositions`,
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
 *
 * What it says about disclosure is bounded by what this read reaches: the names
 * it derives from the header, which are the matching name, the name this screen
 * shows, and the sent name where the exchange takes that from the header. A name
 * the linkage terms or a `metadata` block declare is not read from the header at
 * all; refusing it is the schema's, not this read's, so the copy states that
 * refusal, and names a standardization `input` or `output` as the one declared
 * name it does not reach. It names no remedy: this notice serves
 * every intake seat, including the acceptor seats whose terms are the partner's
 * invitation and the direct-exchange seats with no terms to edit, so no one edit
 * is the operator's to make.
 */
export function sanitizedColumnsAlert(positions: ReadonlyArray<number>): {
  title: string;
  message: string;
} {
  const plural = positions.length > 1;
  return {
    title: plural
      ? "Invisible control characters removed from column names"
      : "An invisible control character was removed from a column name",
    message:
      `Column${plural ? "s" : ""} ${positions.join(", ")} in your CSV ` +
      `${plural ? "had names that held" : "had a name that held"} invisible ` +
      `control characters, a class that includes the text-direction ones. ` +
      `The characters are ` +
      `gone from every name ` +
      `this read takes from the header: the name${plural ? "s" : ""} matched ` +
      `on, the name${plural ? "s" : ""} shown on this screen, and the ` +
      `name${plural ? "s" : ""} sent to your partner where the exchange takes ` +
      `${plural ? "them" : "it"} from the header. This read does not change a ` +
      `name the linkage terms or a metadata block declare: one that holds ` +
      `these characters is refused when the document is read, and a ` +
      `standardization input or output name is not held to that rule. ` +
      `Where that left two columns with the same name, the later one was ` +
      `numbered to keep the two apart. Check that ` +
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

/**
 * What a whole-document schema refused about one declared column name. The four
 * rules `ColumnMetadata.name` is held to (packages/core/src/config/metadata.ts):
 * the length ceiling, the name-class character rule, the non-empty floor, and the
 * block's uniqueness refine.
 */
export type ColumnNameRefusal =
  "too-long" | "control-character" | "unnamed" | "repeated";

/**
 * One column a whole-document refusal is about: its 1-based place in the block
 * the refusal came from, the name as declared, and what the schema refused about
 * it. The name is the operator's own header, held raw here and cut at the display
 * boundary ({@link refusedColumnsSentence}).
 */
export interface RefusedColumnName {
  /** 1-based position in the metadata block, or in the file's header for a
   * refusal located against the header. */
  position: number;
  /** The name as declared, before the display cut. */
  name: string;
  /** What the schema refused about it. */
  refusal: ColumnNameRefusal;
}

/** The issue paths a Zod error reports, read structurally so a caller passes any
 * failed parse without this module depending on which schema raised it. */
function issuePathsOf(error: unknown): Array<ReadonlyArray<PropertyKey>> {
  const issues = (error as { issues?: unknown } | null | undefined)?.issues;
  if (!Array.isArray(issues)) return [];
  const paths: Array<ReadonlyArray<PropertyKey>> = [];
  for (const issue of issues) {
    const path = (issue as { path?: unknown }).path;
    if (Array.isArray(path)) paths.push(path as Array<PropertyKey>);
  }
  return paths;
}

/**
 * The metadata index a column-name issue points at, or undefined for any other
 * issue. Matched on the path's TAIL -- `metadata`, an array index, `name` -- so
 * one mapper reads a stored record's nested block (`exchangeFile.metadata`) and a
 * job intent's top-level one alike, without either naming the other.
 */
function metadataNameIndexOf(
  path: ReadonlyArray<PropertyKey>,
): number | undefined {
  const [block, index, field] = path.slice(-3);
  return block === "metadata" && typeof index === "number" && field === "name"
    ? index
    : undefined;
}

/** What the schema refuses about a declared name, or undefined when the name
 * breaks none of the rules this module can name. */
function refusalOf(name: string): ColumnNameRefusal | undefined {
  if (name.length === 0) return "unnamed";
  if (name.length > MAX_NAME_LENGTH) return "too-long";
  if (!NAME_SHAPE_PATTERN.test(name)) return "control-character";
  return undefined;
}

/** The 1-based positions of the entries repeating a name an earlier entry
 * already used -- what the block's uniqueness refine fires on, which reports its
 * issue against the whole block and so names no column itself. */
function repeatedNamePositions(
  metadata: ReadonlyArray<{ name: string }>,
): Array<number> {
  const seen = new Set<string>();
  const repeated: Array<number> = [];
  metadata.forEach((column, index) => {
    if (seen.has(column.name)) repeated.push(index + 1);
    else seen.add(column.name);
  });
  return repeated;
}

/**
 * The columns a failed whole-document parse refused, located by the Zod issue
 * path and classified against the name the document declares at that path. The
 * one mapper behind every point that would otherwise report a whole-document
 * failure holding nothing the operator can act on.
 *
 * Classified from the NAME rather than from the issue's code: the code taxonomy
 * is the validation library's and moves with it, while the four rules the name is
 * held to are core's own and are checkable here. A position whose name breaks
 * none of them is left out, so the caller falls back to its own whole-document
 * copy rather than naming a column it can say nothing true about.
 *
 * `metadata` is the block the caller tried to write, which is what holds the
 * names; an absent block yields nothing.
 */
export function refusedColumnNames(
  error: unknown,
  metadata: ReadonlyArray<{ name: string }> | undefined,
): Array<RefusedColumnName> {
  if (metadata === undefined) return [];
  const byPosition = new Map<number, RefusedColumnName>();
  // The index rides in on an issue path, and the block the caller holds need not
  // be the one that raised it, so an index outside the block names no column.
  const nameAt = (index: number): string | undefined =>
    index >= 0 && index < metadata.length ? metadata[index].name : undefined;
  const add = (index: number, refusal: ColumnNameRefusal) => {
    const name = nameAt(index);
    if (name === undefined || byPosition.has(index + 1)) return;
    byPosition.set(index + 1, { position: index + 1, name, refusal });
  };
  for (const path of issuePathsOf(error)) {
    const index = metadataNameIndexOf(path);
    if (index !== undefined) {
      const name = nameAt(index);
      const refusal = name === undefined ? undefined : refusalOf(name);
      if (refusal !== undefined) add(index, refusal);
      continue;
    }
    if (path[path.length - 1] === "metadata")
      for (const position of repeatedNamePositions(metadata))
        add(position - 1, "repeated");
  }
  return [...byPosition.values()].sort((a, b) => a.position - b.position);
}

/**
 * The columns a cleaning field reads whose header is longer than
 * {@link MAX_NAME_LENGTH}, located in the file's own header. The console's
 * coverage sweep bounds every standardization `input` and `output` at that
 * ceiling (`apps/web/src/jobs/workInputs.ts`), so a header past it settles the
 * sweep with no result; this is what names the column behind that.
 *
 * Scoped to the `input` side, which is a column of the file: an `output` is a
 * linkage field's name, and naming it as a column would be wrong. A cleaning
 * field whose input matches no header entry is left out for the same reason.
 */
export function overlongCoverageColumns(
  standardization: ReadonlyArray<{ input: string }>,
  columns: ReadonlyArray<string>,
): Array<RefusedColumnName> {
  const byPosition = new Map<number, RefusedColumnName>();
  for (const transformation of standardization) {
    if (transformation.input.length <= MAX_NAME_LENGTH) continue;
    const index = columns.indexOf(transformation.input);
    if (index < 0) continue;
    byPosition.set(index + 1, {
      position: index + 1,
      name: transformation.input,
      refusal: "too-long",
    });
  }
  return [...byPosition.values()].sort((a, b) => a.position - b.position);
}

/** What each refusal says about the column, completing the sentence below. */
const REFUSAL_CLAUSES: Record<ColumnNameRefusal, string> = {
  "too-long": `has a name longer than ${MAX_NAME_LENGTH} characters`,
  "control-character":
    "has a name holding an invisible control or text-direction character",
  unnamed: "has no name",
  repeated: "repeats a name an earlier column already uses",
};

/**
 * The sentence naming each refused column and what was refused about it, shared
 * by every refusal point so the identification cannot drift. The position locates
 * the column in the block the refusal came from; the name follows it through the
 * display cut every operator-facing column name takes
 * ({@link isolatedColumnName}), which bounds an oversized header and isolates a
 * text-direction one.
 *
 * A name is shown here where {@link overlongColumnsAlert} shows only positions,
 * because that alert asks the operator to choose what to send while this one asks
 * them to find a column in a document whose parse failed.
 */
export function refusedColumnsSentence(
  refused: ReadonlyArray<RefusedColumnName>,
): string {
  return refused
    .map(
      (column) =>
        `Column ${column.position}, ${isolatedColumnName(column.name)}, ` +
        `${REFUSAL_CLAUSES[column.refusal]}.`,
    )
    .join(" ");
}

/**
 * The operator-facing alert for a recurring-exchange save refused over a column
 * name: the identification, then what it cost and what to do. Replaces the
 * generic "try again" copy, which is wrong here -- the same document refuses
 * identically however many times it is saved.
 */
export function savedExchangeColumnRefusalAlert(
  refused: ReadonlyArray<RefusedColumnName>,
): {
  title: string;
  message: string;
} {
  return {
    title: "Could not save this recurring exchange",
    message:
      `${refusedColumnsSentence(refused)} A recurring exchange stores your ` +
      `column names, so it was not stored. Your one-off exchange is ` +
      `unaffected. Fix the header row in your file, then set the exchange up ` +
      `again to save it.`,
  };
}

/**
 * The operator-facing alert for a console job the browser refuses to submit over
 * a column name. Raised before the POST, so the job API's empty-bodied `400` is
 * never what the operator meets and no route's answer changes.
 */
export function consoleJobColumnRefusalAlert(
  refused: ReadonlyArray<RefusedColumnName>,
): {
  title: string;
  message: string;
} {
  return {
    title: "The console could not start this exchange",
    message:
      `${refusedColumnsSentence(refused)} The console cannot run an exchange ` +
      `over a column name it cannot record, so nothing was started and ` +
      `nothing left this machine. Fix the header row in your file, choose the ` +
      `file again, and start over.`,
  };
}
