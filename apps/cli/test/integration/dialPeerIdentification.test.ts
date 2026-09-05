import net from "node:net";
import type { AddressInfo, Socket } from "node:net";

import { expect, test } from "vitest";
import { FileSyncConnection } from "@psilink/core";
import type { SFTPConnectionConfig } from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import {
  ensureNamespace,
  remotePath,
  serverAuth,
  sftpServer,
} from "../sftpServer/testContext";
import {
  displayLinks,
  expectNonSshAnswerDiagnosis,
  HTTP_ERROR_PAGE,
  type PeerAnswer,
} from "./peerIdentification";

// The non-SSH-answer diagnosis on the dials that run over the test SFTP server:
// the connect loop and the connection-per-poll cycle-start re-dial. They are
// driven against peers that are not SSH servers -- one answering with a proxy's
// error page, one accepting and closing having sent nothing -- with the real
// server as the control, since what the diagnosis must not do is disturb a dial
// that reaches a server. The two host-key probe entry points reach no server at
// all and run once per pull request in
// backendAgnostic/hostKeyProbePeerIdentification.test.ts.
//
// The peers are real listeners rather than stubs because what is asserted is
// what arrives on a socket. The cycle-start case additionally needs a peer that
// stops being an SSH server between two of its dials -- the reported case, an
// unattended scheduled run behind a proxy that intercepts the port -- so the
// listener forwards to the real server until it is flipped.

const srv = sftpServer();
const NS = "dial-peer-identification";

const TEST_TIMEOUT_MS = 120_000;

// How long the endpoint waits for a connection to go on a FIN before resetting
// it. Well above the loopback round trip it actually takes, since what it
// bounds is a peer that never answers the FIN, not a measurement.
const SOCKET_RETIREMENT_BUDGET_MS = 500;

interface InterceptableEndpoint {
  host: string;
  port: number;
  /** Answer every connection made from now on this way, instead of forwarding
   * it to the server behind this endpoint. */
  intercept(answer: PeerAnswer): void;
  /** Forward again, so a connection's teardown reaches the server it opened
   * against rather than making a second interception case out of cleanup. */
  stopIntercepting(): void;
  stop(): Promise<void>;
}

/**
 * A TCP endpoint in front of the test SFTP server that can be flipped, at any
 * point, into answering the way something that is not an SSH server does. An
 * already-established connection keeps its forwarding pipe; only later ones meet
 * the interception, which is what a middlebox that starts intercepting the port
 * mid-run looks like from this side.
 */
function interceptableEndpoint(upstream: {
  host: string;
  port: number;
}): Promise<InterceptableEndpoint> {
  return new Promise((resolve) => {
    const open: Socket[] = [];
    let answer: PeerAnswer | undefined;
    const server = net.createServer((accepted) => {
      open.push(accepted);
      // A peer answering and closing errors the write side of whatever is still
      // piping into it; nothing here reads those, and an unhandled 'error' would
      // fail the file.
      accepted.on("error", () => {});
      if (answer !== undefined) {
        answer(accepted);
        return;
      }
      const forwarded = net.connect(upstream);
      open.push(forwarded);
      forwarded.on("error", () => accepted.destroy());
      accepted.pipe(forwarded);
      forwarded.pipe(accepted);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        host: "127.0.0.1",
        port,
        intercept: (next) => {
          answer = next;
        },
        stopIntercepting: () => {
          answer = undefined;
        },
        stop: async () => {
          // Retire each connection with a FIN and give it time to go, rather
          // than destroying it outright: destroying a socket the client has
          // stopped reading resets it, which the ssh2 Client reports as an
          // error landing after the test that provoked it. The destroy is the
          // safety check for anything the FIN did not retire, and runs before
          // close(), which waits on every connection this endpoint still holds.
          const deadline = Date.now() + SOCKET_RETIREMENT_BUDGET_MS;
          while (open.some((socket) => !socket.destroyed)) {
            for (const socket of open) if (!socket.destroyed) socket.end();
            if (Date.now() >= deadline) break;
            await new Promise((waited) => setTimeout(waited, 25));
          }
          for (const socket of open) socket.destroy();
          await new Promise<void>((closed) => server.close(() => closed()));
        },
      });
    });
  });
}

