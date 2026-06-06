import { afterEach, expect, test, vi } from "vitest";

afterEach(() => vi.useRealTimers());

import { p256_hasher } from "@noble/curves/nist.js";
import { runSpake2 } from "../src/pake";
import {
  authenticateConnection,
  deriveAeadKey,
  AEAD_CONTEXTS,
  type AeadContext,
} from "../src/auth";
import { PAKE_TOKEN_REGEX } from "../src/config/connection";
import type { Authentication } from "../src/config/connection";
import {
  createMessagePipe,
  fromEventConnection,
  type MessageConnection,
} from "../src/connection/messageConnection";

import { PassthroughConnection } from "./utils/passthroughConnection";

// --- Token constants ---------------------------------------------------------

// Base64url encoding of 32 bytes of 0x00 and 0x01.  Exactly 43 characters,
// satisfying the pakeToken format constraint.
const TOKEN_ALPHA = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN_BETA = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

// --- Helpers -----------------------------------------------------------------

function makeConnections(): [MessageConnection, MessageConnection] {
  return createMessagePipe();
}

/** Run SPAKE2 between an initiator and a responder with the same token. */
async function runPair(tokenA: string, tokenB: string) {
  const [connA, connB] = makeConnections();
  return Promise.allSettled([
    runSpake2(connA, "initiator", tokenA),
    runSpake2(connB, "responder", tokenB),
  ]);
}

// --- M / N blinding points ---------------------------------------------------

test("M and N match their hash-to-curve derivation", () => {
  const enc = new TextEncoder();
  const DST = "psilink-SPAKE2-P256-SHA256-SSWU-v1";
  const M = p256_hasher.hashToCurve(enc.encode("psilink-SPAKE2-M"), { DST });
  const N = p256_hasher.hashToCurve(enc.encode("psilink-SPAKE2-N"), { DST });
  expect(M.toHex(true)).toBe(
    "03df561bdb8d6bc4d7e4355bac1c376a6e53d5e0c2c3df07e059ed857b811f7693",
  );
  expect(N.toHex(true)).toBe(
    "03969a544c8e21a0a99b6816d63c99746a82b72513d9ac2907749ef6b1bc08b0eb",
  );
});

// --- runSpake2 ---------------------------------------------------------------

test("both sides succeed when tokens match", async () => {
  const [a, b] = await runPair(TOKEN_ALPHA, TOKEN_ALPHA);
  expect(a.status).toBe("fulfilled");
  expect(b.status).toBe("fulfilled");
});

test("session keys are identical when tokens match", async () => {
  const [a, b] = await runPair(TOKEN_ALPHA, TOKEN_ALPHA);
  if (a.status !== "fulfilled" || b.status !== "fulfilled") throw new Error();
  expect(a.value.sessionKey).toEqual(b.value.sessionKey);
});

test("handshake fails when tokens differ", async () => {
  const [a, b] = await runPair(TOKEN_ALPHA, TOKEN_BETA);
  expect(a.status).toBe("rejected");
  expect(b.status).toBe("rejected");
});

test("failure message does not reveal which side failed", async () => {
  const [a, b] = await runPair(TOKEN_ALPHA, TOKEN_BETA);
  const msgs = [a, b]
    .filter((r) => r.status === "rejected")
    .map((r) => (r as PromiseRejectedResult).reason.message as string);
  expect(msgs.every((m) => m === "PAKE authentication failed")).toBe(true);
});

test("different tokens produce different session keys", async () => {
  const [a] = await runPair(TOKEN_ALPHA, TOKEN_ALPHA);
  const [b] = await runPair(TOKEN_BETA, TOKEN_BETA);
  if (a.status !== "fulfilled" || b.status !== "fulfilled") throw new Error();
  expect(a.value.sessionKey).not.toEqual(b.value.sessionKey);
});

