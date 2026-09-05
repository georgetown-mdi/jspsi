import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "vitest";

// The two guards are only as loud as their registration: both are run-level
// options, so a config that drops its line goes quiet with nothing failing. This
// asserts the wiring by loading each config the way vitest does and resolving
// what it registered back to the guard module on disk -- a renamed or moved
// guard fails here rather than at the next run that needed it.
//
// Limit: it reads the configs' own exported values, not vitest's merge of them.
// That a run-level option registered in a workspace config reaches the run --
// and that `reporters` does NOT survive being reached through the root config's
// `projects`, which is why the root registers its own -- was established by
// driving vitest, and the guards' behavior is covered by their own suites.

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIST_GUARD = resolve(REPO_ROOT, "scripts/lib/coreDistFreshness.mjs");
const SKIPPED_LEG_REPORTER = resolve(
  REPO_ROOT,
  "scripts/lib/skippedLegReporter.mjs",
);

async function loadTestConfig(configPath) {
  const absolute = resolve(REPO_ROOT, configPath);
  const module = await import(absolute);
  const config =
    typeof module.default === "function"
      ? await module.default({ command: "serve", mode: "test" })
      : module.default;
  const dir = dirname(absolute);
  // A path entry is resolved against the config's own directory; a built-in
  // reporter name ("default") is left as vitest reads it.
  const resolveAll = (entries) =>
    (entries ?? []).map((entry) =>
      typeof entry === "string" && entry.startsWith(".")
        ? resolve(dir, entry)
        : entry,
    );
  return {
    globalSetup: resolveAll(config.test?.globalSetup),
    reporters: resolveAll(config.test?.reporters),
  };
}

const WEB_CONFIG = "apps/web/vite.config.ts";

// Every config that owns a run. The apps import the built @psilink/core, so
// they hold the dist guard; packages/core builds its own dist in `pretest` and
// tests its sources, and the root config runs no suite of its own.
const CONFIGS = [
  { path: "vitest.config.mts", distGuard: false },
  { path: "packages/core/vitest.config.ts", distGuard: false },
  { path: "apps/cli/vitest.config.mts", distGuard: true },
  { path: WEB_CONFIG, distGuard: true },
];

// The budget for loading all four configs, vitest's 5s default being the wrong
// scale for it: importing the web config pulls the app's server modules through
// vite's loader and is essentially the whole cost of this file -- 1.3s of the
// 1.4s an idle container spends, and 56s at worst with twenty-four competing
// workers on ten cores, where under the default the case that happened to import
// first reds with a bare timeout rather than a wiring verdict. Not a timing
// assertion: nothing waits for it to elapse on a healthy run.
const CONFIG_LOAD_TIMEOUT_MS = 120_000;

/** Each config's loaded value, keyed by its repo-relative path. */
const loadedConfigs = new Map();

// Loaded once, here, rather than per case: the import cost is the same whichever
// case pays it, and charging it to a hook with a bound of its own leaves each
// case asserting wiring at no cost, under the default the assertions deserve.
beforeAll(async () => {
  for (const { path } of CONFIGS)
    loadedConfigs.set(path, await loadTestConfig(path));
}, CONFIG_LOAD_TIMEOUT_MS);

function loadedConfig(path) {
  const config = loadedConfigs.get(path);
  if (config === undefined)
    throw new Error(`config was not preloaded: ${path}`);
  return config;
}

describe.each(CONFIGS)("$path", ({ path, distGuard }) => {
  test("registers the skipped-leg reporter alongside the default one", () => {
    const { reporters } = loadedConfig(path);
    expect(reporters).toContain("default");
    expect(reporters).toContain(SKIPPED_LEG_REPORTER);
  });

  test(`${distGuard ? "guards" : "does not need a guard for"} the core dist`, () => {
    const { globalSetup } = loadedConfig(path);
    expect(globalSetup.includes(DIST_GUARD)).toBe(distGuard);
  });
});

test("the web config declares the environment prerequisites its suites skip on", () => {
  const { globalSetup } = loadedConfig(WEB_CONFIG);
  expect(globalSetup).toContain(
    resolve(REPO_ROOT, "apps/web/test/requireTestPrerequisites.ts"),
  );
});
