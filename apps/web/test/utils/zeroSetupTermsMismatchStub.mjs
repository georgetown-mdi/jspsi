// A stub psilink CLI that emulates a zero-setup terms mismatch: it emits the CLI's
// terminal `error` fd-3 event (category config) and exits non-zero, so an
// integration test driving the REAL built server can assert the mismatch surfaces
// as a failed job. Unconditional and env-free by design: the built server spawns
// the CLI with a sanitized environment that drops the shared stub's STUB_*
// configuration variables, so this scenario is baked into a dedicated binary the
// server is pointed at via JOB_CLI_BINARY rather than configured per run.

import fs from "node:fs";

try {
  fs.writeSync(
    3,
    JSON.stringify({
      v: 1,
      type: "error",
      category: "config",
      message: "linkage terms do not match the partner's inferred terms",
    }) + "\n",
  );
} catch {
  // fd 3 not wired; ignore (mirrors the real CLI's fail-safe writer).
}

process.exit(69);