test("session key is always a 32-byte Uint8Array", async () => {
  const [initiator, responder] = await runPair(TOKEN_ALPHA, TOKEN_ALPHA);
  if (initiator.status !== "fulfilled" || responder.status !== "fulfilled")
    throw new Error();
  expect(initiator.value.sessionKey).toBeInstanceOf(Uint8Array);
  expect(initiator.value.sessionKey.length).toBe(32);
  expect(responder.value.sessionKey).toBeInstanceOf(Uint8Array);
  expect(responder.value.sessionKey.length).toBe(32);
});

test("handshake times out if the peer never responds", async () => {
  // A silent peer must surface as the distinct handshake-timeout error rather
  // than hang forever. runSpake2 bounds each receive by HANDSHAKE_TIMEOUT_MS
  // (30 s); the effective deadline is the min of that and the connection's own
  // inactivity default, so a short bridge-level default fires this quickly
  // while exercising the same transport-error -> timeout-message path.
  const eventConn = new PassthroughConnection();
  const conn = fromEventConnection(eventConn, { inactivityTimeoutMs: 20 });
  await expect(runSpake2(conn, "responder", TOKEN_ALPHA)).rejects.toThrow(
    "PAKE handshake timed out",
  );
});

// --- Abort propagation on malformed peer messages ----------------------------
//
// Regression guard: every peer-input failure path on the receive side must
// send `{ pakeMsg: "abort" }` before throwing, so the partner stops waiting
// for the next protocol message immediately rather than timing out after 30s.
// Each test drives one end of an in-memory pipe by hand, injecting a malformed
// frame and then reading the partner's next frame to confirm the abort landed.

test("responder sends abort when initiator's msg1 has a malformed point", async () => {
  const [connA, connB] = makeConnections();
  const responder = runSpake2(connB, "responder", TOKEN_ALPHA);
  responder.catch(() => {});
  await connA.send({ pakeMsg: "1", point: "not-base64url!!" });
  await expect(responder).rejects.toThrow("PAKE authentication failed");
  expect(await connA.receive()).toEqual({ pakeMsg: "abort" });
});

test("responder sends abort when initiator's msg1 fails schema validation", async () => {
  const [connA, connB] = makeConnections();
  const responder = runSpake2(connB, "responder", TOKEN_ALPHA);
  responder.catch(() => {});
  // pakeMsg is correct but `point` is missing entirely.
  await connA.send({ pakeMsg: "1" });
  await expect(responder).rejects.toThrow("PAKE authentication failed");
  expect(await connA.receive()).toEqual({ pakeMsg: "abort" });
});

test("initiator sends abort when responder's msg2 has a malformed point", async () => {
  const [connA, connB] = makeConnections();
  const initiator = runSpake2(connA, "initiator", TOKEN_ALPHA);
  initiator.catch(() => {});

  // Receive A's msg1, then reply with a malformed msg2.
  const msg1 = await connB.receive();
  expect((msg1 as { pakeMsg?: unknown }).pakeMsg).toBe("1");
  await connB.send({ pakeMsg: "2", point: "not-base64url!!", mac: "AA" });

  await expect(initiator).rejects.toThrow("PAKE authentication failed");
  expect(await connB.receive()).toEqual({ pakeMsg: "abort" });
});

test("responder rejects with PAKE authentication failed when initiator's msg3 is an abort", async () => {
  // Exercises the `Spake2AbortSchema` branch of the responder's msg3 receive.
  // Both parties run runSpake2 with matching tokens so a valid msg1/msg2
  // round-trip occurs; the initiator's msg3 is then intercepted at the send
  // boundary and replaced with an abort. The responder must reject with the
  // generic PAKE-authentication-failed error (the abort is treated as an
  // authentication failure, not a special case).
  const [connA, connB] = makeConnections();

  // Wrap connA so a msg3 send is replaced with an abort; every other call
  // delegates to the real pipe end unchanged.
  const interceptedA: MessageConnection = {
    send: (data: unknown) => {
      if (
        typeof data === "object" &&
        data !== null &&
        (data as { pakeMsg?: unknown }).pakeMsg === "3"
      ) {
        return connA.send({ pakeMsg: "abort" });
      }
      return connA.send(data);
    },
    receive: (timeoutMs?: number) => connA.receive(timeoutMs),
    close: () => connA.close(),
  };

  const initiator = runSpake2(interceptedA, "initiator", TOKEN_ALPHA);
  initiator.catch(() => {});
  const responder = runSpake2(connB, "responder", TOKEN_ALPHA);

  await expect(responder).rejects.toThrow("PAKE authentication failed");
});

