import { configDefaults, defineConfig } from "vitest/config";

// The console sentinel and its captured-log prerequisite, shared by every
// project that runs a file under test/integration. Order is load-bearing:
// capturedLogs MUST precede consoleSentinel. consoleSentinel's import chain pulls
// in @psilink/core, whose module-load loggers (e.g. getLogger("cleaning") in
// standardization.ts) are materialized on that first import; if the sentinel
// setup ran first, those loggers would bind to the bare factory before the
// interceptor exists and bypass capture for the rest of the run.
//
// capturedLogs installs the withCapturedLogs interceptor eagerly, before any test
// logger is constructed, so loglevel-based capture works regardless of logger
// creation order. consoleSentinel wraps console directly and fails the file at
// afterAll on any un-allowlisted console.log/warn/error (the inverse of blanket
// silencing) -- the complementary layer that sees third-party console output
// loglevel capture cannot.
const integrationSetupFiles = [
  "./test/integration/capturedLogs.setup.ts",
  "./test/integration/consoleSentinel.setup.ts",
];

// The WebRTC suite's home. It is transport-agnostic to the SFTP setup -- two
// loopback werift peers meeting through the vendored broker, which the suite
// starts itself -- so it is a project of its own, run once per pull request
// instead of on every SFTP backend and hardened-sshd leg the integration project
// is repeated under (.github/workflows/cli_build_and_test.yaml). A directory
// rather than a filename convention, so a new file joins the right project by
// where it is written.
const WEBRTC_DIR = "test/integration/webrtc";

// The home of the integration files no SFTP backend differentiates: each drives
// a filedrop directory, a listener of its own, or nothing on a socket at all,
// and none reads the suite's server or its per-backend setup. Running them under
// the `integration` project would repeat them on every SFTP backend and
// hardened-sshd leg (.github/workflows/cli_build_and_test.yaml) for the same
// result each time, so they are a project of their own that runs once per pull
// request, like the WebRTC suite above. A directory rather than a filename
// convention, so a new file joins the right project by where it is written.
//
// The bar for writing a file here is that no leg differentiates what it
// EXERCISES, not merely what it asserts: a file that reaches the suite's server
// at all -- including incidentally, through a fixture or a teardown -- belongs
// in `integration`, because moving it would take that exercise off the native
// and hardened legs entirely.
const BACKEND_AGNOSTIC_DIR = "test/integration/backendAgnostic";

export default defineConfig({
  test: {
    // Run-level, not per-project: vitest reads these once for the run rather
    // than per project, so every project below -- and every project added later
    // -- is covered without registering anything of its own.
    //
    // The dist guard fails the run when the built @psilink/core these suites
    // import is older than its sources, instead of letting the run report
    // failures that belong to the build. The reporter names every skipped test
    // at the end of the run, so a leg that quietly stopped running is visible
    // rather than folded into a count.
    globalSetup: ["../../scripts/lib/coreDistFreshness.mjs"],
    reporters: ["default", "../../scripts/lib/skippedLegReporter.mjs"],
    // Coverage is an informational REPORT, produced on demand by `npm run
    // coverage` (see package.json), never a gate: there is deliberately NO
    // `thresholds` line (see CONTRIBUTING.md, Coverage). The coverage script
    // runs every project here, because the SFTP adapter runs in-process and is
    // exercised only by the integration suite, the WebRTC transport only by the
    // webrtc suite, and the exchange and zero-setup command handlers only by the
    // backend-agnostic suite -- a unit-only report would misleadingly show all
    // three near-uncovered.
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
          include: ["test/unit/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
          // The WebRTC and backend-agnostic suites are projects of their own
          // below; excluding them here is what keeps them off the legs that
          // repeat this project per SFTP backend.
          exclude: [
            ...configDefaults.exclude,
            `${WEBRTC_DIR}/**`,
            `${BACKEND_AGNOSTIC_DIR}/**`,
          ],
          // One process per file. This is already Vitest's default, but it is
          // pinned because the console sentinel asserts at file scope and takes
          // that cross-process isolation as its premise
          // (test/integration/consoleSentinel.setup.ts).
          pool: "forks",
          // Scoped to this project so the unit project is unaffected.
          setupFiles: integrationSetupFiles,
          // Starts the SFTP test server (the in-process backend by default, or
          // the native sshd backend when PSILINK_SFTP_BACKEND=native) before the
          // suite and stops it after, handing the conformance tests its
          // connection details and served directory. Scoped to this project, so
          // the unit project (and the default `test` script) starts no server.
          globalSetup: ["./test/sftpServer/globalSetup.ts"],
        },
      },
      {
        test: {
          name: "webrtc",
          include: [`${WEBRTC_DIR}/**/*.{test,spec}.?(c|m)[jt]s?(x)`],
          // One process per file, as in the integration project: the console
          // sentinel asserts at file scope and takes that cross-process
          // isolation as its premise (test/integration/consoleSentinel.setup.ts).
          pool: "forks",
          // Same console hygiene as the integration project it sits beside.
          setupFiles: integrationSetupFiles,
          // No globalSetup: these tests need no SFTP server, and each file
          // spawns the broker it drives (test/signaling/brokerProcess.ts). The
          // sentinel's dead-allowlist-entry report is provided by that
          // globalSetup and is advisory, so its absence here costs no check --
          // the sentinel's own assertion runs per file either way.
        },
      },
      {
        test: {
          name: "backend-agnostic",
          include: [`${BACKEND_AGNOSTIC_DIR}/**/*.{test,spec}.?(c|m)[jt]s?(x)`],
          // One process per file, as in the two projects above. Beyond the
          // console sentinel's file-scope premise, commandDefaultRecord runs
          // each party from a process.chdir'd work dir to capture the default
          // record path; cwd is process-global, so under a threads pool -- whose
          // per-file worker threads share one OS process, and thus one cwd -- a
          // chdir in one file could corrupt a concurrently-running sibling's cwd.
          pool: "forks",
          // Same console hygiene as the two projects it sits beside.
          setupFiles: integrationSetupFiles,
          // No globalSetup: no file here reads the suite's SFTP server, which is
          // the whole reason they are off the per-backend legs. The sentinel's
          // dead-allowlist-entry report is provided by that globalSetup and is
          // advisory, so its absence here costs no check, as in the WebRTC
          // project above.
        },
      },
    ],
  },
});
