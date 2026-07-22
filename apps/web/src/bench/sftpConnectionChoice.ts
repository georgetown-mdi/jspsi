import type { SFTPEndpoint } from "@psilink/core";
import type { SftpConnectionProjection } from "@jobs/jobManager";

/**
 * The pure model behind the console SFTP card: on a console build, the operator
 * authors the connection in-console, and the invitation's sftp endpoint is
 * derived from its locator fields at the same mint seam the save surface's
 * authored fields feed (generateInvitation's `connectionEndpoint`). No React,
 * no I/O -- the tested boundary for "the code points where the appliance will
 * actually connect".
 */

/**
 * The invitation endpoint for the authored SFTP connection: its locator
 * fields verbatim -- host, optional port, optional path -- mirroring how the
 * save surface's `endpointRequestFor` maps its authored fields. No credential
 * can appear: the projection carries none by construction and
 * {@link SFTPEndpoint} admits none.
 */
export function sftpEndpointForConnection(
  connection: SftpConnectionProjection,
): SFTPEndpoint {
  return {
    channel: "sftp",
    host: connection.host,
    ...(connection.port !== undefined ? { port: connection.port } : {}),
    ...(connection.path !== undefined ? { path: connection.path } : {}),
  };
}

/** The connection's display label: its locator (`host[:port] [path]`), so the
 * operator recognizes the destination the exchange will run through. */
export function sftpConnectionLabel(
  connection: SftpConnectionProjection,
): string {
  const port = connection.port !== undefined ? `:${connection.port}` : "";
  const path = connection.path !== undefined ? ` ${connection.path}` : "";
  return `${connection.host}${port}${path}`;
}
