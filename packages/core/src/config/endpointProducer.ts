import { UsageError } from "../errors.js";
import {
  MAX_ENDPOINT_HOST_LENGTH,
  MAX_ENDPOINT_PATH_LENGTH,
} from "./invitation.js";
import type { ConnectionEndpoint } from "./invitation.js";
import type { ConnectionConfig } from "./connection.js";

/**
 * A connection over one of the file-sync channels (`sftp`, `filedrop`) -- the
 * ones a file-drop or SFTP exchange runs over and the only ones
 * {@link endpointFromConnection} produces a locator for. Narrowed from
 * {@link ConnectionConfig} so a `webrtc` connection cannot reach the producer:
 * a webrtc locator is authored from the browser location, not from a connection
 * config, so webrtc's producer lives elsewhere. Mirrors the CLI's
 * `RunnableConnectionConfig` (the channels its transport can run) so the two
 * agree by construction.
 */
export type FileSyncConnectionConfig = Extract<
  ConnectionConfig,
  { channel: "sftp" | "filedrop" }
>;

/**
 * Placeholder host written into an SFTP connection block when no locator seeds
 * it. Chosen to be obvious in a diff and to fail loudly (rather than silently
 * connect somewhere) if an operator runs an exchange before editing it -- the
 * string is intentionally not a valid hostname. Shared by the CLI's
 * `connectionFromEndpoint` and the web mint layer so the "fill this in" marker
 * an operator sees is identical wherever the config was minted.
 */
export const PLACEHOLDER_SFTP_HOST = "REPLACE_WITH_SFTP_HOST";

/**
 * Placeholder SSH username seeded onto an SFTP connection block. The credential
 * portion of a connection is never carried on a locator (by construction: an
 * endpoint has no credential field), so an SFTP config minted from a locator
 * marks the one identity field the operator must supply with this obvious
 * placeholder. Shared by the CLI and the web mint layer (see
 * {@link PLACEHOLDER_SFTP_HOST}).
 */
export const PLACEHOLDER_SSH_USERNAME = "REPLACE_WITH_SSH_USERNAME";

/**
 * Build the credential-free {@link ConnectionEndpoint} an online invitation
 * carries, from the connection the inviter is actually using (its
 * host/port/path locator, with any overrides already applied). The producer
 * inverse of the CLI's `connectionFromEndpoint`: it copies only the public
 * locator (host/port/path, or the split inbound/outbound pair) and NEVER a
 * credential -- the endpoint type has no field for a password, private key,
 * key-file path, or username, and the strict endpoint schema rejects one
 * besides, so credential material cannot ride along by construction (the
 * security invariant this producer exists to honor).
 *
 * The split inbound/outbound pair is emitted VERBATIM -- the inviter's own
 * inbound stays inbound, its outbound stays outbound. The mirror swap that makes
 * the two parties images of each other lives solely at the accept-side
 * `connectionFromEndpoint`; swapping here too would double-swap and undo it. A
 * shared (single-`path`) connection emits a single `path` as before. Guarding on
 * `inboundPath` is enough to read `outboundPath`: the connection reaching here is
 * built and schema-validated, whose both-or-neither refine rejects a half pair,
 * so the pair is always whole (`outboundPath` is statically `string | undefined`
 * but is never undefined once `inboundPath` is set).
 *
 * Scoped to the file-sync channels by the {@link FileSyncConnectionConfig}
 * parameter: a webrtc locator is authored from the browser location, not from a
 * connection config, so webrtc never reaches here.
 *
 * `port` is carried only when it is a reachable 1-65535 value. Port 0 is the one
 * port the connection schema permits but the endpoint schema rejects (it is an
 * OS-assigned ephemeral port, never a connect target), so it is dropped rather
 * than emitted as a locator the partner could not dial -- and rather than
 * failing the whole invite when the endpoint is encoded.
 *
 * A host or path longer than the endpoint schema allows
 * ({@link MAX_ENDPOINT_HOST_LENGTH} / {@link MAX_ENDPOINT_PATH_LENGTH}) is the
 * other connection-permits / endpoint-rejects mismatch (the connection schema
 * bounds neither by length). It is degenerate inviter input -- a real hostname
 * is <= 253 and a path <= PATH_MAX -- and is rejected here as a
 * {@link UsageError} naming the field, rather than dropped (truncating a locator
 * would change where the partner connects) or left to surface as an opaque
 * ZodError at encode.
 */
export function endpointFromConnection(
  connection: FileSyncConnectionConfig,
): ConnectionEndpoint {
  // Keep a port only when it is a reachable 1-65535 value the endpoint schema
  // accepts; drop port 0 (see the doc comment) so encoding never fails on it.
  const reachablePort = (port: number | undefined): number | undefined =>
    port !== undefined && Number.isInteger(port) && port >= 1 && port <= 65535
      ? port
      : undefined;

  // Reject a locator longer than the endpoint schema permits with a clear,
  // field-named UsageError, rather than letting encodeInvitation reject it as an
  // opaque ZodError downstream (see the doc comment). A no-op for an unset field,
  // so each branch may check every locator field and only the present ones fire.
  const requireFits = (
    label: string,
    value: string | undefined,
    max: number,
  ): void => {
    if (value !== undefined && value.length > max)
      throw new UsageError(
        `${label} is too long to carry in an invitation connection endpoint ` +
          `(${value.length} > ${max} characters)`,
      );
  };

  if (connection.channel === "sftp") {
    const { server } = connection;
    requireFits("connection host", server.host, MAX_ENDPOINT_HOST_LENGTH);
    requireFits("connection path", server.path, MAX_ENDPOINT_PATH_LENGTH);
    requireFits("inbound_path", server.inboundPath, MAX_ENDPOINT_PATH_LENGTH);
    requireFits("outbound_path", server.outboundPath, MAX_ENDPOINT_PATH_LENGTH);
    if (server.inboundPath !== undefined)
      // Split-directory connection: emit the inviter's pair verbatim (the
      // acceptor mirror-swaps it at connectionFromEndpoint; do not pre-swap).
      return {
        channel: "sftp",
        host: server.host,
        port: reachablePort(server.port),
        inboundPath: server.inboundPath,
        outboundPath: server.outboundPath,
      };
    return {
      channel: "sftp",
      host: server.host,
      port: reachablePort(server.port),
      // Shared mode: the inviter's remote working directory (omitted for a
      // bare-host connection, which uses the server's default directory).
      path: server.path,
    };
  }

  // filedrop: the locator is the directory only -- no host/port/credentials.
  requireFits("connection path", connection.path, MAX_ENDPOINT_PATH_LENGTH);
  requireFits("inbound_path", connection.inboundPath, MAX_ENDPOINT_PATH_LENGTH);
  requireFits(
    "outbound_path",
    connection.outboundPath,
    MAX_ENDPOINT_PATH_LENGTH,
  );
  if (connection.inboundPath !== undefined)
    // Split-directory connection: emit the pair verbatim (swapped by the
    // acceptor, as in the sftp branch above).
    return {
      channel: "filedrop",
      inboundPath: connection.inboundPath,
      outboundPath: connection.outboundPath,
    };
  return {
    channel: "filedrop",
    path: connection.path,
  };
}