// --- authenticateConnection --------------------------------------------------

test("authenticateConnection succeeds with matching tokens", async () => {
  const [connA, connB] = makeConnections();
  const auth: Authentication = { pakeToken: TOKEN_ALPHA };
  const [a, b] = await Promise.allSettled([
    authenticateConnection(connA, auth, "initiator"),
    authenticateConnection(connB, auth, "responder"),
  ]);
  expect(a.status).toBe("fulfilled");
  expect(b.status).toBe("fulfilled");
});

test("authenticateConnection: newToken is identical on both sides", async () => {
  const [connA, connB] = makeConnections();
  const auth: Authentication = { pakeToken: TOKEN_ALPHA };
  const [a, b] = await Promise.all([
    authenticateConnection(connA, auth, "initiator"),
    authenticateConnection(connB, auth, "responder"),
  ]);
  expect(a.newToken).toBe(b.newToken);
});

test("authenticateConnection: newToken is a non-empty string", async () => {
  const [connA, connB] = makeConnections();
  const auth: Authentication = { pakeToken: TOKEN_ALPHA };
  const [a] = await Promise.all([
    authenticateConnection(connA, auth, "initiator"),
    authenticateConnection(connB, auth, "responder"),
  ]);
  expect(typeof a.newToken).toBe("string");
  expect(a.newToken.length).toBeGreaterThan(0);
});

test("authenticateConnection: newToken satisfies the pakeToken format constraint", async () => {
  const [connA, connB] = makeConnections();
  const auth: Authentication = { pakeToken: TOKEN_ALPHA };
  const [a] = await Promise.all([
    authenticateConnection(connA, auth, "initiator"),
    authenticateConnection(connB, auth, "responder"),
  ]);
  expect(PAKE_TOKEN_REGEX.test(a.newToken)).toBe(true);
});

test("authenticateConnection: different pakeTokens produce different newTokens", async () => {
  const [connA1, connB1] = makeConnections();
  const [connA2, connB2] = makeConnections();
  const [r1] = await Promise.all([
    authenticateConnection(connA1, { pakeToken: TOKEN_ALPHA }, "initiator"),
    authenticateConnection(connB1, { pakeToken: TOKEN_ALPHA }, "responder"),
  ]);
  const [r2] = await Promise.all([
    authenticateConnection(connA2, { pakeToken: TOKEN_BETA }, "initiator"),
    authenticateConnection(connB2, { pakeToken: TOKEN_BETA }, "responder"),
  ]);
  expect(r1.newToken).not.toBe(r2.newToken);
});

test("authenticateConnection: sessionKey is identical on both sides", async () => {
  const [connA, connB] = makeConnections();
  const auth: Authentication = { pakeToken: TOKEN_ALPHA };
  const [a, b] = await Promise.all([
    authenticateConnection(connA, auth, "initiator"),
    authenticateConnection(connB, auth, "responder"),
  ]);
  expect(a.sessionKey).toEqual(b.sessionKey);
});

test("authenticateConnection fails when tokens differ", async () => {
  const [connA, connB] = makeConnections();
  const [a, b] = await Promise.allSettled([
    authenticateConnection(connA, { pakeToken: TOKEN_ALPHA }, "initiator"),
    authenticateConnection(connB, { pakeToken: TOKEN_BETA }, "responder"),
  ]);
  expect(a.status).toBe("rejected");
  expect(b.status).toBe("rejected");
  const msgs = [a, b].map(
    (r) => (r as PromiseRejectedResult).reason.message as string,
  );
  expect(msgs.every((m) => m === "PAKE authentication failed")).toBe(true);
});

