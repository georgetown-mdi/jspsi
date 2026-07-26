// Child process for the terminal-close process-exit assertion in
// terminalCloseBound.test.ts. It opens a real SFTP connection against a server
// the PARENT runs with its close withheld, closes it, and then does nothing:
// whether this process exits is the assertion, and only a separate process can
// carry it. An in-process promise-settlement check passes even when a live
// half-open socket is left behind -- that socket is a ref'd handle, so a
// completed run would never exit -- and the test runner's own handles mask it.
//
// Every connection parameter arrives in the environment so the file is a plain
// script with no argument parsing. Deliberately no process.exit(): the exit code
// must come from a drained event loop.
import logLibrary from "loglevel";
import { FileSyncConnection } from "@psilink/core";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "")
    throw new Error(`terminalCloseChild: ${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  // The CLI's own default log level, so the adapter's default-verbosity teardown
  // line is emitted here exactly as an operator would see it. loglevel binds a
  // logger's level at creation, so this precedes the adapter.
  logLibrary.setDefaultLevel("info");
  const adapter = new SSH2SFTPClientAdapter({
    verbosity: 0,
    ephemeralSessions: process.env.PSILINK_TEST_CONNECTION_PER_POLL === "1",
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
      path: required("PSILINK_TEST_REMOTE_PATH"),
    },
  });
  process.stdout.write("OPENED\n");
  await conn.close();
  process.stdout.write("CLOSED\n");
}

main().catch((error: unknown) => {
  process.stdout.write(`FAILED ${String(error)}\n`);
  process.exitCode = 1;
});
