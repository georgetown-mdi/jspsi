import { UsageError } from "../errors.js";
import {
  MAX_ENDPOINT_HOST_LENGTH,
  MAX_ENDPOINT_PATH_LENGTH,
} from "./invitation.js";
import type { ConnectionEndpoint } from "./invitation.js";
import type { ConnectionConfig } from "./connection.js";

/**
 * The connections {@link endpointFromConnection} produces a locator for. The
 * channels are named one by one rather than aliasing {@link ConnectionConfig}
 * (the allowlist convention in CONTRIBUTING.md), so a channel added to that
 * union is rejected here until its locator fields have been decided. Mirrors the
 * CLI's `ProtocolConnectionConfig` (the channels its transport can run); core
 * cannot see that type, so the two are held in step by hand rather than by a
 * check.
 */
export type EndpointSourceConnectionConfig = Extract<
  ConnectionConfig,
  { channel: "sftp" | "filedrop" | "webrtc" }
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
 * shared (single-`path`) connection emits a single `path`. Guarding on
 * `inboundPath` is enough to read `outboundPath`: the connection reaching here is
 * built and schema-validated, whose both-or-neither refine rejects a half pair,
 * so the pair is always whole (`outboundPath` is statically `string | undefined`
 * but is never undefined once `inboundPath` is set).
 *
 * On `webrtc` the locator is the peer-coordination server's own
 * host/port/path -- where the acceptor's signaling socket goes, which is the
 * only thing a party running its own (or a forked deployment's) coordination
 * server cannot convey any other way. Everything else on that connection is left
 * behind: the `key` and `username` fields (only `key` is PeerJS's own; `username`
 * has no consumer on this channel at all), the `stun`/`turn` entries (a relay
 * entry carries a credential of its own), the `provision` block, and `secure` --
 * the first three because they are not a public locator, `secure` because the
 * endpoint schema has no field for it, so an acceptor seeded from one resolves
 * TLS. A locator for a plaintext broker is therefore out of reach here by
 * construction; the inviting command names that where the operator can act on it.
 *
 * `port` is carried only when it is a reachable 1-65535 value. Port 0 is the one
 * port the connection schema permits but the endpoint schema rejects (it is an
 * OS-assigned ephemeral port, never a connect target), so it is dropped rather
 * than emitted as a locator the partner could not dial -- and rather than
 * failing the whole invite when the endpoint is encoded. An empty `path`, which
 * the webrtc server schema permits and the endpoint schema rejects, is dropped
 * for the same reason: a blank signaling path is not a locator. That drop is
 * unreachable from today's only caller -- `psilink invite`'s URL-built webrtc
 * connection never has an empty pathname (asserted in the CLI's
 * `inviterConnectionFromURL` suite) -- so it is a dead branch, not active
 * behavior. A future producer reachable with a genuinely empty path must emit
 * the resolved mount point itself rather than drop the field and lean on a
 * consumer default: the CLI and browser resolve an absent path differently
 * (see docs/spec/WEBRTC_TRANSPORT.md), so there is no shared default to defer
 * to.
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
