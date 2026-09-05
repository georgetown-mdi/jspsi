import { zeroSetupOptionsArgv, zeroSetupSftpArgv } from "./intentArgv";

import {
  composeConfigDocument,
  composeSftpConfigDocument,
} from "./intentConfig";

import type {
  JobCreateIntent,
  JobExchangeIntent,
  JobSigningPaths,
  JobZeroSetupIntent,
} from "./intentSchemas";
import type { JobSftpServerEntry } from "./sftpServer";

/**
 * The recurring-run hand-off: the portable, secret-free material an operator
 * needs to graduate a prototyped console exchange to a scheduled `psilink`
 * command-line run. The console composes every path it runs the CLI over as
 * a CONTAINER-internal path, and the shared secret lives only in the on-disk
 * `.psilink.key`, which never crosses the browser. The hand-off is a
 * PORTABLE TEMPLATE, not a turnkey export: the machine-independent parts
 * (SFTP host/port/username, the host-key fingerprint pin, the linkage terms
 * exactly as they ran) are filled in, while machine-specific paths are shown
 * as labelled placeholders the operator sets for their own machine.
 *
 * Two invariants, enforced by the compose helpers below and driven in
 * jobHandoff.unit.test.ts and jobHandoffParity.unit.test.ts:
 * - No shared secret, key-file body, or inline credential value is ever
 *   present: the exchange config holds the credential only as an `@path`
 *   reference, and the zero-setup command holds no secret at all.
 * - No container-internal path is ever present: the credential `@path`,
 *   every filedrop rendezvous mount, and the signing identity file are
 *   replaced with fixed placeholder tokens before the template is composed.
 */
