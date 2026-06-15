import { expect, test } from "vitest";
import { FileSyncConnection } from "@psilink/core";

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
