// Independent generator for test/vectors/transform-regex-vectors.json.
//
// Each vector is one partner transform step (a `tier: "regex"` function or
// `parse_date`) run on one input. The EXPECTED output is computed here with the
// JavaScript `RegExp` engine -- the engine these steps ran on before this change
// -- using a from-scratch reimplementation of each factory's logic. The module
// under test now runs the SAME steps on the linear-time engine (re2js), so:
//
//   - packages/core/test/transformRegexVectors.test.ts asserts the re2js factory
//     reproduces these JS-RegExp outputs (byte-identical to the old engine), and
//   - apps/web/test/browser/transformRegex.test.ts asserts the BROWSER build of
//     @psilink/core reproduces the same outputs (the two build targets agree).
//
// Together those pin both acceptance criteria: in-dialect patterns are
// byte-identical to the previous engine, and the CLI (Node) and web (browser)
// builds derive identical values. Only in-dialect patterns and inputs JS `RegExp`
// can evaluate without catastrophic backtracking appear here; the linear-time
// behavior on the former-ReDoS patterns is checked separately (linearRegex.test.ts
// and the parse_date many-token vector below, which uses a matching input so the
// JS reference terminates).
//
// Run:  node packages/core/test/vectors/generate-transform-regex-vectors.mjs
// It prints the JSON to stdout; redirect into transform-regex-vectors.json.

// --- JS-RegExp reference implementations (mirror standardization.ts) ----------

const nfc = (s) => s.normalize("NFC");

function replaceRegex(input, pattern, replacement = "") {
  return nfc(input).replace(new RegExp(pattern, "g"), nfc(replacement));
}

function extractRegex(input, pattern) {
  const m = nfc(input).match(new RegExp(pattern));
  if (!m) return null;
  return (m[1] ?? m[0]) || null;
}

function filterRegex(input, pattern) {
  const n = nfc(input);
  return new RegExp(pattern).test(n) ? n : null;
}

function splitOn(input, delimiter, includeOriginal = false) {
  const n = nfc(input);
  const parts = n.split(new RegExp(delimiter)).filter((p) => p.length > 0);
  if (parts.length <= 1) return new Set([n]);
  return includeOriginal ? new Set([n, ...parts]) : new Set(parts);
}

// Mirrors parseDateFormat + parseDateFactory in standardization.ts.
function parseDateFormat(inputFormat) {
  const order = [];
  let regexStr = "";
  let i = 0;
  while (i < inputFormat.length) {
    if (inputFormat.startsWith("YYYY", i)) {
      order.push("YYYY");
      regexStr += "(\\d{4})";
      i += 4;
    } else if (inputFormat.startsWith("MM", i)) {
      order.push("MM");
      regexStr += "(\\d{1,2})";
      i += 2;
    } else if (inputFormat.startsWith("DD", i)) {
      order.push("DD");
      regexStr += "(\\d{1,2})";
      i += 2;
    } else {
      regexStr += inputFormat[i].replace(/[.*+?^${}()|[\]\\]/, "\\$&");
      i++;
    }
  }
  return { source: `^${regexStr}$`, order };
}

function parseDate(
  input,
  inputFormat = "MM/DD/YYYY",
  outputFormat = "YYYYMMDD",
) {
  const { source, order } = parseDateFormat(inputFormat);
  const m = nfc(input).match(new RegExp(source));
  if (!m) return null;
  const parts = {};
  order.forEach((token, idx) => {
    parts[token] = token === "YYYY" ? m[idx + 1] : m[idx + 1].padStart(2, "0");
  });
  if (!parts.YYYY || !parts.MM || !parts.DD) return null;
  const asDate = new Date(`${parts.YYYY}-${parts.MM}-${parts.DD}`);
  if (isNaN(asDate.getTime())) return null;
  return outputFormat
    .replace("YYYY", parts.YYYY)
    .replace("MM", parts.MM)
    .replace("DD", parts.DD);
}

// Serialize a FieldValue (string | null | Set<string>) to a stable JSON form:
// a Set becomes an array in insertion order (every engine builds it the same way,
// so the order is part of the contract), a string/null pass through.
function serialize(value) {
  if (value === null) return null;
  if (value instanceof Set) return [...value];
  return value;
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
// Param keys are camelCase: these vectors feed runPipeline directly, which reads
// the post-camelizeKeys param names the factories use (camelization happens in
// parseLinkageTerms, upstream of runPipeline).
const SPLIT = (delimiter, input, includeOriginal = false) => ({
  step: { function: "split_on", params: { delimiter, includeOriginal } },
  value: splitOn(input, delimiter, includeOriginal),
  input,
});
const PARSE_DATE = (inputFormat, outputFormat, input) => ({
  step: { function: "parse_date", params: { inputFormat, outputFormat } },
  value: parseDate(input, inputFormat, outputFormat),
  input,
});

const cases = [
  // The bundled default-template patterns, on representative and edge inputs.
  REPLACE("[^0-9]", "", "(555) 123-4567"),
  REPLACE("[^0-9]", "", "abc"),
  REPLACE("^1(\\d{10})$", "$1", "15551234567"),
  REPLACE("^1(\\d{10})$", "$1", "5551234567"),
  EXTRACT("(\\d{4})$", "5551234"),
  EXTRACT("(\\d{4})$", "12"),
  EXTRACT("\\d+", "abc123def"),
  FILTER("[A-Z]", "ABC"),
  FILTER("[A-Z]", "abc"),
  FILTER("^\\d{9}$", "123456789"),
  FILTER("^\\d{9}$", "12345678"),
  FILTER("^\\d{10}$", "5551234567"),
  FILTER("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", "a@b.co"),
  FILTER("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", "not-an-email"),
  PARSE_DATE("MM/DD/YYYY", "YYYYMMDD", "01/02/2020"),
  PARSE_DATE("MM/DD/YYYY", "YYYYMMDD", "1/2/2020"),
  PARSE_DATE("YYYY-MM-DD", "YYYYMMDD", "2020-12-31"),
  PARSE_DATE("MM/DD/YYYY", "YYYYMMDD", "13/40/2020"),
  // General in-dialect coverage beyond the defaults.
  REPLACE("(a)(b)", "$2$1", "abab"),
  REPLACE("\\d", "#", "a1b2"),
  EXTRACT("([a-z]+)@", "user@example.com"),
  SPLIT("[;,]", "a;b,c"),
  SPLIT("\\s+", "a  b   c"),
  SPLIT("-", "a-b-c", true),
  SPLIT("-", "nodelim"),
  // A non-ASCII input to exercise the NFC normalization contract (the cafe e is
  // supplied decomposed; NFC recomposes it before matching).
  FILTER("^.+$", "café"),
  // A many-adjacent-token parse_date format that catastrophically backtracks on
  // new RegExp for a NON-matching input -- but here the input MATCHES (24 single
  // digits), so the JS reference terminates and pins the value the linear-time
  // engine must also produce.
  PARSE_DATE("MM".repeat(12), "YYYYMMDD", "1".repeat(12)),
];

const vectors = cases.map(({ step, value, input }, idx) => ({
  name: `${step.function}-${idx}`,
  steps: [step],
  input,
  expected: serialize(value),
}));

process.stdout.write(JSON.stringify({ vectors }, null, 2) + "\n");
