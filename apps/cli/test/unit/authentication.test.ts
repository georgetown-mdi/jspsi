import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  FileSyncConnection,
  fromEventConnection,
  authenticateConnection,
  createMessagePipe,
  SHARED_SECRET_REGEX,
} from "@psilink/core";
import type { HandshakeRole, MessageConnection } from "@psilink/core";

import { LocalFSClient } from "../../src/connection/localFSClient";
import { loadKeyFile, saveKeyFile } from "../../src/keyFile";

// 32 zero bytes and 32 0x01 bytes, each in base64url without padding (43 chars)
const TOKEN_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN_B = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

let tmpDir: string;
let dropDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-auth-test-"));
  dropDir = path.join(tmpDir, "drop");
  fs.mkdirSync(dropDir);
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConn(): FileSyncConnection {
  return new FileSyncConnection(new LocalFSClient(), { verbose: -1 });
}

// Opens and synchronizes both connections, then bridges each event-based
// FileSyncConnection into the pull-based MessageConnection that
// authenticateConnection consumes - mirroring how runProtocol wires the
// transport. The bridge attaches before any key-exchange frame is in flight (the
// initiator's first message is sent inside authenticateConnection), so no
// inbound data can slip past between start() and the bridge.
async function openAndSync(
  connA: FileSyncConnection,
  connB: FileSyncConnection,
): Promise<[MessageConnection, MessageConnection]> {
  const config = { channel: "filedrop" as const, path: dropDir };
  await Promise.all([connA.open(config), connB.open(config)]);
  await Promise.all([connA.synchronize(), connB.synchronize()]);
  connA.start();
  connB.start();
  return [fromEventConnection(connA), fromEventConnection(connB)];
}

// Call teardown only after both parties have completed authentication
// (i.e., as a .finally() on the Promise.all that awaits both auth calls).
// Each party's last outgoing key-exchange message is consumed by the peer's poller
// before authenticateConnection() returns, so cleanup() can safely delete
// the responsible files with no TOCTOU race.
async function teardown(
  connA: FileSyncConnection,
  connB: FileSyncConnection,
): Promise<void> {
  connA.stop();
  connB.stop();
  await Promise.allSettled([connA.cleanup(), connB.cleanup()]);
  await Promise.allSettled([connA.close(), connB.close()]);
}

// --- Token rotation ----------------------------------------------------------

test("both parties derive the same rotated token over a real connection", async () => {
  const connA = makeConn();
  const connB = makeConn();

  const [mcA, mcB] = await openAndSync(connA, connB);

  expect(connA.handshakeRole).toBeDefined();
  const roleA = connA.handshakeRole as HandshakeRole;
  expect(connB.handshakeRole).toBeDefined();
  const roleB = connB.handshakeRole as HandshakeRole;

  const [a, b] = await Promise.all([
    authenticateConnection(mcA, { sharedSecret: TOKEN_A }, roleA, true),
    authenticateConnection(mcB, { sharedSecret: TOKEN_A }, roleB, true),
  ]).finally(() => teardown(connA, connB));

  expect(a.rotatedSecret).toBe(b.rotatedSecret);
  expect(a.rotatedSecret).not.toBe(TOKEN_A);
  expect(SHARED_SECRET_REGEX.test(a.rotatedSecret)).toBe(true);
  // Both parties requested encryption, so both surface the same wrap decision.
  expect(a.applyEncryption).toBe(true);
  expect(b.applyEncryption).toBe(true);
});

test("applyEncryption surfaces own-OR-peer through authenticateConnection across flag combinations", async () => {
  // The OR semantics are pinned at the runKex layer; this asserts they survive
  // through authenticateConnection, whose AuthResult now carries applyEncryption.
  // All four combinations are exercised so the auth layer pins both the
  // unencrypted (false, false) -> false decision and the own-OR-peer rule on its
  // own, rather than leaning on the (true, true) success path above. Run over an
  // in-memory pipe -- the handshake completes the same as over a real transport,
  // without the file-drop setup the rotation tests need.
  const combos: Array<[boolean, boolean, boolean]> = [
    [false, false, false],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ];
  for (const [reqInit, reqResp, expected] of combos) {
    const [a, b] = createMessagePipe();
    const [resA, resB] = await Promise.all([
      authenticateConnection(a, { sharedSecret: TOKEN_A }, "initiator", reqInit),
      authenticateConnection(b, { sharedSecret: TOKEN_A }, "responder", reqResp),
    ]);
    expect(resA.applyEncryption).toBe(expected);
    expect(resB.applyEncryption).toBe(expected);
    // The rotated secret still agrees regardless of the flag values.
    expect(resA.rotatedSecret).toBe(resB.rotatedSecret);
  }
});

