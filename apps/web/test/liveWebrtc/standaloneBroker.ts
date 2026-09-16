import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";

import { READINESS_SEGMENT } from "@psilink/peerjs-broker/standaloneOptions";

import { LEG_ENVIRONMENT_FAILURE } from "./legTypes.ts";
import { trackChild } from "./childProcess.ts";

/**
 * Starts the repository's vendored PeerJS broker as a process of its own, on a
 * loopback origin that is NOT the page's, so the browser peer in
 * `liveExchange.test.ts` meets a CLI peer through the wiring a provisioned
 * broker runs rather than through the web app's own `/api` mount.
 *
 * Runs through `tsx`, not plain `node`: the vendored broker uses TypeScript
 * parameter properties, which Node's strip-only type support refuses outright.
 * `tsx` is resolved from `packages/peerjs-broker`, the workspace that declares
 * it and whose own `npm start` runs the same file the same way.
 *
 * apps/cli has a harness of its own for this broker
 * (`apps/cli/test/signaling/brokerProcess.ts`), which apps/web may not import
 * (the two apps share code only through packages/). The two are not the same
 * helper either: that one holds the runner's stdout-protocol verdict, which its
 * own suite drives, and reads no readiness endpoint; this one waits on the
 * readiness probe and holds nothing else.
 */

/** What the runner prints once it is listening, and the whole of what its
 * stdout protocol admits (packages/peerjs-broker/src/standalone.ts). */
const READY_LINE = /^psilink-broker (\d+)\n$/;

/** Longest to wait for the child to report its port before giving up. */
const START_TIMEOUT_MS = 30_000;

/** Longest to wait for the readiness endpoint to answer once the port is known,
 * and how often to re-ask within it. */
const READY_PROBE_TIMEOUT_MS = 10_000;
const READY_PROBE_INTERVAL_MS = 100;

const here = path.dirname(fileURLToPath(import.meta.url));
const brokerRoot = path.resolve(here, "../../../../packages/peerjs-broker");
const runner = path.join(brokerRoot, "src/standalone.ts");
const tsxCli = createRequire(path.join(brokerRoot, "package.json")).resolve(
  "tsx/cli",
);

/** A running broker and the handle to stop it. */
export interface StandaloneBroker {
  /** Loopback port the broker is listening on. */
  port: number;
  /** URL path the broker is mounted at. */
  path: string;
  /** What the readiness endpoint answered before the leg used the broker. */
  readinessBody: string;
  /** Terminate the child and wait for it to exit. Idempotent. */
  stop: () => Promise<void>;
}

/** Resolve after `ms`. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ask the readiness endpoint until it answers or the budget runs out. An answer
 * means the process is listening and its signaling mount is attached, which is
 * the whole of what it states (packages/peerjs-broker/src/standaloneOptions.ts).
 */
async function probeReadiness(
  origin: string,
  readinessPath: string,
): Promise<string> {
  const deadline = Date.now() + READY_PROBE_TIMEOUT_MS;
  let lastFailure = "no attempt was made";
  for (;;) {
    try {
      const response = await fetch(`${origin}${readinessPath}`);
      if (response.ok) return await response.text();
      // The body is read either way: an unconsumed one holds the socket open.
      await response.body?.cancel();
      lastFailure = `it answered ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline)
      throw new Error(
        `${LEG_ENVIRONMENT_FAILURE} the signaling broker did not answer ` +
          `${readinessPath} within ${READY_PROBE_TIMEOUT_MS}ms: ${lastFailure}`,
      );
    await delay(READY_PROBE_INTERVAL_MS);
  }
}

/**
 * Spawn the broker on an ephemeral loopback port and resolve once it has
 * reported that port AND answered its readiness endpoint. Kills the child
 * before rejecting, so a failed start leaves no orphan.
 *
 * Every rejection here is prefixed {@link LEG_ENVIRONMENT_FAILURE}: a broker
 * that will not start is the leg's environment, never an interop divergence.
 */
export async function startStandaloneBroker(): Promise<StandaloneBroker> {
  const mountPath = "/api";
  const child = spawn(
    process.execPath,
    [tsxCli, runner, "--path", mountPath, "--key", "peerjs"],
    { cwd: brokerRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stop = trackChild(child);

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const port = await new Promise<number>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      action();
    };
    const fail = (reason: string): void =>
      settle(() => {
        void stop();
        // The child's stderr is the only diagnosis a failed start leaves. The
        // broker's diagnostics sink escapes and caps what reaches it before it
        // is written, so quoting it here is safe.
        reject(
          new Error(
            `${LEG_ENVIRONMENT_FAILURE} ${reason}` +
              (stderr.trim() === "" ? "" : `\n${stderr.trim()}`),
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
    const onError = (error: Error): void =>
      fail(`the signaling broker could not be spawned: ${error.message}`);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = READY_LINE.exec(stdout);
      if (match !== null) settle(() => resolve(Number(match[1])));
    });
    child.once("exit", onExit);
    child.once("error", onError);
  });

  const origin = `http://127.0.0.1:${port}`;
  let readinessBody: string;
  try {
    readinessBody = await probeReadiness(
      origin,
      `${mountPath}/${READINESS_SEGMENT}`,
    );
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    port,
    path: mountPath,
    readinessBody,
    stop,
  };
}
