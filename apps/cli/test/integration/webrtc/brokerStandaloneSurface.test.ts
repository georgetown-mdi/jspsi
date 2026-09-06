import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test } from "vitest";

import { startBrokerProcess } from "../../signaling/brokerProcess";

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
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (data: Buffer) => (stdout += data.toString()));
  child.stderr?.on("data", (data: Buffer) => (stderr += data.toString()));
  const code = await new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );

  expect(code).toBe(64);
  expect(stdout).toBe("");
  expect(stderr).toContain("[ERROR] [peerjs-broker]");
  expect(stderr).toContain("--port");
}, 60_000);
