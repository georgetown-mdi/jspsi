// Blank out fenced code blocks (``` or ~~~) while preserving line numbers, so a
// `](` link, a `##` heading, or a `node_modules` path inside a code sample is not
// mistaken for prose.
export function stripFences(text) {
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return "";
      }
      return inFence ? "" : line;
    })
    .join("\n");
}

const FENCE_LINE = /^\s*(`{3,}|~{3,})(.*)$/;
const JS_LANGUAGES = new Set(["js", "javascript", "mjs"]);

/** Whether a line opens or closes a fenced code block. */
export const isFenceLine = (line) => FENCE_LINE.test(line);

/**
 * Every fenced code block of a Markdown source, as `{code, startLine, language,
 * closed}` where startLine is the 1-based line of the block's first content
 * line. Recognizes the CommonMark fence forms: three or more backticks or
 * tildes, indented, and an info string whose first word is the language. A
 * block closes only on a fence of the same character, at least as long, with
 * nothing after it -- so a block whose closing fence is missing runs on to the
 * next fence that qualifies, and one that reaches the end of the file is
 * returned with `closed` false rather than dropped.
 */
export function fencedBlocks(source) {
  const blocks = [];
  const lines = source.split("\n");
  let open = null;
  const push = (endLine, closed) => {
    blocks.push({
      code: lines.slice(open.start, endLine).join("\n"),
      startLine: open.start + 1,
      language: open.language,
      closed,
    });
  };
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(FENCE_LINE);
    if (!match) continue;
    const marker = match[1];
    const rest = match[2];
    if (open === null) {
      // A backtick fence's info string may not itself contain a backtick.
      if (marker[0] === "`" && rest.includes("`")) continue;
      open = {
        char: marker[0],
        length: marker.length,
        language: rest.trim().split(/\s+/)[0].toLowerCase(),
        start: i + 1,
      };
      continue;
    }
    const closes =
      marker[0] === open.char &&
      marker.length >= open.length &&
      rest.trim().length === 0;
    if (!closes) continue;
    push(i, true);
    open = null;
  }
  if (open !== null) push(lines.length, false);
  return blocks;
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
