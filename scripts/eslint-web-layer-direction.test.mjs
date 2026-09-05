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

// Coverage of the web app's layer-direction ban (productDirectoryBans in
// apps/web/eslint.config.js): src/psi and src/components sit below the three
// product directories and may not import from them. A specifier pattern that
// stops matching fails silently -- it keeps reporting zero problems, which is
// indistinguishable from clean source -- and the ban is folded into two eslint
// blocks that also re-carry the cross-workspace groups and the two path bans,
// because flat config replaces rather than merges a rule's options: a block that
// grows its own no-restricted-imports options can drop the direction groups with
// no other tell.
//
// Each case is linted through the real repo config, which embeds apps/web's
// blocks scoped under apps/web/, with one transform: the type-aware layer is
// stripped off before it is used. The blocks that carry the ban are transformed
// by nothing, so the groups, the per-directory `files` scoping, and flat config's
// replace semantics across the blocks are the real ones.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: true,
  baseConfig: withoutTypeAwareLayer(repoConfig),
});

/** no-restricted-imports messages reported for `source` linted as `filePath`. */
async function directionHits(filePath, source) {
  const [result] = await eslint.lintText(source, { filePath });
  const fatal = result.messages.filter((message) => message.fatal);
  if (fatal.length > 0) {
    throw new Error(`${filePath}: ${fatal.map((m) => m.message).join("; ")}`);
  }
  return result.messages.filter(
    (message) => message.ruleId === "no-restricted-imports",
  );
}

// The two directories below the products, plus the chokepoint module that takes
// the ban from a block of its own (it is spared the ban on calling core's
// comparison predicates, so it cannot share the block that carries that one).
const PSI = resolve(repoRoot, "apps/web/src/psi/exchangeLifecycle.ts");
const COMPONENTS = resolve(repoRoot, "apps/web/src/components/ColumnName.tsx");
const CHOKEPOINT = resolve(repoRoot, "apps/web/src/psi/linkageComparison.ts");

// A product file, to pin that the ban is scoped BELOW the products rather than
// applied to the whole app: a screen importing a sibling product is the
// cross-product reuse the split makes visible, not a violation.
const PRODUCT = resolve(repoRoot, "apps/web/src/exchange/Lobby.tsx");

// Reserved for the first-parse check, linted by nothing else here.
const PSI_FIRST_PARSE = resolve(repoRoot, "apps/web/src/psi/peerIdLabel.ts");

const BELOW = [
  ["src/psi", PSI],
  ["src/components", COMPONENTS],
  ["src/psi (the chokepoint)", CHOKEPOINT],
];

// Both spellings a file below the products could reach one by: the alias every
// import in the app uses, and the relative climb the alias stands in for.
const REFUSED_SPECIFIERS = [
  "@console/mountListing",
  "@exchange/Lobby",
  "@recurring/SavedExchanges",
  "../console/mountListing",
  "../exchange/Lobby",
  "../recurring/SavedExchanges",
];

// What the layers below must keep accepting: each other, the shared helpers, and
// core itself.
const ACCEPTED = [
  ["src/psi", PSI, "@psilink/core"],
  ["src/psi", PSI, "@utils/clientConfig"],
  ["src/psi", PSI, "@components/ColumnName"],
  ["src/psi", PSI, "./runOutputs"],
  ["src/components", COMPONENTS, "@psi/advancedInvite"],
  ["src/exchange", PRODUCT, "@console/mountListing"],
  ["src/exchange", PRODUCT, "@recurring/SavedExchanges"],
];

// Loading the flat config and the typescript-eslint parser for the first time is
// the expensive part of a lintText call, independent of which file or how much
// text it is given; under cold process/CPU load that one-time cost alone can
// outrun the default per-test timeout on a CI runner.
describe("the web app's layer-direction ban", { timeout: 60_000 }, () => {
  it("lints cases against files that exist", () => {
    for (const path of [
      PSI,
      COMPONENTS,
      CHOKEPOINT,
      PRODUCT,
      PSI_FIRST_PARSE,
    ]) {
      expect(existsSync(path), `${path} no longer exists`).toBe(true);
    }
  });

  it("carries the ban to every path below the products, with no type-aware rule", async () => {
    for (const [layer, filePath] of [
      ...BELOW,
      ["first parse", PSI_FIRST_PARSE],
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
      const groups = (options?.patterns ?? []).flatMap(
        (pattern) => pattern.group ?? [],
      );
      expect(
        groups,
        `${layer}: the direction groups are not among the no-restricted-imports options at ${filePath}, so linting it reports zero however the specifier is written`,
      ).toEqual(
        expect.arrayContaining([
          "@console/*",
          "@exchange/*",
          "@recurring/*",
          "../console/*",
          "../exchange/*",
          "../recurring/*",
        ]),
      );
    }
  });

  it("lints the text it is handed, not the file on disk", async () => {
    const [result] = await eslint.lintText("this is not typescript !!! (((\n", {
      filePath: PSI_FIRST_PARSE,
    });
    expect(
      result.messages.map((message) => message.message).join("; "),
      `${PSI_FIRST_PARSE}: the source on disk was linted instead, so every case landing on a first parse is vacuous`,
    ).toMatch(/Parsing error/);
  });

  for (const [layer, filePath] of BELOW) {
    for (const specifier of REFUSED_SPECIFIERS) {
      it(`refuses '${specifier}' from ${layer}`, async () => {
        expect(
          await directionHits(filePath, `import "${specifier}";\n`),
        ).not.toHaveLength(0);
      });

      it(`refuses a type-only '${specifier}' from ${layer}`, async () => {
        expect(
          await directionHits(
            filePath,
            `import type { A } from "${specifier}";\n`,
          ),
        ).not.toHaveLength(0);
      });

      it(`refuses a re-export of '${specifier}' from ${layer}`, async () => {
        expect(
          await directionHits(filePath, `export { a } from "${specifier}";\n`),
        ).not.toHaveLength(0);
      });
    }
  }

  for (const [layer, filePath, specifier] of ACCEPTED) {
    it(`accepts '${specifier}' from ${layer}`, async () => {
      expect(
        await directionHits(filePath, `import "${specifier}";\n`),
      ).toHaveLength(0);
    });
  }
});
