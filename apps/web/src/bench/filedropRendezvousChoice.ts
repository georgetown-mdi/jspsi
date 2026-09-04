import type { AcceptKitEndpoint } from "./acceptKit";
import type { FileDropEndpoint } from "@psilink/core";
import type { JobRendezvousConfig } from "@psi/workInputClient";

/**
 * The pure model behind the console's filedrop rendezvous: what an invitation minted
 * on this appliance says about where the two parties meet, and why the appliance's
 * mounts and the exchange's file-handling choices can disagree. No React, no I/O --
 * the tested boundary for "the code points where the appliance will actually
 * rendezvous".
 *
 * Unlike the SFTP connection, the operator authors no directory here: the mounts are
 * the appliance's own provisioning ({@link JobRendezvousConfig}), so a split filedrop
 * is a fact about the machine rather than a form the operator fills. What is still
 * the operator's, and so still able to disagree with it, is the retain-mode choice a
 * split rendezvous requires.
 */

/**
 * The invitation endpoint for this appliance's rendezvous: the advisory locator the
 * console minted names for, in whichever form the appliance is provisioned -- the
 * single shared folder, or the split pair. Undefined when the appliance names no
 * locator, which is the state that withholds the filedrop card entirely.
 *
 * The pair is carried as THIS party authored it, not mirrored: a
 * {@link FileDropEndpoint}'s pair is defined from the inviter's side and the
 * mirror swap belongs to the single consumer that builds a connection from an
 * endpoint, exactly as it does for an SFTP endpoint. Never the absolute mount path:
 * the appliance's own paths mean nothing on the partner's machine, and the route
 * that reports the provisioning does not carry them to the browser at all.
 */
export function filedropEndpointForRendezvous(
  rendezvous: JobRendezvousConfig | undefined,
): FileDropEndpoint | undefined {
  if (rendezvous?.configured !== true || rendezvous.locator === undefined)
    return undefined;
  if (rendezvous.split !== true)
    return { channel: "filedrop", path: rendezvous.locator };
  if (rendezvous.outboundLocator === undefined) return undefined;
  return {
    channel: "filedrop",
    inboundPath: rendezvous.locator,
    outboundPath: rendezvous.outboundLocator,
  };
}

/**
 * The same rendezvous as the partner's accept kit prints it back: folder NAMES only,
 * and only where the console has a name to print. The sheet is the one place that
 * CALLS a locator the shared folder's name, so where the locator is the mount point a
 * launcher bound the folder at, the sheet says nothing rather than asking the partner
 * to match a name that is not the folder's.
 *
 * On a split appliance the sheet needs both names or neither: a sheet naming one
 * folder of a two-folder rendezvous would read as though the other did not exist.
 */
export function acceptKitEndpointForRendezvous(
  rendezvous: JobRendezvousConfig | undefined,
): AcceptKitEndpoint | undefined {
  if (rendezvous?.configured !== true) return undefined;
  if (rendezvous.split !== true)
    return {
      channel: "filedrop",
      ...(rendezvous.folderName === undefined
        ? {}
        : { path: rendezvous.folderName }),
    };
  const { folderName, outboundFolderName } = rendezvous;
  return {
    channel: "filedrop",
    split: true,
    ...(folderName !== undefined && outboundFolderName !== undefined
      ? { inboundPath: folderName, outboundPath: outboundFolderName }
      : {}),
  };
}

/**
 * What the console says when a split rendezvous meets an exchange that is not in
 * retain mode. The console's own words for the rule core states on the composed
 * connection (a separate outbound directory requires `retain_files`) and the CLI
 * fast-fails on `--outbound-path`, named on the control the operator turns on rather
 * than on the config field.
 *
 * It offers no "clear the outbound directory" alternative, unlike its SFTP
 * counterpart: the two mounts are the appliance's provisioning, not a form field the
 * operator can empty, so retain mode is the only end of this disagreement they can
 * move from here.
 */
export const SPLIT_RENDEZVOUS_RETAIN_REQUIREMENT =
  "This console rendezvouses through separate inbound and outbound folders, " +
  "which need retain mode: nothing is deleted after it is read, so each folder " +
  'keeps what is written into it. Turn on "Keep every exchange file" under "How ' +
  'files are handled" to run a shared-folder exchange here.';

/**
 * Why this appliance's rendezvous cannot be used with the exchange's file-handling
 * choices as they stand -- a split rendezvous needs retain mode -- or undefined when
 * the two agree.
 *
 * The mounts and the retain choice are settled in different places and change
 * independently, so the precondition is re-asked wherever the two are known together:
 * at both Create gates, ahead of the invitation mint, and at the acceptor's launch.
 * Without that, retain mode left off reaches the run as a refused job, and on the
 * invite path only after a partner-facing accept kit was already minted for a
 * rendezvous the run will not conduct.
 */
export function splitRendezvousRetainProblem(
  rendezvous: JobRendezvousConfig | undefined,
  retainFiles: boolean,
): string | undefined {
  if (rendezvous?.split !== true || retainFiles) return undefined;
  return SPLIT_RENDEZVOUS_RETAIN_REQUIREMENT;
}
