import { afterEach, expect, test, vi } from "vitest";

import {
  AEAD_CONTEXTS,
  assertSharedSecretReadyForHandshake,
  authenticateConnection,
  deriveAeadKey,
} from "../src/auth";
import {
  ConnectionError,
  createMessagePipe,
} from "../src/connection/messageConnection";
import { SHARED_SECRET_REGEX } from "../src/config/connection";
import type { Authentication } from "../src/config/connection";
import { hkdfDerive, toBase64Url } from "../src/utils/crypto";

// A well-formed shared secret: 43 base64url characters whose final character is
// in [AEIMQUYcgkosw048], so an expiry case turns on expiry alone.
const SHARED_SECRET = "oaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaE";

// A second well-formed secret, for the mismatched-credential handshake.
const OTHER_SHARED_SECRET = toBase64Url(
  new Uint8Array(32).fill(0x5a) as Uint8Array<ArrayBuffer>,
);

// Every shape SHARED_SECRET_REGEX must refuse: absent, empty, too short, too
// long, and 43 characters whose final character has non-zero trailing bits.
const MALFORMED_SECRETS: Array<string | undefined> = [
  undefined,
  "",
  "not-a-shared-secret",
  SHARED_SECRET.slice(0, 42),
  `${SHARED_SECRET}A`,
  `${SHARED_SECRET.slice(0, 42)}B`,
];

const NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);

function authenticationExpiringAt(offsetMs: number): Authentication {
  return {
    sharedSecret: SHARED_SECRET,
    expires: new Date(NOW_MS + offsetMs).toISOString(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

test("a shared secret expiring exactly now is expired (the boundary is inclusive)", () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  expect(() =>
    assertSharedSecretReadyForHandshake(authenticationExpiringAt(0)),
  ).toThrow(/shared secret expired/);
});

test("a shared secret expiring one millisecond from now is still usable", () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  expect(() =>
    assertSharedSecretReadyForHandshake(authenticationExpiringAt(1)),
  ).not.toThrow();
});

test("a well-formed shared secret with no expiry set is ready for the handshake", () => {
  // The expiry guard must stay conditional on `expires` being set: an unexpiring
  // credential is the common case, and an absent date parses to NaN, which the
  // guard treats as expired -- so reaching it at all refuses every such secret.
  expect(() =>
    assertSharedSecretReadyForHandshake({ sharedSecret: SHARED_SECRET }),
  ).not.toThrow();
});

test("an absent, empty, or wrong-length shared secret is refused as malformed, not as expired", () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  for (const sharedSecret of MALFORMED_SECRETS) {
    // A live expiry, so only the format guard can be what rejects these; the two
    // refusals have different recovery instructions and must stay distinct.
    const authentication: Authentication = {
      sharedSecret,
      expires: new Date(NOW_MS + 86_400_000).toISOString(),
    };
    expect(() => assertSharedSecretReadyForHandshake(authentication)).toThrow(
      /base64url-encoded 32-byte value/,
    );
    expect(() =>
      assertSharedSecretReadyForHandshake(authentication),
    ).not.toThrow(/expired/);
  }
});

test("a malformed shared secret is refused as malformed even when it is also expired", () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  expect(() =>
    assertSharedSecretReadyForHandshake({
      sharedSecret: "",
      expires: new Date(NOW_MS - 1).toISOString(),
    }),
  ).toThrow(/base64url-encoded 32-byte value/);
});

test("both pre-handshake refusals tag themselves as having emitted a recovery hint", () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  // A higher-level catch suppresses its own generic advisory on this tag, so a
  // refusal that lost it would show the user two contradictory messages.
  for (const authentication of [
    { sharedSecret: "" },
    authenticationExpiringAt(0),
  ]) {
    let thrown: unknown;
    try {
      assertSharedSecretReadyForHandshake(authentication);
    } catch (err) {
      thrown = err;
    }
    expect(
      (thrown as { psilinkRecoveryHintEmitted?: unknown })
        .psilinkRecoveryHintEmitted,
    ).toBe(true);
  }
});

