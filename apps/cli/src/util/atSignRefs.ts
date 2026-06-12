import fs from "node:fs";

import type { ConnectionConfig } from "@psilink/core";
import { UsageError } from "@psilink/core";

import { expandTilde } from "../fileUtils";

/**
 * Resolve a single `@path` reference to the referenced file's contents, trimmed.
 * A value not beginning with `@` is returned unchanged. The text after `@` is a
 * local path, so a leading `~` expands to the home directory (e.g.
 * `@~/secrets/id_rsa`).
 *
 * A missing, moved, or unreadable referenced file is a {@link UsageError} (CLI
 * exit 64) -- invalid caller configuration to fix, not a transport failure --
 * naming the reference so the user can locate it. This is the failure a saved
 * config's preserved `@path` produces when the file is gone at the next
 * exchange's config load, before any network activity (see docs/CLI.md
 * "Configuration").
 */
export function resolveAtSignRef(value: string): string {
  if (!value.startsWith("@")) return value;
  const refPath = expandTilde(value.slice(1));
  try {
    return fs.readFileSync(refPath, "utf8").trim();
  } catch (err) {
    throw new UsageError(
      `cannot read the @-file reference ${value}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * Recursively resolve every `@path` string in a JSON-like value, reading each
 * referenced file in place. Applied to a raw config at load and to the
 * invitation argument, where every `@`-eligible field must be resolved.
 *
 * Credential preservation at persistence sites does NOT use this: it uses
 * {@link resolveConnectionCredentials} so the original `@path` survives to disk
 * and the secret is never inlined into `psilink.yaml`.
 */
export function resolveAtSignRefs(obj: unknown): unknown {
  if (typeof obj === "string") return resolveAtSignRef(obj);
  if (Array.isArray(obj)) return obj.map(resolveAtSignRefs);
  if (obj !== null && typeof obj === "object")
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [
        k,
        resolveAtSignRefs(v),
      ]),
    );
  return obj;
}

/**
 * Resolve `@path` credential references on a connection for live use, returning
 * a clone with the SFTP `server.password` / `server.privateKey` fields read from
 * their referenced files. The input is NOT mutated, so a caller can connect with
 * the resolved clone while persisting the original -- whose `@path` is still in
 * place -- keeping the secret out of `psilink.yaml`. The preserved `@path` is
 * re-resolved (by {@link resolveAtSignRefs}) at the next exchange's config load.
 *
 * Only those two fields are resolved: they are the sole credential a CLI flag
 * (`--server-password` / `--server-private-key`) or a connection URL can set on
 * the persistence paths (`--save`, `invite`/`accept`). Other `@`-eligible fields
 * (HTTP `bearer`, `turn.credential`, `providerOptions`, ...) are reachable only
 * from a hand-authored config, which {@link resolveAtSignRefs} resolves at load;
 * a future credential flag that persists must be added here. Non-SFTP channels
 * carry no such credential and pass through unchanged.
 */
export function resolveConnectionCredentials(
  connection: ConnectionConfig,
): ConnectionConfig {
  if (connection.channel !== "sftp") return connection;
  const resolved = structuredClone(connection);
  const { server } = resolved;
  if (server.password !== undefined)
    server.password = resolveAtSignRef(server.password);
  if (server.privateKey !== undefined)
    server.privateKey = resolveAtSignRef(server.privateKey);
  return resolved;
}
