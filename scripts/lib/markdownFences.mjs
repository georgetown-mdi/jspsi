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
