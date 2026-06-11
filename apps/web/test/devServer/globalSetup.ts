import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import type { TestProject } from "vitest/node";

// Vitest globalSetup shared by the `integration` and `browser` projects: it
// brings the Vite/TanStack dev server up before the suite and tears it down
// after, so `npm run test:integration` and `npm run test:browser` are each
// self-contained rather than requiring the operator to start `npm run dev`
// first. The unit project does not reference this file, so `npm run test` never
// touches the dev server.
//
// The dev server runs on 127.0.0.1 (the Vite bind host -- not `localhost`,
// which may resolve to ::1 and miss the IPv4 bind). This setup resolves the
// port as `process.env.PORT ?? "3000"` and probes/launches there, matching
// vite.config.ts. The integration tests (Node) read their target from the same
// expression. The browser tests run in Chromium and cannot read `process.env`,
// so the resolved port is published via `provide()` for them to `inject()`,
// pinning each browser test to the exact port this setup probed rather than a
// hardcoded guess. All three derive from `process.env.PORT ?? "3000"`, so they
// agree whenever PORT is set in the environment or unset (the repo's `.env`
// pins 3000); a non-3000 PORT set only in `.env` would not reach this read and
// is unsupported.
//
// If a server is already listening on 127.0.0.1:PORT when the suite starts,
// it is reused and left running on teardown, so a developer's long-lived
// `npm run dev` is not killed mid-session -- matching the CLI integration
// suite's warm-container reuse behavior.

declare module "vitest" {
  interface ProvidedContext {
    webDevServerPort?: number;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
// apps/web/test/devServer -> apps/web is two levels up.
const webRoot = resolve(here, "../..");

const READY_TIMEOUT_MS = 60_000;
// Per-probe abort: how long a single readiness request waits for an HTTP
// response when the server has accepted the TCP connection but is slow to
// answer (e.g. Vite still compiling). A refused connection rejects near-
// instantly, well before this fires.
const PROBE_TIMEOUT_MS = 1_000;
// Sleep between probes. With a refused connection returning immediately, this
// is roughly the effective poll cadence while the server is still coming up.
const PROBE_SLEEP_MS = 250;
// Short probe to detect an already-running server so we reuse rather than
// start a second one -- and, crucially, leave it running on teardown.
const REUSE_PROBE_TIMEOUT_MS = 500;
// After SIGTERM, how long to wait for the process group to exit before
// escalating to SIGKILL, so teardown cannot hang on a stuck dev server.
const STOP_TIMEOUT_MS = 5_000;

function getPort(): number {
  return parseInt(process.env.PORT ?? "3000", 10);
}

// Returns true if the server responds to an HTTP request within timeoutMs,
// false on connection refusal or timeout. Any HTTP status code counts as ready.
async function httpAccepts(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (await httpAccepts(url, PROBE_TIMEOUT_MS)) return;
    if (Date.now() >= deadline)
      throw new Error(
        `Dev server did not become ready at ${url} within ` +
          `${READY_TIMEOUT_MS / 1000}s. Check that \`npm run dev\` starts ` +
          `cleanly from ${webRoot}.`,
      );
    await new Promise((r) => setTimeout(r, PROBE_SLEEP_MS));
  }
}

// Vite dev compiles route modules lazily, on first request. The PeerJS
// signaling server mounted under /api/peerjs attaches its WebSocket `upgrade`
// handler only when that module first loads -- and waitForServer above probes
// `/`, which never touches it. A browser peer that dials the signaling
// WebSocket directly then stalls on an unhandled upgrade until its own timeout.
// (An auto-id peer hid this by fetching GET /api/peerjs/id first, which loads
// the module; a peer created with an explicit, pre-derived id skips that and
// goes straight to the WebSocket.) So waiting only for `/` understates
// readiness: warm the id endpoint here to load the module and attach the
// upgrade handler, so a cold `test:browser` finds signaling already accepting
// peers rather than hanging. Node-side, so there is no cross-origin concern
// (the id endpoint sets no CORS headers a browser fetch would need).
async function warmPeerSignaling(port: number): Promise<void> {
  const idUrl = `http://127.0.0.1:${port}/api/peerjs/id`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(idUrl, { signal: controller.signal });
      // Once the module is live the id endpoint answers text/plain with a peer
      // id; before that, the SPA 404 fallback answers text/html. Keying off the
      // content type avoids coupling readiness to the id's exact shape.
      if (res.ok && res.headers.get("content-type")?.includes("text/plain"))
        return;
    } catch {
      // Not ready yet -- fall through to the deadline check and retry.
    } finally {
      clearTimeout(timer);
    }
    if (Date.now() >= deadline)
      throw new Error(
        `PeerJS signaling did not become ready at ${idUrl} within ` +
          `${READY_TIMEOUT_MS / 1000}s.`,
      );
    await new Promise((r) => setTimeout(r, PROBE_SLEEP_MS));
  }
}

