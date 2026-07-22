import { dirname, join, resolve } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  getFreePort,
  spawnProdServer,
  stopProdServer,
  waitForRoot,
} from "./prodServer.js";

import type { ChildProcess } from "node:child_process";

// The zero-setup (Direct exchange) drive path, demonstrated against the REAL built
// server: a `mode: "zeroSetup"` intent creates a job the server drives with the CLI's
// literal positional `$0` form -- no shared secret, no linkage terms, no composed
// config or key file. The job API runs only in a console build, so the server env
// sets VITE_DEPLOYMENT_PROFILE=console alongside the data root, and a filedrop
// zero-setup composes its connection against the configured rendezvous mount, so
// JOB_RENDEZVOUS_DIR is set. The CLI is stubbed with a binary that emulates a terms
// mismatch (an error fd-3 event and a non-zero exit), so the run surfaces as a failed
// job -- the failure the two parties see when their inferred terms disagree -- with no
// real exchange or built CLI required.
//
// Build-gated exactly like jobWorkInput: the production entry exists only after
// `npm run build -w apps/web`. CI builds the web app before the integration step, so
// it runs there; a local run without a prior build skips it.
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../..");
const prodEntry = resolve(webRoot, ".output/server/index.mjs");
const hasBuild = existsSync(prodEntry);
const termsMismatchStub = resolve(
  webRoot,
  "test/utils/zeroSetupTermsMismatchStub.mjs",
);

const READY_TIMEOUT_MS = 30_000;

const SOURCE_CSV =
  "ssn,last_name,date_of_birth\n111223333,smith,1990-01-01\n" +
  "222334444,jones,1985-11-30\n";

/** Poll the job status endpoint until it leaves `running`, or the deadline. */
async function waitForJobStatus(
  port: number,
  id: string,
  deadlineMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const response = await fetch(`http://127.0.0.1:${port}/api/jobs/${id}`);
    if (response.ok) {
      const body = (await response.json()) as { status?: string };
      if (body.status !== undefined && body.status !== "running")
        return body.status;
    } else {
      await response.body?.cancel();
    }
    if (Date.now() >= deadline)
      throw new Error("job did not reach a terminal status in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!hasBuild)(
  "a zero-setup job is driven through the real server with no config or key",
  () => {
    let child: ChildProcess | undefined;
    let dataRoot: string | undefined;
    let rendezvousDir: string | undefined;
    let scratchDir: string | undefined;
    let port = 0;

    beforeAll(async () => {
      dataRoot = mkdtempSync(join(tmpdir(), "psilink-zs-data-"));
      rendezvousDir = mkdtempSync(join(tmpdir(), "psilink-zs-rdv-"));
      // The built server runs as an ordinary user here, so relocate the
      // pasted-credential scratch dir off the root-owned default it uses in-image.
      scratchDir = mkdtempSync(join(tmpdir(), "psilink-zs-cred-"));

      port = await getFreePort();
      const { child: proc, getLaunchError } = await spawnProdServer(
        prodEntry,
        webRoot,
        port,
        {
          VITE_DEPLOYMENT_PROFILE: "console",
          JOB_DATA_ROOT: dataRoot,
          JOB_RENDEZVOUS_DIR: rendezvousDir,
          JOB_SFTP_CREDENTIAL_DIR: scratchDir,
          JOB_CLI_BINARY: termsMismatchStub,
        },
      );
      child = proc;
      await waitForRoot(`http://127.0.0.1:${port}/`, proc, getLaunchError);
    }, READY_TIMEOUT_MS + 10_000);

    afterAll(async () => {
      await stopProdServer(child);
      if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
      if (rendezvousDir)
        rmSync(rendezvousDir, { recursive: true, force: true });
      if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
    });

    test("POST mode:zeroSetup runs, skips config/key, and surfaces a terms mismatch", async () => {
      if (dataRoot === undefined) throw new Error("fixtures not initialized");
      const intent = {
        mode: "zeroSetup",
        channel: "filedrop",
        inputCsv: SOURCE_CSV,
        eventStream: true,
      };

      const response = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(intent),
      });
      expect(response.status).toBe(201);
      const { id } = (await response.json()) as { id: string };
      expect(typeof id).toBe("string");

      // A zero-setup job composes no config document and no key file: the workdir
      // holds only the inline input, never psilink.yaml or .psilink.key.
      expect(existsSync(join(dataRoot, id, "psilink.yaml"))).toBe(false);
      expect(existsSync(join(dataRoot, id, ".psilink.key"))).toBe(false);
      expect(existsSync(join(dataRoot, id, "input.csv"))).toBe(true);

      // The terms mismatch surfaces as a failed job, and its error event replays
      // on the SSE stream (which closes after the terminal event).
      const status = await waitForJobStatus(port, id);
      expect(status).toBe("failed");

      const events = await fetch(
        `http://127.0.0.1:${port}/api/jobs/${id}/events`,
        { headers: { Accept: "text/event-stream" } },
      );
      const stream = await events.text();
      expect(stream).toContain("do not match");

      await fetch(`http://127.0.0.1:${port}/api/jobs/${id}`, {
        method: "DELETE",
      });
    });
  },
);
