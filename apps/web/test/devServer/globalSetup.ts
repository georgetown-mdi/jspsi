import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

// Vitest globalSetup for the `integration` project: brings the Vite/TanStack
// dev server up before the suite and tears it down after, so `npm run
// test:integration` is self-contained rather than requiring the operator to
// start `npm run dev` first. Only the integration project references this file,
// so the unit project (and `npm run test`) never touches the dev server.
//
// The dev server runs on 127.0.0.1 (the Vite bind host -- not `localhost`,
// which may resolve to ::1 and miss the IPv4 bind). The port comes from the
// PORT env var (default 3000), matching vite.config.ts. The integration tests
// hardcode http://127.0.0.1:3000; both derive from the same default, so they
// stay in sync as long as PORT is not overridden.
//
// If a server is already listening on 127.0.0.1:PORT when the suite starts,
// it is reused and left running on teardown, so a developer's long-lived
// `npm run dev` is not killed mid-session -- matching the CLI integration
// suite's warm-container reuse behavior.

const here = dirname(fileURLToPath(import.meta.url));
// apps/web/test/devServer -> apps/web is two levels up.
const webRoot = resolve(here, "../..");

const READY_TIMEOUT_MS = 60_000;
const PROBE_INTERVAL_MS = 250;
// Short probe to detect an already-running server so we reuse rather than
// start a second one -- and, crucially, leave it running on teardown.
const REUSE_PROBE_TIMEOUT_MS = 500;

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
    if (await httpAccepts(url, PROBE_INTERVAL_MS)) return;
    if (Date.now() >= deadline)
      throw new Error(
        `Dev server did not become ready at ${url} within ` +
          `${READY_TIMEOUT_MS / 1000}s. Check that \`npm run dev\` starts ` +
          `cleanly from ${webRoot}.`,
      );
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  const port = getPort();
  const url = `http://127.0.0.1:${port}/`;

  // Reuse a server already listening on the port (manual `npm run dev`, or a
  // warm one from a prior run): skip launch and leave it running on teardown.
  if (await httpAccepts(url, REUSE_PROBE_TIMEOUT_MS)) {
    console.log(`[dev-server] reusing server already listening on port ${port}`);
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

  const killGroup = () => {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  };

  try {
    // Yield one tick so the error handler can fire if npm is not found.
    await new Promise<void>((r) => setImmediate(r));
    if (launchError) throw launchError;
    await waitForServer(url);
  } catch (err) {
    killGroup();
    throw err;
  }

  console.log(`[dev-server] ready on port ${port}`);

  return () => {
    console.log("[dev-server] stopping dev server");
    killGroup();
    return Promise.resolve();
  };
}