const configFor = (
  endpoint: { host: string; port: number },
  remote: string,
): SFTPConnectionConfig => ({
  channel: "sftp",
  server: {
    host: endpoint.host,
    port: endpoint.port,
    ...serverAuth(srv.usera),
    path: remote,
  },
  // One attempt: every dial in this file either reaches the server or meets a
  // peer that answers the same way every time, so a retry budget would only
  // repeat the same rejection a second apart.
  options: { maxReconnectAttempts: 0 },
});

/**
 * Retire a connection and the endpoint it ran over. Both halves draw
 * diagnostics of their own once a peer has been interfered with -- a teardown
 * re-dial over a transport the interception left behind, and the reset the
 * endpoint's close sends the client -- which belong to the interference rather
 * than to what is under test, so capture them instead of silencing the logger.
 * Forwarding is restored first so the teardown's dial reaches the server the
 * connection was opened against.
 */
const retireQuietly = (
  conn: FileSyncConnection,
  endpoint: InterceptableEndpoint,
): Promise<unknown> => {
  endpoint.stopIntercepting();
  return withCapturedLogs(
    async () => {
      await conn.close().catch(() => {});
      await endpoint.stop();
    },
    (level) => level === "WARN" || level === "ERROR",
  );
};

test(
  "the connect loop names a peer answering the SFTP port with a web page",
  async () => {
    const remote = remotePath(srv, NS);
    await ensureNamespace(srv, NS);
    const endpoint = await interceptableEndpoint(srv);
    endpoint.intercept((socket) => socket.end(HTTP_ERROR_PAGE));
    const conn = new FileSyncConnection(new SSH2SFTPClientAdapter(), {
      verbose: -1,
      pollingFrequency: 10,
    });
    conn.on("error", () => {});
    try {
      const raised = await conn.open(configFor(endpoint, remote)).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(raised).toBeInstanceOf(Error);
      expectNonSshAnswerDiagnosis(displayLinks(raised), endpoint);
    } finally {
      await retireQuietly(conn, endpoint);
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "the connect loop names a peer that accepts and closes having sent nothing",
  async () => {
    const remote = remotePath(srv, NS);
    await ensureNamespace(srv, NS);
    const endpoint = await interceptableEndpoint(srv);
    endpoint.intercept((socket) => socket.end());
    const conn = new FileSyncConnection(new SSH2SFTPClientAdapter(), {
      verbose: -1,
      pollingFrequency: 10,
    });
    conn.on("error", () => {});
    try {
      const raised = await conn.open(configFor(endpoint, remote)).then(
        () => undefined,
        (err: unknown) => err,
      );
      const links = displayLinks(raised);
      expect(links[0]).toContain("closed it having sent nothing");
      // The firewall/allowlist copy, and no excerpt: there were no bytes.
      expect(links.some((link) => link.includes("source-IP allowlist"))).toBe(
        true,
      );
      expect(
        links.filter((link) =>
          link.startsWith(
            "first bytes the peer sent; PEM private-key blocks replaced:",
          ),
        ),
      ).toEqual([]);
      expect(links).toContain(
        `configured endpoint: 127.0.0.1:${endpoint.port}`,
      );
    } finally {
      await retireQuietly(conn, endpoint);
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "the cycle-start re-dial names what answered the port, once for the run",
  async () => {
    // The connection-per-poll path: a session is established through the
    // endpoint, released at the idle boundary, and the next cycle's re-dial
    // meets a peer that is no longer the server. The re-dial reports rather than
    // raises -- peer identification is not a terminal dial failure, so the poll
    // loop skips the cycle and retries -- and the operator's line is where the
    // diagnosis lands.
    const remote = remotePath(srv, NS);
    await ensureNamespace(srv, NS);
    const endpoint = await interceptableEndpoint(srv);
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const conn = new FileSyncConnection(adapter, {
      verbose: -1,
      pollingFrequency: 10,
    });
    conn.on("error", () => {});
    try {
      await conn.open(configFor(endpoint, remote));
      const [, logs] = await withCapturedLogs(
        async () => {
          await adapter.releaseForIdle();
          endpoint.intercept((socket) => socket.end(HTTP_ERROR_PAGE));
          await expect(adapter.ensureConnected()).resolves.toBe(false);
          await expect(adapter.ensureConnected()).resolves.toBe(false);
        },
        (level) => level === "WARN" || level === "ERROR",
      );
      const redialLines = logs
        .map((entry) => entry.message)
        .filter((message) => message.includes("ephemeral SFTP re-dial failed"));
      expect(redialLines).toHaveLength(2);
      expectNonSshAnswerDiagnosis(
        redialLines[0].split("\ncaused by: "),
        endpoint,
      );
      // The diagnosis opens a TCP connection of its own, so this mode -- which
      // dials every cycle -- pays for it once and then leaves the rejection as
      // the stack raised it, however long the condition stands.
      expect(redialLines[1]).toContain("Connection lost before handshake");
      expect(redialLines[1]).not.toContain("did not identify itself");
      expect(redialLines[1]).not.toContain("403 Forbidden");
    } finally {
      await retireQuietly(conn, endpoint);
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "a dial that reaches the real SFTP server is untouched on both paths",
  async () => {
    // The control: the same two dial paths, through the same endpoint, against
    // the server that really does speak SSH. Nothing is diagnosed and nothing is
    // added -- the connect resolves, and the cycle-start re-dial re-establishes.
    const remote = remotePath(srv, NS);
    await ensureNamespace(srv, NS);
    const endpoint = await interceptableEndpoint(srv);
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const conn = new FileSyncConnection(adapter, {
      verbose: -1,
      pollingFrequency: 10,
    });
    conn.on("error", () => {});
    try {
      await conn.open(configFor(endpoint, remote));
      await expect(adapter.list(remote)).resolves.toBeInstanceOf(Array);
      await adapter.releaseForIdle();
      await expect(adapter.ensureConnected()).resolves.toBe(true);
      await expect(adapter.list(remote)).resolves.toBeInstanceOf(Array);
    } finally {
      await retireQuietly(conn, endpoint);
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "a dial that fails for another reason keeps the rejection it already had",
  async () => {
    // The other side of the control: a rejection this diagnosis must not touch.
    // A wrong pin is the terminal one -- the server it names really is an SSH
    // server, and the refusal is the trust-boundary fault the operator has to
    // act on -- and a refused connection is the ordinary transport failure the
    // stack already reports for what it is.
    const remote = remotePath(srv, NS);
    await ensureNamespace(srv, NS);
    const endpoint = await interceptableEndpoint(srv);
    const auth = serverAuth(srv.usera);
    const body = auth.hostKeyFingerprint.slice("SHA256:".length);
    const mismatched = `SHA256:${body[0] === "A" ? "B" : "A"}${body.slice(1)}`;
    const pinned = new FileSyncConnection(new SSH2SFTPClientAdapter(), {
      verbose: -1,
      pollingFrequency: 10,
    });
    pinned.on("error", () => {});
    try {
      const config = configFor(endpoint, remote);
      const rejected = await pinned
        .open({
          ...config,
          server: { ...config.server, hostKeyFingerprint: mismatched },
        })
        .then(
          () => undefined,
          (err: unknown) => err,
        );
      const links = displayLinks(rejected);
      expect(links[0]).toContain("SFTP host-key verification failed");
      expect(links.join("\n")).not.toContain("identify itself");
    } finally {
      await retireQuietly(pinned, endpoint);
    }

    // Nothing listens on the endpoint's port now, so this dial never reaches a
    // peer to read.
    const unreachable = new FileSyncConnection(new SSH2SFTPClientAdapter(), {
      verbose: -1,
      pollingFrequency: 10,
    });
    unreachable.on("error", () => {});
    try {
      const rejected = await unreachable.open(configFor(endpoint, remote)).then(
        () => undefined,
        (err: unknown) => err,
      );
      const rendered = displayLinks(rejected).join("\n");
      expect(rendered).toContain("ECONNREFUSED");
      expect(rendered).not.toContain("identify itself");
    } finally {
      await retireQuietly(unreachable, endpoint);
    }
  },
  TEST_TIMEOUT_MS,
);