test("authenticateConnection throws when pakeToken is absent", async () => {
  const [connA] = makeConnections();
  await expect(authenticateConnection(connA, {}, "initiator")).rejects.toThrow(
    "pakeToken",
  );
});

test("authenticateConnection throws when pakeToken is not a valid base64url-encoded 32-byte value", async () => {
  const [connA] = makeConnections();
  await expect(
    authenticateConnection(connA, { pakeToken: "too-short" }, "initiator"),
  ).rejects.toThrow("pakeToken");
});

test("authenticateConnection throws when pakeToken is 43 characters but contains non-base64url characters", async () => {
  const [connA] = makeConnections();
  // 42 'A's + '=' is 43 chars but '=' is not in the base64url alphabet.
  const badToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  await expect(
    authenticateConnection(connA, { pakeToken: badToken }, "initiator"),
  ).rejects.toThrow("pakeToken");
});

test("authenticateConnection throws when pakeToken is 43 valid base64url characters but the final character is not in [AEIMQUYcgkosw048]", async () => {
  const [connA] = makeConnections();
  // 42 'A's + 'B': 43 chars, all base64url, but 'B' (index 1) is not in the
  // 16-character set [AEIMQUYcgkosw048] that encodes 4 data bits + 2 zero
  // padding bits for a 32-byte value.
  const badToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";
  await expect(
    authenticateConnection(connA, { pakeToken: badToken }, "initiator"),
  ).rejects.toThrow("pakeToken");
});

test("authenticateConnection throws when token is expired", async () => {
  const [connA] = makeConnections();
  const auth: Authentication = {
    pakeToken: TOKEN_ALPHA,
    expires: "2020-01-01T00:00:00Z",
  };
  await expect(
    authenticateConnection(connA, auth, "initiator"),
  ).rejects.toThrow("expired");
});

// --- Recovery-hint tagging ---------------------------------------------------
//
// Errors thrown by authenticateConnection's own validation checks carry a
// recovery hint in their message ("must re-invite" / "obtain a new invitation").
// They are tagged with `psilinkRecoveryHintEmitted: true` so a higher-level
// caller (e.g. the CLI) that adds a generic recovery advisory can suppress its
// own message and avoid contradicting the specific guidance. SPAKE2 protocol
// failures from runSpake2 are intentionally not tagged because their messages
// are generic and benefit from the caller's added advisory.

test("authenticateConnection tags malformed-pakeToken errors with psilinkRecoveryHintEmitted", async () => {
  const [connA] = makeConnections();
  const err = await authenticateConnection(
    connA,
    { pakeToken: "too-short" },
    "initiator",
  ).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect(
    (err as { psilinkRecoveryHintEmitted?: unknown })
      .psilinkRecoveryHintEmitted,
  ).toBe(true);
});

test("authenticateConnection tags pre-handshake-expiry errors with psilinkRecoveryHintEmitted", async () => {
  const [connA] = makeConnections();
  const err = await authenticateConnection(
    connA,
    { pakeToken: TOKEN_ALPHA, expires: "2020-01-01T00:00:00Z" },
    "initiator",
  ).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toContain("expired");
  expect(
    (err as { psilinkRecoveryHintEmitted?: unknown })
      .psilinkRecoveryHintEmitted,
  ).toBe(true);
});

