// Child process for the wire-trace drain's process-liveness assertion in
// sftpWireTrace.test.ts. It puts an adapter in the one state that drain waits
// in with nothing ref'd behind it -- the socket destroyed and the ssh2 Client's
// 'close' still owed -- and reports when end() settled and when the event loop
// ran dry. It is a child process because an in-process check that end() settled
// passes even when nothing holds the loop open, the runner's own handles
// standing in for the wait's; only a separate process shows a run exiting with
// end() still pending.
//
// The client is a stand-in rather than a server: no partner produces a
// destroyed socket whose 'close' never arrives on demand, and what is under
// test is the wait, not the dial. The root log level arrives in the environment
// because the drain exists only at trace, so the same script run at info is the
// control. No process.exit(), by design: the exit must come from a drained
// event loop.
import { EventEmitter } from "node:events";

import logLibrary from "loglevel";
import { setLogLevel } from "@psilink/core";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";

// An ssh2-sftp-client stand-in whose end() closes nothing and whose socket, once
// destroyed, emits no 'close' -- the partner that accepts a disconnect and goes
// quiet, seen from the client side. Both are the shapes the adapter's terminal
// close is built for: the rejection is what sends it to the forced close, and
// the withheld 'close' is what leaves the transport still owing one after it.
function withheldCloseStandIn() {
  const raw = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const socket = {
    setKeepAlive: () => {},
    writableEnded: false,
    readableEnded: false,
    destroyed: false,
    destroy: () => {
      socket.destroyed = true;
    },
  };
  Object.assign(raw, { setNoDelay: () => {}, _sock: socket, end: () => {} });
  const wrapper = {
    open: () => {},
    close: () => {},
    opendir: () => {},
    readdir: () => {},
    on: () => {},
  };
  let live = true;
  const client = {
    get sftp() {
      return live ? wrapper : null;
    },
    set sftp(value: unknown) {
      live = value !== null;
    },
    connect: async () => {},
    client: raw,
    end: async () => {
      throw new Error("the SFTP server did not close the connection");
    },
    realPath: async () => "/",
  };
  return { client, raw };
}

async function main(): Promise<void> {
  const level = process.env.PSILINK_TEST_LOG_LEVEL ?? "trace";
  setLogLevel(
    level === "trace" ? logLibrary.levels.TRACE : logLibrary.levels.INFO,
  );
  process.stdout.write(`LEVEL ${level}\n`);

  const { client, raw } = withheldCloseStandIn();
  const adapter = new SSH2SFTPClientAdapter({ verbosity: 0 });
  (adapter as unknown as { client: unknown }).client = client;
  await adapter.connect({ host: "127.0.0.1", maxReconnectAttempts: 0 });
  // The partner half-closed: the ssh2 Client's 'end' has fired and its 'close'
  // is owed, which is what the adapter's transport watch reads off this event.
  raw.emit("end");

  const started = Date.now();
  // Read from the last event-loop turn, so a run that exits with end() still
  // pending reports that rather than reporting nothing.
  const close: { settledMs?: number } = {};
  process.on("beforeExit", () => {
    process.stdout.write(
      `DRAINED settled=${close.settledMs ?? "pending"} at=${Date.now() - started}\n`,
    );
  });
  // The close rejects because this partner's end() closed nothing; what is
  // measured is when the call settles, not how.
  await adapter.end().catch(() => {});
  close.settledMs = Date.now() - started;
  process.stdout.write(`ENDED ${close.settledMs}\n`);
}

main().catch((error: unknown) => {
  process.stdout.write(`FAILED ${String(error)}\n`);
  process.exitCode = 1;
});
