import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
