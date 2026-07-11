import { dirname, join, resolve } from "node:path";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { chromium } from "playwright";

import {
  getFreePort,
  sleep,
  spawnProdServer,
  stopProdServer,
  waitForRoot,
} from "./prodServer.js";

import type { Browser } from "playwright";
import type { ChildProcess } from "node:child_process";

// The regression #307 fixed, guarded against return: PapaParse's `worker: true`
// self-hosted worker corrupted the CSV parse once Vite bundled and minified the app
// (dev and Vitest's real-Chromium tests both passed with the broken worker, so a
// dev-only test cannot catch it). This drives the REAL inviter bench flow -- the
// operator's name, a large CSV, and the spine through to Create -- against the app
// served from a production `vite build` (.output), so the parse runs through the
// Vite-native worker in the exact bundled/minified form #307's inline switch was
// forced by. A worker is created (page.on("worker")) and the invitation is produced
// with correct linkage terms, which only happens if the parse yielded a clean header
// -- the broken worker mis-applied the header and crashed invitation generation. The
// CSV is sized above CSV_WORKER_FILE_BYTE_THRESHOLD so the off-thread routing takes
// the worker rather than the inline fallback.
//
// Build-gated: the production entry exists only after `npm run build`. CI builds the
// web app before this suite (eb_build_and_test.yaml: "Build server" precedes the
// integration/browser step), so it runs there; a local `npm run test:integration`
// without a prior build skips it. A non-skipped LOCAL run tests whatever `.output`
// currently holds -- rebuild (`npm run build -w apps/web`) before re-running to
// validate a change; CI always rebuilds first.
const here = dirname(fileURLToPath(import.meta.url));
// apps/web/test/integration -> apps/web is two levels up.
const webRoot = resolve(here, "../..");
const prodEntry = resolve(webRoot, ".output/server/index.mjs");
const hasBuild = existsSync(prodEntry);

const READY_TIMEOUT_MS = 30_000;
const GENERATE_TIMEOUT_MS = 30_000;
// Budget for the app to hydrate before the invite interactions "stick". The page is
// server-rendered and hydrates asynchronously; an interaction landing before React
// attaches its handlers is lost, so the invite flow re-applies its inputs until the
// Continue button reflects them within this window.
const HYDRATION_TIMEOUT_MS = 20_000;

// A CSV comfortably above CSV_WORKER_FILE_BYTE_THRESHOLD (4 MiB), carrying columns
// that infer to default linkage keys so the invitation is producible. Duplicate rows
// are fine -- invitation generation parses and infers, it does not deduplicate.
function writeLargeCsv(dir: string): string {
  const header = "ssn,first_name,last_name,dob\n";
  const dataRow = "123456789,Alice,Smith,1990-01-02\n";
  const targetBytes = 5 * 1024 * 1024;
  const rows = Math.ceil(targetBytes / dataRow.length);
  const path = join(dir, "large.csv");
  writeFileSync(path, header + dataRow.repeat(rows));
  return path;
}