test("authenticateConnection tags post-handshake-expiry errors with psilinkRecoveryHintEmitted", async () => {
  // Same setup as the "expires during the SPAKE2 round-trip" test below:
  // advance the clock past `expires` between the pre-check and the
  // post-handshake check so the second check fires.
  const expires = "2030-01-01T00:00:00.000Z";
  vi.useFakeTimers({
    toFake: ["Date"],
    now: new Date("2029-12-31T23:59:59.000Z"),
  });
  const [connA, connB] = makeConnections();
  const authPromise = Promise.allSettled([
    authenticateConnection(
      connA,
      { pakeToken: TOKEN_ALPHA, expires },
      "initiator",
    ),
    authenticateConnection(
      connB,
      { pakeToken: TOKEN_ALPHA, expires },
      "responder",
    ),
  ]);
  await Promise.resolve().then(() =>
    vi.setSystemTime(new Date("2030-01-01T00:00:01.000Z")),
  );
  const [resultA, resultB] = await authPromise;
  expect(resultA.status).toBe("rejected");
  expect(resultB.status).toBe("rejected");
  for (const result of [resultA, resultB] as PromiseRejectedResult[]) {
    expect(result.reason.message).toContain("during the SPAKE2 round-trip");
    expect(result.reason.psilinkRecoveryHintEmitted).toBe(true);
  }
});

test("authenticateConnection does NOT tag SPAKE2 'PAKE authentication failed' errors (generic)", async () => {
  // Generic SPAKE2 failures (wrong token, malformed peer message) carry the
  // intentionally-generic "PAKE authentication failed" message. They are not
  // tagged because the caller's generic recovery advisory adds useful context
  // ("retry first; if it still fails, re-invite").
  const [connA, connB] = makeConnections();
  const [a] = await Promise.allSettled([
    authenticateConnection(connA, { pakeToken: TOKEN_ALPHA }, "initiator"),
    authenticateConnection(connB, { pakeToken: TOKEN_BETA }, "responder"),
  ]);
  expect(a.status).toBe("rejected");
  const err = (a as PromiseRejectedResult).reason;
  expect(err.message).toBe("PAKE authentication failed");
  expect(
    (err as { psilinkRecoveryHintEmitted?: unknown })
      .psilinkRecoveryHintEmitted,
  ).toBeUndefined();
});

test("authenticateConnection throws when token expires during the SPAKE2 round-trip", async () => {
  // This exercises the second expiry check (after runSpake2 returns) rather
  // than the first (before it starts). The pre-checks run synchronously when
  // authenticateConnection is first called, before any await; the SPAKE2
  // round-trip then proceeds across many async hops (in-memory message
  // delivery plus real WebCrypto). A microtask scheduled now
  // (Promise.resolve().then) advances the fake clock past `expires` while the
  // handshake is still in flight, so the post-handshake checks — which run
  // only after both runSpake2 calls resolve — see the token as expired.
  const expires = "2030-01-01T00:00:00.000Z";
  vi.useFakeTimers({
    toFake: ["Date"],
    now: new Date("2029-12-31T23:59:59.000Z"),
  });
  const [connA, connB] = makeConnections();
  const authPromise = Promise.allSettled([
    authenticateConnection(
      connA,
      { pakeToken: TOKEN_ALPHA, expires },
      "initiator",
    ),
    authenticateConnection(
      connB,
      { pakeToken: TOKEN_ALPHA, expires },
      "responder",
    ),
  ]);
  // Advance past expires while the SPAKE2 round-trip is still in flight.
  await Promise.resolve().then(() =>
    vi.setSystemTime(new Date("2030-01-01T00:00:01.000Z")),
  );
  const [resultA, resultB] = await authPromise;
  expect(resultA.status).toBe("rejected");
  expect(resultB.status).toBe("rejected");
  expect((resultA as PromiseRejectedResult).reason.message).toContain(
    "during the SPAKE2 round-trip",
  );
  expect((resultB as PromiseRejectedResult).reason.message).toContain(
    "during the SPAKE2 round-trip",
  );
});

test("authenticateConnection accepts a token that has not yet expired", async () => {
  const [connA, connB] = makeConnections();
  const auth: Authentication = {
    pakeToken: TOKEN_ALPHA,
    expires: "2099-01-01T00:00:00Z",
  };
  const [a, b] = await Promise.allSettled([
    authenticateConnection(connA, auth, "initiator"),
    authenticateConnection(connB, auth, "responder"),
  ]);
  expect(a.status).toBe("fulfilled");
  expect(b.status).toBe("fulfilled");
});

