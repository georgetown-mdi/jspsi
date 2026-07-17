import { disclosedColumnNames } from "@psilink/core";

import type {
  ConnectionEndpointRequest,
  GeneratedInvitation,
} from "@psi/invitation";
import type { ExchangeFileConnection, ExchangeFileInput } from "@psilink/core";
import type { Transport } from "./inviterModel";

/**
 * The pure model behind the save-exchange-file surface: the transport-specific
 * copy, the field the operator authors and its validation, the download
 * filename, and the single derivation that turns the authored locator into BOTH
 * the invitation's {@link ConnectionEndpointRequest} and the exchange file's
 * {@link ExchangeFileConnection}. Deriving both from one place is the invariant
 * that keeps the minted invitation code and the minted YAML pointing at the
 * same rendezvous. No React, no I/O -- the tested boundary for the surface.
 *
 * Only the two command-line transports reach this model; a `browser` transport
 * never routes here (its Create runs the live exchange). The functions accept
 * the narrowed CLI transport to make that unrepresentable.
 */

/** The command-line transports the save surface serves -- {@link Transport}
 * minus `browser`, which never routes here. */
export type CliTransport = Exclude<Transport, "browser">;

/**
 * The fields the operator authors on the save surface. SFTP needs a host and a
 * remote directory; a shared-directory exchange needs only the directory both
 * parties can reach. Both are held here so the surface's single form model
 * carries whichever the transport uses; the validators read only the fields
 * their transport requires.
 */
export interface SaveExchangeFields {
  /** SFTP server host (SFTP only). */
  host: string;
  /** Remote directory on the SFTP server (SFTP only). */
  remoteDirectory: string;
  /** Shared directory both parties reach (filedrop only). */
  sharedDirectory: string;
}

/** An empty field set -- the surface's initial state before the operator
 * authors the locator. */
export const EMPTY_SAVE_FIELDS: SaveExchangeFields = {
  host: "",
  remoteDirectory: "",
  sharedDirectory: "",
};

/** The lead paragraph naming the chosen transport; the terms are identical to a
 * browser exchange, only the transport differs. */
export function saveLeadCopy(transport: CliTransport): string {
  const over = transport === "sftp" ? "over SFTP" : "over a shared directory";
  return (
    `You chose to run this exchange ${over} with the psilink command-line ` +
    "tool. The linkage terms inside the exchange file are identical to a " +
    "browser exchange - only the transport differs."
  );
}

/** The info-alert copy about credentials: SFTP credentials are never stored in
 * this file -- the operator fills in the SSH username and points the config at
 * a key or password (an `@file` reference) before running; the psilink key
 * file the printed command provisions carries only the exchange's shared
 * secret. A shared-directory exchange carries no credentials at all, only the
 * directory both parties can reach. */
export function credentialAlertCopy(transport: CliTransport): string {
  return transport === "sftp"
    ? "Credentials are never stored in this file. You fill in the SSH " +
        "username and point the config at your key or password (an @file " +
        "reference) before running - the psilink key file carries only the " +
        "exchange secret, provisioned by the command below."
    : "A shared-directory exchange carries no credentials at all. The file " +
        "names only the directory both parties can reach.";
}

/** The shared pre-run trust footer: the local-encryption and disclosure
 * statement holds for every way an exchange runs (browser, SFTP, shared
 * directory, or a server-driven run -- the machine running the exchange is
 * the operator's local machine, even reached over a VPN), so every pre-run
 * surface states it identically. */
export const PRE_RUN_TRUST_FOOTER =
  "Data is encrypted locally before leaving your machine. Your partner " +
  "receives only the fields listed under 'you will send' (step 2 above) " +
  "and only for clients who are in common.";

/** The ledger trust-footer copy for a live run: the shared pre-run assurance
 * until a result lands. The settled copy differs only in the literal
 * "this browser" claim, which a server-driven run cannot make. */
export function liveRunLedgerFooter(
  serverJob: boolean,
  hasResult: boolean,
): string {
  if (hasResult)
    return serverJob
      ? "The results above are all your partner received about your data."
      : "Your file never left this browser. The results above are all your " +
          "partner received about your data.";
  return PRE_RUN_TRUST_FOOTER;
}

/** The trust-footer copy for the ledger on the save surface: the same
 * pre-run assurance as a browser run -- the statement holds for the SFTP and
 * shared-directory transports too. */
export function saveTrustFooter(): string {
  return PRE_RUN_TRUST_FOOTER;
}

/** The top bar's transport note on the save surface. */
export function saveRailNote(transport: CliTransport): string {
  return transport === "sftp" ? "SFTP" : "Shared directory";
}

/** The explicit channel-capability statement: the browser does not run this
 * transport's exchanges; the file runs in the command-line tool. */
export function saveCapabilityCopy(transport: CliTransport): string {
  const noun = transport === "sftp" ? "SFTP" : "shared-directory";
  return (
    `This browser does not run ${noun} exchanges; this file runs in the ` +
    "psilink command-line tool."
  );
}

/** The closing operator instructions per the mockup, naming the rendezvous the
 * tool exchanges protocol messages through. */
