import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

import repoConfig, { UNMARKED_OPERATOR_PATH_FILES } from "../eslint.config.mjs";
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
// The second half holds the exemption list. It names the CLI sources whose
// sinks are not converted yet, and an entry left on it past its sweep would
// exempt a file from a rule it already satisfies -- so every listed file is
// linted with the exemption lifted and has to still report.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const baseConfig = withoutTypeAwareLayer(repoConfig);
const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: true,
  baseConfig,
});

// The same config with the exemption lifted, for reading what a listed file
// would report once it joins the ban.
const eslintWithoutExemptions = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: true,
  baseConfig: baseConfig.map((block) =>
    Array.isArray(block.ignores) &&
    block.ignores.some((pattern) =>
      UNMARKED_OPERATOR_PATH_FILES.includes(pattern),
    )
      ? {
          ...block,
          ignores: block.ignores.filter(
            (pattern) => !UNMARKED_OPERATOR_PATH_FILES.includes(pattern),
          ),
        }
      : block,
  ),
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

// A guarded path the ban covers and no exemption names, and one it exempts.
const COVERED_FILE = resolve(repoRoot, "apps/cli/src/banFixture.ts");
const EXEMPT_FILE = resolve(repoRoot, UNMARKED_OPERATOR_PATH_FILES[0]);

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
    "a name opening with path rather than ending in it",
    "throw new Error(`could not read ${pathValue}`);",
  ],
  [
    "a name opening with file before a capital",
    "throw new Error(`could not read ${fileName}`);",
  ],
  ["an all-lowercase filename", "log.warn(`${filename} is unreadable`);"],
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
    "throw new Error(`could not read ${target} to ${destination}`);",
  ],
];

const PREAMBLE = `
declare const configPath: string;
declare const keyFile: string;
declare const inputDir: string;
declare const recordFile: string;
declare const detail: string;
declare const pathValue: string;
declare const fileName: string;
declare const filename: string;
declare const target: string;
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

  it("exempts a listed source", async () => {
    expect(
      await banHits(
        EXEMPT_FILE,
        fixture("throw new Error(`could not read ${configPath}`);"),
      ),
    ).toHaveLength(0);
  });
});

describe("the exemption list", () => {
  it("names only files that exist", () => {
    expect(
      UNMARKED_OPERATOR_PATH_FILES.filter(
        (file) => !existsSync(resolve(repoRoot, file)),
      ),
    ).toEqual([]);
  });

  it(
    "holds no file the ban would already pass",
    async () => {
      const results = await eslintWithoutExemptions.lintFiles(
        UNMARKED_OPERATOR_PATH_FILES.map((file) => resolve(repoRoot, file)),
      );
      const clean = results
        .filter((result) => banMessages(result.messages).length === 0)
        .map((result) => result.filePath.slice(repoRoot.length + 1));
      expect(
        clean,
        "these sources mark every operator path they name: drop them from UNMARKED_OPERATOR_PATH_FILES so the ban holds them",
      ).toEqual([]);
    },
    LINTER_WARM_UP_TIMEOUT_MS,
  );
});
