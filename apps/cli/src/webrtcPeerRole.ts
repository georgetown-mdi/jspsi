import type {
  ConnectionConfig,
  RendezvousRole,
  WebRTCConnectionConfig,
} from "@psilink/core";

/**
 * Return `connection` holding `role`, for the bootstrap commands to apply to
 * every connection they run and persist -- `psilink invite` stamps `inviter`
 * and `psilink accept` stamps `acceptor`, decided by which command runs and
 * orthogonal to the PSI sender/receiver roles the linkage terms resolve.
 *
 * On the WebRTC channel `role` is the half of the rendezvous peer-id
 * derivation the CLI supplies (see docs/spec/PROTOCOL.md,
 * "WebRTC rendezvous peer-id derivation"): the two commands stamping
 * complementary roles is what makes the derived ids a meeting pair, and the
 * persisted role is the only place a later run learns which side of it this
 * party is on.
 *
 * `role` is a WebRTC-only field (the sftp and filedrop connection schemas
 * define none), so a connection on any other channel is returned unchanged
 * rather than holding a field its own schema would reject. The argument is
 * never mutated: a stamped WebRTC connection is a copy; every other channel
 * returns the argument itself.
 */
export function withWebRTCPeerRole<Connection extends ConnectionConfig>(
  connection: Connection,
  role: RendezvousRole,
): Connection {
  if (connection.channel !== "webrtc") return connection;
  // Hold the derivation's own role label to the connection schema's field type,
  // so a divergence between the two vocabularies fails to compile here instead
  // of persisting a role the rendezvous cannot key an id on. It stays a
  // separate statement because a generic spread's overridden property is not
  // checked against the constraint -- inlining it into the return below erases
  // the check without any other symptom.
  const schemaRole: NonNullable<WebRTCConnectionConfig["role"]> = role;
  return { ...connection, role: schemaRole };
}
