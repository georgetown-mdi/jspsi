import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import repoConfig from "../eslint.config.mjs";
import webConfig from "../apps/web/eslint.config.js";
import {
  PROJECT_PARSER_OPTIONS,
  typeAwareRuleNames,
  withoutTypeAwareLayer,
} from "./eslint-strip-type-aware-layer.mjs";

// Coverage of the two parse bans in apps/web/eslint.config.js, which share one
// no-restricted-properties block: JSON this app did not produce is parsed
// through @psilink/core's parseBoundedJson, and a fetched body is read through
// the bounded read in src/psi/jobClient/jobApiBody.ts rather than Response.json(). The
// property-access form of each (the same form packages/core/src uses) closes the
// alias, computed-access, and destructure routes around a direct call as well.
//
// A ban fails silently: a `files` pattern or an object/property name that stops
// matching keeps reporting zero problems, which reads exactly like clean source.
// The shapes each does NOT catch are pinned here too, so its reach is a measured
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

// Two files the ban covers -- one in the browser-and-console tree, one in the
// Nitro server entry tree -- and a test file outside it: the web test tree parses
// fixtures of its own and is not a trust boundary.
const WEB_SRC = resolve(repoRoot, "apps/web/src/jobs/routeSupport.ts");
const WEB_SERVER = resolve(repoRoot, "apps/web/server/upgradeHardening.ts");
const WEB_TEST = resolve(
  repoRoot,
  "apps/web/test/unit/routes/jobRoutes.unit.test.ts",
);

/** The apps/web block whose rules carry a property ban matching `matches`. */
function propertyBanBlock(matches) {
  return webConfig.find((block) => {
    const rule = block.rules?.["no-restricted-properties"];
    if (!Array.isArray(rule)) return false;
    return rule.slice(1).some(matches);
  });
}

/** Whether a no-restricted-properties entry is the JSON.parse ban. */
const isJsonParseBan = (entry) =>
  entry.object === "JSON" && entry.property === "parse";

/** Whether an entry is the Response.json ban: a property with no object name,
 * since the receiver of a `.json()` is a variable the rule cannot resolve. */
const isResponseJsonBan = (entry) =>
  entry.object === undefined && entry.property === "json";

// Loading the flat config and the typescript-eslint parser for the first time is
// the expensive part of a lintText call, independent of which file or how much
// text it is given; under cold process/CPU load that one-time cost alone can
// outrun the default per-test timeout on a CI runner.
describe("the web raw-JSON.parse ban", { timeout: 60_000 }, () => {
  it("lints paths that exist", () => {
    for (const path of [WEB_SRC, WEB_SERVER, WEB_TEST]) {
      expect(existsSync(path), `${path} no longer exists`).toBe(true);
    }
  });

  it("lints the text it is handed, not the file on disk", async () => {
    for (const filePath of [WEB_SRC, WEB_SERVER, WEB_TEST]) {
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

  it("resolves the ban for the shipped trees and not the test tree", async () => {
    for (const [filePath, expected] of [
      [WEB_SRC, true],
      [WEB_SERVER, true],
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
        entries.some(isJsonParseBan),
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

    it(`refuses ${shape} in apps/web/server`, async () => {
      expect(await parseHits(WEB_SERVER, `${source}\n`)).not.toHaveLength(0);
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

  // A disable directive that no longer silences anything is an error rather than
  // a warning, so an exemption left behind on a parse that stopped needing one
  // fails CI instead of sitting unread. The setting is per config block, so the
  // ban's block has to carry it: inherited from a sibling, it would lapse the day
  // the sibling's `files` stopped covering the same tree, and nothing linted here
  // would report differently.
  it("carries its own unused-disable-directive setting", () => {
    const block = propertyBanBlock(isJsonParseBan);
    expect(block, "no apps/web block carries the JSON.parse ban").toBeDefined();
    expect(block.linterOptions?.reportUnusedDisableDirectives).toBe("error");
  });

  it("reports an unused disable directive on the ban as an error", async () => {
    const [result] = await eslint.lintText(
      "// eslint-disable-next-line no-restricted-properties -- nothing to silence\nconst text = JSON.stringify({});\n",
      { filePath: WEB_SRC },
    );
    expect(
      result.messages.map((message) => message.message).join("; "),
    ).toMatch(/Unused eslint-disable directive/);
    expect(result.errorCount).toBeGreaterThan(0);
  });
});

// The Response.json ban shares the block above, so what is pinned here is only
// what differs: the property has no object name, which is what lets it reach a
// `.json()` on a variable -- and what makes every other `.json` property read in
// these trees a violation too. Nothing under src/ or server/ has one, so the ban
// carries no standing exemption, and this file would report the day one appeared.
describe("the web Response.json ban", { timeout: 60_000 }, () => {
  it("resolves the ban for the shipped trees and not the test tree", async () => {
    for (const [filePath, expected] of [
      [WEB_SRC, true],
      [WEB_SERVER, true],
      [WEB_TEST, false],
    ]) {
      const config = await eslint.calculateConfigForFile(filePath);
      const [, ...entries] = config.rules["no-restricted-properties"] ?? [];
      expect(
        entries.some(isResponseJsonBan),
        `${filePath}: the resolved no-restricted-properties options do not carry the Response.json ban, so linting it reports zero however the read is written`,
      ).toBe(expected);
    }
  });

  for (const [shape, source] of [
    ["a direct call", "const value = await response.json();"],
    ["an alias", "const read = response.json;"],
    ["a computed access", 'const value = await response["json"]();'],
    ["a destructure", "const { json } = response;"],
    ["a static Response.json builder", "const answer = Response.json({});"],
  ]) {
    it(`refuses ${shape} in apps/web/src`, async () => {
      expect(await parseHits(WEB_SRC, `${source}\n`)).not.toHaveLength(0);
    });

    it(`refuses ${shape} in apps/web/server`, async () => {
      expect(await parseHits(WEB_SERVER, `${source}\n`)).not.toHaveLength(0);
    });

    it(`accepts ${shape} in the web test tree`, async () => {
      expect(await parseHits(WEB_TEST, `${source}\n`)).toHaveLength(0);
    });
  }

  // The reach the property form does not have: a body read as text and parsed
  // elsewhere never names `json` at all, so only the JSON.parse half of the block
  // catches it -- which it does, and that is what this pins.
  it("catches a text-then-parse read through the JSON.parse half", async () => {
    const hits = await parseHits(
      WEB_SRC,
      "const value = JSON.parse(await response.text());\n",
    );
    expect(hits).not.toHaveLength(0);
  });

  it("leaves a non-json body read alone", async () => {
    expect(
      await parseHits(WEB_SRC, "const text = await response.text();\n"),
    ).toHaveLength(0);
  });

  it("carries its own unused-disable-directive setting", () => {
    const block = propertyBanBlock(isResponseJsonBan);
    expect(
      block,
      "no apps/web block carries the Response.json ban",
    ).toBeDefined();
    expect(block.linterOptions?.reportUnusedDisableDirectives).toBe("error");
  });

  it("takes a disable directive with a one-line why", async () => {
    const [result] = await eslint.lintText(
      "// eslint-disable-next-line no-restricted-properties -- a body this process built itself\nconst value = await response.json();\n",
      { filePath: WEB_SRC },
    );
    expect(
      result.messages.filter(
        (message) => message.ruleId === "no-restricted-properties",
      ),
    ).toHaveLength(0);
    expect(result.errorCount).toBe(0);
  });
});
