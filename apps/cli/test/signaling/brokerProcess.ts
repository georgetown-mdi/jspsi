import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ChildProcess } from "node:child_process";

/**
 * Starts the repository's vendored PeerJS broker as a child PROCESS, so the
 * CLI's hand-written signaling client can be driven against the real wire
 * instead of a stand-in.
 *
 * Why a process and not an import: a deployed broker is a service of its own,
 * and the CLI's WebRTC transport hand-writes a broker client
 * (src/connection/webrtc/brokerClient.ts) against what that service does on the
 * wire. Spawning `@psilink/peerjs-broker`'s standalone entry point exercises the
 * same wiring a provisioned broker runs, rather than a subset assembled in this
 * process. It is also why .github/workflows/cli_build_and_test.yaml filters on
 * that workspace: a change there must re-run this suite.
 *
 * Why `tsx` and not plain `node`: the vendored broker uses TypeScript parameter
 * properties, which Node 26's strip-only type support refuses outright
 * (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`), so it needs a transforming loader.
 * `tsx` is already an apps/cli devDependency and is resolved through the module
 * resolver rather than a guessed `node_modules/.bin` path, so a hoisting change
 * cannot silently break the spawn.
 */

/** The line the runner prints once it is listening. */
const READY_LINE = /psilink-broker (\d+)/;

/** Longest to wait for the child to report its port before giving up. */
const START_TIMEOUT_MS = 30_000;

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const brokerRoot = path.join(repoRoot, "packages/peerjs-broker");
const runner = path.join(brokerRoot, "src/standalone.ts");

/** A running broker, and the handle to stop it. */
export interface BrokerProcess {
  /** Loopback port the broker is listening on. */
  port: number;
  /** URL path the broker is mounted at. */
  path: string;
  /** API key the broker accepts. */
  key: string;
  /** Terminate the child and wait for it to exit. Idempotent. */
  stop: () => Promise<void>;
}

/**
 * Spawn the broker and resolve once it reports its port. Rejects (after killing
 * the child) if it exits first or does not report within
 * {@link START_TIMEOUT_MS}, so a failed start never leaves an orphan.
 */
export function startBrokerProcess(): Promise<BrokerProcess> {
  // The runner's own mount path and API key.
  const mountPath = "/api";
  const key = "peerjs";
  const child = spawn(
    process.execPath,
    [require.resolve("tsx/cli"), runner, "--path", mountPath, "--key", key],
    { cwd: brokerRoot, stdio: ["ignore", "pipe", "pipe"] },
  );

  return new Promise<BrokerProcess>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";

    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners("data");
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      action();
    };

    const fail = (reason: string): void =>
      settle(() => {
        stopChild(child);
        // The child's stderr is the only diagnosis a failed start leaves; it is
        // this repository's own code, not partner-controlled, so it is safe to
        // surface verbatim.
        reject(
          new Error(
            `${reason}${stderr.trim() === "" ? "" : `\n${stderr.trim()}`}`,
          ),
        );
      });

    const timer = setTimeout(
      () =>
        fail(`the signaling broker did not start within ${START_TIMEOUT_MS}ms`),
      START_TIMEOUT_MS,
    );

    const onExit = (code: number | null): void =>
      fail(`the signaling broker exited with code ${code} before listening`);
    const onError = (err: Error): void =>
      fail(`the signaling broker could not be spawned: ${err.message}`);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
      const match = READY_LINE.exec(stdout);
      if (match === null) return;
      settle(() =>
        resolve({
          port: Number(match[1]),
          path: mountPath,
          key,
          stop: () => stopChild(child),
        }),
      );
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

/** Terminate `child` and resolve once it has exited (or is already gone). */
function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise<void>((resolve) => {
    // A broker holding a live WebSocket does not exit on SIGTERM alone within
    // its own grace window; SIGKILL is the backstop so a suite never hangs on
    // teardown.
    const kill = setTimeout(() => child.kill("SIGKILL"), 2_000);
    kill.unref();
    child.once("exit", () => {
      clearTimeout(kill);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
