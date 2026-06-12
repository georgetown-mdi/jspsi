import { describe, expect, test } from "vitest";

import { ConnectionError, createMessagePipe, runKex } from "@psilink/core";

import { authenticateExchange } from "../../src/psi/authenticateExchange.js";

import type { MessageConnection } from "@psilink/core";

/** A MessageConnection whose `send` resolves and whose `receive` rejects with
 * `error`. As the initiator, the handshake sends its first frame then awaits a
 * reply, so this surfaces `error` from the kex's receive -- the seam by which a
 * peer-driven frame failure reaches the classifier. */
function rejectingReceiveMc(error: unknown): MessageConnection {
  return {
    send: () => Promise.resolve(),
    receive: () => Promise.reject(error),
    close: () => Promise.resolve(),
  };
}

// A 32-byte value, base64url-encoded, always satisfies SHARED_SECRET_REGEX (43
// chars, the final one drawn from the 4-bit-aligned set), so any fill byte gives
// a valid distinct invitation secret. Two distinct fills model matching vs.
// mismatching invitations.
const SECRET_A = Buffer.from(new Uint8Array(32).fill(0x11)).toString(
  "base64url",
);
const SECRET_B = Buffer.from(new Uint8Array(32).fill(0x22)).toString(
  "base64url",
);

// The generic, non-oracular message every key-exchange authentication failure
// surfaces (it must not hint at which check failed).
const GENERIC_FAILURE = "key exchange authentication failed";

/** The web handshake role assignment (Exchange.tsx): inviter -> responder,
 * acceptor -> initiator. */
function runBothEnds(
  connInitiator: MessageConnection,
  connResponder: MessageConnection,
  initiatorSecret: string,
  responderSecret: string,
) {
  return Promise.allSettled([
    authenticateExchange(connInitiator, "initiator", initiatorSecret),
    authenticateExchange(connResponder, "responder", responderSecret),
  ]);
}

