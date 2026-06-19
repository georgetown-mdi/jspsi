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
          // Installs the standing console sentinel in every integration file's
          // worker: it wraps console directly and fails the file at afterAll on
          // any un-allowlisted console.log/warn/error (the inverse of blanket
          // silencing). Scoped to this project, so the unit project is unaffected.
          setupFiles: ["./test/integration/consoleSentinel.setup.ts"],
          // Starts the SFTP test server (the in-process backend by default, or
          // the native sshd backend when PSILINK_SFTP_BACKEND=native) before the
          // suite and stops it after, handing the conformance tests its
          // connection details and served directory. Scoped to this project, so
          // the unit project (and the default `test` script) starts no server.
          globalSetup: ["./test/sftpServer/globalSetup.ts"],
        },
      },
    ],
  },
});
