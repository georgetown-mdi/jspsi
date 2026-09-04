import { test } from "vitest";

import { selectedBackend } from "./sftpServer";

/**
 * A test that runs only against the in-process SFTP backend, skipped when
 * `PSILINK_SFTP_BACKEND=native` selects a real OpenSSH `sshd`.
 *
 * What qualifies: a test that drives the server into a state only a server this
 * suite controls can be put into -- a withheld close, a vanished session, a key
 * exchange narrowed mid-run, a listener ceiling. A real sshd exposes no control
 * for any of them, so such a test would not fail there, it could not be written
 * there at all. A behavior BOTH backends show is not gated here; it belongs in
 * the backend-agnostic project instead (docs/TESTING.md).
 *
 * The backend is read once at module load, as each gated file's own copy did,
 * so a test cannot see a different backend than the gate did.
 *
 * @internal test-only
 */
export const inProcessOnly: ReturnType<typeof test.skipIf> = test.skipIf(
  selectedBackend() !== "in-process",
);
