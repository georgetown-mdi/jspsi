import { dirname, join, resolve } from "node:path";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { getDefaultLinkageTerms } from "@psilink/core";

import {
  getFreePort,
  spawnProdServer,
  stopProdServer,
  waitForRoot,
} from "./prodServer.js";

import type { ChildProcess } from "node:child_process";

// The WP2 claim, demonstrated once against the REAL built server: after the intent
// gains an inputFile reference and the manager snapshot-copies it, a job can be
// driven from an operator-mounted directory with no UI -- a single authenticated
// POST names a mounted file and the server writes the fixed workdir input.csv from
// it. The job API is loopback-gated with no token, so the loopback fetch is
// permitted; the CLI is stubbed so no real exchange (or built CLI) is needed -- the
// input.csv is written before the child spawns, so its bytes are the assertion.
//
// Build-gated exactly like csvWorkerProd: the production entry exists only after
// `npm run build -w apps/web`. CI builds the web app before the integration step,
// so it runs there; a local run without a prior build skips it.
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../..");
const prodEntry = resolve(webRoot, ".output/server/index.mjs");
const hasBuild = existsSync(prodEntry);
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
    let port = 0;

    beforeAll(async () => {
      dataRoot = mkdtempSync(join(tmpdir(), "psilink-wp2-data-"));
      inputDir = mkdtempSync(join(tmpdir(), "psilink-wp2-input-"));
      writeFileSync(join(inputDir, "mounted.csv"), SOURCE_CSV);

      port = await getFreePort();
      const { child: proc, getLaunchError } = await spawnProdServer(
        prodEntry,
        webRoot,
        port,
        {
          JOB_DATA_ROOT: dataRoot,
          JOB_INPUT_DIR: inputDir,
          JOB_CLI_BINARY: stubCli,
        },
      );
      child = proc;
      await waitForRoot(`http://127.0.0.1:${port}/`, proc, getLaunchError);
    }, READY_TIMEOUT_MS + 10_000);

    afterAll(async () => {
      await stopProdServer(child);
      if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
      if (inputDir) rmSync(inputDir, { recursive: true, force: true });
    });

    test("POST /api/jobs with an inputFile reference writes input.csv from the mount", async () => {
      if (dataRoot === undefined || inputDir === undefined)
        throw new Error("fixtures not initialized");
      const stat = statSync(join(inputDir, "mounted.csv"));
      const intent = {
        channel: "filedrop",
        linkageTerms: {
          ...getDefaultLinkageTerms("wp2-smoke"),
          date: "2026-07-18",
        },
        sharedSecret: VALID_SHARED_SECRET,
        inputFile: {
          name: "mounted.csv",
          sizeBytes: stat.size,
          modifiedAt: Math.trunc(stat.mtimeMs),
        },
      };

      const response = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(intent),
      });
      expect(response.status).toBe(201);
      const { id } = (await response.json()) as { id: string };
      expect(typeof id).toBe("string");

      // The snapshot copy is written synchronously before the CLI spawns, so the
      // fixed workdir input.csv holds the mounted file's exact bytes.
      const inputCsv = readFileSync(join(dataRoot, id, "input.csv"), "utf8");
      expect(inputCsv).toBe(SOURCE_CSV);

      await fetch(`http://127.0.0.1:${port}/api/jobs/${id}`, {
        method: "DELETE",
      });
    });
  },
);