// --- authenticateConnection over an in-memory connection pair ----------------

function authenticateOverPipe(
  initiatorSecret: string,
  responderSecret: string,
) {
  const [initiatorConn, responderConn] = createMessagePipe();
  return Promise.allSettled([
    authenticateConnection(
      initiatorConn,
      { sharedSecret: initiatorSecret },
      "initiator",
      false,
    ),
    authenticateConnection(
      responderConn,
      { sharedSecret: responderSecret },
      "responder",
      true,
    ),
  ]);
}

test("authenticateConnection returns an agreed session key, rotated secret, and encryption decision", async () => {
  const [initiator, responder] = await authenticateOverPipe(
    SHARED_SECRET,
    SHARED_SECRET,
  );
  if (initiator.status !== "fulfilled" || responder.status !== "fulfilled") {
    throw new Error("the handshake did not complete on both sides");
  }

  expect(initiator.value.sessionKey).toHaveLength(32);
  expect(initiator.value.sessionKey).toEqual(responder.value.sessionKey);
  expect(initiator.value.rotatedSecret).toBe(responder.value.rotatedSecret);
  // The rotated secret is persisted as the next exchange's shared secret, so it
  // must satisfy the same format guard that credential is held to.
  expect(SHARED_SECRET_REGEX.test(initiator.value.rotatedSecret)).toBe(true);
  // Only the responder requested the encryption layer; the transcript-bound OR
  // turns it on for both.
  expect(initiator.value.applyEncryption).toBe(true);
  expect(responder.value.applyEncryption).toBe(true);
});

test("the rotated secret pins the psilink-shared-secret-rotation-v1 HKDF label", async () => {
  const [initiator] = await authenticateOverPipe(SHARED_SECRET, SHARED_SECRET);
  if (initiator.status !== "fulfilled") {
    throw new Error("the handshake did not complete");
  }
  const { sessionKey, rotatedSecret } = initiator.value;

  // The session key is ephemeral, so the pin is the label rather than fixed
  // bytes: re-deriving from the returned session key with the literal info
  // string must reproduce the rotated secret. Any edit to the label -- including
  // a swap to another live psilink label -- breaks this equality.
  expect(rotatedSecret).toBe(
    toBase64Url(
      await hkdfDerive(sessionKey, "psilink-shared-secret-rotation-v1", 32),
    ),
  );

  // Domain separation against the other label derived from the same session key:
  // a collision would make an AEAD key usable as the next shared secret.
  for (const context of AEAD_CONTEXTS) {
    expect(rotatedSecret).not.toBe(
      toBase64Url(await deriveAeadKey(sessionKey, context)),
    );
  }
});

test("authenticateConnection propagates a failed key exchange as a security-kind ConnectionError", async () => {
  const settled = await authenticateOverPipe(
    SHARED_SECRET,
    OTHER_SHARED_SECRET,
  );
  for (const outcome of settled) {
    expect(outcome.status).toBe("rejected");
    const reason = (outcome as PromiseRejectedResult).reason as unknown;
    // The kind is the trust-boundary marker consumers classify on, and the
    // handshake failure must reach them with it intact rather than re-wrapped as
    // a transport fault.
    expect(reason).toBeInstanceOf(ConnectionError);
    expect((reason as ConnectionError).kind).toBe("security");
  }
});

test("authenticateConnection refuses a malformed secret before touching the connection", async () => {
  const [conn, peer] = createMessagePipe();
  let peerReceived = false;
  void peer.receive().then(
    () => {
      peerReceived = true;
    },
    () => {},
  );

  await expect(
    authenticateConnection(conn, { sharedSecret: "" }, "initiator", false),
  ).rejects.toThrow(/base64url-encoded 32-byte value/);
  expect(peerReceived).toBe(false);

  await conn.close();
});
