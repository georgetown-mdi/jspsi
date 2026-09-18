/**
 * The field delimiter a CSV write uses when the party chose none, and the one
 * every reader assumes for a file it was given no delimiter for.
 */
export const DEFAULT_CSV_DELIMITER = ",";

/**
 * The spellings a delimiter of tab may be written as, for the command lines and
 * configuration files a literal tab is awkward in. Matched case-insensitively
 * after trimming, so `TAB` and ` tab ` resolve too.
 */
const TAB_SPELLINGS: ReadonlySet<string> = new Set(["tab", "\\t"]);

/**
 * Resolve the spellings of a delimiter a party may write where the character
 * itself is awkward to type: a tab is `tab` or `\t`. Every other value is
 * returned unchanged -- not trimmed, since a space is itself an acceptable
 * delimiter and trimming one away would silently read a file by a delimiter the
 * party did not choose.
 *
 * Applied at both boundaries a delimiter is authored at (the CLI flag and the
 * configuration schema) so the two take the same spellings, and applied BEFORE
 * {@link isCsvDelimiter}, which grades the resolved character.
 */
export function normalizeCsvDelimiter(value: string): string {
  return TAB_SPELLINGS.has(value.trim().toLowerCase()) ? "\t" : value;
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
 */
export function csvDelimiterRefusal(value: string): string {
  return (
    `a CSV field delimiter must be a single character -- a tab (write it ` +
    `\`tab\` or \`\\t\`), or a printable ASCII character other than the ` +
    `double quote -- and this is ${csvDelimiterShape(value)}`
  );
}
