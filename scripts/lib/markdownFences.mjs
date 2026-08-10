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