test("rotated token written to the key file carries no expiry", async () => {
  const connA = makeConn();
  const connB = makeConn();

  const [mcA, mcB] = await openAndSync(connA, connB);

  expect(connA.handshakeRole).toBeDefined();
  const roleA = connA.handshakeRole as HandshakeRole;
  expect(connB.handshakeRole).toBeDefined();
  const roleB = connB.handshakeRole as HandshakeRole;

  const [{ rotatedSecret }] = await Promise.all([
    authenticateConnection(mcA, { sharedSecret: TOKEN_A }, roleA, true),
    authenticateConnection(mcB, { sharedSecret: TOKEN_A }, roleB, true),
  ]).finally(() => teardown(connA, connB));

  const keyFilePath = path.join(tmpDir, "rotated.key");
  saveKeyFile(keyFilePath, { sharedSecret: rotatedSecret });

  const loaded = loadKeyFile(keyFilePath);
  expect(loaded?.sharedSecret).toBe(rotatedSecret);
  expect(loaded?.expires).toBeUndefined();
});

// --- Input validation --------------------------------------------------------

test("authentication throws for an expired token without opening a connection", async () => {
  const mc = fromEventConnection(makeConn());
  await expect(
    authenticateConnection(
      mc,
      { sharedSecret: TOKEN_A, expires: "2000-01-01T00:00:00.000Z" },
      "initiator",
      true,
    ),
  ).rejects.toThrow("shared secret expired");
});

test("authentication tags a pre-handshake-expiry error with psilinkRecoveryHintEmitted", async () => {
  const mc = fromEventConnection(makeConn());
  // Direct tag assertion, symmetric with the malformed-secret and post-
  // handshake-expiry paths: the pre-handshake expiry error (checked before any
  // network activity) carries the recovery-hint tag so the CLI surfaces its
  // specific "re-invite" instruction instead of the generic advisory.
  const err = await authenticateConnection(
    mc,
    { sharedSecret: TOKEN_A, expires: "2000-01-01T00:00:00.000Z" },
    "initiator",
    true,
  ).catch((e: unknown) => e);
  expect(
    (err as { psilinkRecoveryHintEmitted?: unknown })
      .psilinkRecoveryHintEmitted,
  ).toBe(true);
});

test("authentication throws for a token that is not 43 base64url characters", async () => {
  const mc = fromEventConnection(makeConn());
  await expect(
    authenticateConnection(mc, { sharedSecret: "tooshort" }, "initiator", true),
  ).rejects.toThrow(
    "authentication.sharedSecret must be a base64url-encoded 32-byte value",
  );
});

test("authentication throws for a token containing non-base64url characters", async () => {
  const mc = fromEventConnection(makeConn());
  // 43 chars but contains '=' (standard base64 padding, not valid base64url)
  const badToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  await expect(
    authenticateConnection(mc, { sharedSecret: badToken }, "initiator", true),
  ).rejects.toThrow(
    "authentication.sharedSecret must be a base64url-encoded 32-byte value",
  );
});

test("authentication throws for a token with valid base64url characters but wrong final character", async () => {
  const mc = fromEventConnection(makeConn());
  // 42 'A's + 'B': all valid base64url characters, but 'B' is not in
  // [AEIMQUYcgkosw048] — the 16-character set that encodes 4 data bits +
  // 2 zero padding bits for a 32-byte value.
  const badToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";
  await expect(
    authenticateConnection(mc, { sharedSecret: badToken }, "initiator", true),
  ).rejects.toThrow(
    "authentication.sharedSecret must be a base64url-encoded 32-byte value",
  );
});

test("authentication tags a malformed-secret error with psilinkRecoveryHintEmitted", async () => {
  const mc = fromEventConnection(makeConn());
  // The secret-format error carries the recovery-hint tag so the CLI surfaces
  // its specific "re-invite" instruction instead of stacking the generic
  // transport-failure advisory on top (see runProtocol's catch).
  const err = await authenticateConnection(
    mc,
    { sharedSecret: "tooshort" },
    "initiator",
    true,
  ).catch((e: unknown) => e);
  expect(
    (err as { psilinkRecoveryHintEmitted?: unknown })
      .psilinkRecoveryHintEmitted,
  ).toBe(true);
});

// --- Authentication failure --------------------------------------------------

test("authentication throws when tokens differ", async () => {
  const connA = makeConn();
  const connB = makeConn();

  const [mcA, mcB] = await openAndSync(connA, connB);

  expect(connA.handshakeRole).toBeDefined();
  const roleA = connA.handshakeRole as HandshakeRole;
  expect(connB.handshakeRole).toBeDefined();
  const roleB = connB.handshakeRole as HandshakeRole;

  const [resultA, resultB] = await Promise.allSettled([
    authenticateConnection(mcA, { sharedSecret: TOKEN_A }, roleA, true),
    authenticateConnection(mcB, { sharedSecret: TOKEN_B }, roleB, true),
  ]).finally(() => teardown(connA, connB));

  expect(resultA.status).toBe("rejected");
  expect(resultB.status).toBe("rejected");
  expect((resultA as PromiseRejectedResult).reason).toBeInstanceOf(Error);
  expect((resultA as PromiseRejectedResult).reason.message).toContain(
    "key exchange authentication failed",
  );
  expect((resultB as PromiseRejectedResult).reason).toBeInstanceOf(Error);
  expect((resultB as PromiseRejectedResult).reason.message).toContain(
    "key exchange authentication failed",
  );
});

