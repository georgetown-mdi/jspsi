import { expect, test } from "vitest";
import { FileSyncConnection } from "@psilink/core";
import Ssh2SftpClient from "ssh2-sftp-client";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { selectedBackend, selectedNativeProfile } from "../sftpServer";
import { remotePath, sftpServer } from "../sftpServer/testContext";

// Profile-specific coverage for the native sshd `allowlist` profile, which
// narrows AllowUsers to an explicit user@host matrix. It runs only on that
// profile (a true skip elsewhere, like the in-process-only tags in the
// conformance files) and asserts the credential-separation property: a
// connection presenting a VALID authorized key but a username other than the
// one served user is rejected, so possessing an authorized key does not by
// itself let a client authenticate as an arbitrary principal. This closes the
// parent item's open credential-separation question while preserving the
// two-user-shared-directory behavior -- the two legitimate parties still
// authenticate as the one allowed OS user. (The rejection is overdetermined:
// AllowUsers does not list the name AND the name is not a real OS account; the
// assertion is the security property, not which sshd stage enforces it.)
const allowlistOnly = test.skipIf(
  !(selectedBackend() === "native" && selectedNativeProfile() === "allowlist"),
);
const chrootOnly = test.skipIf(
  !(selectedBackend() === "native" && selectedNativeProfile() === "chroot"),
);
const restrictedCryptoOnly = test.skipIf(
  !(
    selectedBackend() === "native" &&
    selectedNativeProfile() === "restricted-crypto"
  ),
);

const srv = sftpServer();

allowlistOnly(
  "rejects a valid key under a username outside the allowlist",
  async () => {
    // A username that cannot match `AllowUsers <osUser>@127.0.0.1`: the served
    // user is srv.usera.username (the one OS user this backend maps both parties
    // to), so suffixing it guarantees a name the allowlist does not permit.
    const intruder = `${srv.usera.username}-intruder`;
    const conn = new FileSyncConnection(new SSH2SFTPClientAdapter(), {
      verbose: -1,
    });
    // A failed connect surfaces from open()'s rejection; swallow any connection
    // 'error' event so it does not crash the worker as an unhandled emit.
    conn.on("error", () => {});

    await expect(
      conn.open({
        channel: "sftp",
        server: {
          host: srv.host,
          port: srv.port,
          username: intruder,
          privateKey: srv.usera.privateKey,
          // Pin the host key so the connection passes host-key verification and
          // reaches authentication, where the allowlist rejects the intruder --
          // without the pin the no-pin fail-closed default would reject it first,
          // testing the wrong thing.
          hostKeyFingerprint: srv.hostKeyFingerprint,
          path: remotePath(srv, "allowlist-reject"),
        },
        // A single connect attempt (maxReconnectAttempts is the retry count, so
        // 0 means one try): the rejection is permanent, so retrying with the
        // adapter's 1s backoff only slows the test.
        options: { maxReconnectAttempts: 0 },
      }),
    ).rejects.toThrow();

    await conn.close().catch(() => {});
  },
);

chrootOnly(
  "confines the session: a path outside the served root is unreachable",
  async () => {
    const client = new Ssh2SftpClient();
    await client.connect({
      host: srv.host,
      port: srv.port,
      username: srv.usera.username,
      privateKey: srv.usera.privateKey,
      readyTimeout: 5_000,
    });
    try {
      // /etc/passwd exists on the host but not inside the jail, so a chrooted
      // session cannot reach it. This is non-vacuous: without ChrootDirectory the
      // path would resolve to the host's real /etc/passwd and stat would succeed,
      // so asserting it is refused proves the jail confines -- and this fails red
      // if the chroot is ever dropped.
      await expect(client.stat("/etc/passwd")).rejects.toThrow();
      // Positive control: the served root inside the jail IS reachable, so the
      // rejection above is confinement, not a stat that simply never works.
      const served = await client.stat(srv.remoteRoot);
      expect(served.isDirectory).toBe(true);
    } finally {
      await client.end().catch(() => {});
    }
  },
);

restrictedCryptoOnly(
  "rejects a client offering only a key exchange the policy excludes",
  async () => {
    // The restricted-crypto profile pins KexAlgorithms to curve25519 only. A
    // client offering ONLY ecdh-sha2-nistp256 shares no kex with the server, so
    // the handshake must fail. ecdh-sha2-nistp256 is deliberate: it is a kex
    // OpenSSH advertises BY DEFAULT but this profile excludes, so the rejection
    // is attributable to the profile's restriction -- if the KexAlgorithms line
    // were dropped, the server's default set would include ecdh-sha2-nistp256,
    // the handshake would succeed, and this test would fail red. (A legacy kex
    // like diffie-hellman-group14-sha1 would not catch that regression, since a
    // modern OpenSSH default already excludes it.)
    const client = new Ssh2SftpClient();
    await expect(
      client.connect({
        host: srv.host,
        port: srv.port,
        username: srv.usera.username,
        privateKey: srv.usera.privateKey,
        readyTimeout: 5_000,
        algorithms: { kex: ["ecdh-sha2-nistp256"] },
      }),
    ).rejects.toThrow();
    await client.end().catch(() => {});
  },
);
