import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Coverage is an informational REPORT, produced on demand by `npm run
    // coverage` (see package.json), never a gate: there is deliberately NO
    // `thresholds` line. A blanket "N% or the build fails" bar rewards vanity
    // tests that raise the number without raising confidence; any future gating
    // stays diff-scoped to this package (see CONTRIBUTING.md, Coverage).
    coverage: {
      provider: "v8",
      // text -> terminal summary; html + lcov -> browsable/tooling report
      // under coverage/.
      reporter: ["text", "html", "lcov"],
      // Confine the denominator to product source: the test/ suite, fixtures,
      // and this config are all siblings of src/, so scoping include here keeps
      // them out of the report without a per-file exclude list.
      include: ["src/**"],
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
          // Keep the stress tier out of the default run; it is opt-in via
          // `npm run test:stress`. Extend (not replace) vitest's defaults so
          // node_modules/dist stay excluded.
          exclude: [...configDefaults.exclude, "test/stress/**"],
        },
      },
      {
        test: {
          name: "stress",
          include: ["test/stress/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
          // Large PSI rounds run for tens of seconds at the default sizes; the
          // 5s default would flake. Headroom here also lets a tuned-up run
          // (raised PSI_STRESS_N / PSI_STRESS_E2E_N) finish without flaking.
          testTimeout: 300_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
});
