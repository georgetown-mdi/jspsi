import {
  FileSyncConnection,
  redactAndSanitizeForDisplay,
  redactPrivateKeyMaterial,
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

/**
 * Compose a host-key refusal as a cause chain rather than one string: `summary`
 * becomes the error's own message and each `details` entry a `cause` link of its
 * own, in order.
 *
 * The split is what the display boundary forces. `sanitizeErrorForDisplay` caps
 * EVERY link at `COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH` independently, so a link
 * that mixes first-party text with a fragment somebody else chose lets that
 * chooser spend the whole budget and delete the step the operator has to act on.
 * Partitioning by WHO CHOSE THE BYTES -- first-party copy on its own links, then
 * one labelled link per chooser -- bounds the cap to a chooser's own bytes. It
 * does not remove the cap: fixed copy that outgrows a budget truncates just the
 * same, so what each link measures at the rendered boundary is pinned by test.
 *
 * Each link installs its `cause` with `Object.defineProperty` rather than the
 * two-argument `Error` constructor -- this app's emit target predates
 * `ErrorOptions`, so the direct form typechecks against the test config's newer
 * lib and then fails the build -- using the descriptor that constructor would
 * have set, so a link matches the `UsageError` above it for any sink that
 * enumerates or serializes a thrown error rather than rendering it.
 */
const hostKeyRefusal = (summary: string, details: string[]): UsageError =>
  new UsageError(summary, {
    cause: details.reduceRight<unknown>(
      (cause, detail) =>
        Object.defineProperty(new Error(detail), "cause", {
          value: cause,
          writable: true,
          configurable: true,
          enumerable: false,
        }),
      undefined,
    ),
  });

const REAL_DEPS: HostKeyTrustDeps = {
  probe: (connection, verbosity) => {
    // The caller guarantees an sftp connection before invoking the probe (see
    // establishHostKeyTrust); narrow for probeHostKeyFingerprint's signature.
    const config = connection as Extract<ConnectionConfig, { channel: "sftp" }>;
    // A dial that dies before the peer identifies itself as an SSH server is
    // diagnosed by the adapter this probe dials through, which is the single
    // point every dial passes -- see connection/sftpPeerIdentification.
    return new FileSyncConnection(new SSH2SFTPClientAdapter({ verbosity }), {
      verbose: verbosity,
    }).probeHostKeyFingerprint(config);
  },
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
 * - Not sftp, or a pin is already set (pinned out-of-band -- a saved
 *   `host_key_fingerprint`, or `--server-host-key-fingerprint` -- or by a prior
 *   first-use run): a no-op -- the caller proceeds and a pinned connection
 *   enforces in core. This is what lets a supervised, TTY-less run complete
 *   without the interactive prompt: pre-pinning skips the QUESTION, never the
 *   CHECK, since the real connect that follows still verifies the pin against
 *   the server's actual presented key and fails closed on a mismatch.
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
 * the connection for live use (via `resolveConnectionCredentials`, or
 * `applyConnectionCredentials` where the credential files are read ahead of this
 * step) must invoke this on the ORIGINAL before cloning, so the mutation reaches
 * both the live connect and the persisted config.
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
  // The host reaches the operator down two routes with different escape points:
  // the refusals below, composed raw because the display boundary escapes the
  // rendered cause chain once, and the log/prompt lines, whose call sites are
  // themselves that value's display sink.
  const host = connection.server.host;
  const hostDisplay = redactAndSanitizeForDisplay(host);
  // On an offline-accept-seeded config the host is the PARTNER's, copied
  // verbatim out of the invitation endpoint (connectionFromEndpoint), and
  // SFTPServerSchema bounds it neither in length nor in format; the config path
  // is the operator's own, and unbounded too. Each therefore rides a labelled
  // link of its own in the refusals below rather than sharing one with the text
  // the operator has to act on, and each is passed through the private-key
  // redaction where it is interpolated (docs/spec/CHANNEL_SECURITY.md).
  const hostDetail = `configured host: ${redactPrivateKeyMaterial(host)}`;
  // The config the operator would pin into / where the pin will be saved; absent
  // for an ephemeral (one-off, no --save) run, which the messages adapt to.
  const configDetail =
    persistence.mode === "ephemeral"
      ? undefined
      : `configuration file: ${redactPrivateKeyMaterial(persistence.configPath)}`;

  // stdin must be an interactive terminal to prompt. The strict `!== true` test
  // mirrors openInputSource: isTTY is `undefined` (not `false`) for a pipe, a
  // `< file` redirect, or a CSV piped through stdin, so this fails closed for
  // every non-interactive run rather than hang on a prompt that can never be
  // answered or silently auto-accept.
  if (process.stdin.isTTY !== true) {
    throw hostKeyRefusal(
      `no host_key_fingerprint is pinned for this SFTP server and this run ` +
        `is not interactive, so its identity cannot be confirmed; refusing ` +
        `to connect.`,
      configDetail !== undefined
        ? [
            `Run once from an interactive terminal to review and pin the ` +
              `presented key, or pin it out-of-band by setting ` +
              `connection.server.host_key_fingerprint in the configuration ` +
              `below.`,
            configDetail,
            hostDetail,
          ]
        : [
            `Run once from an interactive terminal to review and pin the ` +
              `presented key, or pin it out-of-band by setting ` +
              `connection.server.host_key_fingerprint in a saved ` +
              `configuration.`,
            hostDetail,
          ],
    );
  }

  // Probe on a throwaway connection (its own adapter): the verifier records the
  // presented key and refuses, so no credential is ever sent and nothing needs
  // closing. A genuine connect failure propagates as it stands, unwrapped and
  // with nothing pinned (hostKeyTrust.test.ts, "a probe failure propagates
  // unchanged and pins nothing").
  const presented = await deps.probe(connection, verbosity);

  // presented.keyType is the server's choice within the bound core's
  // keyTypeFromBlob applies, so escape it before it reaches the operator's
  // terminal/log (the same treatment fileSyncConnection's verifiers give it).
  // The fingerprint is base64.
  log.warn(
    `The authenticity of host ${hostDisplay} cannot be established: no ` +
      `host_key_fingerprint is pinned. It presented a ` +
      `${redactAndSanitizeForDisplay(presented.keyType)} host key with ` +
      `fingerprint ${presented.fingerprint}. Verify this matches the server's ` +
      `published fingerprint out-of-band if you can; confirming pins it for ` +
      `this connection.`,
  );
  const trusted = await deps.confirm(`Trust this host key for ${hostDisplay}?`);
  if (!trusted)
    throw hostKeyRefusal(
      `the presented host key was not trusted; no credential was sent and ` +
        `nothing was written. Obtain and verify the server's fingerprint ` +
        `out-of-band, then retry.`,
      [hostDetail],
    );

  // Pin in memory so the real open() that follows enforces the confirmed key.
  connection.server.hostKeyFingerprint = presented.fingerprint;

  switch (persistence.mode) {
    case "write-now":
      // The config is already on disk and the command does not re-write it, so
      // write the pin in place now; future runs enforce it without prompting.
      persistHostKeyFingerprint(persistence.configPath, presented.fingerprint);
      log.info(
        `pinned ${hostDisplay}'s host key (${presented.fingerprint}) to ` +
          `${redactAndSanitizeForDisplay(persistence.configPath)}; future ` +
          `connections will verify it automatically.`,
      );
      break;
    case "save-with-config":
      // The command writes the connection (now carrying the pin) to its config
      // after the handshake; no separate write here.
      log.info(
        `trusted ${hostDisplay}'s host key (${presented.fingerprint}); it ` +
          `will be saved to ` +
          `${redactAndSanitizeForDisplay(persistence.configPath)} and ` +
          `verified automatically on future connections.`,
      );
      break;
    case "ephemeral":
      log.info(
        `trusting ${hostDisplay}'s host key (${presented.fingerprint}) for ` +
          `this ` +
          `exchange only; it is not saved. Use a saved configuration ` +
          `(psilink invite/accept, or --save) to pin it for future runs.`,
      );
      break;
  }
}
