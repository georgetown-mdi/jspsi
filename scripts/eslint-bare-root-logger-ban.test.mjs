import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { noBareRootLoglevelEmit } from "../eslint.boundaries.mjs";
import repoConfig from "../eslint.config.mjs";
import {
  PROJECT_PARSER_OPTIONS,
  typeAwareRuleNames,
  withoutTypeAwareLayer,
} from "./eslint-strip-type-aware-layer.mjs";

// Coverage of the two bans that hold every diagnostic line to a NAMED logger
// built through @psilink/core's getLogger: the emit selector shared by both
// config files (noBareRootLoglevelEmit in eslint.boundaries.mjs, applied to
// packages/core/src, apps/cli/src and apps/web's src/ and server/), and the
// import ban apps/web adds beside it, which refuses loglevel's default export --
// the root logger itself -- so no alias of it can emit under any name.
//
// Both fail silently: a `files` pattern that stops matching, or a rule's options
// replaced by a later block (flat config replaces rather than merges), keeps
// reporting zero problems, which reads exactly like clean source. apps/web
// resolves each of its src files through one of four blocks that set
// no-restricted-imports and one of five that set no-restricted-syntax, so a file
// per block is linted here rather than one file standing for the tree.
//
// Each case is linted through the repo-root config, which embeds apps/web's
// blocks scoped under apps/web/ (scopeToDir in eslint.config.mjs); a real
// `eslint .` reaches those same blocks through apps/web/eslint.config.js, the
// nearest config file for that subtree. One transform is applied: the type-aware
// layer is stripped off (withoutTypeAwareLayer), so what this file reports rests
// on the text it hands in and nothing else.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: true,
  baseConfig: withoutTypeAwareLayer(repoConfig),
});

/** Messages for `ruleId` reported for `source` linted as `filePath`. */
async function hits(ruleId, filePath, source) {
  const [result] = await eslint.lintText(source, { filePath });
  const fatal = result.messages.filter((message) => message.fatal);
  if (fatal.length > 0) {
    throw new Error(`${filePath}: ${fatal.map((m) => m.message).join("; ")}`);
  }
  return result.messages.filter((message) => message.ruleId === ruleId);
}

const importHits = (filePath, source) =>
  hits("no-restricted-imports", filePath, source);
const emitHits = (filePath, source) =>
  hits("no-restricted-syntax", filePath, source);

// One apps/web file per block that sets these rules for src/, so a block whose
// options drop a ban is reported here rather than only by the emit that
// reintroduces it. The two trees outside apps/web that take the emit ban, and
// the web test tree, which takes neither: a test builds loggers of its own to
// spy on.
const WEB_PRODUCT = resolve(
  repoRoot,
  "apps/web/src/exchange/InviterScreen.tsx",
);
const WEB_BELOW_PRODUCTS = resolve(
  repoRoot,
  "apps/web/src/psi/managed/managedRunDriver.ts",
);
const WEB_CHOKEPOINT = resolve(
  repoRoot,
  "apps/web/src/psi/linkageComparison.ts",
);
const WEB_RAW_ROWS = resolve(repoRoot, "apps/web/src/psi/inviterEditor.ts");
const WEB_SERVER = resolve(repoRoot, "apps/web/server/custom-entry.ts");
const WEB_TEST = resolve(
  repoRoot,
  "apps/web/test/unit/psi/managedRunDriver.test.ts",
);
const CORE_SRC = resolve(repoRoot, "packages/core/src/exchange.ts");
const CLI_SRC = resolve(repoRoot, "apps/cli/src/commands/exchange.ts");

const WEB_BANNED = [
  WEB_PRODUCT,
  WEB_BELOW_PRODUCTS,
  WEB_CHOKEPOINT,
  WEB_RAW_ROWS,
  WEB_SERVER,
];

/** Whether a no-restricted-imports `paths` entry is the root-logger ban. */
const isRootLoglevelBan = (entry) =>
  entry.name === "loglevel" && (entry.importNames ?? []).includes("default");

