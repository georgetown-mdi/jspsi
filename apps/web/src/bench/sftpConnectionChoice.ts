import { SPLIT_DIRECTORY_RETAIN_REQUIREMENT } from "./sftpConnectionForm";

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
 * fields verbatim -- host, optional port, and whichever remote-directory form
 * the connection carries (the shared `path`, or the split
 * `inboundPath`/`outboundPath` pair) -- mirroring how the save surface's
 * `endpointRequestFor` maps its authored fields. No credential can appear: the
 * projection carries none by construction and {@link SFTPEndpoint} admits none.
 *
 * The split pair is carried as THIS party authored it, not mirrored: an
 * {@link SFTPEndpoint}'s pair is defined from the inviter's side, and the swap
 * that makes the acceptor read where the inviter writes belongs to the single
 * consumer that builds a connection from an endpoint. Emitting the pair mirrored
 * here would apply that swap twice.
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
 * Why the authored connection cannot be used with the exchange's file-handling
 * choices as they stand right now -- a split-directory connection needs retain
 * mode -- or undefined when the two agree.
 *
 * The connection and the retain choice are authored on separate cards and change
 * independently, so the precondition the authoring form states while both are in
 * front of the operator is re-asked wherever the two are known together. Without
 * that, retain mode turned off after the connection was authored reaches the run
 * as a refused job, and on the invite path only after a partner-facing accept kit
 * was already minted for a rendezvous the run will not conduct.
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
