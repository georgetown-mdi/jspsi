import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { crossWorkspaceImportBans } from "../eslint.boundaries.mjs";
import repoConfig from "../eslint.config.mjs";
import {
  PROJECT_PARSER_OPTIONS,
  typeAwareRuleNames,
  withoutTypeAwareLayer,
} from "./eslint-strip-type-aware-layer.mjs";

// Coverage of the cross-workspace import ban in eslint.boundaries.mjs: apps
// consume packages, packages never consume apps, and the two apps never reach
// into each other. A specifier pattern that stops matching fails silently -- it
// keeps reporting zero problems, which is indistinguishable from clean source --
// and the groups are folded into five separate eslint blocks across two config
// files, because flat config replaces rather than merges a rule's options, so a
// block that grows its own no-restricted-imports options can drop them with no
// other tell.
//
// Each case is linted through the real repo config -- eslint.config.mjs already
// embeds apps/web's blocks (scoped under apps/web/, see scopeToDir there), so one
// config covers every tree this file lints -- with one transform: the
// type-aware layer is stripped off before it is used (withoutTypeAwareLayer,
// imported from ./eslint-strip-type-aware-layer.mjs). The blocks that hold the
// ban are transformed by nothing, so the selector, the per-tree `files`
// scoping, and flat config's replace-semantics across the five blocks are the
// real ones.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: true,
  baseConfig: withoutTypeAwareLayer(repoConfig),
});

/** no-restricted-imports messages reported for `source` linted as `filePath`. */
async function boundaryHits(filePath, source) {
  const [result] = await eslint.lintText(source, { filePath });
  const fatal = result.messages.filter((message) => message.fatal);
  if (fatal.length > 0) {
    throw new Error(`${filePath}: ${fatal.map((m) => m.message).join("; ")}`);
  }
  return result.messages.filter(
    (message) => message.ruleId === "no-restricted-imports",
  );
}

// A src path and a path outside src per workspace: the src files are the ones
// whose blocks repeat the groups alongside another rule's options, and the
// test and build-config files are covered only by the broad boundary blocks.
const CORE_SRC = resolve(repoRoot, "packages/core/src/boundaryFixture.ts");
const CORE_TEST = resolve(repoRoot, "packages/core/test/boundaryFixture.ts");
const BROKER_SRC = resolve(
  repoRoot,
  "packages/peerjs-broker/src/boundaryFixture.ts",
);
const CLI_SRC = resolve(repoRoot, "apps/cli/src/boundaryFixture.ts");
const CLI_TEST = resolve(repoRoot, "apps/cli/test/unit/boundaryFixture.ts");
const WEB_SRC = resolve(repoRoot, "apps/web/src/utils/serverConfig.ts");
const WEB_OUTSIDE_SRC = resolve(repoRoot, "apps/web/vite.config.ts");

// Reserved for the first-parse check: one apps/web path on each side of src/,
// linted by nothing else here.
const WEB_SRC_FIRST_PARSE = resolve(repoRoot, "apps/web/src/utils/seo.ts");
const WEB_OUTSIDE_SRC_FIRST_PARSE = resolve(
  repoRoot,
  "apps/web/nitro.config.ts",
);

// The reaches each guarded tree must refuse. The bare package names are live
// specifiers, not hypotheticals: npm workspaces symlinks apps/cli and apps/web
// into the root node_modules as `psilink` and `jspsi`. The bare-directory forms
// sit alongside their subpath siblings because they exercise a different
// pattern: matching is gitignore-style, where `dir/**` matches only strictly
// beneath `dir` and never `dir` itself.
const REFUSED = [
  ["packages/core/src", CORE_SRC, "../../../apps/cli/src/protocol"],
  ["packages/core/src", CORE_SRC, "../../../apps/web/src/psi/exchange"],
  ["packages/core/src", CORE_SRC, "../../../apps/web"],
  ["packages/core/src", CORE_SRC, "psilink"],
  ["packages/core/src", CORE_SRC, "jspsi"],
  ["packages/core/test", CORE_TEST, "../../../apps/cli/src/protocol"],
  ["packages/core/test", CORE_TEST, "psilink"],
  [
    "packages/peerjs-broker/src",
    BROKER_SRC,
    "../../../apps/web/src/psi/exchange",
  ],
  ["packages/peerjs-broker/src", BROKER_SRC, "jspsi"],
  ["apps/cli/src", CLI_SRC, "../../web/src/psi/exchange"],
  ["apps/cli/src", CLI_SRC, "../../web"],
  ["apps/cli/src", CLI_SRC, "../../../apps/web/src/psi/exchange"],
  ["apps/cli/src", CLI_SRC, "../../../apps/web"],
  ["apps/cli/src", CLI_SRC, "jspsi"],
  ["apps/cli/test", CLI_TEST, "../../../web/src/psi/exchange"],
  ["apps/cli/test", CLI_TEST, "../../../web"],
  ["apps/web/src", WEB_SRC, "../../../cli/src/protocol"],
  ["apps/web/src", WEB_SRC, "../../../cli"],
  ["apps/web/src", WEB_SRC, "../../../../apps/cli/src/protocol"],
  ["apps/web/src", WEB_SRC, "../../../../apps/cli"],
  ["apps/web/src", WEB_SRC, "psilink"],
  ["apps/web", WEB_OUTSIDE_SRC, "../cli/src/protocol"],
  ["apps/web", WEB_OUTSIDE_SRC, "../cli"],
  ["apps/web", WEB_OUTSIDE_SRC, "psilink"],
];

