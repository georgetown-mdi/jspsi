import { afterEach, expect, test, vi } from "vitest";

afterEach(() => vi.useRealTimers());

import { p256_hasher } from "@noble/curves/nist.js";
import { runSpake2 } from "../src/pake";
import { authenticateConnection, deriveAeadKey } from "../src/auth";
import { PAKE_TOKEN_REGEX } from "../src/config/connection";
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

// --- Buffered-error consumption ----------------------------------------------
//
// Regression guard for the listener gap addressed by takeBufferedError(). An
// `error` emitted while no listener is attached is buffered on the connection;
// the next protocol-layer receive must consume it and reject the promise
// rather than registering a fresh listener that waits indefinitely.

test("runSpake2 rejects with the buffered error when one was emitted before the call", async () => {
  const [connA] = makeConnections();
  const buffered = new Error("poller error during gap");
  // Emit before any listener is registered so the error is buffered rather
  // than dispatched. PassthroughConnection mirrors FileSyncConnection's emit
  // override for this purpose.
  connA.emit("error", buffered);
  await expect(runSpake2(connA, "responder", TOKEN_ALPHA)).rejects.toThrow(
    "poller error during gap",
  );
});

test("runSpake2 initiator consumes a buffered error before sending msg1", async () => {
  const [connA, connB] = makeConnections();
  // Capture anything sent by connA; if the initiator short-circuits on a
  // buffered error before sending msg1, connB must see nothing.
  const observed: unknown[] = [];
  connB.on("data", (m) => observed.push(m));
  connA.emit("error", new Error("poller error during gap"));
  await expect(runSpake2(connA, "initiator", TOKEN_ALPHA)).rejects.toThrow(
    "poller error during gap",
  );
  // Allow any setImmediate-queued sends to drain before asserting.
  await new Promise<void>((r) => setImmediate(r));
  expect(observed).toEqual([]);
});

test("PassthroughConnection.takeBufferedError clears the buffered error after one read", () => {
  const [connA] = makeConnections();
  connA.emit("error", new Error("first"));
  expect((connA.takeBufferedError() as Error).message).toBe("first");
  expect(connA.takeBufferedError()).toBeUndefined();
});

test("PassthroughConnection.emit does not buffer when an error listener is attached", () => {
  const [connA] = makeConnections();
  const observed: unknown[] = [];
  connA.on("error", (err) => observed.push(err));
  connA.emit("error", new Error("delivered to listener"));
  expect(observed).toHaveLength(1);
  expect(connA.takeBufferedError()).toBeUndefined();
});

// --- Abort propagation on malformed peer messages ----------------------------
//
// Regression guard: every peer-input failure path on the receive side must
// send `{ pakeMsg: "abort" }` before throwing, so the partner stops waiting
// for the next protocol message immediately rather than timing out after 30s.

// PassthroughConnection.send dispatches messages via setImmediate. When
// runSpake2 throws after calling sendAbort(), the abort's delivery is still
// pending in the setImmediate queue at the moment the rejection propagates.
// `drainSetImmediate` lets queued callbacks fire so we can observe the abort
// at the partner end.
const drainSetImmediate = () => new Promise<void>((r) => setImmediate(r));

const isAbort = (m: unknown) =>
  typeof m === "object" &&
  m !== null &&
  (m as { pakeMsg?: unknown }).pakeMsg === "abort";

test("responder sends abort when initiator's msg1 has a malformed point", async () => {
  const [connA, connB] = makeConnections();
  const aborts: unknown[] = [];
  connA.on("data", (m) => aborts.push(m));
  const responder = runSpake2(connB, "responder", TOKEN_ALPHA);
  responder.catch(() => {});
  // Send malformed msg1 from A to B directly.
  connA.send({ pakeMsg: "1", point: "not-base64url!!" });
  await expect(responder).rejects.toThrow("PAKE authentication failed");
  await drainSetImmediate();
  expect(aborts.some(isAbort)).toBe(true);
});

test("responder sends abort when initiator's msg1 fails schema validation", async () => {
  const [connA, connB] = makeConnections();
  const aborts: unknown[] = [];
  connA.on("data", (m) => aborts.push(m));
  const responder = runSpake2(connB, "responder", TOKEN_ALPHA);
  responder.catch(() => {});
  // pakeMsg is correct but `point` is missing entirely.
  connA.send({ pakeMsg: "1" });
  await expect(responder).rejects.toThrow("PAKE authentication failed");
  await drainSetImmediate();
  expect(aborts.some(isAbort)).toBe(true);
});

test("initiator sends abort when responder's msg2 has a malformed point", async () => {
  const [connA, connB] = makeConnections();
  const aborts: unknown[] = [];
  // Capture aborts arriving at B (the side that sent the malformed msg2).
  // The runSpake2 responder is NOT running here; we inject msg2 manually.
  connB.on("data", (m) => {
    if (isAbort(m)) aborts.push(m);
  });
  const initiator = runSpake2(connA, "initiator", TOKEN_ALPHA);
  initiator.catch(() => {});

  // Wait for A's msg1 to arrive at B, then respond with malformed msg2.
  await new Promise<void>((resolve) => {
    const onMsg1 = (m: unknown) => {
      if (
        typeof m === "object" &&
        m !== null &&
        (m as { pakeMsg?: unknown }).pakeMsg === "1"
      ) {
        connB.removeListener("data", onMsg1);
        connB.send({
          pakeMsg: "2",
          point: "not-base64url!!",
          mac: "AA",
        });
        resolve();
      }
    };
    connB.on("data", onMsg1);
  });

  await expect(initiator).rejects.toThrow("PAKE authentication failed");
  await drainSetImmediate();
  expect(aborts.length).toBeGreaterThan(0);
});

test("responder rejects with PAKE authentication failed when initiator's msg3 is an abort", async () => {
  // Exercises the `Spake2AbortSchema` branch of the responder's msg3 receive
  // (pake.ts line ~472). Both parties run runSpake2 with matching tokens so
  // a valid msg1/msg2 round-trip occurs; the initiator's msg3 is then
  // intercepted at the send boundary and replaced with an abort. The
  // responder must reject with the generic PAKE-authentication-failed error
  // (the abort is treated as an authentication failure, not a special case).
  const [connA, connB] = makeConnections();

  // Intercept connA.send: a valid msg3 is replaced with abort; other messages
  // pass through unchanged. Bind the original prototype method via .call to
  // avoid `this` being lost after reassignment, then write the replacement
  // to the instance (shadowing the prototype method).
  const realSend = connA.send.bind(connA);
  (connA as { send: (data: unknown) => void }).send = (data: unknown) => {
    if (
      typeof data === "object" &&
      data !== null &&
      (data as { pakeMsg?: unknown }).pakeMsg === "3"
    ) {
      return realSend({ pakeMsg: "abort" });
    }
    return realSend(data);
  };

  const initiator = runSpake2(connA, "initiator", TOKEN_ALPHA);
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
  // than the first (before it starts). The pre-checks run synchronously
  // before the first `await runSpake2`; PassthroughConnection delivers
  // messages via setImmediate, so SPAKE2 completes across multiple event
  // loop ticks. A microtask (Promise.resolve().then) fires before the first
  // setImmediate callback, advancing the fake clock past `expires` so the
  // post-handshake checks — which run after all setImmediate callbacks —
  // see the token as expired.
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
  // Advance past expires before any setImmediate (SPAKE2 message delivery) fires.
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
