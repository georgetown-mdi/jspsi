import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

import repoConfig from "../eslint.config.mjs";
import {
  STRING_BOUND_CHAIN_REACH,
  noBareStringLengthBound,
} from "../eslint.boundaries.mjs";
import {
  PROJECT_PARSER_OPTIONS,
  typeAwareRuleNames,
  withoutTypeAwareLayer,
} from "./eslint-strip-type-aware-layer.mjs";

// Coverage of the bare-string-bound ban in eslint.boundaries.mjs, which both
// config files apply: a string length bound counts UTF-16 code units, so a
// ceiling is written with `maxCodeUnits` (packages/core/src/utils/maxCodeUnits.ts)
// rather than Zod's own `.max()`, which counts code points and admits a value of
// astral characters the hand-written predicates sharing the ceiling refuse.
//
// The ban is a set of esquery selectors, and a selector that stops matching
// fails silently -- it keeps reporting zero problems, which reads exactly like
// clean source. The cases below are what makes its coverage executable: the
// shapes it refuses, the shapes it must leave alone (a floor of one, an array
// or integer bound), and the shapes it does NOT reach, so its limits are a
// measured property rather than an assumption a reader makes about it.
//
// Each case is linted through the real repo config -- which embeds apps/web's
// blocks scoped under apps/web/ (scopeToDir in eslint.config.mjs), the same
// blocks a real `eslint .` reaches through apps/web/eslint.config.js -- with the
// type-aware layer stripped off, so what this reports rests on the text it hands
// in and no lint here waits on a TypeScript program.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: true,
  baseConfig: withoutTypeAwareLayer(repoConfig),
});

const BAN_MESSAGE_PREFIX = "Count a string length bound in UTF-16 code units";

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

// The schema-bearing trees the ban covers: core's src, the web app's src (its
// job and intent schemas) and the web server entry tree. Beside them, the two
// core chokepoint modules the parse-ban block exempts, which the ban still
// holds, and the two test trees, which are outside it.
const CORE_SRC = resolve(repoRoot, "packages/core/src/banFixture.ts");
const WEB_SRC = resolve(repoRoot, "apps/web/src/banFixture.ts");
const WEB_SERVER = resolve(repoRoot, "apps/web/server/banFixture.ts");
const CORE_CHOKEPOINT = resolve(repoRoot, "packages/core/src/sensitiveFile.ts");
const CORE_TEST = resolve(repoRoot, "packages/core/test/banFixture.ts");
const WEB_TEST = resolve(repoRoot, "apps/web/test/banFixture.ts");

const COVERED_FILES = [CORE_SRC, WEB_SRC, WEB_SERVER, CORE_CHOKEPOINT];

// Loading the typescript-eslint parser for the first time is the expensive part
// of a lintText call, independent of the text it is given; a beforeAll absorbs
// it once under its own budget so no case pays for it inside vitest's default.
const LINTER_WARM_UP_TIMEOUT_MS = 30_000;

/** A chain of `depth` schema-preserving calls between `z.string()` and a bound. */
const intermediates = (depth) => ".trim()".repeat(depth);

const BANNED = [
  ["a bare ceiling", "const name = z.string().max(10);"],
  [
    "a ceiling named by a constant",
    "const name = z.string().max(MAX_NAME_LENGTH);",
  ],
  ["an exact length", "const digest = z.string().length(64);"],
  ["a floor above one", "const name = z.string().min(2);"],
  [
    "a floor named by a constant",
    "const name = z.string().min(MIN_NAME_LENGTH);",
  ],
  ["a ceiling after a trim", "const name = z.string().trim().max(10);"],
  [
    "a ceiling appended to a code-unit bound",
    "const name = z.string().min(1).check(maxCodeUnits(MAX_NAME_LENGTH)).regex(NAME_PATTERN).max(10);",
  ],
  [
    "a chain spelled over several lines",
    "const name = z\n    .string()\n    .max(10);",
  ],
  [
    "a ceiling at the end of the reach",
    `const name = z.string()${intermediates(STRING_BOUND_CHAIN_REACH)}.max(10);`,
  ],
];

const ALLOWED = [
  [
    "the code-unit ceiling",
    "const name = z.string().check(maxCodeUnits(MAX_NAME_LENGTH));",
  ],
  ["a floor of one", "const name = z.string().min(1);"],
  ["a floor of zero", "const name = z.string().min(0);"],
  ["a non-empty floor", "const name = z.string().nonempty();"],
  ["an array length bound", "const names = z.array(z.string()).max(3);"],
  ["an array exact length", "const pair = z.array(z.string()).length(2);"],
  ["an integer range", "const port = z.int().min(0).max(65535);"],
  ["a number range", "const count = z.number().int().min(1).max(99);"],
  ["a numeric maximum", "const remaining = Math.max(0, budget);"],
  ["a length read", "const width = value.length;"],
];

