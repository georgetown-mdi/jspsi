import {
  FileSyncConnection,
  sanitizeForDisplay,
  UsageError,
  getLogger,
} from "@psilink/core";
import type { ConnectionConfig, PresentedHostKey } from "@psilink/core";

import { SSH2SFTPClientAdapter } from "./connection/ssh2SftpAdapter";
import { persistHostKeyFingerprint } from "./config";
import { promptConfirm } from "./util/cli";

/**
 * How a confirmed first-use pin is persisted. Every connect path mutates the
 * in-memory connection so the real `open()` enforces the just-confirmed key; the
 * mode only governs how it reaches disk:
 *
 * - `write-now`: the config already exists on disk and the command does not
 *   re-write it (the `exchange` command), so the pin is written in place
 *   immediately.
 * - `save-with-config`: the command writes the connection to `configPath` later,
 *   after the handshake (the `invite`/`accept` online paths and `zero-setup
 *   --save`); the in-memory mutation flows into that write, so no separate write
 *   is needed here.
 * - `ephemeral`: nothing is persisted (a `zero-setup` run without `--save`); the
 *   key is trusted for this exchange only, the way `ssh` to an unsaved host is.
 */
export type HostKeyPersistence =
  | { mode: "write-now"; configPath: string }
  | { mode: "save-with-config"; configPath: string }
  | { mode: "ephemeral" };

/**
 * The two external effects {@link establishHostKeyTrust} performs, injectable so
 * the prompt/persist glue is unit-testable without a live server or a real TTY.
 * @internal
 */
export interface HostKeyTrustDeps {
  /** Connect just far enough to read the server's host key (see {@link FileSyncConnection.probeHostKeyFingerprint}). */
  probe: (
    connection: ConnectionConfig,
    verbosity: number,
  ) => Promise<PresentedHostKey>;
  /** Ask the operator to confirm; returns true only on an explicit yes. */
  confirm: (question: string) => Promise<boolean>;
}

const REAL_DEPS: HostKeyTrustDeps = {
  probe: (connection, verbosity) =>
    new FileSyncConnection(new SSH2SFTPClientAdapter({ verbosity }), {
      verbose: verbosity,
    }).probeHostKeyFingerprint(
      // The caller guarantees an sftp connection before invoking the probe (see
      // establishHostKeyTrust); narrow for probeHostKeyFingerprint's signature.
      connection as Extract<ConnectionConfig, { channel: "sftp" }>,
    ),
  confirm: promptConfirm,
};

/**
 * Establish first-use SSH host-key trust for an sftp connection that has no
 * `host_key_fingerprint` pinned, the moment before it is opened. Modeled on
 * ssh's trust-on-first-use: the first interactive connect surfaces the server's
 * presented fingerprint, asks the operator to confirm, and pins it; every later
 * run then enforces the pin silently. A changed key is never handled here -- a
 * pinned mismatch fails closed in core and is re-pinned only by a deliberate
 * config edit, exactly as ssh refuses a changed key until `known_hosts` is
 * edited. Shared by every interactive connect path (`exchange`, the online
 * `invite`/`accept`, and `zero-setup`); the persistence mode differs per command.
 *
 * Behavior:
 * - Not sftp, or a pin is already set (pinned out-of-band, or by a prior
 *   first-use run): a no-op -- the caller proceeds and a pinned connection
 *   enforces in core.
 * - Non-interactive (stdin is not a TTY -- an automated run, or one piping its
 *   CSV through stdin): fails closed with an actionable {@link UsageError}; it
 *   never hangs on a prompt and never auto-accepts. The error names the recovery.
 * - Interactive (stdin is a TTY): probes the server for its host key WITHOUT
 *   presenting any credential (see {@link FileSyncConnection.probeHostKeyFingerprint}),
 *   shows the fingerprint and key type, and prompts. On confirmation it pins the
 *   fingerprint into the connection (so the immediately-following real open()
 *   enforces it) and persists it per {@link HostKeyPersistence}. On decline it
 *   aborts.
 *
 * Mutates `connection.server.hostKeyFingerprint` in place on success so the
 * caller's subsequent open() verifies the just-confirmed key -- which also
 * catches a key swapped between this probe and that connect. Callers that clone
 * the connection for live use (via `resolveConnectionCredentials`) must invoke
 * this on the ORIGINAL before cloning, so the mutation reaches both the live
 * connect and the persisted config.
 *
 * @param deps injectable probe/confirm; defaults to the real implementations
 *   (a throwaway probe connection and the stderr y/N prompt). `@internal`.
 */
