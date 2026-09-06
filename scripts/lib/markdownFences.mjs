// Reading Markdown code fences, for the checks that must tell a code sample
// apart from the prose around it.
//
// The rule every reader here enforces, CommonMark's: a fence marker is a run
// of three or more backticks or tildes indented no more than three spaces, and
// a block that one opens closes only on a marker of the same character, at
// least as long, with nothing after it. Every other marker between the two is
// code, so a four-backtick marker inside a three-backtick block, and a tilde
// marker inside a backtick block, open nothing -- markdown has no nested
// fences. Four or more spaces open an indented code block instead of a fence,
// which bounds the indent above.
//
// Containers are not tracked, which bounds this: a marker behind a
// blockquote's `>` prefix, or indented to the content column of a nested list
// item, is not read as a fence.

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const JS_LANGUAGES = new Set(["js", "javascript", "mjs"]);

/** Whether a line opens or closes a fenced code block. */
export const isFenceLine = (line) => FENCE_LINE.test(line);

/** A Markdown source in which a fenced code block opens and never closes. */
export class UnterminatedFenceError extends Error {
  /**
   * @param {string} file The document the fence was read from.
   * @param {number} line The 1-based line of the opening fence.
   */
  constructor(file, line) {
    super(
      `${file}:${line} opens a fenced code block that never closes, so the lines below it cannot be told apart from code. Close the fence, or delete the stray marker.`,
    );
    this.name = "UnterminatedFenceError";
    this.file = file;
    this.line = line;
  }
}

/**
 * Every fenced code block of `lines`, as `{open, close, language}` in 0-based
 * line indices, where `close` is the index of the closing fence line or null
 * for a block that reaches the end of the source.
 */
function scanFences(lines) {
  const blocks = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const match = FENCE_LINE.exec(lines[i]);
    if (!match) continue;
    const [, marker, rest] = match;
    if (open === null) {
      // A backtick fence's info string may not itself contain a backtick.
      if (marker[0] === "`" && rest.includes("`")) continue;
      open = {
        char: marker[0],
        length: marker.length,
        language: rest.trim().split(/\s+/)[0].toLowerCase(),
        open: i,
      };
      continue;
    }
    const closes =
      marker[0] === open.char &&
      marker.length >= open.length &&
      rest.trim().length === 0;
    if (!closes) continue;
    blocks.push({ ...open, close: i });
    open = null;
  }
  if (open !== null) blocks.push({ ...open, close: null });
  return blocks;
}

/**
 * Blank out fenced code blocks while preserving line numbers, so a `](` link, a
 * `##` heading, or a `node_modules` path inside a code sample is not mistaken
 * for prose. Blocks are read by the fence rule at the top of this file, so an
 * inner marker never splits the document in two. A block that never closes
 * throws UnterminatedFenceError, naming `file` and the opening fence's line,
 * rather than blanking the rest of the source and leaving the caller to check
 * text the document does not hold.
 */
export function stripFences(text, file) {
  const lines = text.split("\n");
  const stripped = lines.slice();
  for (const { open, close } of scanFences(lines)) {
    if (close === null) throw new UnterminatedFenceError(file, open + 1);
    for (let i = open; i <= close; i++) stripped[i] = "";
  }
  return stripped.join("\n");
}

/**
 * Every fenced code block of a Markdown source, as `{code, startLine, language,
 * closed}` where startLine is the 1-based line of the block's first content
 * line and `language` is the first word of the info string. A block whose
 * closing fence is missing runs on to the next marker that closes it, and one
 * that reaches the end of the source is returned with `closed` false rather
 * than dropped, so a caller that reports an unpaired fence can still see it.
 */
export function fencedBlocks(source) {
  const lines = source.split("\n");
  return scanFences(lines).map(({ open, close, language }) => ({
    code: lines.slice(open + 1, close ?? lines.length).join("\n"),
    startLine: open + 2,
    language,
    closed: close !== null,
  }));
}

/**
 * The fenced js blocks of a Markdown source, as `{code, startLine}`. An
 * unclosed js fence yields the rest of the file rather than disappearing.
 */
export function jsBlocks(source) {
  return fencedBlocks(source)
    .filter((block) => JS_LANGUAGES.has(block.language))
    .map(({ code, startLine }) => ({ code, startLine }));
}

// Blank out inline code spans while preserving every character offset (so a
// caller deriving a line number from `match.index` on the returned string
// stays correct) and every newline (a code span may cross one, per
// CommonMark). A run of N backticks opens a span; the first later run of
// exactly N backticks closes it -- a longer or shorter run in between is part
// of the code content, which is why a double-backtick span can contain a
// single backtick and vice versa. An opening run with no matching close is
// left as literal text.
export function stripCodeSpans(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] !== "`") {
      out += text[i];
      i++;
      continue;
    }
    let openEnd = i;
    while (openEnd < n && text[openEnd] === "`") openEnd++;
    const openLen = openEnd - i;

    let k = openEnd;
    let closeEnd = -1;
    while (k < n) {
      if (text[k] !== "`") {
        k++;
        continue;
      }
      let runEnd = k;
      while (runEnd < n && text[runEnd] === "`") runEnd++;
      if (runEnd - k === openLen) {
        closeEnd = runEnd;
        break;
      }
      k = runEnd;
    }

    if (closeEnd === -1) {
      out += text.slice(i, openEnd);
      i = openEnd;
    } else {
      out += text.slice(i, closeEnd).replace(/[^\n]/g, " ");
      i = closeEnd;
    }
  }
  return out;
}
