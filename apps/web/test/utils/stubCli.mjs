// A stub psilink CLI the job-driver tests point the driver at via the
// JOB_CLI_BINARY override. It emulates the parts of the real CLI the driver
// depends on: it can emit chosen fd-3 NDJSON events, write an output file, exit
// with a chosen code, and honor or ignore an interrupt signal -- all configured
// through environment variables so a test can drive one binary through many
// scenarios without a separate script per case.
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

import fs from "node:fs";

function writeFd3(line) {
  try {
    fs.writeSync(3, line);
  } catch {
    // fd 3 not wired; ignore (mirrors the real CLI's fail-safe writer).
  }
}

if (process.env.STUB_FD3_RAW !== undefined) writeFd3(process.env.STUB_FD3_RAW);
const events = JSON.parse(process.env.STUB_FD3_EVENTS ?? "[]");
for (const event of events) writeFd3(JSON.stringify(event) + "\n");

if (process.env.STUB_STDERR !== undefined)
  process.stderr.write(process.env.STUB_STDERR);
if (process.env.STUB_STDOUT !== undefined)
  process.stdout.write(process.env.STUB_STDOUT);

if (process.env.STUB_OUTPUT_FILE !== undefined) {
  const outputPath = process.argv[process.argv.length - 1];
  fs.writeFileSync(outputPath, process.env.STUB_OUTPUT_FILE);
}

if (process.env.STUB_RECORD_JSON !== undefined) {
  const flagIndex = process.argv.indexOf("--record-file");
  if (flagIndex !== -1 && flagIndex + 1 < process.argv.length) {
    const recordPath = process.argv[flagIndex + 1];
    const keysPath = recordPath.endsWith(".json")
      ? recordPath.slice(0, -".json".length) + ".keys.json"
      : recordPath + ".keys.json";
    fs.writeFileSync(recordPath, process.env.STUB_RECORD_JSON);
    fs.writeFileSync(keysPath, JSON.stringify({ salts: {} }));
  }
}

const exitCode = Number.parseInt(process.env.STUB_EXIT_CODE ?? "0", 10);
const delayMs = Number.parseInt(process.env.STUB_DELAY_MS ?? "0", 10);

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

if (delayMs > 0) {
  setTimeout(() => process.exit(exitCode), delayMs);
} else {
  process.exit(exitCode);
}
