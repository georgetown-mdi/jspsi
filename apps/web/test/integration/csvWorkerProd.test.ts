import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { chromium } from "playwright";

import {
  getFreePort,
  hasBuild,
  spawnProdServer,
  stopProdServer,
  waitForRoot,
} from "./prodServer.js";

import type { Browser, FileChooser } from "playwright";
import type { ChildProcess } from "node:child_process";

// PapaParse's `worker: true` self-hosted worker corrupted the CSV parse once
// Vite bundled and minified the app; only a production build catches it, since
// dev and Vitest's real-Chromium tests both passed with the broken worker. This
// drives the real inviter bench flow against a `vite build` (.output), with a
// CSV sized above CSV_WORKER_FILE_BYTE_THRESHOLD so parsing routes off-thread.
// Rebuild (`npm run build -w apps/web`) before re-running; CI always rebuilds
// first.

const READY_TIMEOUT_MS = 30_000;
// The phases that wait on real work: the bundle fetch, the off-thread parse, and
// the invitation mint.
const GENERATE_TIMEOUT_MS = 30_000;
// The spine steps between those, which are re-renders off state the app already
// holds.
const SPINE_TIMEOUT_MS = 15_000;
// Budget for the app to hydrate before the dropzone answers a click.
const HYDRATION_TIMEOUT_MS = 20_000;
// One hydration probe: click the dropzone and see whether a file chooser opens.
const CHOOSER_PROBE_TIMEOUT_MS = 2_000;
// Bound for an individual page action, so one stuck call cannot eat the budget
// of the loop it sits in (playwright's 30s default would).
const ACTION_TIMEOUT_MS = 5_000;

// A CSV comfortably above CSV_WORKER_FILE_BYTE_THRESHOLD (4 MiB), with columns
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
      const { child: proc, getLaunchError } = await spawnProdServer(port);
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
          // fallback or an unrelated worker -- ran in the production build: Vite
          // emits it as `csvParse.worker-<hash>.js`, so its URL includes that name.
          const workerUrls: Array<string> = [];
          page.on("worker", (worker) => workerUrls.push(worker.url()));

          // Step 1 of the inviter spine ("Your file") lives on the served /exchange
          // route.
          await page.goto(`http://127.0.0.1:${port}/exchange`, {
            waitUntil: "load",
            timeout: GENERATE_TIMEOUT_MS,
          });

          // Supply the CSV through the dropzone's own file chooser, retrying only
          // the click that opens it: `load` guarantees the bundle fetched, not
          // that hydration ran, and a file set before React attaches its change
          // handler is lost, with no recovery from re-setting the same path. The
          // click alone gates itself -- the chooser opens only once the handler
          // is attached, so its opening IS hydration, and the file is applied
          // exactly once, after it.
          const dropzone = page.getByLabel("Your data file");
          let chooser: FileChooser | undefined;
          try {
            await vi.waitFor(
              async () => {
                const opened = await Promise.all([
                  page.waitForEvent("filechooser", {
                    timeout: CHOOSER_PROBE_TIMEOUT_MS,
                  }),
                  dropzone.click({ timeout: ACTION_TIMEOUT_MS }),
                ]);
                chooser = opened[0];
              },
              { timeout: HYDRATION_TIMEOUT_MS, interval: 200 },
            );
          } catch (err) {
            throw new Error(
              `the dropzone opened no file chooser within ${HYDRATION_TIMEOUT_MS}ms ` +
                `(last failure: ${err instanceof Error ? err.message : String(err)}); ` +
                "the page's interactions have not hydrated",
            );
          }
          if (chooser === undefined)
            throw new Error("no file chooser was captured");
          await chooser.setFiles(csvPath);

          // The file card shows the parsed row count, so it renders only once the
          // off-thread parse has landed -- the one signal that separates a parse
          // that never finished from a Continue button held back by something else.
          try {
            await page
              .getByText("large.csv", { exact: false })
              .first()
              .waitFor({ state: "visible", timeout: GENERATE_TIMEOUT_MS });
          } catch (err) {
            throw new Error(
              `the dropzone showed no parsed file within ${GENERATE_TIMEOUT_MS}ms ` +
                `(last failure: ${err instanceof Error ? err.message : String(err)}); ` +
                "the parse did not land, or the file was rejected by the accept " +
                "filter or the size cap",
            );
          }

          // Hydration is proven by now, so one fill sticks: a controlled field only
          // loses its value to the hydrating re-render that precedes it.
          await page
            .getByLabel("Your name")
            .fill("Prod Worker Test", { timeout: ACTION_TIMEOUT_MS });

          await page
            .getByRole("button", { name: "Continue to matching & sharing" })
            .click({ timeout: SPINE_TIMEOUT_MS });

          // Step 2 ("Matching & sharing") derives recommended terms from the file's
          // columns; step 3 restates them for review. Neither needs edits here -- the
          // large CSV's header/dob/ssn columns infer to default linkage keys -- so
          // advance straight through both.
          await page
            .getByRole("button", { name: "Continue to review & create" })
            .click({ timeout: SPINE_TIMEOUT_MS });
          await page
            .getByRole("heading", { name: "Review & create", level: 1 })
            .waitFor({ state: "visible", timeout: SPINE_TIMEOUT_MS });

          // Create mints the invitation on the default browser transport, which
          // starts listening for the partner immediately -- no partner is needed for
          // the share surface to render.
          await page
            .getByRole("button", { name: "Create the invitation" })
            .click({ timeout: SPINE_TIMEOUT_MS });

          // The share block appears only after generateInvitation resolves, which
          // requires a clean parse (a corrupted header crashes generation). Its
          // presence is the success signal.
          await page
            .getByRole("heading", { name: "Share this invitation" })
            .waitFor({ state: "visible", timeout: GENERATE_TIMEOUT_MS });

          // The deep link has the accept route and the encoded token in its
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
      // Cover every bounded phase serially, so a slow one reports its own error
      // rather than a bare per-test timeout: goto, the parsed-file wait, and the
      // share-block wait at GENERATE_TIMEOUT_MS each; the chooser loop at
      // HYDRATION_TIMEOUT_MS plus the one iteration in flight when the deadline
      // passes (a chooser probe and a click); the name fill; and the four spine
      // steps at SPINE_TIMEOUT_MS each. Plus margin.
      GENERATE_TIMEOUT_MS * 3 +
        HYDRATION_TIMEOUT_MS +
        CHOOSER_PROBE_TIMEOUT_MS +
        ACTION_TIMEOUT_MS * 2 +
        SPINE_TIMEOUT_MS * 4 +
        20_000,
    );
  },
);
