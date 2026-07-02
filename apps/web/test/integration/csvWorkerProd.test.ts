import { dirname, join, resolve } from "node:path";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { chromium } from "playwright";

import type { Browser } from "playwright";
import type { ChildProcess } from "node:child_process";

// The regression #307 fixed, guarded against return: PapaParse's `worker: true`
// self-hosted worker corrupted the CSV parse once Vite bundled and minified the app
// (dev and Vitest's real-Chromium tests both passed with the broken worker, so a
// dev-only test cannot catch it). This drives the REAL invite flow -- name, a large
// CSV, Generate -- against the app served from a production `vite build` (.output),
// so the parse runs through the Vite-native worker in the exact bundled/minified form
// #307's inline switch was forced by. A worker is created (page.on("worker")) and the
// invitation is produced with correct linkage terms, which only happens if the parse
// yielded a clean header -- the broken worker mis-applied the header and crashed
// invitation generation. The CSV is sized above CSV_WORKER_FILE_BYTE_THRESHOLD so the
// off-thread routing takes the worker rather than the inline fallback.
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
const STOP_TIMEOUT_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Ask the OS for a free loopback TCP port so this server never collides with the
 * shared globalSetup dev server. Mirrors prodSignaling.test.ts. */
function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address !== "object" || address === null) {
        probe.close(() =>
          reject(new Error("could not determine a free port from the probe")),
        );
        return;
      }
      const port = address.port;
      probe.close(() => resolvePort(port));
    });
  });
}

async function httpAccepts(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForRoot(
  url: string,
  proc: ChildProcess,
  getLaunchError: () => Error | undefined,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const launchError = getLaunchError();
    if (launchError) throw launchError;
    if (proc.exitCode !== null || proc.signalCode !== null)
      throw new Error(
        `production server exited before becoming ready ` +
          `(code ${proc.exitCode}, signal ${proc.signalCode})`,
      );
    if (await httpAccepts(url, 1_000)) return;
    if (Date.now() >= deadline)
      throw new Error(`production server did not answer ${url} in time`);
    await sleep(250);
  }
}

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
    let launchError: Error | undefined;

    beforeAll(async () => {
      tempDir = mkdtempSync(join(tmpdir(), "psilink-csv-worker-"));
      port = await getFreePort();
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PORT: String(port),
        NITRO_HOST: "127.0.0.1",
      };
      const proc = spawn("node", [prodEntry], {
        cwd: webRoot,
        env,
        detached: true,
        stdio: "ignore",
      });
      child = proc;
      proc.unref();
      proc.on("error", (err) => {
        launchError = err;
      });
      await new Promise<void>((r) => setImmediate(r));
      if (launchError) throw launchError;

      await waitForRoot(`http://127.0.0.1:${port}/`, proc, () => launchError);
      browser = await chromium.launch({ headless: true });
    }, READY_TIMEOUT_MS + 20_000);

    afterAll(async () => {
      await browser?.close();
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });

      const c = child;
      if (
        !c ||
        c.pid === undefined ||
        c.exitCode !== null ||
        c.signalCode !== null
      )
        return;
      const pid = c.pid;
      c.ref();
      await new Promise<void>((resolveStop) => {
        const timer = setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // already gone
          }
        }, STOP_TIMEOUT_MS);
        timer.unref();
        c.once("exit", () => {
          clearTimeout(timer);
          resolveStop();
        });
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          clearTimeout(timer);
          resolveStop();
        }
      });
    });

    test(
      "a large CSV parses off-thread and the invitation is generated",
      async () => {
        if (browser === undefined || tempDir === undefined)
          throw new Error("browser/tempDir not initialized");
        const csvPath = writeLargeCsv(tempDir);
        const page = await browser.newPage();
        try {
          // Record every Web Worker the page constructs. On the quick invite path the
          // only worker spawned is the CSV parse worker, so at least one worker is
          // direct evidence the Vite-native worker ran in the bundled build.
          const workers: Array<unknown> = [];
          page.on("worker", (worker) => workers.push(worker));

          await page.goto(`http://127.0.0.1:${port}/`, {
            waitUntil: "domcontentloaded",
          });

          await page.getByLabel("Your name").fill("Prod Worker Test");
          await page
            .locator('input[type="file"]')
            .first()
            .setInputFiles(csvPath);
          await page
            .getByRole("button", { name: "Generate invitation" })
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

          expect(workers.length).toBeGreaterThanOrEqual(1);
        } finally {
          await page.close();
        }
      },
      GENERATE_TIMEOUT_MS + 20_000,
    );
  },
);
