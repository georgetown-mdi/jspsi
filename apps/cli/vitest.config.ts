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
          // Per-file worker setup, scoped to this project so the unit project is
          // unaffected. capturedLogs installs the withCapturedLogs interceptor
          // eagerly, before any test logger is constructed, so loglevel-based
          // capture works regardless of logger creation order. consoleSentinel
          // wraps console directly and fails the file at afterAll on any
          // un-allowlisted console.log/warn/error (the inverse of blanket
          // silencing) -- the complementary layer that sees third-party console
          // output loglevel capture cannot.
          //
          // Order is load-bearing: capturedLogs MUST precede consoleSentinel.
          // consoleSentinel's import chain pulls in @psilink/core, whose
          // module-load loggers (e.g. getLogger("cleaning") in standardization.ts)
          // are materialized on that first import; if the sentinel setup ran
          // first, those loggers would bind to the bare factory before the
          // interceptor exists and bypass capture for the rest of the run.
          setupFiles: [
            "./test/integration/capturedLogs.setup.ts",
            "./test/integration/consoleSentinel.setup.ts",
          ],
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
