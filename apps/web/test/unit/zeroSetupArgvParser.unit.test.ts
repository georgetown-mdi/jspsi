import { afterEach, describe, expect, test } from "vitest";

import {
  CHILD_EXIT_TIMEOUT_MS,
  RENDEZVOUS_URL,
  captureZeroSetupArgv,
  trackScratchDirs,
} from "../utils/jobFixtures";

// The console's argv builder, checked without a CLI process: whether a card
// left at its default emits a token at all. The cases that ask what the real
// CLI's parser does with an emitted token live in
// apps/web/test/interop/zeroSetupArgvParser.test.ts instead (apps must not
// build or spawn the CLI from the unit project).

/**
 * The budget for every test below: vitest's 5s default is the wrong scale,
 * since each spawns one real node child (the stub), where a sibling unit test
 * only calls a function.
 */
const SPAWN_TEST_TIMEOUT_MS = CHILD_EXIT_TIMEOUT_MS + 10_000;

const { scratchDir, cleanup } = trackScratchDirs();

afterEach(cleanup);

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
