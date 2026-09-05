import { UsageError } from "../errors.js";
import {
  MAX_ENDPOINT_HOST_LENGTH,
  MAX_ENDPOINT_PATH_LENGTH,
} from "./invitation.js";
import type { ConnectionEndpoint } from "./invitation.js";
import type { ConnectionConfig } from "./connection.js";

/**
 * The connections {@link endpointFromConnection} produces a locator for.
 * Channels are named one by one rather than aliasing
 * {@link ConnectionConfig} (the allowlist convention in CONTRIBUTING.md),
 * so a channel added to that union is rejected here until its locator
 * fields are decided. Mirrors the CLI's `ProtocolConnectionConfig`; the
 * check that the two stay in step lives where both are visible
 * (apps/cli/test/unit/protocolEndpointParity.test.ts).
 */
export type EndpointSourceConnectionConfig = Extract<
  ConnectionConfig,
  { channel: "sftp" | "filedrop" | "webrtc" }
>;

/**
 * Placeholder host written into an SFTP connection block when no locator
 * seeds it. Obvious in a diff and fails loudly (rather than silently
 * connecting somewhere) if run before editing -- not a valid hostname.
 * Shared by the CLI's `connectionFromEndpoint` and the web mint layer so
 * the "fill this in" marker is identical wherever the config was minted.
 */
export const PLACEHOLDER_SFTP_HOST = "REPLACE_WITH_SFTP_HOST";

/**
 * Placeholder SSH username seeded onto an SFTP connection block. A
 * locator carries no credential (an endpoint has no credential field), so
 * an SFTP config minted from a locator marks the one identity field the
 * operator must supply with this placeholder. Shared by the CLI and the
 * web mint layer (see {@link PLACEHOLDER_SFTP_HOST}).
 */
export const PLACEHOLDER_SSH_USERNAME = "REPLACE_WITH_SSH_USERNAME";

/**
 * Build the credential-free {@link ConnectionEndpoint} an online invitation
 * carries, from the connection the inviter is actually using. The producer
 * inverse of the CLI's `connectionFromEndpoint`: it copies only the public
 * locator (host/port/path, or the split inbound/outbound pair) and never a
 * credential -- the endpoint type has no credential field and the strict
 * endpoint schema rejects one besides, so credential material cannot ride
 * along by construction.
 *
 * The split inbound/outbound pair is emitted VERBATIM: the inviter's own
 * inbound stays inbound. The mirror swap that makes the two parties images
 * of each other lives only at the accept-side `connectionFromEndpoint`;
 * swapping here too would double-swap and undo it. A shared connection
 * emits a single `path`.
 *
 * On `webrtc` the locator is only the peer-coordination server's own
 * host/port/path -- where the acceptor's signaling socket goes. Everything
 * else (`key`, `username`, `stun`/`turn`, `provision`, `secure`) is left
 * behind: those are either not a public locator or have no endpoint-schema
 * field, so a plaintext-broker locator is unreachable here by construction.
 *
 * `port` is carried only when it is a reachable 1-65535 value: port 0 (an
 * OS-assigned ephemeral port) is dropped rather than emitted as an
 * undialable locator. An empty `path`, which the webrtc server schema
 * permits and the endpoint schema rejects, is dropped for the same reason
 * -- a dead branch for today's only caller (asserted in the CLI's
 * `inviterConnectionFromURL` suite); a future caller reaching this with an
 * empty path must resolve the mount point itself, since the CLI and
 * browser resolve an absent path differently
 * (docs/spec/WEBRTC_TRANSPORT.md).
 *
 * A host or path longer than the endpoint schema allows
 * ({@link MAX_ENDPOINT_HOST_LENGTH} / {@link MAX_ENDPOINT_PATH_LENGTH}) is
 * rejected here as a {@link UsageError} naming the field, rather than
 * truncated or left to appear as an opaque ZodError at encode.
 */
export function endpointFromConnection(
  connection: EndpointSourceConnectionConfig,
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

  if (connection.channel === "webrtc") {
    const { server } = connection;
    requireFits("connection host", server.host, MAX_ENDPOINT_HOST_LENGTH);
    requireFits("connection path", server.path, MAX_ENDPOINT_PATH_LENGTH);
    return {
      channel: "webrtc",
      host: server.host,
      port: reachablePort(server.port),
      // The signaling mount point, dropped when blank (see the doc comment); a
      // dead branch for today's only caller, which never mints an empty one.
      path:
        server.path !== undefined && server.path !== ""
          ? server.path
          : undefined,
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
