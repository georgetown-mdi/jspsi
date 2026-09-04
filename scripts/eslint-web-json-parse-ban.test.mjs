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

// Coverage of the raw-JSON.parse ban in apps/web/eslint.config.js: JSON this app
// did not produce is parsed through @psilink/core's parseBoundedJson, and the
// property-access form of the ban (no-restricted-properties, the same form
// packages/core/src uses) closes the alias, computed-access, and destructure
// routes around a direct call as well.
//
// The ban fails silently: a `files` pattern or an object/property name that
// stops matching keeps reporting zero problems, which reads exactly like clean
// source. The shapes it does NOT catch -- a renamed JSON binding, and
// globalThis.JSON.parse -- are pinned here too, so its reach is a measured
// property rather than an assumption a reader makes about the rule.
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

/** no-restricted-properties messages reported for `source` linted as `filePath`. */
async function parseHits(filePath, source) {
  const [result] = await eslint.lintText(source, { filePath });
  const fatal = result.messages.filter((message) => message.fatal);
  if (fatal.length > 0) {
    throw new Error(`${filePath}: ${fatal.map((m) => m.message).join("; ")}`);
  }
  return result.messages.filter(
    (message) => message.ruleId === "no-restricted-properties",
  );
}

// A src file the ban covers, and a test file outside it: the web test tree
// parses fixtures of its own and is not a trust boundary.
const WEB_SRC = resolve(repoRoot, "apps/web/src/jobs/routeSupport.ts");
const WEB_TEST = resolve(repoRoot, "apps/web/test/unit/jobRoutes.unit.test.ts");

// Loading the flat config and the typescript-eslint parser for the first time is
// the expensive part of a lintText call, independent of which file or how much
// text it is given; under cold process/CPU load that one-time cost alone can
// outrun the default per-test timeout on a CI runner.
describe("the web raw-JSON.parse ban", { timeout: 60_000 }, () => {
  it("lints paths that exist", () => {
    for (const path of [WEB_SRC, WEB_TEST]) {
      expect(existsSync(path), `${path} no longer exists`).toBe(true);
    }
  });

  it("lints the text it is handed, not the file on disk", async () => {
    for (const filePath of [WEB_SRC, WEB_TEST]) {
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

  it("resolves the ban for the src file and not the test file", async () => {
    for (const [filePath, expected] of [
      [WEB_SRC, true],
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
      const [, ...entries] = config.rules["no-restricted-properties"] ?? [];
      expect(
        entries.some(
          (entry) => entry.object === "JSON" && entry.property === "parse",
        ),
        `${filePath}: the resolved no-restricted-properties options do not carry the JSON.parse ban, so linting it reports zero however the parse is written`,
      ).toBe(expected);
    }
  });

  for (const [shape, source] of [
    ["a direct call", 'const value = JSON.parse("{}");'],
    ["an alias", "const parse = JSON.parse;"],
    ["a computed access", 'const value = JSON["parse"]("{}");'],
    ["a destructure", "const { parse } = JSON;"],
  ]) {
    it(`refuses ${shape} in apps/web/src`, async () => {
      expect(await parseHits(WEB_SRC, `${source}\n`)).not.toHaveLength(0);
    });

    it(`accepts ${shape} in the web test tree`, async () => {
      expect(await parseHits(WEB_TEST, `${source}\n`)).toHaveLength(0);
    });
  }

  // The reach the syntactic form does not have: both need value-flow analysis,
  // and both are left to review, exactly as packages/core/src's identical ban
  // states of itself.
  for (const [shape, source] of [
    ["a renamed JSON object", 'const J = JSON;\nconst value = J.parse("{}");'],
    ["a globalThis access", 'const value = globalThis.JSON.parse("{}");'],
  ]) {
    it(`does not reach ${shape}`, async () => {
      expect(await parseHits(WEB_SRC, `${source}\n`)).toHaveLength(0);
    });
  }

  it("leaves JSON.stringify alone", async () => {
    expect(
      await parseHits(WEB_SRC, "const text = JSON.stringify({});\n"),
    ).toHaveLength(0);
  });
});
