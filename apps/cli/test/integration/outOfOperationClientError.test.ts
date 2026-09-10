import crypto from "node:crypto";
import net from "node:net";

import logLibrary from "loglevel";
import { describe, expect, test } from "vitest";
import { setLogLevel } from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { serverAuth, sftpServer } from "../sftpServer/testContext";

// Where an ssh2 Client error that fires outside any operation the adapter
// initiated reaches the operator. ssh2-sftp-client hands one to the adapter's
// constructor callback, and the two ends of that callback are driven here
// against the real stack rather than modeled: a reset that takes a live session
// away is the operator's business, while one arriving behind a dial that has
// already failed is the transport catching up on a failure its own caller was
// told about.
//
// The second is not hypothetical. A real OpenSSH server refusing a key exchange
// writes its disconnect and closes, and the client's own disconnect -- written
// as it reaches the same verdict locally -- lands on a socket already closing,
// which answers with a reset (measured against the hardened-sshd harness; the
// listener below reproduces it deterministically by resetting on exactly that
// write). Reporting that at error level tells an operator a refused dial failed
// twice.

const uint32 = (value: number): Buffer => {
  const encoded = Buffer.alloc(4);
  encoded.writeUInt32BE(value);
  return encoded;
};

const nameList = (names: string): Buffer =>
  Buffer.concat([uint32(names.length), Buffer.from(names, "utf8")]);

// RFC 4253 6: length field, padding length, payload and padding total a
// multiple of 8, with at least 4 bytes of padding.
const framePacket = (payload: Buffer): Buffer => {
  const block = 8 - ((payload.length + 5) % 8);
  const padding = Buffer.alloc(block < 4 ? block + 8 : block);
  return Buffer.concat([
    uint32(payload.length + padding.length + 1),
    Buffer.from([padding.length]),
    payload,
    padding,
  ]);
};

const SSH_MSG_KEXINIT = 20;

// A KEXINIT offering nothing a current ssh2 offers, so the client fails the
// negotiation itself and writes its own disconnect. The ten name-lists are in
// wire order (RFC 4253 7.1).
const unnegotiableKexinit = (): Buffer =>
  framePacket(
    Buffer.concat([
      Buffer.from([SSH_MSG_KEXINIT]),
      crypto.randomBytes(16),
      nameList("diffie-hellman-group1-sha1"),
      nameList("ssh-dss"),
      nameList("3des-cbc"),
      nameList("3des-cbc"),
      nameList("hmac-md5"),
      nameList("hmac-md5"),
      nameList("none"),
      nameList("none"),
      nameList(""),
      nameList(""),
      Buffer.from([0]),
      uint32(0),
    ]),
  );

/**
 * A listener that refuses the key exchange and then resets the connection on
 * the client's next write -- the window a real sshd's close-with-unread-data
 * reaches by accident, entered here on purpose so the error lands outside the
 * dial every run rather than most of them.
 */
function createRefusingResettingListener(): {
  port: Promise<number>;
  close: () => void;
} {
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => (resolvePort = resolve));
  const server = net.createServer((socket) => {
    let answered = false;
    socket.on("error", () => {});
    socket.write("SSH-2.0-psilink-refusing-listener\r\n");
    socket.on("data", () => {
      if (!answered) {
        answered = true;
        socket.write(unnegotiableKexinit());
        return;
      }
      socket.resetAndDestroy();
    });
  });
  server.listen(0, "127.0.0.1", () => {
    resolvePort((server.address() as net.AddressInfo).port);
  });
  return { port, close: () => server.close() };
}

/** A pass-through in front of the suite's server whose client half can be reset. */
function createResettableRelay(target: { host: string; port: number }): {
  port: Promise<number>;
  resetClientHalf: () => void;
  close: () => Promise<void>;
} {
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => (resolvePort = resolve));
  const halves: net.Socket[] = [];
  let clientHalf: net.Socket | undefined;
  const server = net.createServer((client) => {
    clientHalf = client;
    const upstream = net.connect(target.port, target.host);
    halves.push(client, upstream);
    client.on("data", (chunk: Buffer) => upstream.write(chunk));
    upstream.on("data", (chunk: Buffer) => client.write(chunk));
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });
  server.listen(0, "127.0.0.1", () => {
    resolvePort((server.address() as net.AddressInfo).port);
  });
  return {
    port,
    resetClientHalf: () => clientHalf?.resetAndDestroy(),
    close: () =>
      new Promise<void>((resolve) => {
        for (const half of halves) half.destroy();
        server.close(() => resolve());
      }),
  };
}

