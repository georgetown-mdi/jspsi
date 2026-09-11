import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// Coverage of the Displayable-as-error-text ban in the repo-root
// eslint.config.mjs: an already-escaped value may not be composed into an Error.
// Operator-facing escaping happens at ONE altitude -- the display sink -- and an
// Error is not one, so a Displayable composed into an error message or cause is
// escaped again where the chain is rendered and every literal backslash in it
// reaches the operator doubled. The ban is a set of esquery selectors, and a
// selector that stops matching fails silently: it keeps reporting zero problems,
// which is indistinguishable from clean source. These cases are what makes its
// coverage executable.
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
 * Messages the Displayable-as-error-text ban reports for `source` linted as
 * `filePath`. A source that does not parse throws rather than counting as zero
 * problems.
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
      message.message.startsWith(
        "Do not compose an already-escaped Displayable",
      ),
  );
}

// The test tree is the primary fixture path. A test is where the split is
// cheapest to get wrong -- composing an error out of an escaped fragment pins a
// rendering no operator ever sees -- and the src blocks are covered below.
const CORE_TEST_FILE = resolve(repoRoot, "packages/core/test/banFixture.ts");
const CORE_SRC_FILE = resolve(repoRoot, "packages/core/src/banFixture.ts");
const CLI_SRC_FILE = resolve(repoRoot, "apps/cli/src/banFixture.ts");
const CLI_TEST_FILE = resolve(repoRoot, "apps/cli/test/banFixture.ts");
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
// linted by nothing else here. The module that owns the brand, so a rename
// there fails this rather than leaving the canary pointed at nothing.
const CORE_FILE_FIRST_PARSE = resolve(
  repoRoot,
  "packages/core/src/utils/sanitizeForDisplay.ts",
);

// Each entry is a statement body appended to a preamble that declares the
// bindings it uses, so a case looks like the line a contributor would write.
const BANNED = [
  [
    "an escaped decode description interpolated into an Error",
    "throw new Error(`invalid invitation string: ${describeDecodeError(err)}`);",
  ],
  [
    "an escaped fragment as the whole message",
    "throw new Error(sanitizeForDisplay(name));",
  ],
  [
    "an escaped fragment in an Error subclass",
    "throw new UsageError(sanitizeForDisplay(name));",
  ],
  [
    "an escaped fragment reached through a namespace",
    "throw new Error(core.sanitizeForDisplay(name));",
  ],
  ["a displayText composition", "throw new Error(displayText`at ${name}`);"],
  [
    "an escaped fragment concatenated into the message",
    'throw new Error("at " + sanitizeForDisplay(name));',
  ],
  [
    "an escaped fragment on a ternary branch",
    "throw new Error(name ? sanitizeForDisplay(name) : name);",
  ],
  [
    "an escaped fragment as the cause",
    "throw new Error(name, { cause: describeDecodeError(err) });",
  ],
  [
    "an escaped detail fragment in a cause chain",
    "chainDetailCauses([sanitizeForDisplay(name)]);",
  ],
  [
    "an escaped fragment in a fitted cause link",
    'fittedCauseLink("at: ", redactAndSanitizeForDisplay(name));',
  ],
  [
    "an escaped party identity interpolated into an Error",
    "throw new Error(`from ${displayPartyIdentity(identity)}`);",
  ],
  [
    "fragments escaped inside the composer's own call",
    "chainDetailCauses(names.map((each) => sanitizeForDisplay(each)));",
  ],
];

const ALLOWED = [
  [
    "the raw decode description the Error route takes",
    "throw new Error(`invalid invitation string: ${rawDecodeErrorDescription(err)}`);",
  ],
  [
    "a raw fragment interpolated into an Error",
    "throw new Error(`at ${name}`);",
  ],
  [
    "a raw fragment in a cause chain",
    "chainDetailCauses([`at: ${name}`], err);",
  ],
  [
    "an escaped fragment at a display sink",
    "console.error(sanitizeForDisplay(name));",
  ],
  [
    "an escaped fragment in a display field",
    "render({ label: sanitizeForDisplay(name) });",
  ],
];

const PREAMBLE = `
declare const err: unknown;
declare const name: string;
declare const names: string[];
declare const identity: unknown;
declare function sanitizeForDisplay(value: string): string;
declare function redactAndSanitizeForDisplay(value: string): string;
declare function describeDecodeError(value: unknown): string;
declare function rawDecodeErrorDescription(value: unknown): string;
declare function displayPartyIdentity(value: unknown): string;
declare function displayText(
  fixedSpans: TemplateStringsArray,
  ...values: unknown[]
): string;
declare function chainDetailCauses(
  details: readonly string[],
  tail?: unknown,
): unknown;
declare function fittedCauseLink(label: string, fragment: string): string;
declare function render(field: { label: string }): void;
declare class UsageError extends Error {}
declare const core: { sanitizeForDisplay(value: string): string };
export function fixture(): void {
`;

function fixture(body) {
  return `${PREAMBLE}  ${body}\n}\n`;
}

describe("the Displayable-as-error-text ban", () => {
  beforeAll(async () => {
    await banHits(CORE_TEST_FILE, fixture("throw new Error(`at ${name}`);"));
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
      expect(await banHits(CORE_TEST_FILE, fixture(body))).not.toHaveLength(0);
    });
  }

  for (const [label, body] of ALLOWED) {
    it(`accepts ${label}`, async () => {
      expect(await banHits(CORE_TEST_FILE, fixture(body))).toHaveLength(0);
    });
  }

  // Every tree the root config governs, src and test alike. The src blocks carry
  // their own no-restricted-syntax options, which flat config replaces rather
  // than merges, so each has to re-carry this ban to hold it.
  for (const [tree, filePath] of [
    ["packages/core/src", CORE_SRC_FILE],
    ["apps/cli/src", CLI_SRC_FILE],
    ["apps/cli/test", CLI_TEST_FILE],
    ["packages/peerjs-broker/src", BROKER_FILE],
  ]) {
    it(`guards ${tree} as well as packages/core/test`, async () => {
      expect(
        await banHits(
          filePath,
          fixture("throw new Error(sanitizeForDisplay(name));"),
        ),
      ).not.toHaveLength(0);
    });
  }
});
