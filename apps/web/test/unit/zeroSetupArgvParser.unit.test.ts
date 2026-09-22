import fs from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { captureZeroSetupArgv, tempDataRoot } from "../utils/jobFixtures";

// The console's argv builder, checked without a CLI process: whether a card
// left at its default emits a token at all. The cases that ask what the real
// CLI's parser does with an emitted token live in
// apps/web/test/interop/zeroSetupArgvParser.test.ts instead (apps must not
// build or spawn the CLI from the unit project).

/** The connection portion of a filedrop zero-setup argv. A directory that does not
 * exist is by design: every case here fails at the input file, before the CLI opens
 * a transport, so no case can reach a network or a rendezvous. */
const RENDEZVOUS_URL = "file:///srv/jobs/abc/rendezvous";

/** The wait for a spawned child's terminal state here: generous next to the
 * stub's near-instant exit. */
const CHILD_EXIT_TIMEOUT_MS = 60_000;

/**
 * The budget for every test below: vitest's 5s default is the wrong scale,
 * since each spawns one real node child (the stub), where a sibling unit test
 * only calls a function.
 */
const SPAWN_TEST_TIMEOUT_MS = CHILD_EXIT_TIMEOUT_MS + 10_000;

const dirs: Array<string> = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

/** A scratch directory for one spawn, removed after the test. */
function scratchDir(label: string): string {
  const dir = tempDataRoot(label);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

describe(
  "the console's zero-setup argv omits tokens the operator left at their default",
  { timeout: SPAWN_TEST_TIMEOUT_MS },
  () => {
    test("the console emits no deduplicate token for the closed default", async () => {
      // A zero-setup run loads no configuration file for a flag to override, so
      // the unset flag and an explicit off select the same side; emitting one
      // would lengthen every graduated command line for nothing.
      const dir = scratchDir("zs-terms-default");
      const argv = await captureZeroSetupArgv({
        workdir: dir,
        connectionArgs: [RENDEZVOUS_URL],
        eventStream: true,
        deduplicate: false,
        timeoutMs: CHILD_EXIT_TIMEOUT_MS,
      });
      expect(argv).not.toContain("--deduplicate");
      expect(argv).not.toContain("--no-deduplicate");
    });

    test("the console emits no delimiter token where the operator chose none", async () => {
      // A zero-setup run loads no configuration file for a flag to override, so
      // an unset flag reads the comma the CLI reads by default.
      const dir = scratchDir("zs-delimiter-default");
      const argv = await captureZeroSetupArgv({
        workdir: dir,
        connectionArgs: [RENDEZVOUS_URL],
        eventStream: true,
        timeoutMs: CHILD_EXIT_TIMEOUT_MS,
      });
      expect(argv.some((token) => token.startsWith("--csv-delimiter"))).toBe(
        false,
      );
    });
  },
);
