import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Coverage of the cross-workspace import ban in eslint.boundaries.mjs: apps
// consume packages, packages never consume apps, and the two apps never reach
// into each other. A specifier pattern that stops matching fails silently -- it
// keeps reporting zero problems, which is indistinguishable from clean source --
// and the groups are folded into five separate eslint blocks across two config
// files, because flat config replaces rather than merges a rule's options, so a
// block that grows its own no-restricted-imports options can drop them with no
// other tell.
//
// Nothing here names a config file: the ESLint instance resolves configuration
// the way `npm run lint` does, from the linted path. That is load-bearing rather
// than incidental -- ESLint resolves the nearest config file for a subtree, so
// apps/web is governed by apps/web/eslint.config.js and a web ban written only
// into the repo-root config would never run.
//
// The apps/web cases name files that exist, where the core and cli cases do not:
// the web config parses with type information against apps/web/tsconfig.json,
// which fails on a path that is in no TypeScript program.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const eslint = new ESLint({ cwd: repoRoot });

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
// whose blocks re-carry the groups alongside another rule's options, and the
// test and build-config files are covered only by the broad boundary blocks.
const CORE_SRC = resolve(repoRoot, "packages/core/src/boundaryFixture.ts");
const CORE_TEST = resolve(repoRoot, "packages/core/test/boundaryFixture.ts");
const CLI_SRC = resolve(repoRoot, "apps/cli/src/boundaryFixture.ts");
const CLI_TEST = resolve(repoRoot, "apps/cli/test/unit/boundaryFixture.ts");
const WEB_SRC = resolve(repoRoot, "apps/web/src/utils/serverConfig.ts");
const WEB_OUTSIDE_SRC = resolve(repoRoot, "apps/web/vite.config.ts");

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
  ["apps/cli/src", CLI_SRC, "@psilink/core"],
  ["apps/cli/src", CLI_SRC, "@psilink/core/testing"],
  ["apps/cli/test", CLI_TEST, "../../src/protocol"],
  ["apps/web/src", WEB_SRC, "@psilink/core"],
  ["apps/web/src", WEB_SRC, "../../src/utils/seo"],
  ["apps/web", WEB_OUTSIDE_SRC, "@psilink/core"],
];

describe("the cross-workspace import ban", () => {
  it("lints the apps/web cases against files that exist", () => {
    for (const path of [WEB_SRC, WEB_OUTSIDE_SRC]) {
      expect(existsSync(path), `${path} no longer exists`).toBe(true);
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
