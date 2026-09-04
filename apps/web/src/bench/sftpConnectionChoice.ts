import { SPLIT_DIRECTORY_RETAIN_REQUIREMENT } from "./sftpConnectionForm";

import type { SFTPEndpoint } from "@psilink/core";
import type { SftpConnectionProjection } from "@jobs/jobManager";

/**
 * The pure model behind the console SFTP card: on a console build, the operator
 * authors the connection in-console, and the invitation's sftp endpoint is
 * derived from its locator fields at the same mint seam the save surface's
 * authored fields feed (generateInvitation's `connectionEndpoint`). No React,
 * no I/O -- the tested boundary for "the code points where the console will
 * actually connect".
 */

/**
 * The invitation endpoint for the authored SFTP connection, mirroring how the
 * save surface's `endpointRequestFor` maps the same fields. No credential can
 * appear: {@link SFTPEndpoint} admits none.
 *
 * The split pair is carried as this party authored it, NOT mirrored -- the
 * inviter/acceptor swap belongs to the single consumer that builds a
 * connection from an endpoint; mirroring here would apply it twice.
 */
export function sftpEndpointForConnection(
  connection: SftpConnectionProjection,
): SFTPEndpoint {
  return {
    channel: "sftp",
    host: connection.host,
    ...(connection.port !== undefined ? { port: connection.port } : {}),
    ...(connection.path !== undefined ? { path: connection.path } : {}),
    ...(connection.inboundPath !== undefined &&
    connection.outboundPath !== undefined
      ? {
          inboundPath: connection.inboundPath,
          outboundPath: connection.outboundPath,
        }
      : {}),
  };
}

/**
 * Why the authored connection cannot run with the exchange's current
 * file-handling choice -- a split-directory connection needs retain mode --
 * or undefined when the two agree.
 *
 * The connection and the retain choice are authored on separate cards and
 * change independently, so this precondition is re-checked wherever both are
 * known together.
 */
export function splitDirectoryRetainProblem(
  connection: SftpConnectionProjection | null | undefined,
  retainFiles: boolean,
): string | undefined {
  if (connection == null || retainFiles) return undefined;
  const split =
    connection.inboundPath !== undefined &&
    connection.outboundPath !== undefined;
  return split ? SPLIT_DIRECTORY_RETAIN_REQUIREMENT : undefined;
}

/** The connection's display label: its locator (`host[:port] [directories]`), so
 * the operator recognizes the destination the exchange will run through. A
 * split-directory connection names both halves in the direction they run, since
 * which folder is read and which is written is the whole point of naming two. */
export function sftpConnectionLabel(
  connection: SftpConnectionProjection,
): string {
  const port = connection.port !== undefined ? `:${connection.port}` : "";
  const directories =
    connection.inboundPath !== undefined &&
    connection.outboundPath !== undefined
      ? ` in ${connection.inboundPath} out ${connection.outboundPath}`
      : connection.path !== undefined
        ? ` ${connection.path}`
        : "";
  return `${connection.host}${port}${directories}`;
}
