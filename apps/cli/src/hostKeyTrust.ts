import {
  FileSyncConnection,
  sanitizeForDisplay,
  UsageError,
  getLogger,
} from "@psilink/core";
import type { ConnectionConfig } from "@psilink/core";

import { SSH2SFTPClientAdapter } from "./connection/ssh2SftpAdapter";
import { persistHostKeyFingerprint } from "./config";
import { promptConfirm } from "./util/cli";

/**
 * Establish first-use SSH host-key trust for an sftp connection that has no
 * `host_key_fingerprint` pinned, the moment before it is opened. Modeled on
 * ssh's trust-on-first-use: the first interactive connect surfaces the server's
 * presented fingerprint, asks the operator to confirm, and pins it; every later
 * run then enforces the pin silently. A changed key is never handled here -- a
 * pinned mismatch fails closed in core and is re-pinned only by a deliberate
 * config edit, exactly as ssh refuses a changed key until `known_hosts` is
 * edited.
 *
 * Behavior:
 * - Not sftp, or a pin is already set: a no-op (the caller proceeds; a pinned
 *   connection enforces in core).
 * - Non-interactive (stdin is not a TTY -- an automated run, or one piping its
 *   CSV through stdin): fails closed with an actionable {@link UsageError}; it
 *   never hangs on a prompt and never auto-accepts. The error names the recovery
 *   (run once interactively to pin, or pin out-of-band).
 * - Interactive (stdin is a TTY): probes the server for its host key WITHOUT
 *   presenting any credential (see {@link FileSyncConnection.probeHostKeyFingerprint}),
 *   shows the fingerprint and key type, and prompts. On confirmation it pins the
 *   fingerprint into the connection (so the immediately-following real open()
 *   enforces it) and persists it to `configPath`. On decline it aborts.
 *
 * Mutates `connection.server.hostKeyFingerprint` in place on success so the
 * caller's subsequent open() verifies the just-confirmed key -- which also
 * catches a key swapped between this probe and that connect.
 *
 * @param verbosity  log verbosity for the throwaway probe connection.
 * @param configPath the psilink.yaml to persist the pin into on confirmation.
 */
export async function establishHostKeyTrust(
  connection: ConnectionConfig,
  configPath: string,
  verbosity: number,
): Promise<void> {
  if (connection.channel !== "sftp") return;
  if (connection.server.hostKeyFingerprint !== undefined) return;

  const log = getLogger("exchange");
  const host = sanitizeForDisplay(connection.server.host);

  // stdin must be an interactive terminal to prompt. The strict `!== true` test
  // mirrors openInputSource: isTTY is `undefined` (not `false`) for a pipe, a
  // `< file` redirect, or a CSV piped through stdin, so this fails closed for
  // every non-interactive run rather than hang on a prompt that can never be
  // answered or silently auto-accept.
  if (process.stdin.isTTY !== true)
    throw new UsageError(
      `no host_key_fingerprint is pinned for ${host} and this run is not ` +
        `interactive, so the server's identity cannot be confirmed; refusing ` +
        `to connect. Run 'psilink exchange' once from an interactive terminal ` +
        `to review the presented host key and pin it, or set ` +
        `connection.server.host_key_fingerprint in ${configPath} to the ` +
        `server's OpenSSH SHA256 fingerprint (obtained out-of-band) before ` +
        `running unattended.`,
    );

  // Probe on a throwaway connection (its own adapter): the verifier records the
  // presented key and refuses, so no credential is ever sent and nothing needs
  // closing. A genuine connect failure (unreachable host) propagates as-is.
  const probe = new FileSyncConnection(
    new SSH2SFTPClientAdapter({ verbosity }),
    {
      verbose: verbosity,
    },
  );
  const presented = await probe.probeHostKeyFingerprint(connection);

  // presented.keyType is decoded straight from the server-controlled key blob,
  // so escape it before it reaches the operator's terminal/log (the same
  // treatment fileSyncConnection's verifiers give keyTypeFromBlob). The
  // fingerprint is base64 and the host is already escaped above.
  log.warn(
    `The authenticity of host ${host} cannot be established: no ` +
      `host_key_fingerprint is pinned. It presented a ` +
      `${sanitizeForDisplay(presented.keyType)} host key with fingerprint ` +
      `${presented.fingerprint}. Verify this matches the server's published ` +
      `fingerprint out-of-band if you can; confirming pins it for every future ` +
      `connection.`,
  );
  const trusted = await promptConfirm(
    `Trust this host key and pin it for future connections to ${host}?`,
  );
  if (!trusted)
    throw new UsageError(
      `host key for ${host} was not trusted; no connection was made and ` +
        `nothing was written. Obtain and verify the server's fingerprint, then ` +
        `retry.`,
    );

  // Pin in memory so the real open() that follows enforces the confirmed key,
  // and persist it so later runs enforce it without prompting.
  connection.server.hostKeyFingerprint = presented.fingerprint;
  persistHostKeyFingerprint(configPath, presented.fingerprint);
  log.info(
    `pinned ${host}'s host key (${presented.fingerprint}) to ${configPath}; ` +
      `future connections will verify it automatically.`,
  );
}
