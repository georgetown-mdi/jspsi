import {
  composeConfigDocument,
  composeSftpConfigDocument,
  zeroSetupSftpArgv,
} from "./intent";

import type {
  JobCreateIntent,
  JobExchangeIntent,
  JobZeroSetupIntent,
} from "./intent";
import type { JobSftpServerEntry } from "./sftpServer";

/**
 * The recurring-run hand-off: the portable, secret-free material an operator
 * needs to graduate a prototyped console exchange to a scheduled `psilink`
 * command-line run. The console composes every path it runs the CLI over as a
 * CONTAINER-internal path (the credential `@path`, the filedrop rendezvous
 * directory), and the shared secret lives only in the on-disk `.psilink.key` that
 * never crosses the browser. So the hand-off is a PORTABLE TEMPLATE, not a
 * turnkey export: the machine-independent parts (SFTP host/port/username, the
 * host-key fingerprint pin, and the linkage terms exactly as they ran) are filled
 * in, while the machine-specific paths are shown as clearly-labelled placeholders
 * the operator sets for their own machine.
 *
 * Two hard invariants hold by construction, enforced by the compose helpers below
 * and pinned by tests:
 * - No shared secret, key-file body, or inline credential value is ever present:
 *   the exchange config the compose functions emit carries the credential only as
 *   an `@path` reference (the secret rides the key file), and the zero-setup
 *   command carries no secret at all.
 * - No container-internal path is ever present: the credential `@path` and the
 *   filedrop rendezvous directory are replaced with fixed placeholder tokens
 *   before the template is composed, so the real container path is never emitted.
 */
export interface JobHandoff {
  /** The mode the run used: `exchange` (invitation, config-and-key driven) or
   * `zeroSetup` (Direct, the positional `$0` command form). */
  mode: "exchange" | "zeroSetup";
  /** The channel the run used. */
  channel: "sftp" | "filedrop";
  /**
   * Whether the run wrote a `.psilink.key` the operator must copy to their
   * recurring folder. True for the exchange mode (which carries a shared secret in
   * the key file), false for the zero-setup mode (which carries none).
   */
  usedKeyFile: boolean;
  /**
   * Whether the authored SFTP credential arrived as a PASTED value (materialized
   * to a server-owned file) rather than a file the operator owns. The panel shows
   * the save-it-to-a-file caveat when true, since a pasted credential is not a file
   * the recurring run can reference. Always false on the filedrop channel, which
   * carries no credential.
   */
  credentialPasted: boolean;
  /** The portable template itself: the exchange config document (exchange mode) or
   * the zero-setup command tokens (zeroSetup mode). */
  template: JobHandoffTemplate;
}

/**
 * The portable template, discriminated on which artifact the mode produces: the
 * `psilink.yaml` config text an exchange-mode recurring run loads, or the argv
 * tokens of the zero-setup command a Direct-mode recurring run invokes.
 */
export type JobHandoffTemplate =
  { kind: "config"; yaml: string } | { kind: "command"; argv: Array<string> };

/** The placeholder a container-internal credential `@path` is shown as. The
 * operator replaces it with the path to their own credential file. */
export const HANDOFF_CREDENTIAL_PATH_PLACEHOLDER =
  "@/path/to/your/credential-file";

/** The placeholder a container-internal private-key passphrase `@path` is shown
 * as, kept distinct from the primary credential so the two files read clearly. */
export const HANDOFF_PASSPHRASE_PATH_PLACEHOLDER =
  "@/path/to/your/passphrase-file";

/** The placeholder the filedrop rendezvous directory is shown as in the exchange
 * config's `connection.path`. */
export const HANDOFF_SHARED_DIRECTORY_PLACEHOLDER =
  "/path/to/your/shared-directory";

/** The placeholder the filedrop rendezvous directory is shown as in a zero-setup
 * command's `file://` locator (the CLI requires the three-slash URL form for a
 * filedrop positional). */
export const HANDOFF_SHARED_DIRECTORY_URL_PLACEHOLDER =
  "file:///path/to/your/shared-directory";

/** The input/output positionals the recurring command template names, matching the
 * console's `results.csv` download name so the two flows read consistently. */
const HANDOFF_INPUT_NAME = "input.csv";
const HANDOFF_OUTPUT_NAME = "results.csv";

/**
 * Rebuild the authored SFTP server entry with every container-internal credential
 * `@path` replaced by a placeholder, keeping every portable field verbatim (host,
 * port, username, the REMOTE working directory `path`, the host-key fingerprint,
 * and the keyboard-interactive toggle). Constructed field-by-field -- never by
 * spreading the entry -- so no real credential `@path` and no future field can ride
 * along into a template. The remote `path` is the directory on the partner's SFTP
 * server, identical on any machine, so it stays; only the LOCAL credential files
 * differ per machine and become placeholders.
 */
