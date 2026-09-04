import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// Coverage of the display-sink ban in the repo-root eslint.config.mjs: no raw
// error may be rendered at an operator-facing sink. Operator-facing escaping
// happens at ONE altitude -- the sink -- so an omission there puts a partner- or
// server-controlled error message on the terminal verbatim, with whatever ANSI,
// CR/LF, bidi or confusable bytes it carries. The ban is a set of esquery
// selectors, and a selector that stops matching fails silently: it keeps
// reporting zero problems, which is indistinguishable from clean source. These
// cases are what makes its coverage executable.
//
// Each case is linted through the real repo config against a path inside a
// guarded tree, so the scope, the selectors, and the rule wiring are all
// exercised as CI runs them rather than restated here.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: resolve(repoRoot, "eslint.config.mjs"),
});

/**
 * Messages the display-sink ban reports for `source` linted as `filePath`. A
 * source that does not parse throws rather than reading as zero problems.
 */
async function banHits(filePath, source) {
  const [result] = await eslint.lintText(source, { filePath });
  const fatal = result.messages.filter((message) => message.fatal);
  if (fatal.length > 0) {
    throw new Error(`${filePath}: ${fatal.map((m) => m.message).join("; ")}`);
  }
  return result.messages.filter(
    (message) =>
      message.ruleId === "no-restricted-syntax" &&
      message.message.startsWith("Do not render a raw error"),
  );
}

const CORE_FILE = resolve(repoRoot, "packages/core/src/banFixture.ts");
const CLI_FILE = resolve(repoRoot, "apps/cli/src/banFixture.ts");
const BROKER_FILE = resolve(
  repoRoot,
  "packages/peerjs-broker/src/banFixture.ts",
);

// Loading the flat config and the typescript-eslint parser for the first time
// is the expensive part of a lintText call, independent of which file or how
// much text it is given; under cold process/CPU load that one-time cost alone
// can exceed vitest's 5s test default. A beforeAll absorbs it once, under its
// own explicit budget, so no individual case pays for it inside the default
// test timeout.
const LINTER_WARM_UP_TIMEOUT_MS = 30_000;

// Reserved for the canary: a guarded path that exists on disk, parses, and is
// linted by nothing else here.
const CORE_FILE_FIRST_PARSE = resolve(repoRoot, "packages/core/src/main.ts");

// Each entry is a statement body appended to a preamble that declares the
// bindings it uses, so a case reads as the line a contributor would write.
const BANNED = [
  ["a bare error value at console.error", "console.error(err);"],
  ["a bare error value at a logger", "log.error(err);"],
  ["`.message` read at a logger", "log.warn(err.message);"],
  ["String() coercion at a logger", "log.warn(String(err));"],
  ["template coercion of the value", "log.warn(`failed: ${err}`);"],
  [
    "template interpolation of `.message`",
    "log.warn(`failed: ${err.message}`);",
  ],
  ["concatenation of `.message`", 'log.warn("failed: " + err.message);'],
  [
    "a ternary over `.message`",
    "log.warn(err instanceof Error ? err.message : String(err));",
  ],
  ["the errorMessage accessor", "log.info(errorMessage(err));"],
  ["a `.log()` accessor sink", "deps.log().debug(`failed: ${err.message}`);"],
  ["a `this.log` field sink", "holder.log.debug(errorMessage(err));"],
  ["a getLogger(...) sink", 'getLogger("x").error(err);'],
  [
    "a value mapped inside the call",
    'log.info(errors.map((cause) => cause.message).join(", "));',
  ],
];

const ALLOWED = [
  [
    "an error routed through the error sanitizer",
    "console.error(sanitizeErrorForDisplay(err));",
  ],
  [
    "an interpolated sanitized error",
    "log.warn(`failed: ${sanitizeErrorForDisplay(err)}`);",
  ],
  [
    "a concatenated sanitized error",
    'log.warn("failed: " + sanitizeErrorForDisplay(err));',
  ],
  [
    "a sanitized message accessor",
    "log.debug(`failed: ${sanitizeForDisplay(errorMessage(err))}`);",
  ],
  [
    "a sanitized string fragment",
    "log.info(`at ${sanitizeForDisplay(name)}`);",
  ],
  [
    "a raw fragment composed into an Error",
    "throw new Error(`at ${name}: ${errorMessage(err)}`);",
  ],
  ["`.message` on a non-sink call", "record(err.message);"],
];

const PREAMBLE = `
declare const err: unknown;
declare const name: string;
declare const errors: Array<{ message: string }>;
declare const log: {
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
declare const holder: { log: typeof log };
declare const deps: { log(): typeof log };
declare function getLogger(name: string): typeof log;
declare function errorMessage(value: unknown): string;
declare function sanitizeForDisplay(value: string): string;
declare function sanitizeErrorForDisplay(value: unknown): string;
declare function record(value: string): void;
export function fixture(): void {
`;

function fixture(body) {
  return `${PREAMBLE}  ${body}\n}\n`;
}

describe("the display-sink raw-error ban", () => {
  beforeAll(async () => {
    await banHits(CORE_FILE, fixture("record(err.message);"));
  }, LINTER_WARM_UP_TIMEOUT_MS);

  it("lints the text it is handed, not the file on disk", async () => {
    expect(
      existsSync(CORE_FILE_FIRST_PARSE),
      `${CORE_FILE_FIRST_PARSE} no longer exists`,
    ).toBe(true);
    const [result] = await eslint.lintText("this is not typescript !!! (((\n", {
      filePath: CORE_FILE_FIRST_PARSE,
    });
    expect(
      result.messages.map((message) => message.message).join("; "),
      `${CORE_FILE_FIRST_PARSE}: the source on disk was linted instead, so a case asserting zero problems proves nothing about the text it handed in`,
    ).toMatch(/Parsing error/);
  });

  for (const [label, body] of BANNED) {
    it(`rejects ${label}`, async () => {
      expect(await banHits(CORE_FILE, fixture(body))).not.toHaveLength(0);
    });
  }

  for (const [label, body] of ALLOWED) {
    it(`accepts ${label}`, async () => {
      expect(await banHits(CORE_FILE, fixture(body))).toHaveLength(0);
    });
  }

  // The broker's diagnostics sink writes a peer's own error text to the
  // operator's log, so it is guarded alongside the two first-party trees.
  for (const [tree, filePath] of [
    ["apps/cli/src", CLI_FILE],
    ["packages/peerjs-broker/src", BROKER_FILE],
  ]) {
    it(`guards ${tree} as well as packages/core/src`, async () => {
      expect(
        await banHits(filePath, fixture("log.warn(err.message);")),
      ).not.toHaveLength(0);
    });
  }
});
