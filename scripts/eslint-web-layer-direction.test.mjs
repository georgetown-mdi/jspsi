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

// Coverage of the web app's layer-direction ban (productDirectorySpecifierBan and
// productDirectoryBans in apps/web/eslint.config.js): src/psi and src/components
// sit below the three product directories and may not import from them. A
// specifier pattern that stops matching fails silently -- it keeps reporting zero
// problems, which is indistinguishable from clean source -- and the ban is folded
// into eslint blocks that also re-carry the cross-workspace groups and the two
// path bans, because flat config replaces rather than merges a rule's options: a
// block that grows its own options can drop the direction groups or the direction
// selector with no other tell.
//
// The reach has more spellings than an import in the app is written with, so most
// cases here are spellings nothing writes: the tsconfig `@*` catch-all
// (`@/exchange/Lobby`), a climb with a "./" step in it, and the climb that goes
// past src/ and back down. Each names a real module in a real vite build.
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

// The ban is two rules: one no-restricted-syntax selector over every import and
// export form, and the coarser no-restricted-imports groups beside it. A case is
// refused when either reports.
/** Direction-ban messages reported for `source` linted as `filePath`. */
async function directionHits(filePath, source) {
  const [result] = await eslint.lintText(source, { filePath });
  const fatal = result.messages.filter((message) => message.fatal);
  if (fatal.length > 0) {
    throw new Error(`${filePath}: ${fatal.map((m) => m.message).join("; ")}`);
  }
  return result.messages.filter(
    (message) =>
      message.ruleId === "no-restricted-imports" ||
      message.ruleId === "no-restricted-syntax",
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
const PSI_FIRST_PARSE = resolve(
  repoRoot,
  "apps/web/src/psi/transport/peerLogging.ts",
);

// A file one directory deeper than PSI: src/psi has its own subdirectories
// (transport/, workers/, jobClient/, managed/, authoring/), and a climb from one
// of those needs an extra ".." to reach a product directory.
const PSI_NESTED = resolve(
  repoRoot,
  "apps/web/src/psi/transport/boundedReassembly.ts",
);

// The two modules the app already loads with a dynamic import, linted with the
// specifier each one really writes: the arm of the ban that reads an
// ImportExpression has to leave them alone.
const RUNNER = resolve(
  repoRoot,
  "apps/web/src/components/ScheduledExchangeRunner.tsx",
);
const CSV_PARSE_CONTROLLER = resolve(
  repoRoot,
  "apps/web/src/psi/workers/csvParseController.ts",
);

const BELOW = [
  ["src/psi", PSI],
  ["src/components", COMPONENTS],
  ["src/psi (the chokepoint)", CHOKEPOINT],
];

// Both spellings a file below the products could reach one by: the alias every
// import in the app uses, and the relative climb the alias stands in for.
const ALIAS_SPECIFIERS = [
  "@console/mountListing",
  "@exchange/Lobby",
  "@recurring/SavedExchanges",
];

const CLIMB_SPECIFIERS = [
  "../console/mountListing",
  "../exchange/Lobby",
  "../recurring/SavedExchanges",
];

// The tsconfig `@*` -> `./src/*` catch-all spells every alias a second way, and a
// real vite build resolves it: `@/exchange/Lobby` names the module
// `@exchange/Lobby` names. Nothing in the app writes an import this way, which is
// exactly why a ban stated over the `@exchange` spelling alone stays green while
// the reach is open.
const CATCH_ALL_ALIAS_SPECIFIERS = [
  "@/console/mountListing",
  "@/exchange/Lobby",
  "@/recurring/SavedExchanges",
];

// A climb with a "./" step in it, which leaves no ".." immediately before the
// product directory and no "src/" segment to match instead. Written from a file
// one level below src/.
const STEPPED_CLIMB_SPECIFIERS = [
  ".././console/mountListing",
  ".././exchange/Lobby",
  ".././recurring/SavedExchanges",
  "./../console/mountListing",
  "./../exchange/Lobby",
  "./../recurring/SavedExchanges",
];

const REFUSED_SPECIFIERS = [
  ...ALIAS_SPECIFIERS,
  ...CATCH_ALL_ALIAS_SPECIFIERS,
  ...CLIMB_SPECIFIERS,
  ...STEPPED_CLIMB_SPECIFIERS,
];

// The same relative climb, one directory deeper, as written from a nested src/psi
// subdirectory.
const NESTED_REFUSED_SPECIFIERS = [
  "../../console/mountListing",
  "../../exchange/Lobby",
  "../../recurring/SavedExchanges",
];

// The stepped climb from one directory deeper.
const NESTED_STEPPED_CLIMB_SPECIFIERS = [
  "../.././console/mountListing",
  "../.././exchange/Lobby",
  "../.././recurring/SavedExchanges",
  "./../../console/mountListing",
  "./../../exchange/Lobby",
  "./../../recurring/SavedExchanges",
];

// Every spelling a nested src/psi file could reach a product with, alias
// spellings included: the alias does not change with depth.
const NESTED_ALL_REFUSED_SPECIFIERS = [
  ...ALIAS_SPECIFIERS,
  ...CATCH_ALL_ALIAS_SPECIFIERS,
  ...NESTED_REFUSED_SPECIFIERS,
  ...NESTED_STEPPED_CLIMB_SPECIFIERS,
];

// A third spelling of the same reach: climbing PAST src/ and back down through
// it, which puts no ".." immediately before the product directory. It is refused
// only while the src-rooted groups are in the ban.
const PAST_SRC_SPECIFIERS = [
  "../../src/console/mountListing",
  "../../src/exchange/Lobby",
  "../../src/recurring/SavedExchanges",
];

const NESTED_PAST_SRC_SPECIFIERS = [
  "../../../src/console/mountListing",
  "../../../src/exchange/Lobby",
  "../../../src/recurring/SavedExchanges",
];

// What the layers below must keep accepting: each other, the shared helpers, and
// core itself.
const ACCEPTED = [
  ["src/psi", PSI, "@psilink/core"],
  ["src/psi", PSI, "@utils/clientConfig"],
  ["src/psi", PSI, "@components/ColumnName"],
  ["src/psi", PSI, "./runOutputs"],
  ["src/components", COMPONENTS, "@psi/authoring/advancedInvite"],
  ["src/exchange", PRODUCT, "@console/mountListing"],
  ["src/exchange", PRODUCT, "@recurring/SavedExchanges"],
  // Specifiers whose segment merely BEGINS with a product directory's name: what
  // a pattern reaching one character past the segment boundary would refuse.
  ["src/psi", PSI, "@components/exchangeRecord"],
  ["src/psi", PSI, "../utils/consoleLogger"],
  ["src/components", COMPONENTS, "../psi/exchangeState"],
  ["src/components", COMPONENTS, "@psi/managed/managedScheduleRuntime"],
  // The two dynamic imports the app ships, each from its own file.
  ["a shipped lazy load", RUNNER, "@psi/managed/managedScheduleRuntime"],
  ["a shipped lazy load", CSV_PARSE_CONTROLLER, "./csvParseWorkerClient"],
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
      PSI_NESTED,
      RUNNER,
      CSV_PARSE_CONTROLLER,
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
          "@/console",
          "@/console/*",
          "@/exchange",
          "@/exchange/*",
          "@/recurring",
          "@/recurring/*",
          "**/../console",
          "**/../console/**",
          "**/../exchange",
          "**/../exchange/**",
          "**/../recurring",
          "**/../recurring/**",
          "**/src/console",
          "**/src/console/**",
          "**/src/exchange",
          "**/src/exchange/**",
          "**/src/recurring",
          "**/src/recurring/**",
        ]),
      );
      const [, ...syntax] = config.rules["no-restricted-syntax"] ?? [];
      expect(
        syntax
          .map((option) => option.selector)
          .filter((selector) => /console\|exchange\|recurring/.test(selector)),
        `${layer}: the direction selector is not among the no-restricted-syntax options at ${filePath}, and it is the half that reads every import form`,
      ).toHaveLength(1);
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

  // A pattern scoped to one ".." catches the climb from src/psi's own files but
  // not from a nested subdirectory one level further down; each case here plants
  // the deeper climb to pin that the pattern covers it too.
  for (const specifier of NESTED_ALL_REFUSED_SPECIFIERS) {
    it(`refuses '${specifier}' from a nested src/psi subdirectory`, async () => {
      expect(
        await directionHits(PSI_NESTED, `import "${specifier}";\n`),
      ).not.toHaveLength(0);
    });
  }

  for (const [layer, filePath] of BELOW) {
    for (const specifier of PAST_SRC_SPECIFIERS) {
      it(`refuses the climb past src to '${specifier}' from ${layer}`, async () => {
        expect(
          await directionHits(filePath, `import "${specifier}";\n`),
        ).not.toHaveLength(0);
      });
    }
  }

  for (const specifier of NESTED_PAST_SRC_SPECIFIERS) {
    it(`refuses the climb past src to '${specifier}' from a nested src/psi subdirectory`, async () => {
      expect(
        await directionHits(PSI_NESTED, `import "${specifier}";\n`),
      ).not.toHaveLength(0);
    });
  }

  // A dynamic import reaches the same modules and no import declaration reports
  // it, so every spelling is planted again in that form -- including from a
  // nested src/psi subdirectory, where the app already loads a module this way.
  for (const [layer, filePath] of BELOW) {
    for (const specifier of [...REFUSED_SPECIFIERS, ...PAST_SRC_SPECIFIERS]) {
      it(`refuses a dynamic import of '${specifier}' from ${layer}`, async () => {
        expect(
          await directionHits(
            filePath,
            `export const load = () => import("${specifier}");\n`,
          ),
        ).not.toHaveLength(0);
      });
    }
  }

  for (const specifier of [
    ...NESTED_ALL_REFUSED_SPECIFIERS,
    ...NESTED_PAST_SRC_SPECIFIERS,
  ]) {
    it(`refuses a dynamic import of '${specifier}' from a nested src/psi subdirectory`, async () => {
      expect(
        await directionHits(
          PSI_NESTED,
          `export const load = () => import("${specifier}");\n`,
        ),
      ).not.toHaveLength(0);
    });
  }

  for (const [layer, filePath, specifier] of ACCEPTED) {
    it(`accepts '${specifier}' from ${layer}`, async () => {
      expect(
        await directionHits(filePath, `import "${specifier}";\n`),
      ).toHaveLength(0);
    });

    it(`accepts a dynamic import of '${specifier}' from ${layer}`, async () => {
      expect(
        await directionHits(
          filePath,
          `export const load = () => import("${specifier}");\n`,
        ),
      ).toHaveLength(0);
    });
  }
});