function placeholderServerEntry(entry: JobSftpServerEntry): JobSftpServerEntry {
  const sanitized: JobSftpServerEntry = {
    host: entry.host,
    ...(entry.port !== undefined ? { port: entry.port } : {}),
    ...(entry.username !== undefined ? { username: entry.username } : {}),
    ...(entry.path !== undefined ? { path: entry.path } : {}),
    ...(entry.keyboardInteractive !== undefined
      ? { keyboardInteractive: entry.keyboardInteractive }
      : {}),
    hostKeyFingerprint: entry.hostKeyFingerprint,
  };
  if (entry.password !== undefined)
    sanitized.password = HANDOFF_CREDENTIAL_PATH_PLACEHOLDER;
  else if (entry.privateKey !== undefined)
    sanitized.privateKey = HANDOFF_CREDENTIAL_PATH_PLACEHOLDER;
  if (entry.privateKeyPassphrase !== undefined)
    sanitized.privateKeyPassphrase = HANDOFF_PASSPHRASE_PATH_PLACEHOLDER;
  return sanitized;
}

/**
 * Compose the exchange mode's portable `psilink.yaml` template. It recomposes
 * through the SAME compose functions the live run used, so the linkage terms,
 * metadata, standardization, host, port, username, and fingerprint are byte-for-
 * byte what ran -- only the container paths are substituted first: the sftp arm
 * passes a placeholder-credential server entry, the filedrop arm a placeholder
 * rendezvous path. Recomposing (rather than reading and munging the on-disk file)
 * keeps the container path out by construction and never reads the secret-adjacent
 * config off disk.
 */
function buildExchangeHandoffTemplate(
  intent: JobExchangeIntent,
  serverEntry: JobSftpServerEntry | undefined,
): JobHandoffTemplate {
  if (intent.channel === "sftp") {
    if (serverEntry === undefined)
      throw new Error("sftp handoff reached compose without a resolved server");
    return {
      kind: "config",
      yaml: composeSftpConfigDocument(
        intent,
        placeholderServerEntry(serverEntry),
      ),
    };
  }
  return {
    kind: "config",
    yaml: composeConfigDocument(intent, HANDOFF_SHARED_DIRECTORY_PLACEHOLDER),
  };
}

/**
 * Compose the zero-setup mode's portable command tokens: `psilink` plus the
 * connection portion (the sftp arm's `sftp://` URL and `--server-*` flags with the
 * credential `@path` placeholdered, or the filedrop arm's placeholder `file://`
 * locator), the run's identity and linkage-strategy selectors when set, and the
 * input/output positionals. The sftp arm reuses {@link zeroSetupSftpArgv} against a
 * placeholder-credential entry, so the URL, username, and mandatory fingerprint pin
 * are exactly what ran while no credential `@path` is emitted.
 */
function buildZeroSetupHandoffTemplate(
  intent: JobZeroSetupIntent,
  serverEntry: JobSftpServerEntry | undefined,
): JobHandoffTemplate {
  let connectionArgs: Array<string>;
  if (intent.channel === "sftp") {
    if (serverEntry === undefined)
      throw new Error(
        "sftp zero-setup handoff reached compose without a resolved server",
      );
    connectionArgs = zeroSetupSftpArgv(placeholderServerEntry(serverEntry));
  } else {
    connectionArgs = [HANDOFF_SHARED_DIRECTORY_URL_PLACEHOLDER];
  }
  const argv: Array<string> = [
    "psilink",
    ...connectionArgs,
    ...(intent.identity !== undefined ? [`--identity=${intent.identity}`] : []),
    ...(intent.linkageStrategy !== undefined
      ? [`--linkage-strategy=${intent.linkageStrategy}`]
      : []),
    HANDOFF_INPUT_NAME,
    HANDOFF_OUTPUT_NAME,
  ];
  return { kind: "command", argv };
}

/**
 * Build the recurring-run hand-off from a job's create intent and the resources it
 * ran against, captured at job creation so it reflects exactly what ran (rather
 * than re-reading authored state that a later action could change). The exchange
 * arm recomposes the config template; the zero-setup arm the command template. The
 * `credentialPasted` flag is supplied by the manager (true only for an sftp run
 * whose credential was a pasted, materialized value); it is forced false on the
 * filedrop channel, which carries no credential.
 */
export function buildJobHandoff(
  intent: JobCreateIntent,
  serverEntry: JobSftpServerEntry | undefined,
  credentialPasted: boolean,
): JobHandoff {
  const zeroSetup = intent.mode === "zeroSetup";
  return {
    mode: zeroSetup ? "zeroSetup" : "exchange",
    channel: intent.channel,
    usedKeyFile: !zeroSetup,
    credentialPasted: intent.channel === "sftp" && credentialPasted,
    template: zeroSetup
      ? buildZeroSetupHandoffTemplate(intent, serverEntry)
      : buildExchangeHandoffTemplate(intent, serverEntry),
  };
}