describe.skipIf(!hasBuild)(
  "the production bundle parses a large CSV through the Vite-native worker",
  () => {
    let child: ChildProcess | undefined;
    let browser: Browser | undefined;
    let tempDir: string | undefined;
    let port = 0;

    beforeAll(async () => {
      tempDir = mkdtempSync(join(tmpdir(), "psilink-csv-worker-"));
      port = await getFreePort();
      const { child: proc, getLaunchError } = await spawnProdServer(
        prodEntry,
        webRoot,
        port,
      );
      child = proc;

      await waitForRoot(`http://127.0.0.1:${port}/`, proc, getLaunchError);
      browser = await chromium.launch({ headless: true });
    }, READY_TIMEOUT_MS + 20_000);

    afterAll(async () => {
      await browser?.close();
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
      await stopProdServer(child);
    });

    test(
      "a large CSV parses off-thread and the invitation is generated",
      async () => {
        if (browser === undefined || tempDir === undefined)
          throw new Error("browser/tempDir not initialized");
        const csvPath = writeLargeCsv(tempDir);
        const page = await browser.newPage();
        try {
          // Record the URL of every Web Worker the page constructs. Asserting on the
          // CSV parse worker's own bundled-asset URL (not merely that some worker
          // fired) is what proves the Vite-native worker -- and not the inline
          // fallback or an unrelated worker -- actually ran in the production build:
          // Vite emits it as `csvParse.worker-<hash>.js`, so its URL carries that name.
          const workerUrls: Array<string> = [];
          page.on("worker", (worker) => workerUrls.push(worker.url()));

          // Step 1 of the inviter spine ("Your file") lives on the served /exchange
          // route.
          await page.goto(`http://127.0.0.1:${port}/exchange`, {
            waitUntil: "load",
            timeout: GENERATE_TIMEOUT_MS,
          });

          // Re-apply the name and file until Continue enables, then walk the spine.
          // The page is server-rendered and hydrates asynchronously; an interaction
          // that lands before React attaches its handlers is lost -- a controlled
          // field re-renders from empty state and the file input's change event is
          // dropped -- leaving Continue disabled. That is the race that flaked this
          // deploy under CI load. `load` only guarantees the bundle fetched, not that
          // hydration ran, so the real fix is to re-apply both inputs until the button
          // reflects them: an enabled button IS the hydration signal. Each action is
          // short-bounded so one stuck call cannot overrun the loop's own deadline
          // (its 30s default would).
          const ACTION_TIMEOUT_MS = 5_000;
          const nameField = page.getByLabel("Your name");
          const fileInput = page.locator('input[type="file"]').first();
          const continueToColumns = page.getByRole("button", {
            name: "Continue to matching & sharing",
          });
          const enableDeadline = Date.now() + HYDRATION_TIMEOUT_MS;
          for (;;) {
            await nameField.fill("Prod Worker Test", {
              timeout: ACTION_TIMEOUT_MS,
            });
            await fileInput.setInputFiles(csvPath, {
              timeout: ACTION_TIMEOUT_MS,
            });
            if (
              await continueToColumns.isEnabled({ timeout: ACTION_TIMEOUT_MS })
            )
              break;
            if (Date.now() >= enableDeadline) {
              // Distinguish a hydration stall from a real rejection (the accept filter,
              // the 100 MB cap, or a broken name/file binding) so the failure is
              // diagnosable rather than a bare "still disabled": report whether the file
              // registered in the dropzone and the button's disabled attribute.
              const fileShown =
                (await page.getByText("large.csv", { exact: false }).count()) >
                0;
              const disabledAttr =
                await continueToColumns.getAttribute("disabled");
              throw new Error(
                `Continue to matching & sharing stayed disabled after ${HYDRATION_TIMEOUT_MS}ms ` +
                  `(file shown in dropzone: ${fileShown}, disabled attr: ${disabledAttr}); ` +
                  "the invite interactions may not have hydrated, or the file was rejected",
              );
            }
            await sleep(200);
          }
          await continueToColumns.click();

          // Step 2 ("Matching & sharing") derives recommended terms from the file's
          // columns; step 3 restates them for review. Neither needs edits here -- the
          // large CSV's header/dob/ssn columns infer to default linkage keys -- so
          // advance straight through both.
          await page
            .getByRole("button", { name: "Continue to review & create" })
            .click();
          await page
            .getByRole("heading", { name: "Review & create", level: 1 })
            .waitFor({ state: "visible", timeout: GENERATE_TIMEOUT_MS });

          // Create mints the invitation on the default browser transport, which
          // starts listening for the partner immediately -- no partner is needed for
          // the share surface to render.
          await page
            .getByRole("button", { name: "Create the invitation" })
            .click();

          // The share block appears only after generateInvitation resolves, which
          // requires a clean parse (a corrupted header crashes generation). Its
          // presence is the success signal.
          await page
            .getByRole("heading", { name: "Share this invitation" })
            .waitFor({ state: "visible", timeout: GENERATE_TIMEOUT_MS });

          // The deep link carries the accept route and the encoded token in its
          // fragment, further confirming a real invitation was minted from the parse.
          const deepLink = await page
            .getByText("/accept#", { exact: false })
            .first()
            .textContent();
          expect(deepLink).toContain("/accept#");

          expect(workerUrls.some((url) => url.includes("csvParse"))).toBe(true);
        } finally {
          await page.close();
        }
      },
      // Cover the four bounded phases serially -- goto (<= GENERATE_TIMEOUT_MS), the
      // enable loop (<= HYDRATION_TIMEOUT_MS), the Review & create heading wait
      // (<= GENERATE_TIMEOUT_MS), and the share-block wait (<= GENERATE_TIMEOUT_MS)
      // -- plus margin, so a slow phase surfaces its own error rather than a bare
      // per-test timeout.
      GENERATE_TIMEOUT_MS * 3 + HYDRATION_TIMEOUT_MS + 20_000,
    );
  },
);
