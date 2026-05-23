import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
        },
      },
    ],
  },
});
