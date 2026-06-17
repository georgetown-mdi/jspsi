import { afterEach, expect, test } from "vitest";
import { UsageError } from "@psilink/core";
import type { ConnectionConfig } from "@psilink/core";

import { establishHostKeyTrust } from "../../src/hostKeyTrust";

// establishHostKeyTrust gates the interactive prompt on stdin being a TTY. The
// tests drive that flag deterministically and restore it afterward; the
// non-interactive default (isTTY undefined) is what an automated run sees.
const originalIsTTY = process.stdin.isTTY;
afterEach(() => {
  process.stdin.isTTY = originalIsTTY;
});

test("is a no-op for a non-sftp channel (no host key to establish)", async () => {
  const conn: ConnectionConfig = { channel: "filedrop", path: "/mnt/share" };
  // Resolves without throwing or touching the network, even non-interactively.
  process.stdin.isTTY = false;
  await expect(
    establishHostKeyTrust(conn, "psilink.yaml", 0),
  ).resolves.toBeUndefined();
});

test("is a no-op when a host_key_fingerprint is already pinned", async () => {
  const conn: ConnectionConfig = {
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      hostKeyFingerprint: "SHA256:" + "A".repeat(43),
    },
  };
  // A pinned connection enforces in core; first-use does nothing here, so even a
  // non-interactive run proceeds (it does not fail closed).
  process.stdin.isTTY = false;
  await expect(
    establishHostKeyTrust(conn, "psilink.yaml", 0),
  ).resolves.toBeUndefined();
});

test("fails closed (no prompt, no auto-accept) on a non-interactive unpinned sftp run, naming the recovery", async () => {
  const conn: ConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org" },
  };
  process.stdin.isTTY = false;
  const result = establishHostKeyTrust(conn, "/etc/psilink.yaml", 0);
  await expect(result).rejects.toBeInstanceOf(UsageError);
  // The error names both recovery routes: run interactively to pin, or set
  // host_key_fingerprint out-of-band. It must NOT have auto-accepted (the pin is
  // still unset).
  await expect(result).rejects.toThrow(/interactive/i);
  await expect(result).rejects.toThrow(/host_key_fingerprint/);
  if (conn.channel === "sftp")
    expect(conn.server.hostKeyFingerprint).toBeUndefined();
});
