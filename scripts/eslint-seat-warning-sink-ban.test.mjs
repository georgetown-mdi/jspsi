import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// Coverage of the seat warning-sink ban in apps/web/eslint.config.js: a console
// run surface that offers the exchange driver an `onWarning` slot must fold the
// message through `appendSanitizedRunWarning`, the one display boundary the
// surfaces share. The manager's rendezvous preflight composes its warnings RAW on
// the premise that the boundary escapes them exactly once -- so a seat that
// escapes again shows one backslash in a partner filename as four, and a seat
// that escapes not at all puts a partner's ESC, bidi override, or confusable
// straight into the operator's page. A unit test of the boundary cannot see
// either failure: both are a seat routing AROUND it. The ban is one esquery
// selector, and a selector that stops matching fails silently -- it keeps
// reporting zero problems, indistinguishable from clean source -- so these cases
// are what makes its coverage executable.
//
// Each case is linted through the real repo config against a path inside
// apps/web/src, so the scope, the selector, and the rule wiring are exercised as
// CI runs them rather than restated here.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: resolve(repoRoot, "eslint.config.mjs"),
});

/**
 * Messages the seat warning-sink ban reports for `source` linted as `filePath`. A
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
      message.message.startsWith("Fold an onWarning message"),
  );
}

// A real path inside the guarded tree. It has to be one: apps/web's tsconfig uses
// project references, and typescript-eslint refuses to parse a path that TSConfig
// does not include. Only the path is borrowed -- every case below lints the text it
// hands in, which the canary proves.
const SEAT_FILE = resolve(repoRoot, "apps/web/src/bench/runWarnings.ts");

// A real seat that also sits in the rawRows allowlist block, whose separate
// `no-restricted-syntax` options REPLACE (not merge with) the broad src block's.
// Without the ban re-carried there, a quarter of the console's seats would be
// silently uncovered.
const RAW_ROWS_SEAT_FILE = resolve(
  repoRoot,
  "apps/web/src/bench/useInviterExchange.ts",
);

// Loading the flat config and the typescript-eslint parser for the first time is
// the expensive part of a lintText call, independent of which file or how much
// text it is given; under cold process/CPU load that one-time cost alone can
// exceed vitest's 5s test default. A beforeAll absorbs it once, under its own
// explicit budget.
const LINTER_WARM_UP_TIMEOUT_MS = 30_000;

// Reserved for the canary: a guarded path that exists on disk, parses, and is
// linted by nothing else here.
const SEAT_FILE_FIRST_PARSE = resolve(
  repoRoot,
  "apps/web/src/bench/runOutputs.ts",
);

// Every seat the app actually offers the driver, linted as it stands on disk. The
// synthesized cases below say what the selector catches; these say what it costs on
// the real sources, a selector reaching past function literals to bare references
// being the kind that catches a seat it should not. A seat renamed away, or one
// that stops offering the slot, fails here rather than leaving a short list
// reporting zero.
const APP_SEAT_FILES = [
  "apps/web/src/bench/useDirectExchange.ts",
  "apps/web/src/bench/useAcceptorExchange.ts",
  "apps/web/src/bench/useInviterExchange.ts",
  "apps/web/src/bench/RecoveredExchangePanel.tsx",
].map((seat) => resolve(repoRoot, seat));

// Linting those from disk is a second real pass over type-checked sources, so it
// gets its own explicit budget rather than vitest's 5s default.
const SEAT_LINT_TIMEOUT_MS = 30_000;

const BANNED = [
  [
    "a seat that stores the message unescaped",
    "run({ onWarning: (message) => setWarnings((current) => [...current, message]) });",
  ],
  [
    "a seat that escapes at its own altitude instead of the shared boundary",
    "run({ onWarning: (message) => setWarnings((current) => [...current, sanitizeForDisplay(message)]) });",
  ],
  [
    "a seat written as a function expression",
    "run({ onWarning: function (message) { setWarnings((current) => [...current, message]); } });",
  ],
  [
    "a seat that only logs the message",
    "run({ onWarning: (message) => { console.warn(message); } });",
  ],
  [
    "a seat that drops the message entirely",
    "run({ onWarning: () => setWarnings((current) => current) });",
  ],
  [
    "a seat written as an object method",
    "run({ onWarning(message) { setWarnings((current) => [...current, message]); } });",
  ],
  [
    "a seat that hands over a handler defined elsewhere",
    "run({ onWarning: handleWarning });",
  ],
  [
    "a seat that hands over a handler read off another object",
    "run({ onWarning: handlers.onWarning });",
  ],
  [
    "a seat whose key is a string literal",
    'run({ "onWarning": (message) => setWarnings((current) => [...current, message]) });',
  ],
  [
    "a seat whose key is computed from a string literal",
    'run({ ["onWarning"]: handleWarning });',
  ],
];

const ALLOWED = [
  [
    "the shared boundary folded into state",
    "run({ onWarning: (message) => setWarnings((current) => appendSanitizedRunWarning(current, message)) });",
  ],
  [
    "the shared boundary in a block body",
    "run({ onWarning: (message) => { setWarnings((current) => appendSanitizedRunWarning(current, message)); } });",
  ],
  [
    "an onWarning handler forwarded from a prop",
    "run({ onWarning: (message) => onWarning(appendSanitizedRunWarning([], message)[0]) });",
  ],
  [
    "the shared boundary under a string-literal key",
    'run({ "onWarning": (message) => setWarnings((current) => appendSanitizedRunWarning(current, message)) });',
  ],
  [
    "the shared boundary in an object method",
    "run({ onWarning(message) { setWarnings((current) => appendSanitizedRunWarning(current, message)); } });",
  ],
  [
    "a renamed destructure of the slot the driver owns",
    "const { onWarning: slot } = handlers; void slot;",
  ],
];

const PREAMBLE = `
declare function run(handlers: { onWarning?: (message: string) => void }): void;
declare function setWarnings(
  update: (current: Array<string>) => Array<string>,
): void;
declare function appendSanitizedRunWarning(
  current: ReadonlyArray<string>,
  message: string,
): Array<string>;
declare function sanitizeForDisplay(value: string): string;
declare const onWarning: (message: string) => void;
declare const handleWarning: (message: string) => void;
declare const handlers: { onWarning: (message: string) => void };
export function fixture(): void {
`;

function fixture(body) {
  return `${PREAMBLE}  ${body}\n}\n`;
}

describe("the seat warning-sink ban", () => {
  beforeAll(async () => {
    await banHits(SEAT_FILE, fixture("run({});"));
  }, LINTER_WARM_UP_TIMEOUT_MS);

  it("lints the text it is handed, not the file on disk", async () => {
    expect(
      existsSync(SEAT_FILE_FIRST_PARSE),
      `${SEAT_FILE_FIRST_PARSE} no longer exists`,
    ).toBe(true);
    const [result] = await eslint.lintText("this is not typescript !!! (((\n", {
      filePath: SEAT_FILE_FIRST_PARSE,
    });
    expect(
      result.messages.map((message) => message.message).join("; "),
      `${SEAT_FILE_FIRST_PARSE}: the source on disk was linted instead, so a case asserting zero problems proves nothing about the text it handed in`,
    ).toMatch(/Parsing error/);
  });

  for (const [label, body] of BANNED) {
    it(`rejects ${label}`, async () => {
      expect(await banHits(SEAT_FILE, fixture(body))).not.toHaveLength(0);
    });
  }

  for (const [label, body] of ALLOWED) {
    it(`accepts ${label}`, async () => {
      expect(await banHits(SEAT_FILE, fixture(body))).toHaveLength(0);
    });
  }

  it("leaves a shorthand property and a type declaration alone", async () => {
    // The declaration is the driver's own interface. The shorthand is the bypass
    // the ban knowingly leaves open: it is how a seat forwards a slot its caller
    // owns (serverJobExchangeDriver destructures one), and separating that from a
    // locally-defined handler of the same name takes scope a selector has not got.
    // Pinned so the exemption is a decision on the record rather than a gap.
    expect(
      await banHits(
        SEAT_FILE,
        fixture("run({ onWarning });") +
          "export interface Handlers { onWarning?: (message: string) => void }\n",
      ),
    ).toHaveLength(0);
  });

  it("covers a seat inside the rawRows allowlist block", async () => {
    expect(
      await banHits(
        RAW_ROWS_SEAT_FILE,
        fixture(
          "run({ onWarning: (message) => setWarnings((current) => [...current, message]) });",
        ),
      ),
    ).not.toHaveLength(0);
  });

  it(
    "leaves every seat the app offers clean",
    async () => {
      for (const seat of APP_SEAT_FILES) {
        expect(existsSync(seat), `${seat} no longer exists`).toBe(true);
        expect(
          readFileSync(seat, "utf8"),
          `${seat} no longer offers an onWarning slot, so linting it clean says nothing`,
        ).toMatch(/onWarning:/);
      }
      const results = await eslint.lintFiles(APP_SEAT_FILES);
      const reported = results.flatMap((result) =>
        result.messages
          .filter(
            (message) =>
              message.ruleId === "no-restricted-syntax" &&
              message.message.startsWith("Fold an onWarning message"),
          )
          .map((message) => `${result.filePath}:${message.line}`),
      );
      expect(reported).toEqual([]);
    },
    SEAT_LINT_TIMEOUT_MS,
  );
});