export async function establishHostKeyTrust(
  connection: ConnectionConfig,
  options: {
    verbosity: number;
    loggerName: string;
    persistence: HostKeyPersistence;
  },
  deps: HostKeyTrustDeps = REAL_DEPS,
): Promise<void> {
  if (connection.channel !== "sftp") return;
  if (connection.server.hostKeyFingerprint !== undefined) return;

  const { verbosity, loggerName, persistence } = options;
  const log = getLogger(loggerName);
  const host = sanitizeForDisplay(connection.server.host);
  // The config the operator would pin into / where the pin will be saved; absent
  // for an ephemeral (one-off, no --save) run, which the messages adapt to.
  const configPath =
    persistence.mode === "ephemeral" ? undefined : persistence.configPath;

  // stdin must be an interactive terminal to prompt. The strict `!== true` test
  // mirrors openInputSource: isTTY is `undefined` (not `false`) for a pipe, a
  // `< file` redirect, or a CSV piped through stdin, so this fails closed for
  // every non-interactive run rather than hang on a prompt that can never be
  // answered or silently auto-accept.
  if (process.stdin.isTTY !== true) {
    const recovery =
      configPath !== undefined
        ? `Run this command once from an interactive terminal to review the ` +
          `presented host key and pin it, or set ` +
          `connection.server.host_key_fingerprint in ${configPath} to the ` +
          `server's OpenSSH SHA256 fingerprint (obtained out-of-band) before ` +
          `running unattended.`
        : `Run this command once from an interactive terminal to review and ` +
          `confirm the presented host key, or pin the server out-of-band in a ` +
          `saved configuration (set connection.server.host_key_fingerprint) ` +
          `and run that unattended.`;
    throw new UsageError(
      `no host_key_fingerprint is pinned for ${host} and this run is not ` +
        `interactive, so the server's identity cannot be confirmed; refusing ` +
        `to connect. ${recovery}`,
    );
  }

  // Probe on a throwaway connection (its own adapter): the verifier records the
  // presented key and refuses, so no credential is ever sent and nothing needs
  // closing. A genuine connect failure (unreachable host) propagates as-is.
  const presented = await deps.probe(connection, verbosity);

  // presented.keyType is decoded straight from the server-controlled key blob,
  // so escape it before it reaches the operator's terminal/log (the same
  // treatment fileSyncConnection's verifiers give keyTypeFromBlob). The
  // fingerprint is base64 and the host is already escaped above.
  log.warn(
    `The authenticity of host ${host} cannot be established: no ` +
      `host_key_fingerprint is pinned. It presented a ` +
      `${sanitizeForDisplay(presented.keyType)} host key with fingerprint ` +
      `${presented.fingerprint}. Verify this matches the server's published ` +
      `fingerprint out-of-band if you can; confirming pins it for this ` +
      `connection.`,
  );
  const trusted = await deps.confirm(`Trust this host key for ${host}?`);
  if (!trusted)
    throw new UsageError(
      `host key for ${host} was not trusted; no connection was made and ` +
        `nothing was written. Obtain and verify the server's fingerprint, then ` +
        `retry.`,
    );

  // Pin in memory so the real open() that follows enforces the confirmed key.
  connection.server.hostKeyFingerprint = presented.fingerprint;

  switch (persistence.mode) {
    case "write-now":
      // The config is already on disk and the command does not re-write it, so
      // write the pin in place now; future runs enforce it without prompting.
      persistHostKeyFingerprint(persistence.configPath, presented.fingerprint);
      log.info(
        `pinned ${host}'s host key (${presented.fingerprint}) to ` +
          `${persistence.configPath}; future connections will verify it ` +
          `automatically.`,
      );
      break;
    case "save-with-config":
      // The command writes the connection (now carrying the pin) to its config
      // after the handshake; no separate write here.
      log.info(
        `trusted ${host}'s host key (${presented.fingerprint}); it will be ` +
          `saved to ${persistence.configPath} and verified automatically on ` +
          `future connections.`,
      );
      break;
    case "ephemeral":
      log.info(
        `trusting ${host}'s host key (${presented.fingerprint}) for this ` +
          `exchange only; it is not saved. Use a saved configuration ` +
          `(psilink invite/accept, or --save) to pin it for future runs.`,
      );
      break;
  }
}
