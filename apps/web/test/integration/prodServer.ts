import { createServer } from "node:net";
import { spawn } from "node:child_process";

import type { ChildProcess } from "node:child_process";

// Shared production-server harness for the integration suites that drive the
// real built app (csvWorkerProd, prodSignaling): probe a free loopback port,
// spawn `node .output/server/index.mjs` as its own process group, wait for it to
// answer HTTP, and tear the whole group down on teardown.

const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Ask the OS for a free loopback TCP port so a spawned server never collides
 * with the shared globalSetup dev server (or anything else). There is a small,
 * accepted TOCTOU window between closing this probe and the spawned server's own
 * bind; nothing here contends for ephemeral ports (the dev server uses a fixed
 * port), so a collision is improbable, and waitForRoot surfaces it promptly as an
 * early-exit error rather than a confusing readiness timeout. */
export function getFreePort(): Promise<number> {
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

export async function httpAccepts(
  url: string,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    // Release the socket: callers poll and read neither body.
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForRoot(
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

/** A spawned production server: the child process and a live view of any launch
 * error captured off its `error` event (persistent for the child's whole life,
 * so a post-launch spawn/exec failure surfaces and a stray error cannot crash the
 * worker as an unhandled EventEmitter `error`). */
export interface ProdServer {
  child: ChildProcess;
  getLaunchError: () => Error | undefined;
}

/** Spawn `node prodEntry` on `port`, bound to loopback, as its own process group
 * so teardown can signal the whole tree. Yields one tick so a spawn failure (e.g.
 * a missing node) surfaces before returning. NITRO_HOST pins the loopback bind;
 * PORT pins the free port (the nitro entry reads it straight from process.env, no
 * dotenv override). `extraEnv` merges over the inherited environment, for suites
 * that enable a feature-gated surface (e.g. the job API) at boot. */
export async function spawnProdServer(
  prodEntry: string,
  webRoot: string,
  port: number,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<ProdServer> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    NITRO_HOST: "127.0.0.1",
    ...extraEnv,
  };
  const proc = spawn("node", [prodEntry], {
    cwd: webRoot,
    env,
    detached: true,
    stdio: "ignore",
  });
  proc.unref();

  let launchError: Error | undefined;
  proc.on("error", (err) => {
    launchError = err;
  });
  await new Promise<void>((r) => setImmediate(r));
  if (launchError) throw launchError;

  return { child: proc, getLaunchError: () => launchError };
}

/** SIGTERM the spawned server's whole process group and await its exit,
 * escalating to SIGKILL after STOP_TIMEOUT_MS so teardown cannot hang. Re-refs
 * the child (unref'd at spawn) while awaiting, so the event loop cannot drain
 * mid-teardown and leave an orphaned server. No-op if it already exited. */
export async function stopProdServer(
  child: ChildProcess | undefined,
): Promise<void> {
  // Already gone if it exited (exitCode) or was signalled (signalCode); checking
  // only exitCode would miss a SIGKILLed child and kill a dead group.
  if (
    !child ||
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return;
  const pid = child.pid;
  child.ref();
  await new Promise<void>((resolveStop) => {
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
      clearTimeout(timer);
      resolveStop();
    }
  });
}