// The shapes the selectors do not reach. Each needs the value-flow analysis no
// esquery selector runs, and each is pinned so a widening reports here rather
// than in a surprise.
const NOT_REACHED = [
  [
    "a chain one call past the reach",
    `const name = z.string()${intermediates(STRING_BOUND_CHAIN_REACH + 1)}.max(10);`,
  ],
  ["a bound on a schema held in a variable", "const bounded = name.max(10);"],
  ["a bound reached through a computed member", 'z.string()["max"](10);'],
];

describe("the bare-string-bound ban", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await banHits(CORE_SRC, "const name = z.string().min(1);\n");
  }, LINTER_WARM_UP_TIMEOUT_MS);

  it("lints paths whose trees exist", () => {
    for (const path of [
      ...COVERED_FILES,
      CORE_TEST,
      WEB_TEST,
      resolve(repoRoot, "apps/web/server"),
    ]) {
      expect(
        existsSync(dirname(path)),
        `${dirname(path)} no longer exists`,
      ).toBe(true);
    }
    expect(existsSync(CORE_CHOKEPOINT), `${CORE_CHOKEPOINT} moved`).toBe(true);
  });

  it("lints the text it is handed, not the file on disk", async () => {
    for (const filePath of [...COVERED_FILES, CORE_TEST, WEB_TEST]) {
      const [result] = await eslint.lintText(
        "this is not typescript !!! (((\n",
        {
          filePath,
        },
      );
      expect(
        result.messages.map((message) => message.message).join("; "),
        `${filePath}: the source on disk was linted instead, so every case at this path is vacuous`,
      ).toMatch(/Parsing error/);
    }
  });

  it("resolves the ban for the schema trees and not the test trees", async () => {
    const selectors = new Set(
      noBareStringLengthBound.map((entry) => entry.selector),
    );
    for (const [filePath, expected] of [
      [CORE_SRC, true],
      [WEB_SRC, true],
      [WEB_SERVER, true],
      [CORE_CHOKEPOINT, true],
      [CORE_TEST, false],
      [WEB_TEST, false],
    ]) {
      const config = await eslint.calculateConfigForFile(filePath);
      const parserOptions = config.languageOptions?.parserOptions ?? {};
      expect(
        Object.keys(parserOptions).filter((option) =>
          PROJECT_PARSER_OPTIONS.includes(option),
        ),
        `${filePath}: a TypeScript program is configured, so a type-aware rule can run -- and crash -- on ground this file does not test`,
      ).toEqual([]);
      expect(
        typeAwareRuleNames(config.rules, (prefix) => config.plugins?.[prefix]),
        `${filePath}: a type-aware rule survived the strip`,
      ).toEqual([]);
      const [, ...entries] = config.rules["no-restricted-syntax"] ?? [];
      expect(
        entries.some((entry) => selectors.has(entry.selector)),
        `${filePath}: the resolved no-restricted-syntax options do not carry the string-bound ban, so linting it reports zero however the bound is written`,
      ).toBe(expected);
    }
  });

  for (const [label, source] of BANNED) {
    it(`refuses ${label}`, async () => {
      for (const filePath of COVERED_FILES) {
        expect(
          await banHits(filePath, `${source}\n`),
          `${filePath}: ${label}`,
        ).not.toHaveLength(0);
      }
    });

    it(`leaves ${label} in the test trees alone`, async () => {
      for (const filePath of [CORE_TEST, WEB_TEST]) {
        expect(
          await banHits(filePath, `${source}\n`),
          `${filePath}: ${label}`,
        ).toHaveLength(0);
      }
    });
  }

  for (const [label, source] of ALLOWED) {
    it(`accepts ${label}`, async () => {
      for (const filePath of COVERED_FILES) {
        expect(
          await banHits(filePath, `${source}\n`),
          `${filePath}: ${label}`,
        ).toHaveLength(0);
      }
    });
  }

  for (const [label, source] of NOT_REACHED) {
    it(`does not reach ${label}`, async () => {
      expect(await banHits(CORE_SRC, `${source}\n`)).toHaveLength(0);
    });
  }

  // A disable directive that no longer silences anything is an error rather than
  // a warning in these blocks, so an exemption left behind on a bound that
  // stopped needing one fails CI instead of sitting unread.
  it("takes a disable directive with a one-line why", async () => {
    for (const filePath of COVERED_FILES) {
      const [result] = await eslint.lintText(
        "// eslint-disable-next-line no-restricted-syntax -- a bound no hand-written predicate shares\nexport const name = z.string().max(10);\n",
        { filePath },
      );
      expect(banMessages(result.messages), filePath).toHaveLength(0);
      expect(result.errorCount, filePath).toBe(0);
    }
  });

  it("reports a stray disable directive as an error", async () => {
    for (const filePath of COVERED_FILES) {
      const [result] = await eslint.lintText(
        "// eslint-disable-next-line no-restricted-syntax -- nothing to silence\nexport const name = z.string().min(1);\n",
        { filePath },
      );
      expect(
        result.messages.filter(
          (message) => message.ruleId === null && message.severity === 2,
        ),
        `${filePath}: an unused disable directive is not an error here`,
      ).not.toHaveLength(0);
    }
  });
});
