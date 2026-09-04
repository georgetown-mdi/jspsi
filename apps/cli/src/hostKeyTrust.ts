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
import { promptConfirm } from "./util/prompt";

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
 * Compose a host-key refusal as a cause chain rather than one string:
 * `summary` becomes the error's own message and each `details` entry a
 * `cause` link of its own, in order -- first-party copy on its own link(s),
 * then one labelled link per chooser of the rest -- so the display cap
 * (`sanitizeErrorForDisplay`) bounds each chooser to its own budget. See
 * docs/spec/CHANNEL_SECURITY.md#display-sanitization-escape-format.
 *
 * Each link installs its `cause` with `Object.defineProperty` rather than the
 * two-argument `Error` constructor: this app's emit target predates
 * `ErrorOptions`, so the constructor form typechecks against the test
 * config's newer lib and then fails the build.
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
 * Establish first-use SSH host-key trust for an sftp connection with no
 * `host_key_fingerprint` pinned, the moment before it is opened. Modeled on
 * ssh's trust-on-first-use; shared by every interactive connect path
 * (`exchange`, the online `invite`/`accept`, and `zero-setup`), persistence
 * differing per command. Full behavior:
 * docs/spec/CHANNEL_SECURITY.md#sftp-host-key-verification ("First-use trust
 * (ssh-style)").
 *
 * Not sftp, or a pin already set, is a no-op: the caller proceeds and the
 * real connect that follows still verifies the pin and fails closed on a
 * mismatch. A changed key is never handled here -- it fails closed in core
 * and is re-pinned only by a manual config edit.
 *
 * Mutates `connection.server.hostKeyFingerprint` in place on success so the
 * caller's subsequent open() verifies the just-confirmed key, which also
 * catches a key swapped between this probe and that connect. A caller that
 * clones the connection for live use (`resolveConnectionCredentials` or
 * `applyConnectionCredentials`) must invoke this on the ORIGINAL before
 * cloning, so the mutation reaches both the live connect and the persisted
 * config.
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
  // unbounded by SFTPServerSchema in length or format; the config path is the
  // operator's own, and unbounded too. Each rides a labelled link of its own
  // in the refusals below, passed through the private-key redaction where it
  // is interpolated -- see
  // docs/spec/CHANNEL_SECURITY.md#display-sanitization-escape-format.
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
      // The command writes the connection (now holding the pin) to its config
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
