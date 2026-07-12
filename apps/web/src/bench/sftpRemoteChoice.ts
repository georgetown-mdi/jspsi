import type { SFTPEndpoint } from "@psilink/core";
import type { SftpRemoteProjection } from "@jobs/jobManager";

/**
 * The pure model behind the console remote picker: on a console build with
 * provisioned SFTP remotes, the operator picks a remote by name instead of
 * authoring a free-text host/directory, and the invitation's sftp endpoint is
 * derived from the picked remote's locator fields at the same mint seam the
 * save surface's authored fields feed (generateInvitation's
 * `connectionEndpoint`). No React, no I/O -- the tested boundary for "the code
 * points where the appliance will actually connect".
 */

/**
 * The invitation endpoint for a chosen operator-provisioned remote: the
 * remote's locator fields verbatim -- host, optional port, optional path --
 * mirroring how the save surface's `endpointRequestFor` maps its authored
 * fields. The remote NAME stays out of the token (it is an appliance-local
 * handle the job intent carries, meaningless to the partner), and no
 * credential can appear: the projection carries none by construction and
 * {@link SFTPEndpoint} admits none.
 */
export function sftpEndpointForRemote(
  remote: SftpRemoteProjection,
): SFTPEndpoint {
  return {
    channel: "sftp",
    host: remote.host,
    ...(remote.port !== undefined ? { port: remote.port } : {}),
    ...(remote.path !== undefined ? { path: remote.path } : {}),
  };
}

/** The picker's option label: the remote's name plus its locator, so the
 * operator recognizes the destination the exchange will run through. */
export function sftpRemoteOptionLabel(remote: SftpRemoteProjection): string {
  const port = remote.port !== undefined ? `:${remote.port}` : "";
  const path = remote.path !== undefined ? ` ${remote.path}` : "";
  return `${remote.name} - ${remote.host}${port}${path}`;
}
