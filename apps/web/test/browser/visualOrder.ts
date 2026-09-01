/** The given substrings in visual reading order, measured with a Range over the
 * text nodes under `root`. Glyph level rather than element level, which is what
 * makes it discriminating: an unterminated override reorders the glyphs a
 * neighbouring name's box already holds without moving that box, so sorting the
 * elements' own rectangles reports the DOM order either way. Throws on a substring
 * that is absent or paints nothing, so an order it returns is one the browser
 * actually laid out rather than a sort over empty boxes. */
export function visualOrderWithin(
  root: Node,
  substrings: Array<string>,
): Array<string> {
  const texts: Array<Text> = [];
  if (root instanceof Text) texts.push(root);
  else {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      texts.push(node as Text);
    }
  }
  return substrings
    .map((substring) => {
      const hit = texts
        .map((node) => ({ node, start: node.data.indexOf(substring) }))
        .find(({ start }) => start >= 0);
      if (hit === undefined) throw new Error(`not rendered: ${substring}`);
      const range = document.createRange();
      range.setStart(hit.node, hit.start);
      range.setEnd(hit.node, hit.start + substring.length);
      const box = range.getBoundingClientRect();
      if (box.width === 0) throw new Error(`paints nothing: ${substring}`);
      return { substring, box };
    })
    .sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left)
    .map((entry) => entry.substring);
}