// Imports each tree must keep accepting: the package channel the apps are meant
// to use, and within-workspace relative paths that climb but stay inside.
const ACCEPTED = [
  ["packages/core/src", CORE_SRC, "./utils/boundedJson"],
  ["packages/core/test", CORE_TEST, "../src/main"],
  ["packages/peerjs-broker/src", BROKER_SRC, "./contrib/index.ts"],
  ["apps/cli/src", CLI_SRC, "@psilink/core"],
  ["apps/cli/src", CLI_SRC, "@psilink/core/testing"],
  ["apps/cli/test", CLI_TEST, "../../src/protocol"],
  ["apps/web/src", WEB_SRC, "@psilink/core"],
  ["apps/web/src", WEB_SRC, "../../src/utils/seo"],
  ["apps/web", WEB_OUTSIDE_SRC, "@psilink/core"],
];

// Loading the flat config and the typescript-eslint parser for the first time is
// the expensive part of a lintText call, independent of which file or how much
// text it is given; under cold process/CPU load that one-time cost alone can
// outrun the default per-test timeout on a CI runner. The timeout rides the
// whole suite rather than one case because a `-t` filter decides which one
// pays; every case is a single lint call otherwise.
describe("the cross-workspace import ban", { timeout: 60_000 }, () => {
  it("lints the apps/web cases against files that exist", () => {
    for (const path of [
      WEB_SRC,
      WEB_OUTSIDE_SRC,
      WEB_SRC_FIRST_PARSE,
      WEB_OUTSIDE_SRC_FIRST_PARSE,
    ]) {
      expect(existsSync(path), `${path} no longer exists`).toBe(true);
    }
  });

  it("applies the ban to every path it lints, with no type-aware rule", async () => {
    for (const [tree, filePath, expectedPatterns] of [
      ["packages/core/src", CORE_SRC, crossWorkspaceImportBans.packages],
      ["packages/core/test", CORE_TEST, crossWorkspaceImportBans.packages],
      [
        "packages/peerjs-broker/src",
        BROKER_SRC,
        crossWorkspaceImportBans.packages,
      ],
      ["apps/cli/src", CLI_SRC, crossWorkspaceImportBans.cli],
      ["apps/cli/test", CLI_TEST, crossWorkspaceImportBans.cli],
      ["apps/web/src", WEB_SRC, crossWorkspaceImportBans.web],
      ["apps/web", WEB_OUTSIDE_SRC, crossWorkspaceImportBans.web],
      ["apps/web/src", WEB_SRC_FIRST_PARSE, crossWorkspaceImportBans.web],
      ["apps/web", WEB_OUTSIDE_SRC_FIRST_PARSE, crossWorkspaceImportBans.web],
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
      expect(
        options?.patterns,
        `${tree}: the cross-workspace import ban is not among the no-restricted-imports options at ${filePath}, so linting it reports zero however the specifier is written`,
      ).toEqual(expectedPatterns);
    }
  });

  it("lints the text it is handed, not the file on disk", async () => {
    for (const filePath of [WEB_SRC_FIRST_PARSE, WEB_OUTSIDE_SRC_FIRST_PARSE]) {
      const [result] = await eslint.lintText(
        "this is not typescript !!! (((\n",
        {
          filePath,
        },
      );
      expect(
        result.messages.map((message) => message.message).join("; "),
        `${filePath}: the source on disk was linted instead, so every apps/web case landing on a first parse is vacuous`,
      ).toMatch(/Parsing error/);
    }
  });

  for (const [tree, filePath, specifier] of REFUSED) {
    it(`refuses '${specifier}' from ${tree}`, async () => {
      expect(
        await boundaryHits(filePath, `import "${specifier}";\n`),
      ).not.toHaveLength(0);
    });

    it(`refuses a type-only '${specifier}' from ${tree}`, async () => {
      expect(
        await boundaryHits(
          filePath,
          `import type { A } from "${specifier}";\n`,
        ),
      ).not.toHaveLength(0);
    });

    it(`refuses a re-export of '${specifier}' from ${tree}`, async () => {
      expect(
        await boundaryHits(filePath, `export { a } from "${specifier}";\n`),
      ).not.toHaveLength(0);
    });
  }

  for (const [tree, filePath, specifier] of ACCEPTED) {
    it(`accepts '${specifier}' from ${tree}`, async () => {
      expect(
        await boundaryHits(filePath, `import "${specifier}";\n`),
      ).toHaveLength(0);
    });
  }
});
