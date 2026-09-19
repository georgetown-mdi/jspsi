/**
 * The field delimiter a CSV write uses when the party chose none, and the one
 * every read takes for a file it was given no delimiter for.
 */
export const DEFAULT_CSV_DELIMITER = ",";

/**
 * The reserved value a party names to have a read take the delimiter from the
 * file itself instead of reading by {@link DEFAULT_CSV_DELIMITER}. Accepted
 * wherever a delimiter is authored -- the CLI flag, the configuration and
 * exchange-document field, the browser's control -- and stored as this word, so
 * naming detection is a value distinct from naming nothing.
 *
 * A delimiter is a single character ({@link isCsvDelimiter}), so no file can be
 * delimited by this word and it cannot collide with a character a party names.
 *
 * A result file is written with {@link DEFAULT_CSV_DELIMITER} under this choice:
 * a detected read names no character the write could follow
 * ({@link resultCsvDelimiter}).
 */
export const CSV_DELIMITER_DETECT = "detect";

/**
 * The spellings a delimiter of tab may be written as, for the command lines and
 * configuration files a literal tab is awkward in. Matched case-insensitively
 * after trimming, so `TAB` and ` tab ` resolve too.
 */
const TAB_SPELLINGS: ReadonlySet<string> = new Set(["tab", "\\t"]);

/**
 * Resolve the words a party may write where the character itself is awkward to
 * type or there is no character to type: a tab is `tab` or `\t`, and detection
 * is {@link CSV_DELIMITER_DETECT}. Both are matched case-insensitively after
 * trimming. Every other value is returned unchanged -- not trimmed, since a
 * space is itself an acceptable delimiter and trimming one away would silently
 * read a file by a delimiter the party did not choose.
 *
 * Applied at both boundaries a delimiter is authored at (the CLI flag and the
 * configuration schema) so the two take the same spellings, and applied BEFORE
 * {@link isCsvDelimiterChoice}, which grades the resolved value.
 */
export function normalizeCsvDelimiter(value: string): string {
  const word = value.trim().toLowerCase();
  if (TAB_SPELLINGS.has(word)) return "\t";
  if (word === CSV_DELIMITER_DETECT) return CSV_DELIMITER_DETECT;
  return value;
}

/**
 * Whether `value` is a delimiter psilink reads and writes a CSV with: exactly
 * one character, either a tab or a printable ASCII character other than the
 * double quote.
 *
 * The bounds are what keeps a parse and a write agreeing on where a field ends.
 * The double quote is RFC 4180's own escape character, so a file delimited by it
 * has no unambiguous reading -- PapaParse ignores such a delimiter and falls
 * back to its own detection (driven and confirmed against the parser), which
 * would read the file by a delimiter nobody chose. CR and LF end a row rather
 * than a field, and both the streamed and the leading-line byte ceilings count a
 * line by scanning for exactly those two bytes. A non-ASCII character is
 * excluded because the write side escapes by UTF-16 code unit while the ceilings
 * count bytes; a multi-character value is excluded because PapaParse accepts one
 * (also driven) and a party could then delimit by a string no single character
 * can be escaped against.
 *
 * Grades a value already through {@link normalizeCsvDelimiter}: `tab` is not
 * one character and is refused here.
 */
export function isCsvDelimiter(value: string): boolean {
  if (value.length !== 1) return false;
  if (value === '"') return false;
  const code = value.charCodeAt(0);
  return code === 0x09 || (code >= 0x20 && code <= 0x7e);
}

/**
 * Whether `value` is a delimiter choice a party may author: a character
 * {@link isCsvDelimiter} accepts, or {@link CSV_DELIMITER_DETECT}. This is the
 * grade every authoring boundary applies -- the CLI flag, the configuration
 * schema, the browser's control -- while {@link isCsvDelimiter} grades the
 * character a read or a write takes.
 *
 * Grades a value already through {@link normalizeCsvDelimiter}.
 */
export function isCsvDelimiterChoice(value: string): boolean {
  return value === CSV_DELIMITER_DETECT || isCsvDelimiter(value);
}

/**
 * The delimiter a result file is written with, from the party's choice: the
 * character they named, and {@link DEFAULT_CSV_DELIMITER} both where they named
 * none and where they chose {@link CSV_DELIMITER_DETECT} -- a detected read
 * names no character, and the reserved word is not one the write could escape
 * against or join with.
 *
 * Every write site resolves its party's choice through this, so the character
 * the table is escaped against is the character the file is joined with.
 */
export function resultCsvDelimiter(choice: string | undefined): string {
  if (choice === undefined || choice === CSV_DELIMITER_DETECT)
    return DEFAULT_CSV_DELIMITER;
  return choice;
}

/**
 * The clause a refusal over an input's columns adds when the whole header came
 * out as ONE column: a file separated by something other than a comma, read
 * with no delimiter named, reaches a column check that way rather than as a
 * wrong result. Empty for any other column count, so a refusal over a file that
 * really does hold one column and a genuine shortfall read the same.
 *
 * Stated without naming a flag, a key, or a control: the copy is shared by the
 * command line's pre-flight and the run boundary both applications reach, and
 * each surface's own name for the choice is in its documentation.
 */
export function singleColumnDelimiterClause(columnCount: number): string {
  if (columnCount !== 1) return "";
  return (
    "This input read as a single column, so its fields may be separated by " +
    "something other than a comma, which is what a read takes when no " +
    "delimiter is named: name your file's separator as the CSV delimiter, or " +
    `name \`${CSV_DELIMITER_DETECT}\` to take it from the file, and run ` +
    "again. "
  );
}

/**
 * Describe `value`'s shape without repeating the value: a party who typed a
 * character the terminal does not draw learns what was read, and no unprintable
 * byte of theirs is written back to their screen or into a schema message.
 */
function csvDelimiterShape(value: string): string {
  const resolved = normalizeCsvDelimiter(value);
  if (resolved.length === 0) return "an empty value";
  if (resolved.length > 1) return `a ${resolved.length}-character value`;
  if (resolved === '"') return "the double quote";
  if (resolved === "\n" || resolved === "\r") return "a line terminator";
  const code = resolved.charCodeAt(0);
  // DEL (0x7f) is an ASCII control character, not a character outside ASCII, so
  // the bound here is one code point above the printable range isCsvDelimiter
  // accepts.
  if (code > 0x7f) return "a non-ASCII character";
  return `a control character (code point ${code})`;
}

/**
 * The one operator-readable refusal for a delimiter outside the accepted set,
 * shared by the CLI flag and the configuration schema so neither can word the
 * same refusal differently. States the rule and the shape of what was given.
 *
 * The tab remedy names one spelling, `tab`, and holds no backslash: every sink
 * this text reaches escapes a backslash once more, so a `\t` written here would
 * show the operator a spelling that is refused when they type it back.
 */
export function csvDelimiterRefusal(value: string): string {
  return (
    `a CSV field delimiter must be a single character -- a tab (write it ` +
    `\`tab\`), or a printable ASCII character other than the double quote -- ` +
    `or \`${CSV_DELIMITER_DETECT}\` to take the delimiter from the file ` +
    `itself, and this is ${csvDelimiterShape(value)}`
  );
}
