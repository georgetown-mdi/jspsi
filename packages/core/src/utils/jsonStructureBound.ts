// Code-unit values of the JSON structural characters and the string escape.
// Every one is ASCII (<= 0x7F). The scan reads either the raw UTF-8 bytes or the
// UTF-16 code units of an already-decoded string, and an ASCII value cannot
// misfire in either: in well-formed UTF-8 no lead or continuation byte of a
// multi-byte code point falls in the ASCII range (lead bytes >= 0xC0,
// continuation bytes 0x80-0xBF), and in UTF-16 an ASCII code point is a single
// unit that is never a surrogate half (0xD800-0xDFFF). So a 0x3A is always a
// real colon and a 0x22 always a real quote. On the byte path the scan needs no
// prior decode -- it runs ahead of it, so a pathological frame is rejected
// without first allocating the decoded string.
const QUOTE = 0x22; // "
const COLON = 0x3a; // :
const COMMA = 0x2c; // ,
const BACKSLASH = 0x5c; // \
const OPEN_BRACE = 0x7b; // {
const CLOSE_BRACE = 0x7d; // }
const OPEN_BRACKET = 0x5b; // [
const CLOSE_BRACKET = 0x5d; // ]

/**
 * Scans a JSON document -- its UTF-8 bytes, or the UTF-16 code units of an
 * already-decoded string -- and returns `true` if it carries a structure that
 * must be rejected BEFORE `JSON.parse` runs:
 *
 * - any single object with more than `maxObjectKeys` members,
 * - any single array with more than `maxArrayElements` elements, or
 * - structural nesting (objects and arrays) deeper than `maxDepth`.
 *
 * Each is a structural pathology a partner-controlled frame can reach within the
 * frame-size cap and that `JSON.parse` cannot be allowed to meet: a single
 * object wide enough, OR a single array long enough, drives the engine into an
 * internal limit (a per-object property ceiling, or its array backing-store
 * length limit) and terminates the process -- not by a thrown exception the
 * surrounding `try`/`catch` could intercept, but by an uncatchable abort. So the
 * bound has to fire ahead of the parse rather than catch its failure. The depth
 * cap additionally bounds THIS scan's own per-container stack, so a degenerate
 * body that is all `{`/`[` is rejected here rather than exhausting memory in the
 * pre-pass. See docs/spec/CHANNEL_SECURITY.md.
 *
 * Counting is structural. An object's members are counted by their colons; an
 * array's elements by their separating commas (the element count is the comma
 * count plus one for a non-empty array, so this undercounts elements by one,
 * immaterial against a budget far above any legitimate array and far below the
 * engine limit). On well-formed JSON every colon and every element-comma falls
 * directly inside the innermost open container and is charged to it. Two
 * approximations are deliberate and safe. The colon count over-counts an object
 * that repeats a key (the parse keeps one member per name), which only rejects
 * sooner, and no legitimate message repeats keys. And on malformed JSON a colon
 * or comma can be mischarged: one outside any container is charged to nothing,
 * and a mismatched close pops without checking the bracket type, so a later
 * marker may land on an outer frame. Neither approximation can hide a crash: a
 * malformed body never reaches an engine limit (`JSON.parse` rejects it as
 * invalid first), and the bound errs only toward an earlier rejection, never
 * toward letting a too-wide object or too-long array through. The scan is a
 * single O(n) pass with early exit, ahead of the parse's own pass.
 */
export function exceedsJsonStructureBound(
  input: Uint8Array | string,
  maxObjectKeys: number,
  maxArrayElements: number,
  maxDepth: number,
): boolean {
  // One entry per open container. An OBJECT frame holds its running key count,
  // always `>= 0`. An ARRAY frame holds a running tally that starts at the
  // sentinel `-1` (empty) and drops by one per element-separating comma, so it
  // is always `<= -1`. The sign therefore both distinguishes the two container
  // kinds and keeps a colon (charged only to objects) and a comma (charged only
  // to arrays) from ever colliding on one frame. The innermost container is the
  // top of the stack.
  const counts: number[] = [];
  // Read a UTF-8 byte or a UTF-16 code unit per position; both yield the ASCII
  // structural values identically. The kind is hoisted into two narrowed locals
  // so the per-position cost is a single null check, not a `typeof` on every
  // unit -- the loop walks a ~512 MB transport string on the large-frame path.
  const str = typeof input === "string" ? input : null;
  const bytes = str === null ? (input as Uint8Array) : null;
  const length = input.length;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < length; i++) {
    const b = str !== null ? str.charCodeAt(i) : bytes![i];
    if (inString) {
      if (escaped) escaped = false;
      else if (b === BACKSLASH) escaped = true;
      else if (b === QUOTE) inString = false;
      continue;
    }
    switch (b) {
      case QUOTE:
        inString = true;
        break;
      case OPEN_BRACE:
      case OPEN_BRACKET:
        if (counts.length >= maxDepth) return true;
        counts.push(b === OPEN_BRACE ? 0 : -1);
        break;
      case CLOSE_BRACE:
      case CLOSE_BRACKET:
        counts.pop();
        break;
      case COLON: {
        const top = counts.length - 1;
        if (top >= 0 && counts[top] >= 0 && ++counts[top] > maxObjectKeys)
          return true;
        break;
      }
      case COMMA: {
        const top = counts.length - 1;
        // A comma at array top-of-stack separates two elements. The frame's
        // tally is negative, so element count = -counts[top] - 1 after this
        // decrement; reject once that passes the budget.
        if (
          top >= 0 &&
          counts[top] < 0 &&
          -(--counts[top]) - 1 > maxArrayElements
        )
          return true;
        break;
      }
    }
  }
  return false;
}
