import { expect, test, vi } from "vitest";

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
import type { SignalingCertificateProbe } from "../../../src/connection/webrtc/signalingTls";

/**
 * What a failed signaling socket tells the operator about the certificate, and
 * which failures are asked about at all.
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

  private emit(type: string, event: unknown): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
  }
}

/** A scripted probe that counts the endpoints it was asked about. */
function countingProbe(answer: Promise<string | undefined>): {
  probe: SignalingCertificateProbe;
  dials: () => number;
} {
  let dials = 0;
  return {
    probe: () => {
      dials += 1;
      return answer;
    },
    dials: () => dials,
  };
}

/**
 * Fail the socket before the broker confirms it, and render what the rejected
 * registration reports. That is the phase a certificate failure lands in: a
 * socket that never registered is one whose handshake may be what failed.
 */
async function failureBeforeRegistration(
  certificateProblem: string | undefined,
): Promise<string> {
  const socket = new FakeSocket();
  const closes: Array<unknown> = [];
  const failure = await connectToBroker({
    location: LOCATION,
    id: LOCAL_ID,
    handlers: {
      onMessage: (_message: BrokerMessage) => {},
      onClose: (error) => closes.push(error),
    },
    socketFactory: () => {
      queueMicrotask(() => socket.fail());
      return socket as unknown as WebSocket;
    },
    certificateProbe: () => Promise.resolve(certificateProblem),
  }).then(
    () => new Error("the registration was expected to fail"),
    (err: unknown) => err,
  );
  // A registration that never opened reports through its own rejection; the
  // handlers belong to the phase after it.
  expect(closes).toHaveLength(0);
  return sanitizeErrorForDisplay(failure);
}

test("a failed socket whose certificate verified reports only the failure", async () => {
  const rendered = await failureBeforeRegistration(undefined);
  expect(rendered).toContain(SIGNALING_SOCKET_FAILED_MESSAGE);
  expect(rendered).not.toContain("certificate check reported");
});

test("a certificate that did not verify is named, with the remedy", async () => {
  const rendered = await failureBeforeRegistration(
    "DEPTH_ZERO_SELF_SIGNED_CERT",
  );
  expect(rendered).toContain(SIGNALING_CERTIFICATE_FAILED_MESSAGE);
  expect(rendered).toContain(
    "certificate check reported: DEPTH_ZERO_SELF_SIGNED_CERT",
  );
});

test("a hostile verification code cannot drive the operator's terminal", async () => {
  const rendered = await failureBeforeRegistration(
    `CERT\u001b[31m\nFAKE: exchange complete${"A".repeat(4000)}`,
  );
  expect(rendered).toContain("CERT\\x1b[31m\\x0aFAKE: exchange complete");
  expect(rendered).not.toContain("\u001b");
  // The first-party remedy keeps its own budget: the code sits on a link of
  // its own, so no length of it can crowd the instruction out.
  expect(rendered).toContain("NODE_EXTRA_CA_CERTS");
});

test("a socket that fails before registering is asked about the certificate", async () => {
  const socket = new FakeSocket();
  const { probe, dials } = countingProbe(
    Promise.resolve("DEPTH_ZERO_SELF_SIGNED_CERT"),
  );
  const failure = await connectToBroker({
    location: LOCATION,
    id: LOCAL_ID,
    handlers: { onMessage: () => {}, onClose: () => {} },
    socketFactory: () => {
      queueMicrotask(() => socket.fail());
      return socket as unknown as WebSocket;
    },
    certificateProbe: probe,
  }).then(
    () => new Error("the registration was expected to fail"),
    (err: unknown) => err as Error,
  );
  expect(dials()).toBe(1);
  expect(failure.message).toBe(SIGNALING_CERTIFICATE_FAILED_MESSAGE);
});

test("a socket that fails after registering reports at once, asking nothing", async () => {
  // This socket completed the handshake the endpoint's certificate is checked
  // in, so a drop after it is not a certificate failure. Asking anyway would
  // hold the report for the probe's ceiling and could name a check that had
  // passed. The probe here never answers, so a report that waited on one would
  // never come at all.
  const socket = new FakeSocket();
  const closes: Array<Error> = [];
  const { probe, dials } = countingProbe(
    new Promise<string | undefined>(() => {}),
  );
  const client = await connectToBroker({
    location: LOCATION,
    id: LOCAL_ID,
    handlers: {
      onMessage: () => {},
      onClose: (error) => closes.push(error),
    },
    socketFactory: () => {
      queueMicrotask(() => socket.register());
      return socket as unknown as WebSocket;
    },
    certificateProbe: probe,
  });
  socket.fail();
  expect(dials()).toBe(0);
  expect(closes).toHaveLength(1);
  expect(closes[0]?.message).toBe(SIGNALING_SOCKET_FAILED_MESSAGE);
  // The caller closing behind the report adds nothing: one failure is reported
  // once.
  client.close();
  await vi.waitFor(() => expect(closes).toHaveLength(1));
});

test("a plaintext location is answered without opening a socket", async () => {
  await expect(
    probeSignalingCertificate({ ...LOCATION, secure: false }),
  ).resolves.toBeUndefined();
});

test("an aborted probe is answered without dialing", async () => {
  await expect(
    probeSignalingCertificate(LOCATION, AbortSignal.abort()),
  ).resolves.toBeUndefined();
});

test("a probe that fails reports the socket failure it was asked about", async () => {
  // The probe is an option a caller supplies, so its own failure is one the
  // registration has to settle on: without it the socket failure is never
  // reported and the rejection is unhandled.
  for (const probe of [
    () => Promise.reject(new Error("the probe itself failed")),
    () => {
      throw new Error("the probe itself failed");
    },
  ] satisfies Array<SignalingCertificateProbe>) {
    const socket = new FakeSocket();
    const failure = await connectToBroker({
      location: LOCATION,
      id: LOCAL_ID,
      handlers: { onMessage: () => {}, onClose: () => {} },
      socketFactory: () => {
        queueMicrotask(() => socket.fail());
        return socket as unknown as WebSocket;
      },
      certificateProbe: probe,
    }).then(
      () => new Error("the registration was expected to fail"),
      (err: unknown) => err as Error,
    );
    expect(failure.message).toBe(SIGNALING_SOCKET_FAILED_MESSAGE);
  }
});
