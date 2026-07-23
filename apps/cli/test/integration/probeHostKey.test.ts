import { expect, test } from "vitest";

import { HOST_KEY_FINGERPRINT_REGEX } from "@psilink/core";

import { probeHostKeyLines } from "../../src/commands/probeHostKey";
import { sftpServer } from "../sftpServer/testContext";

// The real host-key probe against the suite's loopback SFTP server. It drives the
// production SSH2SFTPClientAdapter probe (the same path `psilink probe-host-key
// --json` runs) with NO credential and asserts it reads the server's exact
// presented fingerprint. That it succeeds with no username or password is itself
// the proof no authentication was attempted: the verifier refuses at host-key
// verification, before any credential is offered -- had the probe reached auth, a
// blank username would have been rejected and no key returned.

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
  // The probe reads the exact fingerprint the server presents...
  expect(parsed.fingerprint).toBe(srv.hostKeyFingerprint);
  expect(HOST_KEY_FINGERPRINT_REGEX.test(parsed.fingerprint)).toBe(true);
  // ...and a real SSH host-key algorithm name (e.g. ssh-ed25519, rsa-sha2-512).
  expect(parsed.key_type).toMatch(/^[A-Za-z0-9._@-]+$/);
});
