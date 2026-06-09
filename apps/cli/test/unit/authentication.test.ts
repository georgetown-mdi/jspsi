import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";
import {
  FileSyncConnection,
  fromEventConnection,
  authenticateConnection,
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
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConn(): FileSyncConnection {
  return new FileSyncConnection(new LocalFSClient(), { verbose: -1 });
}

// Opens and synchronizes both connections, then bridges each event-based
// FileSyncConnection into the pull-based MessageConnection that
// authenticateConnection consumes - mirroring how runProtocol wires the
// transport. The bridge attaches before any PAKE frame is in flight (the
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
// Each party's last outgoing PAKE message is consumed by the peer's poller
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
    authenticateConnection(mcA, { sharedSecret: TOKEN_A }, roleA),
    authenticateConnection(mcB, { sharedSecret: TOKEN_A }, roleB),
  ]).finally(() => teardown(connA, connB));

  expect(a.newToken).toBe(b.newToken);
  expect(a.newToken).not.toBe(TOKEN_A);
  expect(SHARED_SECRET_REGEX.test(a.newToken)).toBe(true);
});

test("rotated token written to the key file carries no expiry", async () => {
  const connA = makeConn();
  const connB = makeConn();

  const [mcA, mcB] = await openAndSync(connA, connB);

  expect(connA.handshakeRole).toBeDefined();
  const roleA = connA.handshakeRole as HandshakeRole;
  expect(connB.handshakeRole).toBeDefined();
  const roleB = connB.handshakeRole as HandshakeRole;

  const [{ newToken }] = await Promise.all([
    authenticateConnection(mcA, { sharedSecret: TOKEN_A }, roleA),
    authenticateConnection(mcB, { sharedSecret: TOKEN_A }, roleB),
  ]).finally(() => teardown(connA, connB));

  const keyFilePath = path.join(tmpDir, "rotated.key");
  saveKeyFile(keyFilePath, { sharedSecret: newToken });

  const loaded = loadKeyFile(keyFilePath);
  expect(loaded?.sharedSecret).toBe(newToken);
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
    ),
  ).rejects.toThrow("PAKE token expired");
});

test("authentication throws for a token that is not 43 base64url characters", async () => {
  const mc = fromEventConnection(makeConn());
  await expect(
    authenticateConnection(mc, { sharedSecret: "tooshort" }, "initiator"),
  ).rejects.toThrow(
    "authentication.sharedSecret must be a base64url-encoded 32-byte value",
  );
});

test("authentication throws for a token containing non-base64url characters", async () => {
  const mc = fromEventConnection(makeConn());
  // 43 chars but contains '=' (standard base64 padding, not valid base64url)
  const badToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  await expect(
    authenticateConnection(mc, { sharedSecret: badToken }, "initiator"),
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
    authenticateConnection(mc, { sharedSecret: badToken }, "initiator"),
  ).rejects.toThrow(
    "authentication.sharedSecret must be a base64url-encoded 32-byte value",
  );
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
    authenticateConnection(mcA, { sharedSecret: TOKEN_A }, roleA),
    authenticateConnection(mcB, { sharedSecret: TOKEN_B }, roleB),
  ]).finally(() => teardown(connA, connB));

  expect(resultA.status).toBe("rejected");
  expect(resultB.status).toBe("rejected");
  expect((resultA as PromiseRejectedResult).reason).toBeInstanceOf(Error);
  expect((resultA as PromiseRejectedResult).reason.message).toContain(
    "PAKE authentication failed",
  );
  expect((resultB as PromiseRejectedResult).reason).toBeInstanceOf(Error);
  expect((resultB as PromiseRejectedResult).reason.message).toContain(
    "PAKE authentication failed",
  );
});
