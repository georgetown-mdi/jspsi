import type { ConnectionConfig } from "@psilink/core";
import { safeParseFileSyncOptions } from "@psilink/core";

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
  retainFiles?: boolean;
  timestampInFilename?: boolean;
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

  // locklessRendezvous, peerId, retainFiles, and timestampInFilename are
  // FileSyncOptions fields; only apply them on channels that use
  // FileSyncConnection. The other overrides above (peerTimeout etc.) are
  // SharedOptions that apply to all channels including webrtc.
  if (
    (result.channel === "sftp" || result.channel === "filedrop") &&
    (overrides.locklessRendezvous !== undefined ||
      overrides.peerId !== undefined ||
      overrides.retainFiles !== undefined ||
      overrides.timestampInFilename !== undefined)
  ) {
    result.options = {
      ...result.options,
      ...(overrides.locklessRendezvous !== undefined && {
        locklessRendezvous: overrides.locklessRendezvous,
      }),
      ...(overrides.peerId !== undefined && {
        peerId: overrides.peerId,
      }),
      ...(overrides.retainFiles !== undefined && {
        retainFiles: overrides.retainFiles,
      }),
      ...(overrides.timestampInFilename !== undefined && {
        timestampInFilename: overrides.timestampInFilename,
      }),
    };

    // Re-validate the merged options through FileSyncOptionsSchema so that
    // all constraints (min length, timestampInFilename dependency, reserved
    // values) are enforced from one place rather than mirrored here.
    // Re-validate whenever any FileSyncOptions field is overridden, not just
    // peerId/retainFiles, so future cross-field constraints on locklessRendezvous
    // are not silently bypassed.
    const validation = safeParseFileSyncOptions(result.options);
    if (!validation.success) {
      const message = validation.error.issues.map((i: { message: string }) => i.message).join("; ");
      throw new Error(message);
    }
  }

  return result;
}
