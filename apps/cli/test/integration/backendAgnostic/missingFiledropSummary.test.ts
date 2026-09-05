import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { buildCli } from "../../../src/cliParser";
import { captureProcessExit } from "../../exitCapture";
import { captureStdio } from "../../loggingTestSupport";

// A filedrop directory that is not there is the likeliest filedrop
// misconfiguration, and it is the run that never establishes a connection at
// all: every attempt the client makes is a dial that failed. The end-of-run
// summary must therefore report those attempts as retried dials, never as
// re-establishments -- which would tell the operator the link was flaky when
// the directory simply does not exist.
//
// Driven through the real parser (buildCli, the zero-setup command as `$0`)
// rather than runProtocol, because the operator's reading of it comes off the
// command line: the argv, the connection options it resolves, and the stderr
// the run leaves behind.

// Recognizable linkage columns, so the terms infer a linkage key and the run
// reaches the connection rather than being refused before it.
const INPUT_CSV = "FirstName,LastName,DOB\nJames,Heard,7/16/1975\n";

// One retry short of the default, so the run spends one 1-second retry delay
// instead of three and the asserted count is the flag's, not a default that
// could move.
const MAX_RECONNECT_ATTEMPTS = "1";

let work: string;
let exitSpy: ReturnType<typeof captureProcessExit> | undefined;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-missing-drop-"));
  exitSpy = captureProcessExit();
});

afterEach(() => {
  exitSpy?.mockRestore();
  exitSpy = undefined;
  try {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

test("a run that never connected reports its dials as retries, not re-establishments", async () => {
  const input = path.join(work, "in.csv");
  fs.writeFileSync(input, INPUT_CSV);
  // Never created: the directory the URL names must not exist when the run
  // opens it.
  const missing = path.join(work, "not-a-directory");

  const stdio = captureStdio();
  // The trapped exit unwinds through yargs, which reports an escaping error by
  // printing the usage banner and the throw itself to console.error; capture
  // both console halves so that harness noise stays out of the suite's output
  // and off the summary this test reads from the log sink.
  const consoleSpies = (["error", "log"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
  let exit = "";
  try {
    await buildCli([
      pathToFileURL(missing).href,
      input,
      path.join(work, "out.csv"),
      "--max-reconnect-attempts",
      MAX_RECONNECT_ATTEMPTS,
    ]).parseAsync();
  } catch (err) {
    exit = err instanceof Error ? err.message : String(err);
  } finally {
    for (const spy of consoleSpies) spy.mockRestore();
    stdio.restore();
  }

  const stderr = stdio.stderrWrites.join("");
  // The run failed on the missing directory itself, so what follows is that
  // failure's summary and not some earlier refusal's.
  expect(exit).toBe("exit:69");
  expect(stderr).toContain("cannot read/write filedrop directory");
  expect(stderr).toContain(missing);

  expect(stderr).toContain(
    "connecting was retried 1 time during this exchange",
  );
  expect(stderr).not.toContain("re-established");
});
