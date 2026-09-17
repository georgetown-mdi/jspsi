import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

import repoConfig from "../eslint.config.mjs";
import { withoutTypeAwareLayer } from "./eslint-strip-type-aware-layer.mjs";

// Coverage of the unmarked-operator-path ban in the repo-root
// eslint.config.mjs: a CLI message naming the operator's own path composes it
// through the mark, so the display sink shows the path as they typed it rather
// than escaping every separator into one they cannot copy back into a command
// (packages/core/src/utils/operatorSuppliedText.ts).
//
// The ban is a set of esquery selectors, and a selector that stops matching
// fails silently -- it keeps reporting zero problems, which reads exactly like
// clean source. The cases below are what makes its coverage executable. Each is
// linted through the real repo config against a path inside the guarded tree,
// with the type-aware layer stripped off so what this reports rests on the text
// it hands in and no lint here waits on a TypeScript program.
//
// Every CLI source is held to the ban: the sensitive-file re-export shim takes
// its own config block for the raw-parse exemption it needs, and no source is
// exempt from this ban.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const baseConfig = withoutTypeAwareLayer(repoConfig);
const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: true,
  baseConfig,
});

const BAN_MESSAGE_PREFIX = "Mark an operator's own path where the message";

/** The ban's messages among `messages`, a fatal parse counting as neither. */
function banMessages(messages) {
  const fatal = messages.filter((message) => message.fatal);
  if (fatal.length > 0)
    throw new Error(fatal.map((message) => message.message).join("; "));
  return messages.filter(
    (message) =>
      message.ruleId === "no-restricted-syntax" &&
      message.message.startsWith(BAN_MESSAGE_PREFIX),
  );
}

/** What the ban reports for `source` linted as `filePath`. */
async function banHits(filePath, source) {
  const [result] = await eslint.lintText(source, { filePath });
  return banMessages(result.messages);
}

// A guarded path the ban covers.
const COVERED_FILE = resolve(repoRoot, "apps/cli/src/banFixture.ts");

// Loading the typescript-eslint parser for the first time is the expensive part
// of a lintText call, independent of the text it is given; a beforeAll absorbs
// it once under its own budget so no case pays for it inside vitest's default.
const LINTER_WARM_UP_TIMEOUT_MS = 30_000;

const BANNED = [
  [
    "a path interpolated into an Error message",
    "throw new Error(`could not read ${configPath}`);",
  ],
  [
    "a path interpolated into an Error subclass",
    "throw new UsageError(`could not read ${keyFile}`);",
  ],
  [
    "a path concatenated into an Error message",
    'throw new Error("could not read " + inputDir);',
  ],
  [
    "a path read off an options object",
    "throw new Error(`could not read ${options.configFile}`);",
  ],
  ["a path as an Error's whole message", "throw new Error(recordFile);"],
  [
    "a path on a ternary branch of an Error message",
    "throw new Error(missing ? configPath : recordFile);",
  ],
  ["a path in a cause chain's fragments", "chainDetailCauses([configPath]);"],
  ["a path at a log sink", "log.warn(`${configPath} is unreadable`);"],
  ["a path at a console sink", "console.error(`at ${configPath}`);"],
  [
    "a path in a logger reached through a field",
    "deps.log().warn(`at ${configPath}`);",
  ],
  [
    "a path in a terminal question",
    "void promptConfirm(`Overwrite ${configFile}?`);",
  ],
  [
    "a path on a prompt-stream line",
    "writePromptLine(`writing ${recordFile}`);",
  ],
  [
    "a path in a free-text question",
    "void promptFreeText(`where should ${configFile} be written?`);",
  ],
  [
    "a name opening with path rather than ending in it",
    "throw new Error(`could not read ${pathValue}`);",
  ],
  [
    "a name opening with file before a capital",
    "throw new Error(`could not read ${fileName}`);",
  ],
  ["an all-lowercase filename", "log.warn(`${filename} is unreadable`);"],
  [
    "a name ending in File behind an initialism",
    "throw new Error(`could not read ${CSVFile}`);",
  ],
  [
    "a name ending in Path behind an initialism",
    "log.warn(`${ACLPath} is unreadable`);",
  ],
  [
    "a path under the name of the flag argument it came from",
    "throw new Error(`could not read ${identityFileArg}`);",
  ],
  [
    "a plural flag-argument name",
    "log.warn(`${configFileArgs} are unreadable`);",
  ],
  [
    "a positional named target",
    "throw new Error(`could not write ${target}`);",
  ],
  ["a positional named input", "log.warn(`${input} is unreadable`);"],
  [
    "a generic word under the name of the flag argument it came from",
    "throw new Error(`could not read ${inputArg}`);",
  ],
  [
    "a plural generic flag-argument name",
    "log.warn(`${targetArgs} are unreadable`);",
  ],
];