test("authenticateConnection: newToken differs between successive handshake rounds", async () => {
  // Each runSpake2 call uses fresh random scalars, so sessionKey (and thus
  // newToken) differs every round even with the same pakeToken.
  const auth: Authentication = { pakeToken: TOKEN_ALPHA };
  const [connA1, connB1] = makeConnections();
  const [connA2, connB2] = makeConnections();
  const [r1] = await Promise.all([
    authenticateConnection(connA1, auth, "initiator"),
    authenticateConnection(connB1, auth, "responder"),
  ]);
  const [r2] = await Promise.all([
    authenticateConnection(connA2, auth, "initiator"),
    authenticateConnection(connB2, auth, "responder"),
  ]);
  expect(r1.newToken).not.toBe(r2.newToken);
});

// --- deriveAeadKey -----------------------------------------------------------

test("deriveAeadKey returns 32 bytes", async () => {
  const key = await deriveAeadKey(new Uint8Array(32), "sftp-aead");
  expect(key).toHaveLength(32);
});

test("deriveAeadKey derives a stable 32-byte key for each allowed label", async () => {
  const sessionKey = new Uint8Array(32).fill(0x42);
  for (const context of AEAD_CONTEXTS) {
    const k1 = await deriveAeadKey(sessionKey, context);
    const k2 = await deriveAeadKey(sessionKey, context);
    expect(k1).toHaveLength(32);
    expect(k1).toEqual(k2);
  }
});

test("deriveAeadKey differs for different context labels", async () => {
  const sessionKey = new Uint8Array(32).fill(0x01);
  const k1 = await deriveAeadKey(sessionKey, "sftp-aead");
  const k2 = await deriveAeadKey(sessionKey, "filedrop-aead");
  expect(k1).not.toEqual(k2);
});

test("deriveAeadKey differs for different session keys", async () => {
  const k1 = await deriveAeadKey(new Uint8Array(32).fill(0x01), "sftp-aead");
  const k2 = await deriveAeadKey(new Uint8Array(32).fill(0x02), "sftp-aead");
  expect(k1).not.toEqual(k2);
});

test("every AEAD_CONTEXTS label is printable ASCII", () => {
  // The runtime guard's soundness against a non-NFC context rests on every
  // allowed label being ASCII (ASCII has a single NFC form). Enforce the
  // documented "ASCII-only" invariant mechanically so a future non-ASCII label
  // fails here at the point of addition rather than silently.
  for (const context of AEAD_CONTEXTS) {
    expect(context).toMatch(/^[\x21-\x7e]+$/);
  }
});

test("deriveAeadKey rejects a context outside the fixed set", async () => {
  const sessionKey = new Uint8Array(32).fill(0x01);
  // An untyped (plain-JS or `as`-cast) caller can bypass the compile-time
  // AeadContext constraint with a free-form, empty, or non-ASCII label; the
  // runtime guard must fail fast rather than silently derive a key the two
  // parties may not agree on.
  for (const bad of ["sftp", "", "cafe-aead́", "é-aead"]) {
    await expect(
      deriveAeadKey(sessionKey, bad as unknown as AeadContext),
    ).rejects.toThrow(/unknown AEAD context/);
  }
});

test("both sides produce the same AEAD key after a successful handshake", async () => {
  const [connA, connB] = makeConnections();
  const auth: Authentication = { pakeToken: TOKEN_ALPHA };
  const [a, b] = await Promise.all([
    authenticateConnection(connA, auth, "initiator"),
    authenticateConnection(connB, auth, "responder"),
  ]);
  const keyA = await deriveAeadKey(a.sessionKey, "sftp-aead");
  const keyB = await deriveAeadKey(b.sessionKey, "sftp-aead");
  expect(keyA).toEqual(keyB);
});
