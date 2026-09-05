import net from "node:net";
import tls from "node:tls";

import { afterAll, beforeAll, expect, test } from "vitest";

import { loopbackTlsCert } from "@psilink/testkit/loopbackTlsCert";

import { probeSignalingCertificate } from "../../../src/connection/webrtc/signalingTls";

import type { BrokerLocation } from "../../../src/connection/webrtc/brokerClient";
import type { Server as TlsServer } from "node:tls";
import type { Server as TcpServer } from "node:net";

/**
 * What the certificate probe answers, measured against real listeners rather
 * than modelled from Node's documentation: the answer separates a signaling
 * endpoint whose certificate this machine does not trust -- the failure a
 * TLS-intercepting network produces -- from every other reason a socket did
 * not come up, and both halves of that claim are only worth what a real
 * handshake says.
 *
 * The listener presents the throwaway certificate `@psilink/testkit` mints,
 * and nothing here trusts it, so the handshake fails verification exactly as
 * an untrusted proxy's would.
 */

let tlsServer: TlsServer | undefined;
let plainServer: TcpServer | undefined;

/** A location pointing at `port` on loopback, with TLS expected. */
function location(port: number): BrokerLocation {
  return { host: "127.0.0.1", port, path: "/", key: "peerjs", secure: true };
}

beforeAll(async () => {
  if (loopbackTlsCert === null) return;
  tlsServer = tls.createServer(
    { key: loopbackTlsCert.key, cert: loopbackTlsCert.cert },
    (socket) => socket.on("error", () => {}),
  );
  tlsServer.on("error", () => {});
  await new Promise<void>((resolve) =>
    tlsServer?.listen(0, "127.0.0.1", resolve),
  );
  plainServer = net.createServer((socket) => socket.on("error", () => {}));
  await new Promise<void>((resolve) =>
    plainServer?.listen(0, "127.0.0.1", resolve),
  );
});

afterAll(() => {
  tlsServer?.close();
  plainServer?.close();
});

/** The port a started listener bound, or a failure naming which one. */
function boundPort(server: TlsServer | TcpServer | undefined): number {
  const address = server?.address();
  if (address === null || address === undefined || typeof address === "string")
    throw new Error("the listener did not bind a loopback port");
  return address.port;
}

test.skipIf(loopbackTlsCert === null)(
  "an untrusted certificate is reported as a verification failure",
  async () => {
    const problem = await probeSignalingCertificate(
      location(boundPort(tlsServer)),
    );
    expect(problem).toBeDefined();
    // The token is OpenSSL's, so the assertion is on its shape rather than one
    // spelling: a Node or OpenSSL upgrade may name a self-signed chain
    // differently without changing what the operator has to do about it.
    expect(problem).toMatch(/CERT|SIGN/);
  },
);

test("a port with nothing listening is not a certificate problem", async () => {
  // Bind and release, so the port is one nothing answers on rather than one
  // some other process may hold.
  const idle = net.createServer();
  await new Promise<void>((resolve) => idle.listen(0, "127.0.0.1", resolve));
  const port = boundPort(idle);
  await new Promise<void>((resolve) => idle.close(() => resolve()));
  await expect(
    probeSignalingCertificate(location(port)),
  ).resolves.toBeUndefined();
});

test("a plaintext listener that never answers is bounded, not a verdict", async () => {
  await expect(
    probeSignalingCertificate(location(boundPort(plainServer))),
  ).resolves.toBeUndefined();
}, 20_000);
