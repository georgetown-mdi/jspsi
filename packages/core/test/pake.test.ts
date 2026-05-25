import { afterEach, expect, test, vi } from "vitest";

afterEach(() => vi.useRealTimers());

import { p256_hasher } from "@noble/curves/nist.js";
import { runSpake2 } from "../src/pake";
import { authenticateConnection, deriveAeadKey } from "../src/auth";
import type { Authentication } from "../src/config/connection";
import { PassthroughConnection } from "./utils/passthroughConnection";

// --- Token constants ---------------------------------------------------------

// Base64url encoding of 32 bytes of 0x00 and 0x01.  Exactly 43 characters,
// satisfying the pakeToken format constraint.
const TOKEN_ALPHA = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN_BETA = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

// --- Helpers -----------------------------------------------------------------

function makeConnections(): [PassthroughConnection, PassthroughConnection] {
  const a = new PassthroughConnection();
  const b = new PassthroughConnection(a);
  a.setOther(b);
  return [a, b];
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

test("listeners are removed after a successful handshake", async () => {
  const [connA, connB] = makeConnections();
  await Promise.all([
    runSpake2(connA, "initiator", TOKEN_ALPHA),
    runSpake2(connB, "responder", TOKEN_ALPHA),
  ]);
  expect(connA.listenerCount("data")).toBe(0);
  expect(connB.listenerCount("data")).toBe(0);
});

test("listeners are removed after a failed handshake", async () => {
  const [connA, connB] = makeConnections();
  await Promise.allSettled([
    runSpake2(connA, "initiator", TOKEN_ALPHA),
    runSpake2(connB, "responder", TOKEN_BETA),
  ]);
  expect(connA.listenerCount("data")).toBe(0);
  expect(connB.listenerCount("data")).toBe(0);
});

test("handshake times out if the peer never responds", async () => {
  // Only fake setTimeout/clearTimeout so setImmediate remains real; that lets
  // vi.advanceTimersByTimeAsync interleave real async work (WebCrypto) between
  // ticks so runSpake2 reaches `await msg1Promise` before the timeout fires.
  // The responder role is used because it calls receive() synchronously before
  // any await, installing the fake setTimeout before the first yield.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const [connA] = makeConnections();
  const promise = runSpake2(connA, "responder", TOKEN_ALPHA);
  // Without this, the runSpake2 promise would be briefly unhandled between
  // when the timeout fires and when `await expect(...).rejects` is reached.
  promise.catch(() => {});
  await vi.advanceTimersByTimeAsync(30_000);
  await expect(promise).rejects.toThrow("PAKE handshake timed out");
});

test("listener is removed after timeout", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const [connA] = makeConnections();
  const promise = runSpake2(connA, "responder", TOKEN_ALPHA).catch(() => {});
  await vi.advanceTimersByTimeAsync(30_000);
  await promise;
  expect(connA.listenerCount("data")).toBe(0);
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
  expect(/^[A-Za-z0-9_-]{43}$/.test(a.newToken)).toBe(true);
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

// --- deriveAeadKey -----------------------------------------------------------

test("deriveAeadKey returns 32 bytes", async () => {
  const key = await deriveAeadKey(new Uint8Array(32), "sftp-aead");
  expect(key).toHaveLength(32);
});

test("deriveAeadKey is deterministic for the same inputs", async () => {
  const sessionKey = new Uint8Array(32).fill(0x42);
  const k1 = await deriveAeadKey(sessionKey, "test");
  const k2 = await deriveAeadKey(sessionKey, "test");
  expect(k1).toEqual(k2);
});

test("deriveAeadKey differs for different context strings", async () => {
  const sessionKey = new Uint8Array(32).fill(0x01);
  const k1 = await deriveAeadKey(sessionKey, "ctx-a");
  const k2 = await deriveAeadKey(sessionKey, "ctx-b");
  expect(k1).not.toEqual(k2);
});

test("deriveAeadKey differs for different session keys", async () => {
  const k1 = await deriveAeadKey(new Uint8Array(32).fill(0x01), "ctx");
  const k2 = await deriveAeadKey(new Uint8Array(32).fill(0x02), "ctx");
  expect(k1).not.toEqual(k2);
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
