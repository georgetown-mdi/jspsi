import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import repoConfig from "../eslint.config.mjs";
import {
  PROJECT_PARSER_OPTIONS,
  typeAwareRuleNames,
  withoutTypeAwareLayer,
} from "./eslint-strip-type-aware-layer.mjs";

// Coverage of the linkage-compare chokepoint ban in apps/web/eslint.config.js:
// the draft-side rule-set membership questions are asked through
// apps/web/src/psi/linkageComparison.ts, which prunes explicitly-`undefined`
// optional properties before handing the value to core's strict canonical
// compare, and nowhere else under apps/web/src. A direct import of core's
// predicate skips the prune, and skips it silently -- the compare answers
// `false` for a draft key that says exactly what the offer says, dropping the
// key's opt-in badge and the terms' rule-set citation rather than failing.
//
// The ban itself fails silently in the other direction: an import specifier or
// import-name that stops matching keeps reporting zero problems, which displays the
// same as clean source. It is also held by two config objects that flat
// config replaces rather than merges -- the src block, and the block below it
// that repeats the src block's groups alongside this ban and exempts the
// chokepoint -- so a third block growing its own no-restricted-imports options
// would drop it with no other tell.
//
// Each case is linted through the repo-root config, which embeds apps/web's
// blocks scoped under apps/web/ (scopeToDir in eslint.config.mjs); a real
// `eslint .` reaches those same blocks through apps/web/eslint.config.js, the
// nearest config file for that subtree. One transform is applied: the type-aware
// layer is stripped off (withoutTypeAwareLayer), so what this file reports rests
// on the text it hands in and nothing else. The blocks holding the ban are
// transformed by nothing, so the import names, the `files` scoping, and the
// chokepoint's `ignores` exemption are the real ones.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: true,
  baseConfig: withoutTypeAwareLayer(repoConfig),
});

/** no-restricted-imports messages reported for `source` linted as `filePath`. */
async function importHits(filePath, source) {
  const [result] = await eslint.lintText(source, { filePath });
  const fatal = result.messages.filter((message) => message.fatal);
  if (fatal.length > 0) {
    throw new Error(`${filePath}: ${fatal.map((m) => m.message).join("; ")}`);
  }
  return result.messages.filter(
    (message) => message.ruleId === "no-restricted-imports",
  );
}

// The chokepoint, one of its src-side callers, and a test file. The test tree is
// outside the ban by design: the suites that pin the prune's effect ask core's
// strict predicate and the wrapper about the same key and compare the answers.
const CHOKEPOINT = resolve(repoRoot, "apps/web/src/psi/linkageComparison.ts");
const WEB_SRC = resolve(repoRoot, "apps/web/src/psi/advancedInviteTerms.ts");
const WEB_TEST = resolve(
  repoRoot,
  "apps/web/test/unit/guidedOptInKeys.test.ts",
);

/** The core predicates the wrappers in linkageComparison.ts stand in front of. */
const BANNED_NAMES = [
  "encodeForComparison",
  "isDrawnFromLinkageRuleSet",
  "isOptInLinkageKey",
  "linkageRuleSetReferenceFor",
];

// Loading the flat config and the typescript-eslint parser for the first time is
// the expensive part of a lintText call, independent of which file or how much
// text it is given; under cold process/CPU load that one-time cost alone can
// outrun the default per-test timeout on a CI runner.
describe("the linkage-compare chokepoint ban", { timeout: 60_000 }, () => {
  it("lints paths that exist", () => {
    for (const path of [CHOKEPOINT, WEB_SRC, WEB_TEST]) {
      expect(existsSync(path), `${path} no longer exists`).toBe(true);
    }
  });

  it("lints the text it is handed, not the file on disk", async () => {
    for (const filePath of [CHOKEPOINT, WEB_SRC, WEB_TEST]) {
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

  it("extends the ban to the src caller and spares the chokepoint", async () => {
    for (const [filePath, expected] of [
      [WEB_SRC, BANNED_NAMES],
      [CHOKEPOINT, undefined],
      [WEB_TEST, undefined],
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
      const [, options] = config.rules["no-restricted-imports"] ?? [];
      const core = options?.paths?.find(
        (path) => path.name === "@psilink/core",
      );
      expect(
        core?.importNames,
        `${filePath}: the resolved no-restricted-imports options do not match the expected ban, so linting it reports zero however the import is written`,
      ).toEqual(expected);
    }
  });

  for (const name of BANNED_NAMES) {
    it(`refuses '${name}' imported from core in apps/web/src`, async () => {
      expect(
        await importHits(WEB_SRC, `import { ${name} } from "@psilink/core";\n`),
      ).not.toHaveLength(0);
    });

    it(`accepts '${name}' in the chokepoint itself`, async () => {
      expect(
        await importHits(
          CHOKEPOINT,
          `import { ${name} } from "@psilink/core";\n`,
        ),
      ).toHaveLength(0);
    });

    it(`accepts '${name}' in a test file`, async () => {
      expect(
        await importHits(
          WEB_TEST,
          `import { ${name} } from "@psilink/core";\n`,
        ),
      ).toHaveLength(0);
    });
  }

  // The routes around a plain named import that the rule does close. A namespace
  // import is refused outright, since the rule cannot see which member a
  // namespace binding is read for.
  for (const [shape, source] of [
    [
      "a renamed import",
      'import { isOptInLinkageKey as p } from "@psilink/core";',
    ],
    ["a re-export", 'export { isOptInLinkageKey } from "@psilink/core";'],
    ["a namespace import", 'import * as core from "@psilink/core";'],
    ["a blanket re-export", 'export * from "@psilink/core";'],
  ]) {
    it(`refuses ${shape} in apps/web/src`, async () => {
      expect(await importHits(WEB_SRC, `${source}\n`)).not.toHaveLength(0);
    });
  }

  it("leaves the rest of core's surface alone", async () => {
    expect(
      await importHits(
        WEB_SRC,
        'import { canonicalString } from "@psilink/core";\n',
      ),
    ).toHaveLength(0);
  });

  it("accepts the wrappers through the advancedInvite barrel", async () => {
    expect(
      await importHits(
        WEB_SRC,
        'import { isOptInDraftKey } from "@psi/advancedInvite";\n',
      ),
    ).toHaveLength(0);
  });
});
