import { expect, test } from "vitest";

import { HOST_KEY_FINGERPRINT_REGEX } from "@psilink/core";

import { probeHostKeyLines } from "../../src/commands/probeHostKey";
import { sftpServer } from "../sftpServer/testContext";

// Drives the production SSH2SFTPClientAdapter probe (the same path
// `psilink probe-host-key --json` runs) with no credential. Host-key
// verification happens before authentication, so reading the server's exact
// fingerprint with no username or password shows authentication was never
// attempted.

test("probe-host-key --json reads the host key without authenticating", async () => {
  const srv = sftpServer();
  const result = await probeHostKeyLines({
    sftpUrl: `sftp://${srv.host}:${srv.port}`,
    connectTimeoutSeconds: 10,
    json: true,
    verbosity: -1,
  });

  expect(result.stdout).toBeDefined();
  const parsed = JSON.parse(result.stdout ?? "{}") as {
    fingerprint: string;
    key_type: string;
  };
  expect(parsed.fingerprint).toBe(srv.hostKeyFingerprint);
  expect(HOST_KEY_FINGERPRINT_REGEX.test(parsed.fingerprint)).toBe(true);
  // key_type is a real SSH host-key algorithm name, e.g. ssh-ed25519 or rsa-sha2-512.
  expect(parsed.key_type).toMatch(/^[A-Za-z0-9._@-]+$/);
});