// --- Legacy proof-of-concept client interop ----------------------------------
//
// SPAKE2 has been removed; the X25519 key exchange is wire-incompatible with it.
// An old proof-of-concept client speaks the SPAKE2 frame shape (`pakeMsg` /
// `point` / `mac`), which fails the new strict `.strict()` message schemas. Both
// directions must fail closed with the single generic, non-oracular error and
// without hanging -- not crash opaquely or stall until the handshake timeout.

test("a legacy SPAKE2-shaped first message fails a new responder with a clean error", async () => {
  const [a, b] = createMessagePipe();
  // `a` is the new responder running the X25519 handshake via authenticateConnection.
  const newSide = authenticateConnection(
    a,
    { sharedSecret: TOKEN_A },
    "responder",
    true,
  );
  // `b` is the legacy client: it opens with a SPAKE2 message-1 shape.
  await b.send({ pakeMsg: "1", point: TOKEN_A });
  await expect(newSide).rejects.toThrow("key exchange authentication failed");
});

test("a legacy SPAKE2-shaped reply fails a new initiator with a clean error", async () => {
  const [a, b] = createMessagePipe();
  // `a` is the new initiator; it sends X25519 message 1 first.
  const newSide = authenticateConnection(
    a,
    { sharedSecret: TOKEN_A },
    "initiator",
    true,
  );
  // `b` is the legacy responder: it consumes the initiator's frame and replies
  // with a SPAKE2 message-2 shape, which the new initiator cannot parse.
  await b.receive();
  await b.send({ pakeMsg: "2", point: TOKEN_A, mac: TOKEN_A });
  await expect(newSide).rejects.toThrow("key exchange authentication failed");
});

// --- Post-handshake expiry ---------------------------------------------------
//
// authenticateConnection checks `expires` twice: once synchronously before the
// key exchange starts, and once after runKex returns, to catch a secret that
// expires *during* the round-trip. Only the pre-handshake check is covered
// above ("authentication throws for an expired token..."); these two tests
// drive the post-handshake branch (auth.ts) by faking only Date: start the
// clock just before `expires`, kick off both sides over an in-memory pipe (no
// real-timer coupling, so the handshake still completes), then advance the
// clock past `expires` in a microtask while the round-trip is in flight. The
// post-handshake checks -- which run only after both runKex calls resolve --
// then see the secret as expired. (Ported from the deleted pake.test.ts, which
// covered the equivalent SPAKE2 branch before the X25519 cutover.)

test("authentication throws when the shared secret expires during the key-exchange round-trip", async () => {
  const expires = "2030-01-01T00:00:00.000Z";
  vi.useFakeTimers({
    toFake: ["Date"],
    now: new Date("2029-12-31T23:59:59.000Z"),
  });
  const [a, b] = createMessagePipe();
  const authPromise = Promise.allSettled([
    authenticateConnection(
      a,
      { sharedSecret: TOKEN_A, expires },
      "initiator",
      true,
    ),
    authenticateConnection(
      b,
      { sharedSecret: TOKEN_A, expires },
      "responder",
      true,
    ),
  ]);
  // Advance past expires while the round-trip is still in flight.
  await Promise.resolve().then(() =>
    vi.setSystemTime(new Date("2030-01-01T00:00:01.000Z")),
  );
  const [resultA, resultB] = await authPromise;
  expect(resultA.status).toBe("rejected");
  expect(resultB.status).toBe("rejected");
  expect((resultA as PromiseRejectedResult).reason.message).toContain(
    "during the key-exchange round-trip",
  );
  expect((resultB as PromiseRejectedResult).reason.message).toContain(
    "during the key-exchange round-trip",
  );
});

test("authentication tags post-handshake-expiry errors with psilinkRecoveryHintEmitted", async () => {
  const expires = "2030-01-01T00:00:00.000Z";
  vi.useFakeTimers({
    toFake: ["Date"],
    now: new Date("2029-12-31T23:59:59.000Z"),
  });
  const [a, b] = createMessagePipe();
  const authPromise = Promise.allSettled([
    authenticateConnection(
      a,
      { sharedSecret: TOKEN_A, expires },
      "initiator",
      true,
    ),
    authenticateConnection(
      b,
      { sharedSecret: TOKEN_A, expires },
      "responder",
      true,
    ),
  ]);
  await Promise.resolve().then(() =>
    vi.setSystemTime(new Date("2030-01-01T00:00:01.000Z")),
  );
  const [resultA, resultB] = await authPromise;
  expect(resultA.status).toBe("rejected");
  expect(resultB.status).toBe("rejected");
  // Tagged so the CLI surfaces a re-invite hint instead of the generic
  // transport-failure advisory.
  for (const result of [resultA, resultB] as PromiseRejectedResult[]) {
    expect(result.reason.message).toContain(
      "during the key-exchange round-trip",
    );
    expect(result.reason.psilinkRecoveryHintEmitted).toBe(true);
  }
});
