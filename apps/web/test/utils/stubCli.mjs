// A stub psilink CLI the job-driver tests point the driver at via the
// JOB_CLI_BINARY override. It emulates the parts of the real CLI the driver
// depends on: it can emit chosen fd-3 NDJSON events, write an output file, exit
// with a chosen code, and honor or ignore an interrupt signal -- all configured
// through environment variables so a test can drive one binary through many
// scenarios without a separate script per case.
//
// It also emulates the `probe-host-key` and `fingerprint` subcommands the
// console spawns (self-contained branches that never touch the exchange
// emulation).
//
// Environment variables (all optional):
//   STUB_FD3_EVENTS   JSON array of event objects to write to fd 3, in order.
//   STUB_FD3_RAW      A raw string written verbatim to fd 3 (for malformed-line
//                     tests); written BEFORE STUB_FD3_EVENTS so a malformed
//                     preamble is observed before any terminal event.
//   STUB_EXIT_CODE    Integer exit code (default 0).
//   STUB_STDERR       Text written to stderr before exit.
//   STUB_STDOUT       Text written to stdout before exit.
//   STUB_OUTPUT_FILE  When set, the output positional (last argv) is written
//                     with this content (so the result route has a file).
//   STUB_RECORD_JSON  When set, the record file named by --record-file is written
//                     with this content, and its paired .keys.json alongside it
//                     (so the record/keys routes have files). The keys path is
//                     the record path with .json replaced by .keys.json, matching
//                     the CLI's keysPathFor.
//   STUB_DELAY_MS     Milliseconds to wait before exiting (default 0). During
//                     the wait the process is interruptible.
//   STUB_IGNORE_SIGINT  When "1", SIGINT is ignored (to test SIGTERM escalation).
//   STUB_IGNORE_SIGTERM When "1", SIGTERM is ignored (to test SIGKILL).
//   STUB_READY_FILE   When set, this path is written once the signal handlers
//                     above are installed, so a signalling test can wait for the
//                     child to be ready rather than sleeping.
//   STUB_ARGV_FILE    When set, the process argv (JSON array) is written to this
//                     path, so a test can assert exactly how the driver invoked
//                     the CLI (subcommand, flags, and positional order).
//   STUB_PROBE_STDOUT When the `probe-host-key` subcommand is invoked, this raw
//                     string is written to stdout (so a test can feed a valid
//                     JSON line, a malformed line, or an oversized flood). When
//                     unset, a default valid line is emitted, so a driver spawned
//                     under the sanitized child env (which drops STUB_* vars) still
//                     gets a well-formed probe result. The probe branch honors
//                     STUB_EXIT_CODE, STUB_DELAY_MS, and STUB_IGNORE_SIGTERM, and
//                     never runs the exchange emulation.
//   STUB_FINGERPRINT_STDOUT
//                     When the `fingerprint` subcommand is invoked, this raw
//                     string is written to stdout. When unset a default canonical
//                     fingerprint line is emitted. The branch also CREATES the
//                     file named by --identity-file (and the one named by
//                     --export-certificate, when present) so the driver's
//                     created-vs-loaded read of the identity path is exercised
//                     against a file that really appears. It honors
//                     STUB_EXIT_CODE, STUB_DELAY_MS, and STUB_IGNORE_SIGTERM.
//   STUB_CWD_FILE     When set, the child's own process.cwd() is written to this
//                     path by the `fingerprint` branch, so a test can assert the
//                     directory the driver spawned the child in -- which is what
//                     decides whose ./psilink.yaml the real CLI would resolve.

import fs from "node:fs";

// The default probe line emitted when STUB_PROBE_STDOUT is unset (an all-A
// canonical fingerprint), so the probe route's round-trip is deterministic even
// when the driver's sanitized child env cannot include STUB_PROBE_STDOUT.
const DEFAULT_PROBE_LINE =
  JSON.stringify({
    fingerprint: "SHA256:" + "A".repeat(43),
    key_type: "ssh-ed25519",
  }) + "\n";

// The default fingerprint line emitted when STUB_FINGERPRINT_STDOUT is unset: a
// canonical 43-character unpadded base64url digest (the final character drawn
// from the aligned set the config schema requires).
const DEFAULT_FINGERPRINT_LINE = "B".repeat(42) + "A\n";

/** The value of a single `--flag=value` argv token, or undefined when absent. */
function flagValue(argv, flag) {
  const prefix = `${flag}=`;
  const token = argv.find((candidate) => candidate.startsWith(prefix));
  return token === undefined ? undefined : token.slice(prefix.length);
}

if (process.env.STUB_ARGV_FILE !== undefined)
  fs.writeFileSync(process.env.STUB_ARGV_FILE, JSON.stringify(process.argv));

function exitAfterDelay(code) {
  const delayMs = Number.parseInt(process.env.STUB_DELAY_MS ?? "0", 10);
  if (delayMs > 0) setTimeout(() => process.exit(code), delayMs);
  else process.exit(code);
}

