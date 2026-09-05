import { expect, test } from "vitest";

import { sanitizeErrorForDisplay } from "@psilink/core";

import {
  SIGNALING_CERTIFICATE_FAILED_MESSAGE,
  SIGNALING_SOCKET_FAILED_MESSAGE,
  connectToBroker,
} from "../../../src/connection/webrtc/brokerClient";
import { probeSignalingCertificate } from "../../../src/connection/webrtc/signalingTls";

import type {
  BrokerLocation,
  BrokerMessage,
} from "../../../src/connection/webrtc/brokerClient";

/**
 * What a failed signaling socket tells the operator about the certificate.
 *
 * The certificate answer itself is measured against a real TLS listener in
 * test/integration/webrtc/signalingCertificate.test.ts; here the probe is
 * scripted, so the two answers and a hostile one can each be driven.
 */

const LOCATION: BrokerLocation = {
  host: "signal.example",
  port: 9000,
  path: "/api",
  key: "peerjs",
  secure: true,
};

const LOCAL_ID = "aaaa0000aaaa0000aaaa0000aaaa0000";

/** A socket that registers on demand and can then be failed. */
class FakeSocket {
  static readonly OPEN = 1;
  readyState = 0;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
  }

  register(): void {
    this.readyState = FakeSocket.OPEN;
    this.emit("open", {});
    this.emit("message", { data: JSON.stringify({ type: "OPEN" }) });
  }

  fail(): void {
    this.emit("error", {});
  }

  wired(): boolean {
    return (this.listeners.get("message")?.size ?? 0) > 0;
  }

  private emit(type: string, event: unknown): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
  }
}

/** Register, then fail the socket, and render what the failure reports. */
async function failureAfterRegistration(
  certificateProblem: string | undefined,
): Promise<string> {
  const socket = new FakeSocket();
  const closes: Array<unknown> = [];
  const client = await connectToBroker({
    location: LOCATION,
    id: LOCAL_ID,
    handlers: {
      onMessage: (_message: BrokerMessage) => {},
      onClose: (error) => closes.push(error),
    },
    socketFactory: () => {
      queueMicrotask(() => socket.register());
      return socket as unknown as WebSocket;
    },
    certificateProbe: () => Promise.resolve(certificateProblem),
  });
  socket.fail();
  for (let attempt = 0; attempt < 200 && closes.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  client.close();
  return sanitizeErrorForDisplay(closes[0]);
}

test("a failed socket whose certificate verified reports only the failure", async () => {
  const rendered = await failureAfterRegistration(undefined);
  expect(rendered).toContain(SIGNALING_SOCKET_FAILED_MESSAGE);
  expect(rendered).not.toContain("certificate check reported");
});

test("a certificate that did not verify is named, with the remedy", async () => {
  const rendered = await failureAfterRegistration(
    "DEPTH_ZERO_SELF_SIGNED_CERT",
  );
  expect(rendered).toContain(SIGNALING_CERTIFICATE_FAILED_MESSAGE);
  expect(rendered).toContain(
    "certificate check reported: DEPTH_ZERO_SELF_SIGNED_CERT",
  );
});

test("a hostile verification code cannot drive the operator's terminal", async () => {
  const rendered = await failureAfterRegistration(
    `CERT\u001b[31m\nFAKE: exchange complete${"A".repeat(4000)}`,
  );
  expect(rendered).toContain("CERT\\x1b[31m\\x0aFAKE: exchange complete");
  expect(rendered).not.toContain("\u001b");
  // The first-party remedy keeps its own budget: the code sits on a link of
  // its own, so no length of it can crowd the instruction out.
  expect(rendered).toContain("NODE_EXTRA_CA_CERTS");
});

test("a plaintext location is answered without opening a socket", async () => {
  await expect(
    probeSignalingCertificate({ ...LOCATION, secure: false }),
  ).resolves.toBeUndefined();
});