const ALLOWED = [
  [
    "a marked path in a composed message",
    "const message = messageWithOperatorText`could not read ${operatorSuppliedText(configPath)}`;\n" +
      "  throw keepOperatorSuppliedText(new Error(message.text), message);",
  ],
  [
    "a marked path at a log sink",
    "log.warn(`${redactAndRenderOperatorSuppliedText(operatorSuppliedText(configPath))} is unreadable`);",
  ],
  [
    "a marked path in a terminal question",
    "void promptConfirm(`Overwrite ${redactAndRenderOperatorSuppliedText(operatorSuppliedText(configFile))}?`);",
  ],
  [
    "a value whose name names no path",
    "throw new Error(`could not read ${detail}`);",
  ],
  [
    "a path handed to something that is not a message",
    "readFileSync(configPath);",
  ],
  ["a path stored rather than shown", "const kept = { source: configPath };"],
  [
    // What the name-based recognition does not reach, pinned so the spec
    // paragraph stating the miss cannot drift from the selector.
    "a path under a name the pattern does not reach",
    "throw new Error(`could not read ${output} to ${destination}`);",
  ],
  [
    "a flag-argument name whose stem names no path",
    "throw new Error(`could not read ${signedRecordArg}`);",
  ],
  [
    // The generic words are matched whole: a longer name opening with one of
    // them says what it holds and is outside the shape.
    "a longer name opening with one of the bare generic words",
    "log.warn(`${inputColumns} are unreadable`);",
  ],
  [
    // The suffix is matched with its capital, so a lowercase word closing a
    // longer name is outside both shapes -- only a name OPENING with the word
    // reaches the ban in lowercase.
    "an all-lowercase name ending in file rather than opening with it",
    "throw new Error(`could not read ${keyfile}`);",
  ],
];

const PREAMBLE = `
declare const configPath: string;
declare const configFile: string;
declare const keyFile: string;
declare const inputDir: string;
declare const recordFile: string;
declare const detail: string;
declare const pathValue: string;
declare const fileName: string;
declare const filename: string;
declare const CSVFile: string;
declare const ACLPath: string;
declare const keyfile: string;
declare const target: string;
declare const input: string;
declare const inputArg: string;
declare const targetArgs: readonly string[];
declare const identityFileArg: string;
declare const configFileArgs: readonly string[];
declare const signedRecordArg: string;
declare const inputColumns: readonly string[];
declare const output: string;
declare const destination: string;
declare const missing: boolean;
declare const options: { configFile: string };
declare const log: { warn(text: string): void };
declare const deps: { log(): { warn(text: string): void } };
declare function readFileSync(value: string): string;
declare function chainDetailCauses(details: readonly string[]): unknown;
declare function operatorSuppliedText(value: string): unknown;
declare function messageWithOperatorText(
  fixedSpans: TemplateStringsArray,
  ...values: unknown[]
): { text: string };
declare function keepOperatorSuppliedText<E>(error: E, message: unknown): E;
declare function redactAndRenderOperatorSuppliedText(value: unknown): string;
declare function promptConfirm(question: string): Promise<boolean>;
declare function promptFreeText(question: string): Promise<string>;
declare function writePromptLine(line: string): void;
declare class UsageError extends Error {}
export function fixture(): void {
`;

function fixture(body) {
  return `${PREAMBLE}  ${body}\n}\n`;
}

describe("the unmarked-operator-path ban", () => {
  beforeAll(async () => {
    await banHits(COVERED_FILE, fixture("throw new Error(`at ${detail}`);"));
  }, LINTER_WARM_UP_TIMEOUT_MS);

  for (const [label, body] of BANNED) {
    it(`rejects ${label}`, async () => {
      expect(await banHits(COVERED_FILE, fixture(body))).not.toHaveLength(0);
    });
  }

  for (const [label, body] of ALLOWED) {
    it(`accepts ${label}`, async () => {
      expect(await banHits(COVERED_FILE, fixture(body))).toHaveLength(0);
    });
  }

  it("does not reach apps/cli/test, where no operator reads the message", async () => {
    expect(
      await banHits(
        resolve(repoRoot, "apps/cli/test/banFixture.ts"),
        fixture("throw new Error(`could not read ${configPath}`);"),
      ),
    ).toHaveLength(0);
  });

  it("holds the sensitive-file re-export shim, which the raw-parse ban spares", async () => {
    expect(
      await banHits(
        resolve(repoRoot, "apps/cli/src/sensitiveFile.ts"),
        fixture("throw new Error(`could not read ${configPath}`);"),
      ),
    ).not.toHaveLength(0);
  });

  // A disable kept past the site it excused leaves a sink exempt from a rule it
  // already satisfies, and `eslint .` only warns about one, so the blocks
  // carrying this ban raise it to an error. Driven rather than read off the
  // config: what a test of the setting alone would pin is the spelling.
  for (const [label, filePath] of [
    ["a guarded CLI source", COVERED_FILE],
    ["the re-export shim", resolve(repoRoot, "apps/cli/src/sensitiveFile.ts")],
  ]) {
    it(`fails on an unused disable in ${label}`, async () => {
      const [result] = await eslint.lintText(
        fixture(
          "// eslint-disable-next-line no-restricted-syntax -- nothing to excuse.\n" +
            "  readFileSync(configPath);",
        ),
        { filePath },
      );
      const unused = result.messages.filter((message) =>
        message.message.startsWith("Unused eslint-disable directive"),
      );
      expect(unused).toHaveLength(1);
      expect(unused[0].severity).toBe(2);
    });
  }
});
