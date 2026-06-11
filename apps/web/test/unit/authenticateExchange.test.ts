import { describe, expect, test } from "vitest";

import { ConnectionError, createMessagePipe } from "@psilink/core";

import { authenticateExchange } from "../../src/psi/authenticateExchange.js";

import type { MessageConnection } from "@psilink/core";

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

    await expect(responder).rejects.toSatisfy(
      (err: unknown) =>
        !(err instanceof ConnectionError && err.kind === "security"),
    );
  });
});
