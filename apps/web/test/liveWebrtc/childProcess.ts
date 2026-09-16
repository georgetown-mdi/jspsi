import type { ChildProcess } from "node:child_process";

/**
 * Stopping the two processes the live WebRTC leg spawns -- the standalone
 * broker and the `psilink` party -- and reaping one whose run died before its
 * teardown could.
 *
 * The reaper matters because neither child ends on its own: a broker listens
 * until it is signalled, and a `psilink invite` waits out its accept budget. A
 * vitest run that crashes (a browser session lost, a worker killed) would
 * otherwise leave both behind on every such run.
 */

/** Terminate `child` and resolve once it has exited (or is already gone).
 * SIGKILL is the fallback for a child that does not exit on SIGTERM alone
 * within its own grace window -- a broker holding a live WebSocket is one. */
function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise<void>((resolve) => {
    const kill = setTimeout(() => child.kill("SIGKILL"), 2_000);
    kill.unref();
    child.once("exit", () => {
      clearTimeout(kill);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/**
 * Take responsibility for `child`, returning the handle that stops it.
 *
 * Until that handle is called, the child is killed as this process exits. The
 * kill is synchronous because an `exit` listener is: it is the last-resort
 * reaper, not the teardown, which is the returned handle. Idempotent.
 */
export function trackChild(child: ChildProcess): () => Promise<void> {
  const reap = (): void => {
    child.kill("SIGKILL");
  };
  process.once("exit", reap);
  return () => {
    process.removeListener("exit", reap);
    return stopChild(child);
  };
}