describe("authenticateExchange", () => {
  test("matching secret: both ends derive the same 32-byte session key", async () => {
    const [connA, connB] = createMessagePipe();
    const [initiator, responder] = await runBothEnds(
      connA,
      connB,
      SECRET_A,
      SECRET_A,
    );

    expect(initiator.status).toBe("fulfilled");
    expect(responder.status).toBe("fulfilled");
    if (initiator.status !== "fulfilled" || responder.status !== "fulfilled")
      return;

    expect(initiator.value.sessionKey).toBeInstanceOf(Uint8Array);
    expect(initiator.value.sessionKey.length).toBe(32);
    expect(initiator.value.sessionKey).toEqual(responder.value.sessionKey);
    // The web path declines the application AEAD over DTLS (requestEncryption is
    // false on both ends), so the negotiated decision is false.
    expect(initiator.value.applyEncryption).toBe(false);
    expect(responder.value.applyEncryption).toBe(false);
  });

  test("mismatched secret: fails closed as a security-kind ConnectionError on both ends", async () => {
    const [connA, connB] = createMessagePipe();
    const [initiator, responder] = await runBothEnds(
      connA,
      connB,
      SECRET_A,
      SECRET_B,
    );

    expect(initiator.status).toBe("rejected");
    expect(responder.status).toBe("rejected");
    if (initiator.status !== "rejected" || responder.status !== "rejected")
      return;

    for (const reason of [initiator.reason, responder.reason]) {
      expect(reason).toBeInstanceOf(ConnectionError);
      expect((reason as ConnectionError).kind).toBe("security");
      // The non-oracular failure message is preserved for display.
      expect((reason as ConnectionError).message).toBe(GENERIC_FAILURE);
    }
  });

  test("a malformed secret fails closed as security before any frame is sent", async () => {
    const [connA] = createMessagePipe();
    const sent: Array<unknown> = [];
    // Spy on send so we can prove the pre-handshake credential check fired before
    // any wire activity.
    const original = connA.send.bind(connA);
    connA.send = (data: unknown) => {
      sent.push(data);
      return original(data);
    };

    await expect(
      authenticateExchange(connA, "initiator", "not-a-valid-secret"),
    ).rejects.toMatchObject({
      name: "ConnectionError",
      kind: "security",
    });
    expect(sent).toHaveLength(0);
  });

  test("a transport drop is re-thrown unchanged, not re-tagged as a trust failure", async () => {
    const [connA, connB] = createMessagePipe();
    // The responder parks awaiting the initiator's first frame; dropping the peer
    // surfaces a transport ConnectionError, which the kex remaps to its timeout
    // error (a plain Error wrapping the transport cause). That is a retryable
    // transport drop, NOT a trust failure, so authenticateExchange must not
    // re-tag it as security.
    const responder = authenticateExchange(connB, "responder", SECRET_A);
    await Promise.resolve();
    await connA.close();

    const err: unknown = await responder.then(
      () => {
        throw new Error("handshake should have rejected on the transport drop");
      },
      (reason: unknown) => reason,
    );
    // Not re-tagged as a trust failure...
    expect(err instanceof ConnectionError && err.kind === "security").toBe(
      false,
    );
    // ...and the underlying transport ConnectionError is preserved in the cause
    // chain (the kex timeout wraps it), proving the failure was passed through as
    // a retryable transport drop, not swallowed or flattened to a generic Error.
    const cause = (err as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(ConnectionError);
    expect((cause as ConnectionError).kind).toBe("transport");
  });

  test("a protocol violation (peer out of turn) is re-tagged as a security trust failure", async () => {
    // A peer flooding/misordering frames during the handshake overflows the
    // inbound buffer, surfacing a `protocol` ConnectionError. That is never
    // benign mid-handshake, so it must be a non-retryable trust failure, not the
    // retryable transport bucket.
    const mc = rejectingReceiveMc(
      new ConnectionError("the peer is sending out of turn", "protocol"),
    );

    await expect(
      authenticateExchange(mc, "initiator", SECRET_A),
    ).rejects.toMatchObject({ name: "ConnectionError", kind: "security" });
  });

  test("a local usage fault is passed through unchanged, not re-tagged as security", async () => {
    // A `usage`-kind fault (e.g. a send on an already-closed connection) is a
    // local programming fault, not the peer's doing, so it is passed through
    // unchanged rather than mislabeled "Could not verify your partner".
    const usageError = new ConnectionError("send after close", "usage");
    const mc = rejectingReceiveMc(usageError);

    const err: unknown = await authenticateExchange(
      mc,
      "initiator",
      SECRET_A,
    ).then(
      () => {
        throw new Error("handshake should have rejected on the usage fault");
      },
      (reason: unknown) => reason,
    );
    // The exact instance is re-thrown -- not wrapped, not re-tagged as security.
    expect(err).toBe(usageError);
  });

  test("rejects when the peer negotiates encryption the web path does not apply", async () => {
    const [connA, connB] = createMessagePipe();
    // The peer (responder) requests the application AEAD; the web initiator
    // passes false, so the negotiated decision is true -- which the web path does
    // not yet apply. Running the exchange in cleartext while the peer wraps would
    // silently diverge, so the handshake must fail loudly instead.
    const psk = new Uint8Array(Buffer.from(SECRET_A, "base64url"));
    const [initiator] = await Promise.allSettled([
      authenticateExchange(connA, "initiator", SECRET_A),
      runKex(connB, "responder", psk, true),
    ]);

    expect(initiator.status).toBe("rejected");
    if (initiator.status !== "rejected") return;
    expect(initiator.reason).toBeInstanceOf(ConnectionError);
    expect((initiator.reason as ConnectionError).kind).toBe("usage");
    expect((initiator.reason as ConnectionError).message).toMatch(
      /encryption/i,
    );
  });
});
