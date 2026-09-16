import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { operatorSuppliedSpans, sanitizeErrorForDisplay } from "@psilink/core";

import { loadConfig } from "../../src/commands/exchange";
import { readConfigHints } from "../../src/commands/fingerprint";
import {
  readConfigSigningBlock,
  readSignedRecordFile,
} from "../../src/commands/verifyReceipt";
import { loadKeyFile } from "../../src/keyFile";
import { loadSigningIdentity } from "../../src/signingIdentityFile";

// Each reader below names the document it could not parse by a label it
// composes through the mark, so the sensitive-parse chokepoint's refusal shows
// the operator's own path as they typed it: the display escape doubles a
// literal backslash to keep its \xHH tokens unambiguous, which would hand a
// Windows operator a path they cannot copy back into a command
// (packages/core/src/utils/operatorSuppliedText.ts).
//
// The fixture path holds backslashes on every platform -- native separators on
// Windows, and one file name spelling them off it, where a backslash is a
// legal filename character -- so every reader is exercised wherever the suite
// runs rather than only on Windows.

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-labels-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// A tab where YAML wants a space, and a JSON object that never closes.
const UNPARSEABLE_YAML = "a:\n\tb: 1\n";
const UNPARSEABLE_JSON = '{ "version": ';

/** A path under `dir` holding backslashes, with its directory created. */
function backslashedPath(name: string): string {
  const full =
    process.platform === "win32"
      ? path.join(dir, "psilink", name)
      : path.join(dir, `C:\\psilink\\${name}`);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return full;
}

/** The fragments a failure marks as the operator's own, read off the error. */
function markedFragments(thrown: unknown): string[] {
  const error = thrown as Error;
  return (operatorSuppliedSpans(error, error.message) ?? [])
    .filter((span) => span.operatorSupplied)
    .map((span) => span.text);
}

const LABELLED_READERS: ReadonlyArray<
  [string, string, string, (filePath: string) => unknown]
> = [
  [
    "the exchange config reader",
    "psilink.yaml",
    UNPARSEABLE_YAML,
    (filePath) =>
      loadConfig({ configFile: filePath, keyFile: path.join(dir, "key.json") }),
  ],
  [
    "the fingerprint config reader",
    "psilink.yaml",
    UNPARSEABLE_YAML,
    (filePath) => readConfigHints(filePath, true),
  ],
  [
    "the receipt-verification config reader",
    "psilink.yaml",
    UNPARSEABLE_YAML,
    (filePath) => readConfigSigningBlock(filePath, true),
  ],
  [
    "the signed-record reader",
    "record.json",
    UNPARSEABLE_JSON,
    (filePath) => readSignedRecordFile(filePath),
  ],
  [
    "the key-file reader",
    "psilink.key",
    UNPARSEABLE_JSON,
    (filePath) => loadKeyFile(filePath, { warnOnPermissive: false }),
  ],
  [
    "the signing-identity reader",
    "identity.json",
    UNPARSEABLE_JSON,
    (filePath) => loadSigningIdentity(filePath),
  ],
];

for (const [label, name, contents, read] of LABELLED_READERS) {
  test(`${label} names the operator's path as they typed it`, async () => {
    const filePath = backslashedPath(name);
    fs.writeFileSync(filePath, contents, { mode: 0o600 });

    let thrown: unknown;
    try {
      await read(filePath);
    } catch (err: unknown) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(markedFragments(thrown)).toEqual([filePath]);
    const rendered = sanitizeErrorForDisplay(thrown);
    expect(rendered).toContain(filePath);
    expect(rendered).not.toContain(filePath.replaceAll("\\", "\\\\"));
  });
}
