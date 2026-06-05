import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { ConnectionConfig, ExchangeSpec } from "@psilink/core";
import { safeParseFileSyncOptions } from "@psilink/core";

/**
 * Default path for the exchange config file written by the provisioning
 * commands (`invite`, `accept`, and `exchange --save`). Matches the default the
 * `exchange` command reads from, so a config written here is found without an
 * explicit `--config-file`.
 */
export const DEFAULT_CONFIG_PATH = "./psilink.yaml";

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

    // retain_files implies lockless_rendezvous and timestamp_in_filename when
    // those are not yet set. This lets --retain-files alone suffice at the CLI.
    // An explicit false is left untouched so the schema refine can surface the
    // contradiction with a clear error message.
    if (result.options.retainFiles === true) {
      if (result.options.locklessRendezvous === undefined)
        result.options.locklessRendezvous = true;
      if (result.options.timestampInFilename === undefined)
        result.options.timestampInFilename = true;
    }

    // Re-validate the merged options through FileSyncOptionsSchema so that
    // all constraints (min length, timestampInFilename dependency, reserved
    // values) are enforced from one place rather than mirrored here.
    // Re-validate whenever any FileSyncOptions field is overridden, not just
    // peerId/retainFiles, so future cross-field constraints on locklessRendezvous
    // are not silently bypassed.
    const validation = safeParseFileSyncOptions(result.options);
    if (!validation.success) {
      const message = validation.error.issues
        .map((i: { message: string }) => i.message)
        .join("; ");
      throw new Error(message);
    }
  }

  return result;
}

/**
 * Logs a one-time reminder, on the file-sync channels only, that retain mode is
 * a bilateral agreement with no negotiation: this party has it enabled (with the
 * `lockless_rendezvous` and `timestamp_in_filename` it implies), and the peer
 * must set all three identically. A `retain_files` or `lockless_rendezvous`
 * mismatch is detected at rendezvous and fails fast on both sides with a clear
 * error naming each side's setting (`timestamp_in_filename` is not advertised,
 * but it cannot diverge independently of `retain_files`). Shared by the
 * `exchange` and `zero-setup` commands so the wording cannot drift between them.
 */
export function announceRetainMode(
  connection: ConnectionConfig,
  log: { info: (message: string) => void },
): void {
  if (
    (connection.channel === "sftp" || connection.channel === "filedrop") &&
    connection.options?.retainFiles === true
  ) {
    log.info(
      "retain mode is enabled, with lockless_rendezvous and " +
        "timestamp_in_filename; the peer must set all three identically " +
        "(these flags are not negotiated).",
    );
  }
}

// --- Config writer -----------------------------------------------------------

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * Recursively rewrites object keys from camelCase to snake_case. The exact
 * inverse of core's `camelizeKeys`, which is applied when a config is read; the
 * writer is its inverse so a value round-trips through write then read
 * unchanged and the on-disk YAML keeps the snake_case convention. Only keys are
 * rewritten; string values (e.g. the `firstName` in `type: firstName`) are left
 * verbatim, matching the read path.
 */
function snakeizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeizeKeys);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [camelToSnake(k), snakeizeKeys(v)]),
    );
  return value;
}

/**
 * Serialize an {@link ExchangeSpec} and write it to `configPath` as snake_case
 * YAML. Creates parent directories as needed. Does not guard against
 * overwriting an existing file; callers provision through
 * `provisionConfigAndKey`, which runs the conflict gate first.
 *
 * The PAKE token never belongs in the config (it lives only in the key file);
 * callers construct the spec without it.
 */
export function saveConfig(configPath: string, spec: ExchangeSpec): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, YAML.stringify(snakeizeKeys(spec)), "utf8");
}
