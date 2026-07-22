import type { SFTPEndpoint } from "@psilink/core";
import type { SftpConnectionProjection } from "@jobs/jobManager";
import type { SftpEndpointLocator } from "./sftpConnectionForm";

/** The SSH/SFTP default port: an omitted port on either side means this, so a
 * locator that names it explicitly does not read as a mismatch against a boot
 * server that omits it. */
const DEFAULT_SFTP_PORT = 22;

/**
 * The pure model behind the console SFTP card: on a console build with a
 * provisioned SFTP server, the operator authors nothing -- the single
 * connection is shown as static text, and the invitation's sftp endpoint is
 * derived from its locator fields at the same mint seam the save surface's
 * authored fields feed (generateInvitation's `connectionEndpoint`). No React,
 * no I/O -- the tested boundary for "the code points where the appliance will
 * actually connect".
 */

/**
 * The invitation endpoint for the provisioned SFTP connection: its locator
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

/**
 * Whether the partner-named locator and the effective boot-provisioned connection
 * name a DIFFERENT SFTP destination -- a different host, port, or remote directory.
 * A boot host is a legitimate alias or IP of the partner's name often enough that a
 * mismatch drives a prominent warning, never a launch block: the operator confirms
 * the two are the same server. Host comparison is case-insensitive (DNS is); an
 * omitted port matches the default {@link DEFAULT_SFTP_PORT} and an omitted path
 * matches an omitted path, so an inconsequential difference does not warn.
 */
export function sftpBootServerMismatch(
  locator: SftpEndpointLocator,
  connection: SftpConnectionProjection,
): boolean {
  const sameHost = locator.host.toLowerCase() === connection.host.toLowerCase();
  const samePort =
    (locator.port ?? DEFAULT_SFTP_PORT) ===
    (connection.port ?? DEFAULT_SFTP_PORT);
  const samePath = (locator.path ?? "") === (connection.path ?? "");
  return !(sameHost && samePort && samePath);
}
