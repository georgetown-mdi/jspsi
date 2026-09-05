// Child process for the process-exit assertion in transitionWaitBound.test.ts.
// It opens a real SFTP connection against a server the parent runs, releases
// the session, waits for the parent to arm the stalling handshake, drives an
// operation whose re-establishing dial then parks, and closes over it: whether
// this process exits is the assertion, since an in-process check can pass even
// with the parked dial's live socket (a ref'd handle) left behind, masked by
// the test runner's own handles.
//
// Every connection parameter arrives in the environment so this is a plain
// script with no argument parsing, and the two sides synchronize through a
// file the parent creates rather than through stdin, which would itself be a
// ref'd handle this process must not hold. No process.exit(), by design: the
// exit code must come from a drained event loop.
import fs from "node:fs";

import logLibrary from "loglevel";
import { FileSyncConnection } from "@psilink/core";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "")
    throw new Error(`transitionWaitChild: ${name} is not set`);
  return value;
}

async function waitForGo(goFile: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(goFile)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("transitionWaitChild: the parent never armed the stall");
}

async function main(): Promise<void> {
  // The CLI's own default log level, so the adapter's default-verbosity teardown
  // line is emitted here exactly as an operator would see it. loglevel binds a
  // logger's level at creation, so this precedes the adapter.
  logLibrary.setDefaultLevel("info");
  const remote = required("PSILINK_TEST_REMOTE_PATH");
  const adapter = new SSH2SFTPClientAdapter({
    verbosity: 0,
    ephemeralSessions: true,
  });
  const conn = new FileSyncConnection(adapter, {
    verbose: -1,
    pollingFrequency: 50,
  });
  conn.on("error", () => {});
  await conn.open({
    channel: "sftp",
    server: {
      host: required("PSILINK_TEST_HOST"),
      port: Number(required("PSILINK_TEST_PORT")),
      username: required("PSILINK_TEST_USERNAME"),
      password: required("PSILINK_TEST_PASSWORD"),
      hostKeyFingerprint: required("PSILINK_TEST_HOST_KEY"),
      path: remote,
    },
  });
  // Released the way an idle boundary releases it, so what follows is a re-dial.
  await adapter.releaseForIdle();
  process.stdout.write("RELEASED\n");
  await waitForGo(required("PSILINK_TEST_GO_FILE"));

  // Re-establishes through the adapter's own gate against the now-stalling server,
  // so this dial holds the session transition and never settles on its own.
  const parked = adapter.list(remote).catch(() => undefined);
  process.stdout.write("PARKED\n");
  const started = Date.now();
  await conn.close();
  process.stdout.write(`CLOSED ${Date.now() - started}\n`);
  await parked;
}

main().catch((error: unknown) => {
  process.stdout.write(`FAILED ${String(error)}\n`);
  process.exitCode = 1;
});
