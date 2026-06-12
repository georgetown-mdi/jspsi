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
          // Each integration file runs in its own process. This is already
          // Vitest's default, but it is pinned because commandDefaultRecord runs
          // each party from a process.chdir'd work dir to capture the default
          // record path; cwd is process-global, so under a threads pool -- whose
          // per-file worker threads share one OS process, and thus one cwd -- a
          // chdir in one file could corrupt a concurrently-running sibling's cwd.
          // Forks gives each file its own process, the isolation safety needs.
          pool: "forks",
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
