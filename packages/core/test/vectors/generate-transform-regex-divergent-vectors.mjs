// Independent generator for test/vectors/transform-regex-divergent-vectors.json.
//
// Companion to generate-transform-regex-vectors.mjs, covering the OPPOSITE
// domain. That file pins the patterns/inputs where re2js and `new RegExp` AGREE
// (its expected values are computed with `new RegExp`). This file pins the
// inputs where they DIVERGE -- the documented RE2-vs-JavaScript class and
// code-point differences (PROTOCOL.md) -- so the expected values CANNOT be
// computed with `new RegExp`; they are computed with re2js itself, mirroring the
// standardization factories' use of the linearRegex wrapper.
//
// The point is cross-build / cross-version determinism, not migration
// equivalence: both build targets run re2js, so they must agree on exactly these
// inputs, and freezing re2js's current output here turns a future re2js behavior
// change (or an ESM/CJS build divergence) into a failing test. Replayed by:
//
//   - packages/core/test/transformRegexVectors.test.ts (Node re2js), and
//   - apps/web/test/browser/transformRegex.test.ts (browser re2js).
//
// Run:  node packages/core/test/vectors/generate-transform-regex-divergent-vectors.mjs
// It prints the JSON to stdout; redirect into
// transform-regex-divergent-vectors.json, then run `npm run format`.

import { RE2JS } from "re2js";

// --- re2js reference (mirrors src/utils/linearRegex.ts + the factories) -------

const nfc = (s) => s.normalize("NFC");

function compile(pattern) {
  const re = RE2JS.compile(pattern);
  return {
    replaceAll: (input, replacement) =>
      re.matcher(input).replaceAll(replacement),
    extractFirst: (input) => {
      const m = re.matcher(input);
      if (!m.find()) return null;
      const group1 = m.groupCount() >= 1 ? m.group(1) : null;
      return (group1 ?? m.group(0)) || null;
    },
    test: (input) => re.test(input),
  };
}

function replaceRegex(input, pattern, replacement = "") {
  return compile(pattern).replaceAll(nfc(input), nfc(replacement));
}
function extractRegex(input, pattern) {
  return compile(pattern).extractFirst(nfc(input));
}
function filterRegex(input, pattern) {
  const n = nfc(input);
  return compile(pattern).test(n) ? n : null;
}

// --- Vector definitions ------------------------------------------------------

const REPLACE = (pattern, replacement, input) => ({
  step: { function: "replace_regex", params: { pattern, replacement } },
  value: replaceRegex(input, pattern, replacement),
  input,
});
const EXTRACT = (pattern, input) => ({
  step: { function: "extract_regex", params: { pattern } },
  value: extractRegex(input, pattern),
  input,
});
const FILTER = (pattern, input) => ({
  step: { function: "filter_regex", params: { pattern } },
  value: filterRegex(input, pattern),
  input,
});

// Build the invisible code points from their numeric values so the source stays
// pure ASCII and unambiguous (no literal control / whitespace characters).
const EMOJI = String.fromCodePoint(0x1f600); // non-BMP (a surrogate pair)
const NBSP = String.fromCharCode(0x00a0); // NO-BREAK SPACE
const VTAB = String.fromCharCode(0x000b); // LINE TABULATION (vertical tab)
const LSEP = String.fromCharCode(0x2028); // LINE SEPARATOR
const PSEP = String.fromCharCode(0x2029); // PARAGRAPH SEPARATOR
const IDEO = String.fromCharCode(0x3000); // IDEOGRAPHIC SPACE
const CR = String.fromCharCode(0x000d); // CARRIAGE RETURN
const LF = String.fromCharCode(0x000a); // LINE FEED
const TAB = String.fromCharCode(0x0009); // CHARACTER TABULATION
const SP = String.fromCharCode(0x0020); // SPACE

const cases = [
  // `.` spans a CODE POINT under RE2, but a UTF-16 code unit under JavaScript's
  // RegExp without the `u` flag, so `^(.)$` matches a whole non-BMP emoji here
  // and extracts it; under `new RegExp` it would not match (two code units).
  EXTRACT("^(.)$", EMOJI),
  // Empty-match replacement walks code-point boundaries under RE2 (one boundary
  // before and one after the single emoji code point), not the code-unit
  // boundaries `new RegExp` would use (which would also split the surrogate pair).
  REPLACE("a*", "X", EMOJI),
  // RE2 `\s` is ASCII-only `[\t\n\f\r ]`. These Unicode whitespace code points,
  // which JavaScript's `\s` matches (with or without `u`), do NOT match here, so
  // the filter rejects (null) rather than passing the value through.
  FILTER("\\s", NBSP),
  FILTER("\\s", VTAB),
  FILTER("\\s", LSEP),
  FILTER("\\s", PSEP),
  FILTER("\\s", IDEO),
  // RE2 `.` excludes ONLY `\n`; it matches CR and the Unicode line separators
  // that JavaScript's `.` (no `s` flag) also excludes, so `^.$` passes them.
  FILTER("^.$", CR),
  FILTER("^.$", LSEP),
  FILTER("^.$", PSEP),
  // Controls (RE2 and JavaScript AGREE here): `.` still excludes `\n`, and ASCII
  // space and tab still match `\s`. Pinned so the divergence cases above are read
  // against a baseline rather than in isolation.
  FILTER("^.$", LF),
  FILTER("\\s", SP),
  FILTER("\\s", TAB),
];

const vectors = cases.map(({ step, value, input }, idx) => ({
  name: `${step.function}-divergent-${idx}`,
  steps: [step],
  input,
  expected: value,
}));

process.stdout.write(JSON.stringify({ vectors }, null, 2) + "\n");
