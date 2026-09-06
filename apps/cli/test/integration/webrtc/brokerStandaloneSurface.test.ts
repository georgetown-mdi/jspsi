import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { connect, createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test } from "vitest";

import { startBrokerProcess } from "../../signaling/brokerProcess";
import { stopChild } from "../../stopChild";

import type { BrokerProcess } from "../../signaling/brokerProcess";
import type { AddressInfo } from "node:net";

/**
 * The standalone broker runner's operator surface, driven against the real
 * process: the address and port it binds, and the readiness probe a deployment
 * reads. What each setting resolves to from an argument vector and an
 * environment is checked without a process in the web workspace's unit suite
 * (test/unit/signalingStandaloneOptions.test.ts, where the broker's other unit
 * coverage sits); what this file adds is that the resolved values reach
 * `listen`, that the probe answers on the running server, and that an option
 * the runner cannot act on stops it with a clear failure.
 *
 * Stops at the HTTP surface: the signaling wire is broker.test.ts's.
 */

/** Longest a socket owing the runner a request is given before the measurement
 * gives up on it. Well above the runner's own 10-second idle bound
 * (packages/peerjs-broker/src/standaloneUpgradeBounds.ts), so a slow machine
 * does not fail the check, and well under the test timeout, so a runner that
 * went back to holding such a socket fails here rather than hanging. */
const PRE_HANDSHAKE_HOLD_LIMIT_MS = 25_000;

/** Longest the runner is given to refuse an option and exit. Far above the
 * start it would otherwise have completed, and well under the test timeout, so
 * a runner that went back to listening on the defaults fails the check rather
 * than holding it to the timeout. */
const REFUSAL_EXIT_TIMEOUT_MS = 15_000;

let broker: BrokerProcess | undefined;

afterEach(async () => {
  await broker?.stop();
  broker = undefined;
});

/** A port nothing is listening on, taken by binding one and releasing it. The
 * gap between release and re-bind is a race no allocation scheme closes; it is
 * the only way to ask the runner for a port and know which one it got. */
async function releasedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    probe.close(() => resolve());
  });
  return port;
}

/** How long the broker holds a socket that connects and then owes it a request,
 * measured from the connect to the close. Resolves at
 * {@link PRE_HANDSHAKE_HOLD_LIMIT_MS} if the broker has not closed it by then.
 * A reap that destroys a socket with unread bytes on it reaches the client as a
 * reset rather than a clean shutdown, so the error is read as the close it is
 * and `close` is what the measurement waits on. */
async function msBeforeCloseOf(
  port: number,
  firstBytes?: string,
): Promise<number> {
  const socket = connect(port, "127.0.0.1");
  const openedAt = Date.now();
  try {
    return await new Promise<number>((resolve) => {
      const giveUp = setTimeout(
        () => resolve(Date.now() - openedAt),
        PRE_HANDSHAKE_HOLD_LIMIT_MS,
      );
      socket.on("error", () => {});
      socket.on("connect", () => {
        if (firstBytes !== undefined) socket.write(firstBytes);
      });
      socket.on("close", () => {
        clearTimeout(giveUp);
        resolve(Date.now() - openedAt);
      });
    });
  } finally {
    socket.destroy();
  }
}

test("closes a socket that owes it a request rather than holding it", async () => {
  broker = await startBrokerProcess();
  // Both sockets are opened against the one broker at once: each is a wait on
  // the same bound, and running them in series would double it.
  const [sentNothing, sentHalfARequestLine] = await Promise.all([
    msBeforeCloseOf(broker.port),
    msBeforeCloseOf(broker.port, "GET /api/hea"),
  ]);
  expect(sentNothing).toBeLessThan(PRE_HANDSHAKE_HOLD_LIMIT_MS);
  expect(sentHalfARequestLine).toBeLessThan(PRE_HANDSHAKE_HOLD_LIMIT_MS);
}, 60_000);

test("the readiness probe answers on the mount once the broker is listening", async () => {
  broker = await startBrokerProcess();
  const response = await fetch(
    `http://127.0.0.1:${broker.port}${broker.path}/health`,
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ready\n");
}, 60_000);

test("nothing beside the probe answers on the broker's HTTP surface", async () => {
  broker = await startBrokerProcess();
  const base = `http://127.0.0.1:${broker.port}`;
  // The signaling endpoint takes upgrades, not plain requests, and the probe is
  // the one path this server answers with a body.
  expect((await fetch(`${base}${broker.path}/peerjs`)).status).toBe(404);
  expect((await fetch(`${base}${broker.path}/healthz`)).status).toBe(404);
  expect((await fetch(`${base}/health`)).status).toBe(404);
}, 60_000);

test("binds the port the flag names", async () => {
  const port = await releasedPort();
  broker = await startBrokerProcess({ args: ["--port", String(port)] });
  expect(broker.port).toBe(port);
  expect(
    (await fetch(`http://127.0.0.1:${port}${broker.path}/health`)).status,
  ).toBe(200);
}, 60_000);

test("binds the address and port the environment names", async () => {
  const port = await releasedPort();
  broker = await startBrokerProcess({
    env: {
      PSILINK_BROKER_HOST: "127.0.0.1",
      PSILINK_BROKER_PORT: String(port),
    },
  });
  expect(broker.port).toBe(port);
  expect(
    (await fetch(`http://127.0.0.1:${port}${broker.path}/health`)).status,
  ).toBe(200);
}, 60_000);

test("refuses an option it cannot act on rather than binding the defaults", async () => {
  const require = createRequire(import.meta.url);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const brokerRoot = path.resolve(
    here,
    "../../../../..",
    "packages/peerjs-broker",
  );
  const child = spawn(
    process.execPath,
    [
      require.resolve("tsx/cli"),
      path.join(brokerRoot, "src/standalone.ts"),
      "--port",
      "not-a-port",
    ],
    { cwd: brokerRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  // Unlike the broker handle above, this child has no teardown of its own, so
  // it is killed on every path out: a runner that stopped refusing would
  // otherwise be left listening behind a failed assertion.
  try {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data: Buffer) => (stdout += data.toString()));
    child.stderr?.on("data", (data: Buffer) => (stderr += data.toString()));
    const code = await new Promise<number | null | "still running">(
      (resolve) => {
        const giveUp = setTimeout(
          () => resolve("still running"),
          REFUSAL_EXIT_TIMEOUT_MS,
        );
        child.once("exit", (exitCode) => {
          clearTimeout(giveUp);
          resolve(exitCode);
        });
      },
    );

    expect(code).toBe(64);
    expect(stdout).toBe("");
    expect(stderr).toContain("[ERROR] [peerjs-broker]");
    expect(stderr).toContain("--port");
  } finally {
    await stopChild(child);
  }
}, 60_000);