// Loading the flat config and the typescript-eslint parser for the first time is
// the expensive part of a lintText call, independent of which file or how much
// text it is given; under cold process/CPU load that one-time cost alone can
// outrun the default per-test timeout on a CI runner.
describe("the bare-root-logger bans", { timeout: 60_000 }, () => {
  it("lints paths that exist", () => {
    for (const path of [...WEB_BANNED, WEB_TEST, CORE_SRC, CLI_SRC]) {
      expect(existsSync(path), `${path} no longer exists`).toBe(true);
    }
  });

  it("lints the text it is handed, not the file on disk", async () => {
    for (const filePath of [...WEB_BANNED, WEB_TEST, CORE_SRC, CLI_SRC]) {
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

  it("resolves both bans for every apps/web block that sets them", async () => {
    for (const filePath of WEB_BANNED) {
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
      const [, ...importOptions] = config.rules["no-restricted-imports"] ?? [];
      expect(
        importOptions.some((option) =>
          (option.paths ?? []).some(isRootLoglevelBan),
        ),
        `${filePath}: the resolved no-restricted-imports options do not carry the root-logger import ban, so a later block replaced it`,
      ).toBe(true);
      const [, ...syntaxOptions] = config.rules["no-restricted-syntax"] ?? [];
      expect(
        syntaxOptions.some(
          (option) => option.selector === noBareRootLoglevelEmit.selector,
        ),
        `${filePath}: the resolved no-restricted-syntax options do not carry the bare-root emit selector, so a later block replaced it`,
      ).toBe(true);
    }
  });

  for (const [shape, source] of [
    ["a default import", 'import log from "loglevel";\nlog.warn("x");\n'],
    ["a renamed default import", 'import l from "loglevel";\nl.warn("x");\n'],
    ["a namespace import", 'import * as l from "loglevel";\nl.warn("x");\n'],
    [
      "a default beside a named import",
      'import log, { levels } from "loglevel";\nlog.warn(levels);\n',
    ],
  ]) {
    it(`refuses ${shape} everywhere apps/web ships from`, async () => {
      for (const filePath of WEB_BANNED) {
        expect(
          await importHits(filePath, source),
          `${filePath}: ${shape} passed`,
        ).not.toHaveLength(0);
      }
    });
  }

  it("leaves the level-configuration imports the entry points take", async () => {
    for (const filePath of WEB_BANNED) {
      expect(
        await importHits(
          filePath,
          'import { levels, setDefaultLevel } from "loglevel";\nsetDefaultLevel(levels.INFO);\n',
        ),
        `${filePath}: a named import was refused`,
      ).toHaveLength(0);
    }
  });

  it("refuses a bare-root emit in every tree the shared selector covers", async () => {
    const source =
      'import logLibrary from "loglevel";\nlogLibrary.warn("x");\n';
    for (const filePath of [...WEB_BANNED, CORE_SRC, CLI_SRC]) {
      expect(
        await emitHits(filePath, source),
        `${filePath}: the bare-root emit passed`,
      ).not.toHaveLength(0);
    }
  });

  it("leaves a named logger's emit alone", async () => {
    const source =
      'import { getLogger } from "@psilink/core";\nconst log = getLogger("probe");\nlog.warn("x");\n';
    for (const filePath of [...WEB_BANNED, CORE_SRC, CLI_SRC]) {
      expect(
        await emitHits(filePath, source),
        `${filePath}: the named-logger emit was refused`,
      ).toHaveLength(0);
      expect(
        await importHits(filePath, source),
        `${filePath}: the core import was refused`,
      ).toHaveLength(0);
    }
  });

  it("leaves the web test tree free to build loggers of its own", async () => {
    const source = 'import log from "loglevel";\nlog.warn("x");\n';
    expect(await importHits(WEB_TEST, source)).toHaveLength(0);
    expect(await emitHits(WEB_TEST, source)).toHaveLength(0);
  });

  // The reach neither ban has: a root logger obtained from something other than a
  // loglevel import -- core re-exports none, so this needs a module written to
  // hand one out -- and a dynamic import, whose binding no specifier names. Both
  // are left to review, as the sibling bans state of their own blind spots.
  it("does not reach a root logger taken from another module", async () => {
    const source = 'import { root } from "./rootLogger";\nroot.warn("x");\n';
    expect(await importHits(WEB_PRODUCT, source)).toHaveLength(0);
    expect(await emitHits(WEB_PRODUCT, source)).toHaveLength(0);
  });
});