export interface JobHandoff {
  /** The mode the run used: `exchange` (invitation, config-and-key driven) or
   * `zeroSetup` (Direct, the positional `$0` command form). */
  mode: "exchange" | "zeroSetup";
  /** The channel the run used. */
  channel: "sftp" | "filedrop";
  /**
   * Whether the run wrote a `.psilink.key` the operator must copy to their
   * recurring folder. True for the exchange mode (which holds a shared secret
   * in the key file), false for the zero-setup mode (which holds none).
   */
  usedKeyFile: boolean;
  /**
   * Whether the authored SFTP credential arrived as a PASTED value
   * (materialized to a server-owned file) rather than a file the operator
   * owns. The panel shows the save-it-to-a-file caveat when true. Always
   * false on the filedrop channel, which has no credential.
   */
  credentialPasted: boolean;
  /**
   * Whether the run signed receipts under a long-lived signing identity.
   * True for a `certificate`-mode exchange, false otherwise (every
   * zero-setup run signs nothing).
   *
   * The panel shows the reuse-the-identity caveat when true: the recurring
   * run must load the SAME signing key file, since a fresh `psilink
   * fingerprint` on the scheduling machine mints a different key the
   * partner's pin would reject.
   */
  usedSigningIdentity: boolean;
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

/** The placeholder a split console's INBOUND (peer-written) rendezvous mount is
 * shown as, in the exchange config's `connection.inbound_path`. Named for the
 * direction rather than "shared": the two folders are not one. */
export const HANDOFF_INBOUND_DIRECTORY_PLACEHOLDER =
  "/path/to/your/inbound-directory";

/** The placeholder a split console's OUTBOUND (self-written) rendezvous mount is
 * shown as, in `connection.outbound_path` and on `--outbound-path`. */
export const HANDOFF_OUTBOUND_DIRECTORY_PLACEHOLDER =
  "/path/to/your/outbound-directory";

/** The placeholder the inbound mount is shown as in a zero-setup command's
 * `file://` locator, the split counterpart to
 * {@link HANDOFF_SHARED_DIRECTORY_URL_PLACEHOLDER}. */
export const HANDOFF_INBOUND_DIRECTORY_URL_PLACEHOLDER =
  "file:///path/to/your/inbound-directory";

/**
 * The placeholder the signing identity file is shown as in the exchange
 * config's `signing.identity_file`.
 *
 * The identity is a real file on the operator's host, but the console loads
 * it by the CONTAINER's path, which their host does not have. The template
 * names the file rather than the location, and the panel says which file to
 * point it at.
 */
export const HANDOFF_SIGNING_IDENTITY_PLACEHOLDER =
  "/path/to/your/signing-identity.json";

/** The input/output positionals the recurring command template names, matching the
 * console's `results.csv` download name so the two flows read consistently. */
const HANDOFF_INPUT_NAME = "input.csv";
const HANDOFF_OUTPUT_NAME = "results.csv";

/**
 * Rebuild the authored SFTP server entry with every container-internal
 * credential `@path` replaced by a placeholder, keeping every portable field
 * verbatim (host, port, username, the REMOTE working directories, the
 * host-key fingerprint, the keyboard-interactive toggle). Constructed
 * field-by-field, never by spreading the entry, so no real credential
 * `@path` and no future field can ride along. The remote directories are on
 * the partner's SFTP server and identical on any machine, so they stay;
 * only the LOCAL credential files differ per machine.
 */
function placeholderServerEntry(entry: JobSftpServerEntry): JobSftpServerEntry {
  const sanitized: JobSftpServerEntry = {
    host: entry.host,
    ...(entry.port !== undefined ? { port: entry.port } : {}),
    ...(entry.username !== undefined ? { username: entry.username } : {}),
    ...(entry.path !== undefined ? { path: entry.path } : {}),
    ...(entry.inboundPath !== undefined
      ? { inboundPath: entry.inboundPath }
      : {}),
    ...(entry.outboundPath !== undefined
      ? { outboundPath: entry.outboundPath }
      : {}),
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
 * The signing paths the TEMPLATE names, as against the ones the live run
 * used.
 *
 * The identity is placeholdered: the console loads it by a container path
 * the operator's host does not have (see
 * {@link HANDOFF_SIGNING_IDENTITY_PLACEHOLDER}).
 *
 * The receipt output is OMITTED rather than placeholdered: with the key
 * absent, the CLI writes a timestamped receipt into the run's own working
 * directory, so a schedule accumulates one receipt per run. Reusing the
 * console's single fixed name would have each scheduled run overwrite the
 * last run's receipt. The live run pins the name because it serves that one
 * file once; a schedule wants the trail.
 */
const HANDOFF_SIGNING_PATHS: JobSigningPaths = {
  identityFile: HANDOFF_SIGNING_IDENTITY_PLACEHOLDER,
};

/**
 * Compose the exchange mode's portable `psilink.yaml` template through the
 * SAME compose functions the live run used, so linkage terms, metadata,
 * standardization, and connection fields are byte-for-byte what ran, with
 * only the container paths substituted first (a placeholder-credential
 * server entry on sftp, a placeholder rendezvous path on filedrop, and
 * {@link HANDOFF_SIGNING_PATHS} on both). Recomposing, rather than reading
 * and munging the on-disk file, keeps the container path out by
 * construction.
 */
function buildExchangeHandoffTemplate(
  intent: JobExchangeIntent,
  serverEntry: JobSftpServerEntry | undefined,
  filedropSplit: boolean,
): JobHandoffTemplate {
  if (intent.channel === "sftp") {
    if (serverEntry === undefined)
      throw new Error("sftp handoff reached compose without a resolved server");
    return {
      kind: "config",
      yaml: composeSftpConfigDocument(
        intent,
        placeholderServerEntry(serverEntry),
        HANDOFF_SIGNING_PATHS,
      ),
    };
  }
  return {
    kind: "config",
    yaml: filedropSplit
      ? composeConfigDocument(
          intent,
          HANDOFF_INBOUND_DIRECTORY_PLACEHOLDER,
          HANDOFF_OUTBOUND_DIRECTORY_PLACEHOLDER,
          HANDOFF_SIGNING_PATHS,
        )
      : composeConfigDocument(
          intent,
          HANDOFF_SHARED_DIRECTORY_PLACEHOLDER,
          undefined,
          HANDOFF_SIGNING_PATHS,
        ),
  };
}

/**
 * Compose the zero-setup mode's portable command tokens: `psilink` plus the
 * connection portion (sftp's `sftp://` URL and `--server-*` flags with the
 * credential `@path` placeholdered, or filedrop's placeholder `file://`
 * locator), the run's tuning flags, its identity and linkage-strategy
 * selectors when set, and the input/output positionals.
 *
 * The sftp arm reuses {@link zeroSetupSftpArgv} against a
 * placeholder-credential entry, so the URL, username, and mandatory
 * fingerprint pin are exactly what ran while no credential `@path` is
 * emitted. The tuning flags come from {@link zeroSetupOptionsArgv} -- the
 * same builder the live run's argv uses -- and name no path or credential.
 */
function buildZeroSetupHandoffTemplate(
  intent: JobZeroSetupIntent,
  serverEntry: JobSftpServerEntry | undefined,
  filedropSplit: boolean,
): JobHandoffTemplate {
  let connectionArgs: Array<string>;
  if (intent.channel === "sftp") {
    if (serverEntry === undefined)
      throw new Error(
        "sftp zero-setup handoff reached compose without a resolved server",
      );
    connectionArgs = zeroSetupSftpArgv(placeholderServerEntry(serverEntry));
  } else if (filedropSplit) {
    // Composed literally rather than through zeroSetupFiledropArgv: that builder
    // turns a real directory into a `file://` URL, and a placeholder is not a
    // directory to convert. The flag form and the ordering are the ones it emits.
    connectionArgs = [
      HANDOFF_INBOUND_DIRECTORY_URL_PLACEHOLDER,
      `--outbound-path=${HANDOFF_OUTBOUND_DIRECTORY_PLACEHOLDER}`,
    ];
  } else {
    connectionArgs = [HANDOFF_SHARED_DIRECTORY_URL_PLACEHOLDER];
  }
  const argv: Array<string> = [
    "psilink",
    ...connectionArgs,
    ...zeroSetupOptionsArgv(intent.options),
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
 * What the MANAGER knows about the run that the intent does not: whether the
 * credential was pasted, and whether this console rendezvouses over a split pair.
 * A record rather than two positional flags, because the two are same-typed and a
 * transposed pair would otherwise typecheck.
 */
export interface JobHandoffRunFacts {
  /**
   * Whether the sftp credential the run used was a PASTED, server-materialized
   * value rather than a file the operator owns. Forced false on the filedrop
   * channel, which has no credential.
   */
  credentialPasted: boolean;
  /**
   * Whether this console provisions the inbound/outbound rendezvous pair. Read
   * only on the filedrop channel, whose template it decides between the single
   * shared directory and the two-directory form.
   */
  filedropSplit: boolean;
}

/**
 * Build the recurring-run hand-off from a job's create intent and the resources it
 * ran against, captured at job creation so it reflects exactly what ran (rather
 * than re-reading authored state that a later action could change). The exchange
 * arm recomposes the config template; the zero-setup arm the command template.
 */
export function buildJobHandoff(
  intent: JobCreateIntent,
  serverEntry: JobSftpServerEntry | undefined,
  { credentialPasted, filedropSplit }: JobHandoffRunFacts,
): JobHandoff {
  const zeroSetup = intent.mode === "zeroSetup";
  const split = intent.channel === "filedrop" && filedropSplit;
  return {
    mode: zeroSetup ? "zeroSetup" : "exchange",
    channel: intent.channel,
    usedKeyFile: !zeroSetup,
    credentialPasted: intent.channel === "sftp" && credentialPasted,
    usedSigningIdentity:
      intent.mode !== "zeroSetup" && intent.signing?.mode === "certificate",
    template: zeroSetup
      ? buildZeroSetupHandoffTemplate(intent, serverEntry, split)
      : buildExchangeHandoffTemplate(intent, serverEntry, split),
  };
}
