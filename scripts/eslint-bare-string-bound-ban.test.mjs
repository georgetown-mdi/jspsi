import { existsSync, globSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
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
import { readSource } from "./lib/typeScriptSources.mjs";

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
//
// Beside the cases, a scan of the guarded sources themselves: the reach is a
// finite set of selector depths, so it covers a real bound only while the chains
// those sources write stay inside it. The scan takes the files it reads from the
// config blocks that carry the ban, and parses each through the parser ESLint
// resolves for it, so what it counts is the chain the selectors see.

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

const BAN_SELECTORS = new Set(
  noBareStringLengthBound.map((entry) => entry.selector),
);

/** Whether a config block's `no-restricted-syntax` options carry the ban. */
function carriesBan(block) {
  const [, ...entries] = block.rules?.["no-restricted-syntax"] ?? [];
  return entries.some((entry) => BAN_SELECTORS.has(entry?.selector));
}

const BAN_BLOCKS = repoConfig.filter(carriesBan);

/** The repository-relative files a block's `files` or `ignores` list names. */
function filesMatching(patterns) {
  return (patterns ?? []).flatMap((pattern) => {
    if (typeof pattern !== "string")
      throw new Error(
        `a block carrying the ban names its files as ${JSON.stringify(pattern)}, which this does not expand`,
      );
    return globSync(pattern, { cwd: repoRoot }).map((file) =>
      file.split(sep).join("/"),
    );
  });
}

/**
 * Every file the ban covers, read out of the blocks that carry it: a tree added
 * to the ban is scanned with no edit here. Each block's `ignores` are applied to
 * its own `files`, so a module one block exempts and another re-carries stays in.
 */
function guardedFiles() {
  const covered = new Set();
  for (const block of BAN_BLOCKS) {
    const exempted = new Set(filesMatching(block.ignores));
    for (const file of filesMatching(block.files))
      if (!exempted.has(file)) covered.add(file);
  }
  return [...covered].sort();
}

const GUARDED_FILES = guardedFiles();

// The schema-bearing trees the ban covers: core's src, the web app's src (its
// job and intent schemas) and the web server entry tree. Beside them, the core
// chokepoint modules the parse-ban block exempts, which the ban still holds, and
// the two test trees, which are outside it.
const CORE_SRC = resolve(repoRoot, "packages/core/src/banFixture.ts");
const WEB_SRC = resolve(repoRoot, "apps/web/src/banFixture.ts");
const WEB_SERVER = resolve(repoRoot, "apps/web/server/banFixture.ts");
const CORE_TEST = resolve(repoRoot, "packages/core/test/banFixture.ts");
const WEB_TEST = resolve(repoRoot, "apps/web/test/banFixture.ts");

// The chokepoint modules come from the config block that names them rather than
// a list here, so one dropped from it fails the exemption test below instead of
// quietly leaving these cases.
const CORE_CHOKEPOINT_FILES = BAN_BLOCKS.flatMap((block) => block.files ?? [])
  .filter(
    (file) => file.startsWith("packages/core/src/") && !file.includes("*"),
  )
  .sort();
const CORE_CHOKEPOINTS = CORE_CHOKEPOINT_FILES.map((file) =>
  resolve(repoRoot, file),
);

const COVERED_FILES = [CORE_SRC, WEB_SRC, WEB_SERVER, ...CORE_CHOKEPOINTS];

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
    for (const chokepoint of CORE_CHOKEPOINTS)
      expect(existsSync(chokepoint), `${chokepoint} moved`).toBe(true);
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
    for (const [filePath, expected] of [
      [CORE_SRC, true],
      [WEB_SRC, true],
      [WEB_SERVER, true],
      ...CORE_CHOKEPOINTS.map((chokepoint) => [chokepoint, true]),
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
        entries.some((entry) => BAN_SELECTORS.has(entry.selector)),
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

/**
 * Every node of an ESTree tree. A `parent` link walks back up the tree and
 * `loc`/`range` hold no node, so neither key is descended into.
 */
function* nodes(value) {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) yield* nodes(item);
    return;
  }
  if (typeof value.type === "string") yield value;
  for (const [key, child] of Object.entries(value)) {
    if (key === "parent" || key === "loc" || key === "range") continue;
    yield* nodes(child);
  }
}

/** Whether a call is `z.string()`, keyed as the ban keys its chain root. */
const isStringRoot = (call) =>
  call.callee.object?.name === "z" && call.callee.property?.name === "string";

/**
 * How many calls `node` appends to a `z.string()` receiver, or undefined if its
 * chain roots elsewhere. A bound written after n calls is what the ban's
 * depth-n selector matches, so this counts what the reach bounds.
 */
function callsOnStringChain(node) {
  let calls = 0;
  let current = node;
  while (
    current.type === "CallExpression" &&
    current.callee.type === "MemberExpression"
  ) {
    if (isStringRoot(current)) return calls;
    calls += 1;
    current = current.callee.object;
  }
  return undefined;
}

/** The longest `z.string()` chain in `source`, parsed as ESLint parses it. */
async function longestStringChain(filePath, source) {
  const { parser, parserOptions } = (
    await eslint.calculateConfigForFile(filePath)
  ).languageOptions;
  let parsed;
  try {
    parsed = parser.parseForESLint(source, { ...parserOptions, filePath });
  } catch (error) {
    throw new Error(`${filePath}: ${error.message}`);
  }
  let longest = 0;
  for (const node of nodes(parsed.ast)) {
    if (
      node.type !== "CallExpression" ||
      node.callee?.type !== "MemberExpression"
    )
      continue;
    const calls = callsOnStringChain(node);
    if (calls !== undefined && calls > longest) longest = calls;
  }
  return longest;
}

// Parsing every guarded source costs about four seconds on an idle machine. The
// budget is several times that for a loaded container, as the sibling scan's is
// (scripts/eslint-displayable-error-argument-ban.test.mjs).
const CHAIN_SCAN_TIMEOUT_MS = 60_000;

describe(
  "the reach over the guarded sources",
  { timeout: CHAIN_SCAN_TIMEOUT_MS },
  () => {
    /** Each guarded source holding a `z.string()` chain, to that chain's length. */
    const chains = new Map();

    beforeAll(async () => {
      for (const file of GUARDED_FILES) {
        const calls = await longestStringChain(
          resolve(repoRoot, file),
          readSource(file),
        );
        if (calls > 0) chains.set(file, calls);
      }
    }, CHAIN_SCAN_TIMEOUT_MS);

    it("reads every tree the fixture cases stand for", () => {
      for (const tree of [
        "packages/core/src/",
        "apps/web/src/",
        "apps/web/server/",
      ])
        expect(
          GUARDED_FILES.filter((file) => file.startsWith(tree)),
          `${tree}: no file of this tree is in a config block carrying the ban, so the scan reads none of it`,
        ).not.toHaveLength(0);
      expect(
        CORE_CHOKEPOINT_FILES,
        "the config names no core chokepoint module, so the cases above lint none",
      ).not.toHaveLength(0);
    });

    it("re-carries the ban on every file one of its blocks exempts", () => {
      for (const block of BAN_BLOCKS)
        for (const exempted of filesMatching(block.ignores))
          expect(
            GUARDED_FILES,
            `${exempted}: a block carrying the ban exempts it and no other block carries the ban for it`,
          ).toContain(exempted);
    });

    it("counts a chain as the ban's depths reach it", async () => {
      for (let depth = 0; depth <= STRING_BOUND_CHAIN_REACH; depth += 1) {
        const source = `const name = z.string()${intermediates(depth)}.max(10);\n`;
        expect(
          await longestStringChain(CORE_SRC, source),
          `a bound after ${depth} calls`,
        ).toBe(depth + 1);
        expect(
          await banHits(CORE_SRC, source),
          `a bound after ${depth} calls`,
        ).not.toHaveLength(0);
      }
    });

    it("holds every chain the guarded sources write inside the reach", () => {
      expect(
        chains.size,
        "the scan read no z.string() chain at all, so it holds nothing",
      ).toBeGreaterThan(0);
      const [file, calls] = [...chains].reduce((longest, chain) =>
        chain[1] > longest[1] ? chain : longest,
      );
      expect(
        calls,
        `${file}: ${calls} calls after z.string() against a reach of ${STRING_BOUND_CHAIN_REACH} depths -- one more call and a bound written at the end of this chain goes unreported. Raise STRING_BOUND_CHAIN_REACH in eslint.boundaries.mjs.`,
      ).toBeLessThan(STRING_BOUND_CHAIN_REACH);
    });
  },
);