export default async function setup({
  provide,
}: TestProject): Promise<() => Promise<void>> {
  const port = getPort();
  const url = `http://127.0.0.1:${port}/`;

  // Publish the port for browser tests, which cannot read `process.env`. Done
  // before the reuse early-return so it is set on every path.
  provide("webDevServerPort", port);

  // Reuse a server already listening on the port (manual `npm run dev`, or a
  // warm one from a prior run): skip launch and leave it running on teardown.
  if (await httpAccepts(url, REUSE_PROBE_TIMEOUT_MS)) {
    console.log(
      `[dev-server] reusing server already listening on port ${port}`,
    );
    // Even a reused server may never have been asked for /api/peerjs/* (a bare
    // `npm run dev` no one exercised), so warm signaling here too; it is
    // idempotent on an already-warm server.
    await warmPeerSignaling(port);
    return () => Promise.resolve();
  }

  // Strip VITEST so vite.config.ts wires the dev-server-snagger and
  // preview-server-snagger plugins (they are skipped when VITEST is set,
  // since globalSetup runs inside the vitest process where VITEST=true).
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.VITEST;

  console.log(`[dev-server] starting dev server on port ${port}`);
  // detached: true groups npm and its children (sh -> vite) under one process
  // group so teardown can kill the whole tree with process.kill(-pid, SIGTERM).
  const child = spawn("npm", ["run", "dev"], {
    cwd: webRoot,
    env,
    detached: true,
    stdio: "ignore",
  });
  // unref so this process group does not prevent the vitest process from
  // exiting if teardown is never reached (e.g. an uncaught exception before
  // the return below).
  child.unref();

  let launchError: Error | undefined;
  child.once("error", (err) => {
    launchError = err;
  });

  // Sends SIGTERM to the whole process group, then waits for the child to exit
  // before resolving -- otherwise a back-to-back run's reuse probe could see
  // the still-dying server holding the port and treat it as a warm one, or the
  // fresh spawn could fail with EADDRINUSE. Escalates to SIGKILL if the group
  // does not exit within STOP_TIMEOUT_MS, so teardown cannot hang.
  const stopServer = (): Promise<void> => {
    if (child.pid === undefined || child.exitCode !== null)
      return Promise.resolve();
    const pid = child.pid;
    return new Promise<void>((resolveStop) => {
      const timer = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // already gone
        }
      }, STOP_TIMEOUT_MS);
      timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolveStop();
      });
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // already gone -- the exit listener may never fire, so settle here.
        clearTimeout(timer);
        resolveStop();
      }
    });
  };

  try {
    // Yield one tick so the error handler can fire if npm is not found.
    await new Promise<void>((r) => setImmediate(r));
    if (launchError) throw launchError;
    await waitForServer(url);
    // Readiness is not just an HTTP response on `/`: a browser peer needs the
    // PeerJS signaling WebSocket, whose handler attaches only once the
    // /api/peerjs module is first loaded. Warm it before declaring ready.
    await warmPeerSignaling(port);
  } catch (err) {
    await stopServer();
    throw err;
  }

  console.log(`[dev-server] ready on port ${port}`);

  return () => {
    console.log("[dev-server] stopping dev server");
    return stopServer();
  };
}
