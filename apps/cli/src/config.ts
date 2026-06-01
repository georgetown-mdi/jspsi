import type { ConnectionConfig } from "@psilink/core";

export interface ConnectionOverrides {
  connectionTimeout?: number;
  peerTimeout?: number;
  maxReconnectAttempts?: number;
  serverUsername?: string;
  serverPassword?: string;
  serverPrivateKey?: string;
  serverPort?: number;
  locklessRendezvous?: boolean;
  peerId?: string;
}

export function applyConnectionOverrides(
  connection: ConnectionConfig,
  overrides: ConnectionOverrides,
): ConnectionConfig {
  const result = structuredClone(connection);

  if (result.channel === "sftp") {
    const { server } = result;
    if (overrides.serverUsername !== undefined)
      server.username = overrides.serverUsername;
    if (overrides.serverPassword !== undefined)
      server.password = overrides.serverPassword;
    if (overrides.serverPrivateKey !== undefined)
      server.privateKey = overrides.serverPrivateKey;
    if (overrides.serverPort !== undefined) server.port = overrides.serverPort;
  }

  if (
    overrides.peerTimeout !== undefined ||
    overrides.connectionTimeout !== undefined ||
    overrides.maxReconnectAttempts !== undefined
  ) {
    result.options = {
      ...result.options,
      ...(overrides.peerTimeout !== undefined && {
        peerTimeoutMs: overrides.peerTimeout * 1000,
      }),
      ...(overrides.connectionTimeout !== undefined && {
        serverConnectTimeoutMs: overrides.connectionTimeout * 1000,
      }),
      ...(overrides.maxReconnectAttempts !== undefined && {
        maxReconnectAttempts: overrides.maxReconnectAttempts,
      }),
    };
  }

  // locklessRendezvous and peerId are FileSyncOptions fields; only apply them
  // on channels that use FileSyncConnection. The other overrides above
  // (peerTimeout etc.) are SharedOptions that apply to all channels including
  // webrtc.
  if (
    (result.channel === "sftp" || result.channel === "filedrop") &&
    (overrides.locklessRendezvous !== undefined || overrides.peerId !== undefined)
  ) {
    result.options = {
      ...result.options,
      ...(overrides.locklessRendezvous !== undefined && {
        locklessRendezvous: overrides.locklessRendezvous,
      }),
      ...(overrides.peerId !== undefined && {
        peerId: overrides.peerId,
      }),
    };

    // Enforce peer_id schema constraints against the merged options.
    // applyConnectionOverrides bypasses Zod, so these mirror the refines in
    // FileSyncOptionsSchema that cannot be re-run here.
    if (overrides.peerId !== undefined) {
      if (overrides.peerId === "temp")
        throw new Error(
          "peer_id 'temp' is reserved; the lockless rendezvous upload glob " +
            "('<myId>-*') would capture in-flight 'temp-*.tmp' writes",
        );
      if (result.options?.timestampInFilename !== true)
        throw new Error(
          "--peer-id requires timestamp_in_filename: true in the connection " +
            "options (set it in psilink.yaml); without a timestamp segment, " +
            "a reused stable id can collide with a leftover file from a prior " +
            "crashed session",
        );
    }
  }

  return result;
}
