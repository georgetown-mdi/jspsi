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
          // Brings the SFTP test container up before the suite and tears it
          // down after, so `npm run test:integration` needs no manual
          // test:container:up / :down. Scoped to this project, so the unit
          // project (and the default `test` script) never requires Docker.
          globalSetup: ["./test/container/globalSetup.ts"],
        },
      },
    ],
  },
});
