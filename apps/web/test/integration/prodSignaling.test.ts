import { dirname, resolve } from "node:path";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  probeUnmatchedUpgrade,
  waitForColdSignaling,
} from "../devServer/signalingProbe";

import type { ChildProcess } from "node:child_process";

// Regression guard for the "create an invitation -> Lost connection to server"
// bug on the DEPLOYED app. The PeerJS signaling server attaches its WebSocket
// `upgrade` handler only when its /api/peerjs route first runs usePeerServer(),
// and the real client dials that WebSocket with an explicit, pre-derived id --
// it never makes the GET /api/peerjs/id that would load the route. So the server
// must warm signaling itself at startup; the nitro production entry
// (server/custom-entry.ts) does this via nitroApp.localFetch. This spawns the
// real built server and connects the upgrade COLD (never an HTTP request to
// /api/peerjs/*), so it only passes if that startup warm attached the handler.
//
// Verified to fail (assertion, exit 1) when the custom-entry warm is removed and
// the server rebuilt, so this is a real guard rather than a no-op.
//
// Build-gated: the production entry exists only after `npm run build`. CI builds
// the web app before this suite runs (eb_build_and_test.yaml: "Build server"
// precedes "Web integration and browser tests"), so this runs there; a local
// `npm run test:integration` without a prior build skips it rather than failing.
//
// A non-skipped LOCAL run tests whatever `.output` currently holds: if you change
// the startup warm and re-run without rebuilding, an OLD build still on disk makes
// this pass green against stale code. To validate a warm change locally, rebuild
// first (`npm run build -w apps/web`); CI always rebuilds before this suite, so it
// is unaffected.
const here = dirname(fileURLToPath(import.meta.url));
// apps/web/test/integration -> apps/web is two levels up.
const webRoot = resolve(here, "../..");
const prodEntry = resolve(webRoot, ".output/server/index.mjs");
const hasBuild = existsSync(prodEntry);

const READY_TIMEOUT_MS = 30_000;
const COLD_PROBE_DEADLINE_MS = 20_000;
const UNMATCHED_PROBE_MS = 3_000;
const STOP_TIMEOUT_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Ask the OS for a free loopback TCP port so this server never collides with
 * the shared globalSetup dev server (or anything else). There is a small,
 * accepted TOCTOU window between closing this probe and the spawned server's own
 * bind; nothing here contends for ephemeral ports (the dev server uses a fixed
 * port), so a collision is improbable, and waitForRoot surfaces it promptly as an
 * early-exit error rather than a confusing readiness timeout. */
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
    // Release the socket: this polls every 250ms and we read neither body.
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
    // Surface an early exit (a port collision, a missing/broken build) with its
    // real cause, instead of polling a server that is never coming up until the
    // readiness deadline and then reporting a misleading timeout. A spawn/exec
    // failure that surfaces as a child `error` event (rather than an exit) leaves
    // exitCode/signalCode null, so also re-throw a captured launch error here.
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

describe.skipIf(!hasBuild)(
  "the production server warms PeerJS signaling at startup",
  () => {
    let child: ChildProcess | undefined;
    let port = 0;

    beforeAll(async () => {
      port = await getFreePort();
      // node .output/server/index.mjs is a single process, but spawn it as its
      // own group so teardown can SIGTERM the whole tree. NITRO_HOST pins the
      // loopback bind; PORT pins the free port (the nitro entry reads it straight
      // from process.env, no dotenv override).
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

      // Capture child `error` events for the process's whole life (not just the
      // launch tick): a persistent listener both lets waitForRoot surface a
      // post-launch spawn/exec failure and prevents a stray child error from
      // throwing as an unhandled EventEmitter `error` and crashing the worker.
      let launchError: Error | undefined;
      proc.on("error", (err) => {
        launchError = err;
      });
      await new Promise<void>((r) => setImmediate(r));
      if (launchError) throw launchError;

      // Readiness is the ROOT route only -- deliberately not /api/peerjs/*, which
      // would warm signaling and defeat the test.
      await waitForRoot(`http://127.0.0.1:${port}/`, proc, () => launchError);
    }, READY_TIMEOUT_MS + 10_000);

    afterAll(async () => {
      const c = child;
      // Already gone if it exited (exitCode) or was signalled (signalCode);
      // checking only exitCode would miss a SIGKILLed child and kill a dead group.
      if (
        !c ||
        c.pid === undefined ||
        c.exitCode !== null ||
        c.signalCode !== null
      )
        return;
      const pid = c.pid;
      // Re-ref the child (unref'd at spawn) while awaiting its exit, so the event
      // loop cannot drain mid-teardown and leave an orphaned server -- the same
      // guard the dev-server globalSetup uses on its stop path.
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
      "a cold /api/peerjs upgrade answers OPEN without a prior /api/peerjs/* request",
      async () => {
        const opened = await waitForColdSignaling(port, {
          deadlineMs: COLD_PROBE_DEADLINE_MS,
        });
        expect(opened).toBe(true);
      },
      COLD_PROBE_DEADLINE_MS + 10_000,
    );

    // Regression guard: the signaling listener is the only `upgrade` listener on
    // the production server, so an upgrade to any non-/api/peerjs path must be
    // closed rather than left open -- Node does not auto-destroy an unhandled
    // upgrade once a listener exists, and no socket timeout reaps it, so leaving
    // it open is an unauthenticated socket-leak/DoS. Verified to fail (the socket
    // hangs) against the pre-fix routing that simply returned on a path miss.
    test(
      "an upgrade to a non-signaling path is rejected, not left to leak a socket",
      async () => {
        const closed = await probeUnmatchedUpgrade(port, UNMATCHED_PROBE_MS);
        expect(closed).toBe(true);
      },
      UNMATCHED_PROBE_MS + 10_000,
    );
  },
);
