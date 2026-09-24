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

/**
 * Widens a test-name filter written with space-joined names to also match
 * vitest's `>`-joined full names.
 *
 * Stryker's vitest runner selects the tests for each mutant by setting
 * `testNamePattern` to its recorded test names, a `describe` title and the
 * test title joined by a space. Vitest 5 matches the pattern against the
 * full name joined by " > ", so without this every `describe`-nested test is
 * filtered out of every mutant run and kills nothing. Every space is
 * widened, since the pattern does not mark which one joins two titles; a
 * space inside a title can then over-select, never under-select.
 * scripts/stryker-security.test.mjs checks the vitest half against the real
 * vitest.
 */
export function widenTestNamePattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source.replaceAll(" ", "(?: > | )"), pattern.flags);
}

// Stryker assigns the pattern to the resolved config before each mutant run,
// so the widening happens on assignment rather than once at startup.
const widenStrykerTestNamePattern = {
  name: "psilink-stryker-test-name-pattern",
  configureVitest({
    vitest,
  }: {
    vitest: { config: { testNamePattern?: RegExp } };
  }) {
    let pattern = vitest.config.testNamePattern;
    Object.defineProperty(vitest.config, "testNamePattern", {
      configurable: true,
      enumerable: true,
      get: () => pattern,
      set: (value: RegExp | undefined) => {
        pattern = value === undefined ? value : widenTestNamePattern(value);
      },
    });
  },
};

export default defineConfig({
  plugins: [widenStrykerTestNamePattern],
  test: {
    include: ["packages/core/test/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: [...configDefaults.exclude, "packages/core/test/stress/**"],
  },
});
