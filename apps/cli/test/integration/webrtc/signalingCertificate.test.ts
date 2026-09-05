import net from "node:net";
import os from "node:os";
import tls from "node:tls";

import { afterAll, beforeAll, expect, test } from "vitest";

import { loopbackTlsCert } from "@psilink/testkit/loopbackTlsCert";

import {
  SIGNALING_TLS_PROBE_TIMEOUT_MS,
  probeSignalingCertificate,
} from "../../../src/connection/webrtc/signalingTls";
import {
  SNI_VHOST_NAME,
  mintSniVhostCertificates,
  startSniVhostListener,
} from "../../signaling/sniVhost";

import type { SniVhostCertificates } from "../../signaling/sniVhost";
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
let ipv6TlsServer: TlsServer | undefined;
let plainServer: TcpServer | undefined;

/**
 * Whether this machine has an IPv6 loopback address to bind. A container
 * without one cannot drive the bracketed-literal case at all, and the reporter
 * names what the run skipped.
 */
const ipv6Loopback = Object.values(os.networkInterfaces())
  .flatMap((addresses) => addresses ?? [])
  .some((address) => address.internal && address.address === "::1");

/** A location pointing at `port` on `host`, with TLS expected. */
function location(port: number, host = "127.0.0.1"): BrokerLocation {
  return { host, port, path: "/", key: "peerjs", secure: true };
}

/**
 * The live TLS socket handles this process holds against `port`, read off
 * Node's own handle list: a probe that has answered must leave none, or the
 * handshake it abandoned holds the process until its ceiling expires.
 */
function tlsHandlesTo(port: number): Array<tls.TLSSocket> {
  const handles = (
    process as unknown as { _getActiveHandles: () => Array<unknown> }
  )._getActiveHandles();
  return handles.filter(
    (handle): handle is tls.TLSSocket =>
      handle instanceof tls.TLSSocket && handle.remotePort === port,
  );
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
  if (!ipv6Loopback) return;
  ipv6TlsServer = tls.createServer(
    { key: loopbackTlsCert.key, cert: loopbackTlsCert.cert },
    (socket) => socket.on("error", () => {}),
  );
  ipv6TlsServer.on("error", () => {});
  await new Promise<void>((resolve) =>
    ipv6TlsServer?.listen(0, "::1", resolve),
  );
});

afterAll(() => {
  tlsServer?.close();
  ipv6TlsServer?.close();
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

test.skipIf(loopbackTlsCert === null || !ipv6Loopback)(
  "an IPv6 broker is dialed as an address rather than looked up as a name",
  async () => {
    // A configured IPv6 host is bracketed, which is the URL syntax for the
    // literal and not part of the address: handed to tls.connect as written it
    // is resolved as a name and reports ENOTFOUND, so an IPv6 broker's operator
    // would be told the generic failure however its certificate verified.
    const problem = await probeSignalingCertificate(
      location(boundPort(ipv6TlsServer), "[::1]"),
    );
    expect(problem).toBeDefined();
    expect(problem).toMatch(/CERT|SIGN/);
  },
);

test("an aborted probe releases the handshake it holds", async () => {
  // The plaintext listener accepts and answers nothing, so this handshake would
  // run to the probe's ceiling. An interrupt waits out none of this transport's
  // budgets (docs/spec/WEBRTC_TRANSPORT.md, Budgets), and what it leaves behind
  // is measured rather than reasoned about: a socket still open is a handle
  // that holds the process after the run was told to stop.
  const port = boundPort(plainServer);
  const controller = new AbortController();
  const startedAt = Date.now();
  const answered = probeSignalingCertificate(location(port), controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();
  await expect(answered).resolves.toBeUndefined();
  expect(Date.now() - startedAt).toBeLessThan(SIGNALING_TLS_PROBE_TIMEOUT_MS);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(tlsHandlesTo(port)).toHaveLength(0);
}, 20_000);

/**
 * The certificates the server-name tests below select between, or `null` where
 * `openssl` cannot mint them and those tests skip.
 */
const sniVhostCertificates: SniVhostCertificates | null =
  mintSniVhostCertificates();

/** The minted certificates, for a test that has arranged to skip without them. */
function requireSniVhostCertificates(): SniVhostCertificates {
  if (sniVhostCertificates === null) {
    throw new Error("no SNI vhosted certificates could be minted here");
  }
  return sniVhostCertificates;
}

/**
 * Run `body` with `authority` as the one certificate authority this process
 * trusts, restoring the installed set afterwards. The fixture's authorities are
 * minted for the run, so nothing outside `body` may be verified against them.
 */
async function withTrustedAuthority(
  authority: string,
  body: () => Promise<void>,
): Promise<void> {
  const installed = tls.getCACertificates("default");
  tls.setDefaultCACertificates([authority]);
  try {
    await body();
  } finally {
    tls.setDefaultCACertificates(installed);
  }
}

/**
 * What the signaling socket's own TLS handshake reports about `port`: the
 * verification failure's code, or `undefined` where the certificate verified.
 *
 * `servername` is what makes this the socket's dial rather than a bare one --
 * the `WebSocket` the broker client opens sends the host it dialed, measured in
 * the first test below.
 */
function dialAsSignalingSocket(
  port: number,
  servername: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: servername, port, servername });
    const answer = (code: string | undefined): void => {
      socket.destroy();
      resolve(code);
    };
    socket.on("secureConnect", () => answer(undefined));
    socket.on("error", () => {
      const failure: unknown = socket.authorizationError;
      if (typeof failure === "string")
        answer(failure === "" ? undefined : failure);
      else if (failure instanceof Error) {
        const code = (failure as { code?: unknown }).code;
        answer(typeof code === "string" ? code : failure.message);
      } else answer(undefined);
    });
  });
}