// The probe-host-key subcommand the console's host-key probe driver spawns is
// self-contained: emit a chosen stdout line and exit, never touching the
// exchange emulation below. Honors STUB_IGNORE_SIGTERM so the watchdog SIGKILL
// escalation can be exercised.
if (process.argv[2] === "probe-host-key") {
  if (process.env.STUB_IGNORE_SIGTERM === "1")
    process.on("SIGTERM", () => {
      /* swallow: force escalation to SIGKILL */
    });
  process.stdout.write(process.env.STUB_PROBE_STDOUT ?? DEFAULT_PROBE_LINE);
  exitAfterDelay(Number.parseInt(process.env.STUB_EXIT_CODE ?? "0", 10));
} else if (process.argv[2] === "fingerprint") {
  if (process.env.STUB_IGNORE_SIGTERM === "1")
    process.on("SIGTERM", () => {
      /* swallow: force escalation to SIGKILL */
    });
  if (process.env.STUB_CWD_FILE !== undefined)
    fs.writeFileSync(process.env.STUB_CWD_FILE, process.cwd());
  const exitCode = Number.parseInt(process.env.STUB_EXIT_CODE ?? "0", 10);
  if (exitCode === 0) {
    // The real command creates the identity file (and the export) before it
    // prints, so the stub does too: the driver reads the identity path's presence
    // BEFORE spawning, and a second invocation must therefore see the file this
    // one left.
    const identityFile = flagValue(process.argv, "--identity-file");
    if (identityFile !== undefined)
      fs.writeFileSync(identityFile, JSON.stringify({ stub: "identity" }));
    const exportFile = flagValue(process.argv, "--export-certificate");
    if (exportFile !== undefined)
      fs.writeFileSync(exportFile, JSON.stringify({ stub: "certificate" }));
    process.stdout.write(
      process.env.STUB_FINGERPRINT_STDOUT ?? DEFAULT_FINGERPRINT_LINE,
    );
  }
  exitAfterDelay(exitCode);
} else {
  runExchangeStub();
}

function runExchangeStub() {
  // Write the result artifacts BEFORE the fd-3 events, so a terminal `result`
  // event implies the output/record/keys files are already on disk. This mirrors
  // the real CLI (whose result event means the result has been written) and lets a
  // test that waits for the terminal event read the files without racing the
  // child's write.
  if (process.env.STUB_OUTPUT_FILE !== undefined) {
    const outputPath = process.argv[process.argv.length - 1];
    fs.writeFileSync(outputPath, process.env.STUB_OUTPUT_FILE);
  }

  if (process.env.STUB_RECORD_JSON !== undefined) {
    const recordPath = recordFilePath(process.argv);
    if (recordPath !== undefined) {
      const keysPath = recordPath.endsWith(".json")
        ? recordPath.slice(0, -".json".length) + ".keys.json"
        : recordPath + ".keys.json";
      fs.writeFileSync(recordPath, process.env.STUB_RECORD_JSON);
      fs.writeFileSync(keysPath, JSON.stringify({ salts: {} }));
    }
  }

  if (process.env.STUB_FD3_RAW !== undefined)
    writeFd3(process.env.STUB_FD3_RAW);
  const events = JSON.parse(process.env.STUB_FD3_EVENTS ?? "[]");
  for (const event of events) writeFd3(JSON.stringify(event) + "\n");

  if (process.env.STUB_STDERR !== undefined)
    process.stderr.write(process.env.STUB_STDERR);
  if (process.env.STUB_STDOUT !== undefined)
    process.stdout.write(process.env.STUB_STDOUT);

  const exitCode = Number.parseInt(process.env.STUB_EXIT_CODE ?? "0", 10);

  if (process.env.STUB_IGNORE_SIGINT === "1")
    process.on("SIGINT", () => {
      /* swallow: force escalation to SIGTERM */
    });
  if (process.env.STUB_IGNORE_SIGTERM === "1")
    process.on("SIGTERM", () => {
      /* swallow: force escalation to SIGKILL */
    });

  // A default SIGINT/SIGTERM (not ignored above) exits with the conventional
  // signal code so the driver's cancellation classification can be exercised.
  if (process.env.STUB_IGNORE_SIGINT !== "1")
    process.on("SIGINT", () => process.exit(130));
  if (process.env.STUB_IGNORE_SIGTERM !== "1")
    process.on("SIGTERM", () => process.exit(143));

  // Written only once every handler above is installed, so a signalling test can
  // wait for the disposition it is exercising to actually be in place. Sleeping
  // instead races the child's startup: a signal delivered before registration
  // takes the DEFAULT action, so an ignore-and-escalate case silently becomes a
  // first-signal kill and the terminal holds the wrong code.
  if (process.env.STUB_READY_FILE !== undefined)
    fs.writeFileSync(process.env.STUB_READY_FILE, "ready");

  exitAfterDelay(exitCode);
}

function writeFd3(line) {
  try {
    fs.writeSync(3, line);
  } catch {
    // fd 3 not wired; ignore (mirrors the real CLI's fail-safe writer).
  }
}

// The driver passes --record-file as a two-token pair (the exchange form) or a
// single --record-file=<value> token (the zero-setup form, which uses the =value
// shape so a flag-shaped value cannot be misparsed); the real CLI's yargs accepts
// both, so the stub resolves both.
function recordFilePath(argv) {
  const flagIndex = argv.indexOf("--record-file");
  if (flagIndex !== -1 && flagIndex + 1 < argv.length)
    return argv[flagIndex + 1];
  const eqToken = argv.find((token) => token.startsWith("--record-file="));
  return eqToken === undefined
    ? undefined
    : eqToken.slice("--record-file=".length);
}
