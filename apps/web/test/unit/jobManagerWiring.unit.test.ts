import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  JobRendezvousRetainRequiredError,
  JobRendezvousUnavailableError,
} from "@jobs/jobManager";
import { useJobManager } from "@jobs/index";

import { STUB_CLI_PATH, tempDataRoot, validIntent } from "../utils/jobFixtures";

import type { JobManager } from "@jobs/jobManager";

// What the process-wide manager is CONSTRUCTED with, as the environment resolves
// it. Every other job suite hands JobManager its options directly, so this is the
// one place the env-to-manager step itself is driven: a provisioning fault that
// resolved correctly and then never reached the manager would leave every filedrop
// create running against a layout the console already knows is incoherent.

const dirs: Array<string> = [];

/** A created directory registered for cleanup. */
function madeDir(label: string): string {
  const dir = tempDataRoot(label);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

/** The retain trio a split rendezvous requires, as the console's file-handling card
 * resolves it. */
const RETAIN_OPTIONS = {
  retainFiles: true,
  timestampInFilename: true,
  locklessRendezvous: true,
};

/**
 * Enable the job API over a split rendezvous pair and return the manager the
 * environment builds. The outbound leg is the caller's, so a pair the provisioning
 * refuses and one it accepts are the same call with a different mount.
 */
function managerForSplit(outboundDir: string, inboundDir: string): JobManager {
  vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
  vi.stubEnv("JOB_DATA_ROOT", madeDir("wiring-data"));
  vi.stubEnv("JOB_RENDEZVOUS_DIR", inboundDir);
  vi.stubEnv("JOB_RENDEZVOUS_OUTBOUND_DIR", outboundDir);
  vi.stubEnv("JOB_CLI_BINARY", STUB_CLI_PATH);
  const manager = useJobManager();
  expect(manager).not.toBeNull();
  return manager!;
}

afterEach(() => {
  const globals = globalThis as {
    jobManagerInstance?: JobManager;
    jobRendezvousProvisioning?: unknown;
    jobInputDirConfig?: unknown;
    jobSecretsDirConfig?: unknown;
  };
  globals.jobManagerInstance?.shutdown();
  globals.jobManagerInstance = undefined;
  globals.jobRendezvousProvisioning = undefined;
  globals.jobInputDirConfig = undefined;
  globals.jobSecretsDirConfig = undefined;
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("the manager the environment builds", () => {
  test("holds the resolved rendezvous problem, so a filedrop create is refused", async () => {
    // An outbound leg inside the inbound one: the provisioning refuses the pair,
    // and the intent holds the retain trio, so the refusal that lands can only be
    // the problem the manager was constructed with.
    const inbound = madeDir("wiring-inbound");
    const manager = managerForSplit(path.join(inbound, "outgoing"), inbound);
    await expect(
      manager.createJob(validIntent({ options: RETAIN_OPTIONS })),
    ).rejects.toBeInstanceOf(JobRendezvousUnavailableError);
  });

  test("holds no problem for a coherent pair, so the create reaches the retain gate", async () => {
    // The same call with the outbound leg mounted beside the inbound one. The
    // create is refused for the retain mode a split pair requires -- a refusal
    // reachable only PAST the problem gate, so it is what says the coherent
    // provisioning reached the manager as one.
    const manager = managerForSplit(
      madeDir("wiring-outbound"),
      madeDir("wiring-inbound"),
    );
    await expect(manager.createJob(validIntent())).rejects.toBeInstanceOf(
      JobRendezvousRetainRequiredError,
    );
  });
});