// The ssh2 Client under ssh2-sftp-client, which is where the out-of-band events
// are raised. Waiting on its `close` is what lets these cases assert over a
// delivered event rather than over a sleep: the library hands the error to the
// adapter's callback before that close (measured).
function transportClosed(adapter: SSH2SFTPClientAdapter): Promise<void> {
  const client = (adapter as unknown as { client: { client: net.Socket } })
    .client.client;
  return new Promise<void>((resolve) => {
    client.once("close", () => setImmediate(resolve));
  });
}

const outOfOperationErrors = (
  logs: readonly { level: string; message: string }[],
): { level: string; message: string }[] =>
  logs.filter((entry) =>
    entry.message.includes("ssh2 client error outside an operation"),
  );

describe("an ssh2 client error outside any operation", () => {
  test("a reset that takes a live session away reaches the operator", async () => {
    const server = sftpServer();
    const relay = createResettableRelay(server);
    const adapter = new SSH2SFTPClientAdapter();
    // The pin serverAuth holds belongs to a connection's `server` block rather
    // than to ssh2's own options, so it stays out of the dial.
    const { hostKeyFingerprint, ...auth } = serverAuth(server.usera);
    try {
      const [, logs] = await withCapturedLogs(
        async () => {
          await adapter.connect({
            host: "127.0.0.1",
            port: await relay.port,
            ...auth,
            readyTimeout: 10_000,
            maxReconnectAttempts: 0,
          });
          // One operation, so the reset lands on a session that is established
          // and idle rather than on a dial still in flight.
          expect(await adapter.list(server.remoteRoot)).toBeInstanceOf(Array);
          const closed = transportClosed(adapter);
          relay.resetClientHalf();
          await closed;
        },
        () => true,
      );
      const reported = outOfOperationErrors(logs);
      expect(reported.map((entry) => entry.level)).toEqual(["ERROR"]);
      expect(reported[0]!.message).toContain("ECONNRESET");
    } finally {
      await adapter.end().catch(() => {});
      await relay.close();
    }
  });

  test("a reset behind a refused dial is not a second failure", async () => {
    const listener = createRefusingResettingListener();
    // A `getLoggerForVerbosity` logger is never more verbose than the root live
    // when it is built (`@psilink/core/testing`, `withCapturedLogs`), so the
    // root is raised before the adapter is constructed -- otherwise the trace
    // arm would be a level that emits nothing and the case could not tell
    // "routed to trace" from "never raised".
    const previousLevel = logLibrary.getLevel();
    setLogLevel(logLibrary.levels.TRACE);
    try {
      const [failure, logs] = await withCapturedLogs(
        async () => {
          const adapter = new SSH2SFTPClientAdapter({ verbosity: 2 });
          const closed = transportClosed(adapter);
          let thrown: unknown;
          try {
            await adapter.connect({
              host: "127.0.0.1",
              port: await listener.port,
              username: "probe",
              password: "probe",
              readyTimeout: 5_000,
              maxReconnectAttempts: 0,
            });
          } catch (err) {
            thrown = err;
          }
          await closed;
          await adapter.end().catch(() => {});
          return thrown;
        },
        () => true,
      );
      expect((failure as Error).message).toContain(
        "no matching key exchange algorithm",
      );
      // Both halves of the claim: the reset really did arrive out of band, and
      // it went to trace instead of adding an error line to a dial that had
      // already reported its own failure to the caller above.
      const reported = outOfOperationErrors(logs);
      expect(reported.map((entry) => entry.level)).toEqual(["TRACE"]);
      expect(reported[0]!.message).toContain("ECONNRESET");
    } finally {
      setLogLevel(previousLevel);
      listener.close();
    }
  });
});