/** Dial `wss://host:port` and return once the socket has opened or failed. */
function dialWebSocket(port: number, host: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`wss://${host}:${port}/`);
    const done = (): void => {
      socket.close();
      resolve();
    };
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", done, { once: true });
  });
}

test.skipIf(loopbackTlsCert === null)(
  "the probe names the host the signaling socket names",
  async () => {
    // The endpoint the probe explains may hold more than one certificate and
    // pick by the name the handshake sends, so an answer collected under a
    // different name is about a different certificate. Both dials are driven
    // against one recording listener rather than reasoned about from Node's
    // documentation.
    const credentials = loopbackTlsCert;
    if (credentials === null) return;
    const front = await startSniVhostListener(credentials, credentials);
    try {
      await probeSignalingCertificate(location(front.port, SNI_VHOST_NAME));
      expect(front.serverNames).toEqual([SNI_VHOST_NAME]);
      await dialWebSocket(front.port, SNI_VHOST_NAME);
      expect(front.serverNames).toEqual([SNI_VHOST_NAME, SNI_VHOST_NAME]);

      // RFC 6066 defines no server name for an address, and neither dial sends
      // one for a literal.
      await probeSignalingCertificate(location(front.port, "127.0.0.1"));
      await dialWebSocket(front.port, "127.0.0.1");
      expect(front.serverNames).toEqual([SNI_VHOST_NAME, SNI_VHOST_NAME]);
    } finally {
      await front.stop();
    }
  },
  20_000,
);

test.skipIf(sniVhostCertificates === null)(
  "a front selecting by server name is asked about the certificate it served",
  async () => {
    const certificates = requireSniVhostCertificates();
    const front = await startSniVhostListener(
      certificates.fallback,
      certificates.selected,
    );
    try {
      await withTrustedAuthority(certificates.trustedAuthority, async () => {
        // The socket whose failure would be explained verifies against this
        // front, so there is no certificate problem to report. A probe that
        // sent no server name would draw the fallback certificate, valid for a
        // name nobody dialed, and report a verification failure whose remedy
        // tells the operator to widen their trust store.
        await expect(
          dialAsSignalingSocket(front.port, SNI_VHOST_NAME),
        ).resolves.toBeUndefined();
        await expect(
          probeSignalingCertificate(location(front.port, SNI_VHOST_NAME)),
        ).resolves.toBeUndefined();
      });
    } finally {
      await front.stop();
    }
  },
  20_000,
);

test.skipIf(sniVhostCertificates === null)(
  "an untrusted served certificate is reported as the socket's own dial reports it",
  async () => {
    const certificates = requireSniVhostCertificates();
    const front = await startSniVhostListener(
      certificates.fallback,
      certificates.selectedUntrusted,
    );
    try {
      await withTrustedAuthority(certificates.trustedAuthority, async () => {
        const socketFailure = await dialAsSignalingSocket(
          front.port,
          SNI_VHOST_NAME,
        );
        expect(socketFailure).toBeDefined();
        await expect(
          probeSignalingCertificate(location(front.port, SNI_VHOST_NAME)),
        ).resolves.toBe(socketFailure);
      });
    } finally {
      await front.stop();
    }
  },
  20_000,
);
