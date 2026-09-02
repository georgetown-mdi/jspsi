import { configDefaults, defineConfig } from "vitest/config";

// Vitest configuration for the mutation-testing leg ONLY
// (scripts/stryker-security.mjs); no other run loads it. Two constraints force
// a second config rather than a reuse of vitest.config.ts:
//
//   1. Stryker copies the repository into a sandbox and points vitest's `root`
//      at the sandbox ROOT, not at packages/core, so every glob here is written
//      repository-root-relative rather than package-relative.
//   2. vitest.config.ts declares its suites through a `projects` array, which
//      Stryker's vitest runner does not handle; the tiers are flattened here
//      into one include/exclude pair.
//
// The stress tier is excluded for the same reason `npm test` excludes it: those
// tests run for tens of seconds each, and a mutation run re-executes the suite
// once per mutant.
export default defineConfig({
  test: {
    include: ["packages/core/test/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: [...configDefaults.exclude, "packages/core/test/stress/**"],
  },
});
