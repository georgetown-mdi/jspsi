import { afterEach, expect, test, vi } from "vitest";
import YAML from "yaml";

import { UsageError } from "../src/errors";
import {
  JsonStructureBoundError,
  MAX_JSON_NESTING_DEPTH,
} from "../src/utils/boundedJson";
import {
  messageWithOperatorText,
  operatorSuppliedText,
} from "../src/utils/operatorSuppliedText";
import { sanitizeErrorForDisplay } from "../src/utils/sanitizeErrorForDisplay";
import {
  parseSensitiveYaml,
  editSensitiveYamlDocument,
  parseSensitiveJson,
} from "../src/sensitiveFile";

// A distinctive credential value that must never appear in a displayed
// message.
const SECRET = "S3cr3tCredentialValue_2026";
const LABEL = "config file /tmp/alcove.yaml";

afterEach(() => {
  vi.restoreAllMocks();
});

// One row per parser leak channel, each with a credential on or in the offending
// source. Every chokepoint failure must throw a UsageError naming only the label
// (path), never the secret. The raw parser would echo the secret in every case
// (a YAMLParseError snippet, a ReferenceError alias token, doc.errors, V8's
// JSON source span); these assertions are what keep that closed.
const throwingChannels: Array<[string, () => unknown]> = [
  [
    "YAML syntax error (tab indent) with the secret on the line",
    () => parseSensitiveYaml(`a:\n\tb: ${SECRET}\n`, LABEL),
  ],
  [
    "YAML unresolved alias naming the secret (parse)",
    () => parseSensitiveYaml(`password: *${SECRET}\n`, LABEL),
  ],
  [
    "editYamlDocument syntax error collected in doc.errors (before edit)",
    () => editSensitiveYamlDocument(`a:\n\tb: ${SECRET}\n`, LABEL, () => {}),
  ],
  [
    "editYamlDocument unresolved alias reported at serialization (after edit)",
    () => editSensitiveYamlDocument(`password: *${SECRET}\n`, LABEL, () => {}),
  ],
  [
    "JSON parse error on a file that leads with the secret",
    () => parseSensitiveJson(`${SECRET} not json`, LABEL),
  ],
];

test.each(throwingChannels)(
  "reports path-only, never source, on failure: %s",
  (_name, fn) => {
    let caught: unknown;
    try {
      fn();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as Error).message).toContain(LABEL);
    expect((caught as Error).message).not.toContain(SECRET);
  },
);

test("the JSON structural bound stays path-only (no source), like every channel", () => {
  // parseSensitiveJson routes through parseBoundedJson, which rejects a
  // structurally pathological document (here nesting past the depth bound)
  // before JSON.parse can run. That rejection -- a distinct channel from a
  // syntax error -- must also report path-only, never the source.
  const deep = "[".repeat(5000) + `"${SECRET}"` + "]".repeat(5000);
  let caught: unknown;
  try {
    parseSensitiveJson(deep, LABEL);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  expect((caught as Error).message).toContain(LABEL);
  expect((caught as Error).message).not.toContain(SECRET);
});

test("suppresses the source-bearing YAML warning channel (stderr)", () => {
  const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  // An unresolved custom tag is a NON-fatal warning: default YAML.parse emits the
  // full source line through process.emitWarning (to stderr) and returns; the
  // chokepoint's logLevel:'error' must suppress that emission.
  const value = parseSensitiveYaml(`password: !secret ${SECRET}\n`, LABEL);
  expect(spy).not.toHaveBeenCalled();
  // The value still parses (the warning is non-fatal); returning it is correct.
  expect(value).toEqual({ password: SECRET });
});

test("the warning channel really leaks by default (guards the suppression test)", () => {
  // Proves the suppression test is meaningful: the same input through a default
  // YAML.parse emits a warning whose text contains the secret.
  const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  // Intentionally exercises the unguarded default YAML.parse to prove the
  // chokepoint closes a real channel. (No raw-parser ESLint ban applies to core
  // test files; the ban is scoped to src.)
  YAML.parse(`password: !secret ${SECRET}\n`);
  expect(spy).toHaveBeenCalled();
  const allArgs = spy.mock.calls.flat().map(String).join(" ");
  expect(allArgs).toContain(SECRET);
});

// The label route's other half: which side of the fragment boundary the path
// inside a label falls on. A label composed as a plain string is text nobody
// marked and keeps the escape; one composed through the mark names a path the
// OPERATOR chose and renders as they typed it.
const WINDOWS_CONFIG_PATH = "C:\\alcove\\alcove.yaml";
const markedLabel = messageWithOperatorText`config file ${operatorSuppliedText(
  WINDOWS_CONFIG_PATH,
)}`;

test("a marked label renders the operator's path as they typed it", () => {
  let caught: unknown;
  try {
    parseSensitiveJson(`${SECRET} not json`, markedLabel);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  expect((caught as Error).message).toBe(
    `config file ${WINDOWS_CONFIG_PATH} could not be parsed as JSON`,
  );
  const rendered = sanitizeErrorForDisplay(caught);
  expect(rendered).toContain(WINDOWS_CONFIG_PATH);
  expect(rendered).not.toContain(WINDOWS_CONFIG_PATH.replaceAll("\\", "\\\\"));
  expect(rendered).not.toContain(SECRET);
});

test("a string label keeps the escape, as every unmarked fragment does", () => {
  let caught: unknown;
  try {
    parseSensitiveJson(
      `${SECRET} not json`,
      `config file ${WINDOWS_CONFIG_PATH}`,
    );
  } catch (err) {
    caught = err;
  }
  const rendered = sanitizeErrorForDisplay(caught);
  expect(rendered).toContain(WINDOWS_CONFIG_PATH.replaceAll("\\", "\\\\"));
  expect(rendered).not.toContain(SECRET);
});

test("a marked label leaves a control character unrenderable", () => {
  // The mark states who chose the bytes, not that they are safe to emit: an ESC
  // opening an ANSI sequence still reaches the operator as a printable marker.
  const message = messageWithOperatorText`config file ${operatorSuppliedText(
    "C:\\alcove\\\u001b[2Kyaml",
  )}`;
  let caught: unknown;
  try {
    parseSensitiveJson("not json", message);
  } catch (err) {
    caught = err;
  }
  expect(sanitizeErrorForDisplay(caught)).not.toContain("\u001b");
});

test("a JSON document over the structural bound keeps the bound error as its cause", () => {
  const deep = "[".repeat(MAX_JSON_NESTING_DEPTH + 1);
  let overBound: unknown;
  try {
    parseSensitiveJson(deep, "the document");
  } catch (err) {
    overBound = err;
  }
  expect(overBound).toBeInstanceOf(UsageError);
  expect((overBound as Error).cause).toBeInstanceOf(JsonStructureBoundError);

  let malformed: unknown;
  try {
    parseSensitiveJson(`${SECRET} not json`, "the document");
  } catch (err) {
    malformed = err;
  }
  expect(malformed).toBeInstanceOf(UsageError);
  expect((malformed as Error).cause).toBeUndefined();
});
