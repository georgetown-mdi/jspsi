import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LEG_ENVIRONMENT_FAILURE } from "../liveWebrtc/legTypes.ts";
import { startCliInviter } from "../liveWebrtc/cliPeer.ts";

/**
 * The live CLI-to-browser WebRTC leg runs nightly against a browser, a broker
 * and the built CLI (test/liveWebrtc/liveExchange.test.ts). This drives the one
 * path of its Node half that needs none of the three: a party that cannot be
 * spawned at all, which the child raises as an `error` event rather than as an
 * exit code. With no listener for it, Node throws that event as an uncaught
 * exception and the run dies instead of reporting the environment failure.
 */
describe("the live WebRTC leg's CLI party", () => {
  let work: string;

  beforeEach(() => {
    work = mkdtempSync(path.join(tmpdir(), "psilink-cli-peer-"));
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("reports a spawn that does not happen as an environment failure", async () => {
    const entry = path.join(work, "index.js");
    writeFileSync(entry, "");
    const started = startCliInviter("ws://127.0.0.1:1/api", {
      executable: path.join(work, "node-that-is-not-installed"),
      entry,
    });

    await expect(started).rejects.toThrow(LEG_ENVIRONMENT_FAILURE);
    await expect(started).rejects.toThrow("could not be spawned");
    // The child's own message, which reaches the failure through the output the
    // leg accumulates.
    await expect(started).rejects.toThrow("ENOENT");
  });
});
