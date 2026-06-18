import { afterEach, expect, test, vi } from "vitest";
import YAML from "yaml";
import { UsageError } from "@psilink/core";
import {
  parseSensitiveYaml,
  parseSensitiveYamlDocument,
  serializeSensitiveYamlDocument,
  parseSensitiveJson,
} from "../../src/sensitiveFile";

// A distinctive credential value that must never appear in a surfaced message.
const SECRET = "S3cr3tCredentialValue_2026";
const LABEL = "config file /tmp/psilink.yaml";

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
    "parseDocument syntax error collected in doc.errors",
    () => parseSensitiveYamlDocument(`a:\n\tb: ${SECRET}\n`, LABEL),
  ],
  [
    "parseDocument unresolved alias surfacing at serialization",
    () => {
      const doc = parseSensitiveYamlDocument(`password: *${SECRET}\n`, LABEL);
      return serializeSensitiveYamlDocument(doc, LABEL);
    },
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
  // YAML.parse emits a warning whose text carries the secret.
  const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  // Intentionally exercises the unguarded default YAML.parse to prove the
  // chokepoint closes a real channel. (The no-restricted-syntax ban is scoped to
  // apps/cli/src, so test files may call the raw parser directly.)
  YAML.parse(`password: !secret ${SECRET}\n`);
  expect(spy).toHaveBeenCalled();
  const allArgs = spy.mock.calls.flat().map(String).join(" ");
  expect(allArgs).toContain(SECRET);
});