export function saveClosingCopy(
  fields: SaveExchangeFields,
  transport: CliTransport,
): string {
  const where =
    transport === "sftp"
      ? "on the machine that reaches your SFTP server"
      : "on a machine that reaches the shared directory";
  const through =
    transport === "sftp" ? fields.remoteDirectory : fields.sharedDirectory;
  // The SFTP remote directory is optional; fall back to a generic phrase when
  // it is blank so the sentence still reads (a filedrop directory is required).
  const throughClause = through.trim() === "" ? "the shared location" : through;
  return (
    `Run it with the psilink command-line tool ${where}. Your partner ` +
    "accepts with the same invitation code and their own exchange file; the " +
    `tool exchanges protocol messages through ${throughClause} and writes ` +
    "the same three result files you would download here."
  );
}

/** One invalid field on the save surface: the field key and the message. */
export interface SaveExchangeError {
  field: "host" | "remoteDirectory" | "sharedDirectory";
  message: string;
}

/**
 * Validate the authored fields for the chosen transport, returning the first
 * blocking error or `undefined` when the fields are savable. SFTP requires a
 * non-empty host; a remote directory is optional (the CLI defaults it).
 * Filedrop requires an absolute shared directory (an exchange with no host has
 * only the directory to locate it).
 */
export function saveExchangeError(
  transport: CliTransport,
  fields: SaveExchangeFields,
): SaveExchangeError | undefined {
  if (transport === "sftp") {
    if (fields.host.trim() === "")
      return { field: "host", message: "Enter the SFTP server host." };
    return undefined;
  }
  const dir = fields.sharedDirectory.trim();
  if (dir === "")
    return {
      field: "sharedDirectory",
      message: "Enter the shared directory both parties can reach.",
    };
  if (!isAbsolutePath(dir))
    return {
      field: "sharedDirectory",
      message: "Enter an absolute path, e.g. /exchanges/psilink.",
    };
  return undefined;
}

/** Whether a path is absolute (POSIX `/...` or a Windows drive/UNC path). The
 * shared directory must be absolute so both parties resolve it identically. */
function isAbsolutePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith("\\\\")
  );
}

/** The download filename `psilink-exchange-<date>.yaml`, the date the local
 * calendar day of `at` (the moment the invitation and file are minted). Mirrors
 * the record-filename timestamp discipline: the stamp comes from the artifact's
 * own creation instant, so repeated saves after edits carry distinct dates. */
export function exchangeFileName(at: Date): string {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `psilink-exchange-${year}-${month}-${day}.yaml`;
}

/**
 * The invitation endpoint request the authored locator maps to -- the same
 * sftp/filedrop locator fields the exchange file's connection carries, so the
 * code and the YAML point at one rendezvous. An empty optional directory is
 * omitted (the CLI defaults it) rather than sent as an empty string the
 * endpoint schema would reject.
 */
export function endpointRequestFor(
  transport: CliTransport,
  fields: SaveExchangeFields,
): ConnectionEndpointRequest & ExchangeFileConnection {
  if (transport === "sftp") {
    const path = fields.remoteDirectory.trim();
    return {
      channel: "sftp",
      host: fields.host.trim(),
      ...(path === "" ? {} : { path }),
    };
  }
  return { channel: "filedrop", path: fields.sharedDirectory.trim() };
}

/**
 * Assemble the exchange-file input from the minted invitation and the authored
 * locator. The connection carries the SAME host/path {@link endpointRequestFor}
 * put in the token; the linkage terms, metadata, standardization, and disclosed
 * payload columns are read off the invitation the code was minted from, so the
 * config and the token agree by derivation rather than by a parallel rebuild.
 */
export function exchangeFileInputFor(
  transport: CliTransport,
  fields: SaveExchangeFields,
  invitation: GeneratedInvitation,
): ExchangeFileInput {
  // The file's connection IS the endpoint request -- one derivation, so the
  // code and the config cannot point at different rendezvous.
  const connection: ExchangeFileConnection = endpointRequestFor(
    transport,
    fields,
  );
  return {
    connection,
    linkageTerms: invitation.linkageTerms,
    ...(invitation.metadata !== undefined
      ? { metadata: invitation.metadata }
      : {}),
    ...(invitation.standardization !== undefined
      ? { standardization: invitation.standardization }
      : {}),
    // The token's disclosed set is disclosedColumnNames over the same metadata
    // the invitation mint used (or the inferred metadata on the quick path);
    // deriving it here from that metadata keeps the file's commitment identical
    // to the token's.
    ...(invitation.metadata !== undefined
      ? { disclosedPayloadColumns: disclosedColumnNames(invitation.metadata) }
      : {}),
  };
}

/** The one copyable run command the surface offers, naming the JUST-minted
 * exchange file so the command runs as printed instead of falling back to the
 * CLI's default `./psilink.yaml`. Takes the filename rather than a `Date` so a
 * re-save's new date always flows through {@link exchangeFileName} once, at
 * the mint site, rather than being recomputed (and risking drift) here.
 * Saving the invitation code to a file keeps it out of the shell history (the
 * `@file` reference reads it back). */
export function runCommand(fileName: string): string {
  return (
    `psilink exchange your-data.csv --config-file ${fileName} ` +
    "--invitation @invitation-code.txt"
  );
}
