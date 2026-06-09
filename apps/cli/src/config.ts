import YAML from "yaml";
import type { ConnectionConfig, ExchangeSpec } from "@psilink/core";
import {
  OPAQUE_VALUE_KEYS,
  safeParseFileSyncOptions,
  UsageError,
} from "@psilink/core";

import { writeFileOwnerOnly } from "./fileUtils";

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
      // An invalid option combination (from psilink.yaml or a CLI override) is
      // invalid caller configuration: a UsageError so the CLI exits 64, not 69.
      throw new UsageError(message);
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
 * Recursively rewrites object keys from camelCase to snake_case. The inverse of
 * core's `camelizeKeys` for the keys the exchange schema uses: every config key
 * originates as snake_case, so write-then-read round-trips unchanged (the
 * round-trip is covered by a test). It is not a general camelCase inverse -- an
 * embedded acronym such as `URL` would snakeize to `u_r_l` -- but no such key
 * occurs in the schema. Only keys are rewritten; string values (e.g. the
 * `firstName` in `type: firstName`) are left verbatim, matching the read path.
 *
 * Opaque-value maps (`OPAQUE_VALUE_KEYS`, currently `connection.provider_options`)
 * are skipped symmetrically with `camelizeKeys`: the map's own key is snakeized,
 * but its contents are left verbatim so a user-authored key (snake or camel)
 * survives byte-for-byte to disk and back. The shared `OPAQUE_VALUE_KEYS` set
 * keeps the read and write paths excluding exactly the same subtrees, preserving
 * the write -> read round-trip invariant. Function-specific `params` blocks are
 * NOT opaque -- they are psilink's own vocabulary and stay normalized.
 *
 * The opaque check consults the raw key directly (`OPAQUE_VALUE_KEYS.has(k)`),
 * with no casing normalization. This is correct, and the asymmetry with
 * `camelizeKeys` -- which normalizes via its own `snakeToCamel` before the same
 * check -- is deliberate, because the two functions have different input
 * domains. `camelizeKeys` reads user YAML whose key casing is unknown
 * (conventionally snake_case), so it must normalize to the canonical camelCase
 * form first. `snakeizeKeys` is only ever called by `saveConfig` on a typed
 * `ExchangeSpec`, whose opaque key is always the camelCase `providerOptions`, so
 * the raw key already matches the camelCase-keyed set and normalizing would be
 * dead code. Re-introducing a `snakeToCamel` helper here to force symmetry would
 * duplicate core's private copy across the package boundary -- the CLI builds
 * against core's dist, so the two cannot share a private helper without widening
 * core's export surface -- and a silent drift between the copies would break the
 * very round-trip invariant the shared set exists to guarantee.
 */
function snakeizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeizeKeys);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) =>
        // Raw-key check: `k` is already canonical camelCase here (a typed
        // ExchangeSpec from saveConfig), so the opaque key matches the
        // camelCase-keyed set as-is -- see the note above on why this writer
        // does not normalize.
        OPAQUE_VALUE_KEYS.has(k)
          ? [camelToSnake(k), v]
          : [camelToSnake(k), snakeizeKeys(v)],
      ),
    );
  return value;
}

/**
 * Serialize an {@link ExchangeSpec} and write it to `configPath` as snake_case
 * YAML, owner-read-only -- a config may carry inline SFTP credentials
 * (`server.password`, `server.privateKey`), so it gets the same `0600` / ACL
 * protection as the key file via {@link writeFileOwnerOnly}.
 *
 * The PAKE token and its expiration live only in the key file and never belong
 * in the config; they are stripped from `connection.authentication` here even
 * if a caller leaves them populated, so the secret cannot be duplicated onto
 * disk (and cannot go stale after token rotation). The caller's spec is not
 * mutated.
 *
 * Does not guard against overwriting an existing file; callers provision through
 * `provisionConfigAndKey`, which runs the conflict gate first.
 */
export function saveConfig(configPath: string, spec: ExchangeSpec): void {
  const sanitized = structuredClone(spec);
  const auth = sanitized.connection.authentication;
  if (auth) {
    delete auth.sharedSecret;
    delete auth.expires;
    // Drop the container if those were its only keys, so the config carries no
    // noisy empty `authentication: {}` block. WebRTC's `role` (the only other
    // field) keeps it non-empty when present.
    if (Object.keys(auth).length === 0)
      delete sanitized.connection.authentication;
  }
  writeFileOwnerOnly(configPath, YAML.stringify(snakeizeKeys(sanitized)));
}
