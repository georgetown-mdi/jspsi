import type { ChildProcess } from "node:child_process";

/**
 * Terminate `child` and resolve once it has exited (or is already gone).
 * SIGKILL is the fallback, unref'd so it cannot itself hold a teardown open,
 * for a child that does not exit on SIGTERM alone within its own grace window
 * (a broker holding a live WebSocket is one such child).
 * @internal test-only
 */
export function stopChild(child: ChildProcess): Promise<void> {
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
