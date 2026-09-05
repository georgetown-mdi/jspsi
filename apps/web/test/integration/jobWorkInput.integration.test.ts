import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { getDefaultLinkageTerms } from "@psilink/core";

import {
  getFreePort,
  hasBuild,
  spawnProdServer,
  stopProdServer,
  waitForRoot,
  webRoot,
} from "./prodServer.js";

import type { ChildProcess } from "node:child_process";

// The mounted-input drive path, against the real built server: a job can be
// driven from an operator-mounted directory with no UI -- a single POST
// names a mounted file and the CLI reads it in place, so no input.csv is
// copied into the workdir. The job API runs only in a console build, so the
// server sets VITE_DEPLOYMENT_PROFILE=console and stubs the CLI; a filedrop
// job needs JOB_RENDEZVOUS_DIR for its rendezvous mount.
const stubCli = resolve(webRoot, "test/utils/stubCli.mjs");

const READY_TIMEOUT_MS = 30_000;

const VALID_SHARED_SECRET = "A".repeat(43);
const SOURCE_CSV =
  "ssn,last_name,date_of_birth\n111223333,smith,1990-01-01\n" +
  "222334444,jones,1985-11-30\n";

describe.skipIf(!hasBuild)(
  "a job is driven from a mounted work input with no UI",
  () => {
    let child: ChildProcess | undefined;
    let dataRoot: string | undefined;
    let inputDir: string | undefined;
    let rendezvousDir: string | undefined;
    let scratchDir: string | undefined;
    let port = 0;

    beforeAll(async () => {
      dataRoot = mkdtempSync(join(tmpdir(), "psilink-wp2-data-"));
      inputDir = mkdtempSync(join(tmpdir(), "psilink-wp2-input-"));
      rendezvousDir = mkdtempSync(join(tmpdir(), "psilink-wp2-rdv-"));
      // The built server runs as an ordinary user here, so relocate the
      // pasted-credential scratch dir off the root-owned default it uses in-image.
      scratchDir = mkdtempSync(join(tmpdir(), "psilink-wp2-cred-"));
      writeFileSync(join(inputDir, "mounted.csv"), SOURCE_CSV);

      port = await getFreePort();
      const { child: proc, getLaunchError } = await spawnProdServer(port, {
        VITE_DEPLOYMENT_PROFILE: "console",
        JOB_DATA_ROOT: dataRoot,
        JOB_INPUT_DIR: inputDir,
        JOB_RENDEZVOUS_DIR: rendezvousDir,
        JOB_SFTP_CREDENTIAL_DIR: scratchDir,
        JOB_CLI_BINARY: stubCli,
      });
      child = proc;
      await waitForRoot(`http://127.0.0.1:${port}/`, proc, getLaunchError);
    }, READY_TIMEOUT_MS + 10_000);

    afterAll(async () => {
      await stopProdServer(child);
      if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
      if (inputDir) rmSync(inputDir, { recursive: true, force: true });
      if (rendezvousDir)
        rmSync(rendezvousDir, { recursive: true, force: true });
      if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
    });

    test("POST /api/jobs with an inputFile reference reads the mount in place", async () => {
      if (dataRoot === undefined || inputDir === undefined)
        throw new Error("fixtures not initialized");
      const intent = {
        channel: "filedrop",
        linkageTerms: {
          ...getDefaultLinkageTerms("wp2-smoke"),
          date: "2026-07-18",
        },
        sharedSecret: VALID_SHARED_SECRET,
        inputFile: { name: "mounted.csv" },
      };

      const response = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(intent),
      });
      expect(response.status).toBe(201);
      const { id } = (await response.json()) as { id: string };
      expect(typeof id).toBe("string");

      // The CLI reads the mounted file in place, so nothing is copied into the
      // workdir: no input.csv appears alongside the job's other artifacts.
      expect(existsSync(join(dataRoot, id, "input.csv"))).toBe(false);

      await fetch(`http://127.0.0.1:${port}/api/jobs/${id}`, {
        method: "DELETE",
      });
    });
  },
);
