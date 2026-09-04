import fs from "node:fs";

import type { ConnectionConfig, ExchangeSpec, HttpAuth } from "@psilink/core";
import { HOST_KEY_FINGERPRINT_REGEX, UsageError } from "@psilink/core";

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
 * "Configuration"). An empty (or whitespace-only) referenced file is the same
 * class of error: an `@`-file names a file holding a credential or key, and an
 * empty one holds none.
 */
export function resolveAtSignRef(value: string): string {
  if (!value.startsWith("@")) return value;
  const refPath = expandTilde(value.slice(1));
  let content: string;
  try {
    content = fs.readFileSync(refPath, "utf8").trim();
  } catch (err) {
    throw new UsageError(
      `cannot read the @-file reference ${value}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  // Reject an empty result here rather than letting "" pass to a schema that
  // already accepted the non-empty @path string (resolution runs after
  // parse, so e.g. turn.credential's min(1) has validated the literal "@path",
  // not the file contents) and show up only later as an opaque network-layer
  // auth failure with no reference to the offending field.
  if (content === "")
    throw new UsageError(
      `the @-file reference ${value} resolved to an empty file`,
    );
  return content;
}

/**
 * Recursively resolve every `@path` string in a JSON-like value, reading each
 * referenced file in place.
 *
 * Use this only where every contained string is `@`-eligible: a
 * single field-scoped scalar (the `invite`/`accept` invitation argument, a
 * `--server-password` / `--server-private-key` flag value) or an explicitly
 * opaque subtree (`connection.providerOptions`, whose values are passed verbatim
 * to the transport library and may each be an `@`-ref). It must NOT be applied
 * to a whole exchange spec: that resolves free-text fields such as
 * `linkageTerms.identity` and `retentionDisposition`, where a leading `@` is a
 * literal character -- use {@link resolveExchangeSpecRefs} for a loaded config
 * (see docs/EXCHANGE_REFERENCE.md "File references").
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
 * Resolve `@path` references in the credential and opaque-options fields of a
 * parsed {@link ExchangeSpec}, returning a clone with those values read from
 * their referenced files. This is the load-time resolver the CLI applies to a
 * configuration file before connecting.
 *
 * Resolution is scoped to the fields the file-reference convention supports --
 * those documented "`@`-file recommended" in docs/EXCHANGE_REFERENCE.md, all of which
 * live under `connection`: the SFTP `server.password`, `server.privateKey`, and
 * `server.privateKeyPassphrase`, the HTTP-auth `bearer` / `password` on every
 * provisioning endpoint (`server.provision`, `proxy`, `iceProvision`), each
 * WebRTC `turn[].credential`,
 * and the opaque `providerOptions` map. Every other field is left verbatim, so a
 * free-text value with a literal leading `@` (`linkageTerms.identity`,
 * `retentionDisposition`, ...) passes through unread rather than exfiltrating
 * a local file into the self-attested exchange record. A local-path field such as
 * `signing.identityFile` is likewise left alone: its consumer opens that path, so
 * resolving it to the file's contents would corrupt it.
 *
 * A missing or unreadable referenced file is a {@link UsageError} (exit 64); the
 * caller runs this outside the schema-parse try/catch so the error propagates
 * naming the reference rather than being re-wrapped as an invalid-spec error. The
 * input is not mutated.
 */
export function resolveExchangeSpecRefs(spec: ExchangeSpec): ExchangeSpec {
  return { ...spec, connection: resolveConnectionAtSignRefs(spec.connection) };
}

function resolveConnectionAtSignRefs(
  connection: ConnectionConfig,
): ConnectionConfig {
  const resolved = structuredClone(connection);
  switch (resolved.channel) {
    case "sftp":
      resolved.server.password = resolveOptionalAtSignRef(
        resolved.server.password,
      );
      resolved.server.privateKey = resolveOptionalAtSignRef(
        resolved.server.privateKey,
      );
      // The passphrase decrypts an encrypted privateKey; it is a credential
      // companion to it, read live by the SFTP adapter (ssh2 `passphrase`).
      resolved.server.privateKeyPassphrase = resolveOptionalAtSignRef(
        resolved.server.privateKeyPassphrase,
      );
      // The fingerprint is non-secret but supports @-file for operators who
      // manage it alongside other server config in a read-only secrets mount.
      // Only the LOAD resolver handles it: nothing sets the fingerprint via a
      // CLI flag or connection URL, so resolveConnectionCredentials (the save/
      // flag resolver) correctly omits it -- dead code there would never run. A
      // single fingerprint or a list; each entry is resolved independently.
      resolved.server.hostKeyFingerprint = resolveHostKeyFingerprintRefs(
        resolved.server.hostKeyFingerprint,
      );
      resolveHttpAuthAtSignRefs(resolved.server.provision?.auth);
      resolveHttpAuthAtSignRefs(resolved.proxy?.auth);
      resolveProviderOptionsAtSignRefs(resolved);
      break;
    case "webrtc":
      // A WebRTC server has no password/privateKey -- only the provisioning
      // endpoints' HTTP auth, the TURN credentials, and providerOptions.
      resolveHttpAuthAtSignRefs(resolved.server.provision?.auth);
      resolveHttpAuthAtSignRefs(resolved.iceProvision?.auth);
      if (resolved.turn !== undefined)
        for (const turn of resolved.turn)
          turn.credential = resolveAtSignRef(turn.credential);
      resolveProviderOptionsAtSignRefs(resolved);
      break;
    case "filedrop":
      // A filedrop connection has no credential or opaque-options fields.
      break;
  }
  return resolved;
}

function resolveOptionalAtSignRef(
  value: string | undefined,
): string | undefined {
  return value === undefined ? value : resolveAtSignRef(value);
}

/**
 * Resolve `@path` references in a host-key fingerprint field -- a single
 * fingerprint or a non-empty list of them -- resolving each entry independently
 * and preserving the single-vs-list shape. `undefined` passes through unchanged.
 */
function resolveHostKeyFingerprintRefs(
  value: string | string[] | undefined,
): string | string[] | undefined {
  if (value === undefined) return value;
  if (Array.isArray(value)) return value.map(resolveHostKeyFingerprintRef);
  return resolveHostKeyFingerprintRef(value);
}

/**
 * Resolve one host-key fingerprint entry. A literal value passes through
 * unvalidated (the caller owns its format check: the config schema at parse, or
 * the flag parser's flag-named rejection); an @-file one is read and
 * re-validated against {@link HOST_KEY_FINGERPRINT_REGEX}, because the literal
 * `@path` could not match the SHA256: format so no earlier check saw the real
 * value. A malformed or missing secrets file fails here as a clear
 * {@link UsageError} (exit 64) naming the reference rather than later as a
 * confusing host-key "mismatch" at connect time. Shared by the config-load
 * resolver above and the `--server-host-key-fingerprint` flag parser
 * (`hostKeyFingerprintFlag` in optionDefinitions.ts), so the @-file read and
 * re-validation live once.
 */
export function resolveHostKeyFingerprintRef(ref: string): string {
  if (!ref.startsWith("@")) return ref;
  const resolved = resolveAtSignRef(ref);
  if (!HOST_KEY_FINGERPRINT_REGEX.test(resolved))
    throw new UsageError(
      `the @-file reference ${ref} resolved to a value that is not a valid ` +
        `OpenSSH SHA256 host-key fingerprint (SHA256:<43 standard base64 chars>)`,
    );
  return resolved;
}

/** Resolve the two `@`-eligible fields of an HTTP-auth block in place. */
function resolveHttpAuthAtSignRefs(auth: HttpAuth | undefined): void {
  if (auth === undefined) return;
  auth.bearer = resolveOptionalAtSignRef(auth.bearer);
  auth.password = resolveOptionalAtSignRef(auth.password);
}

/**
 * Resolve `@path` refs inside the opaque `providerOptions` map in place. Its
 * values are passed verbatim to the transport library and the docs mark the whole
 * map `@`-file capable, so every contained string is `@`-eligible -- the one
 * place the recursive walk is still correct.
 */
function resolveProviderOptionsAtSignRefs(connection: {
  providerOptions?: Record<string, unknown>;
}): void {
  if (connection.providerOptions !== undefined)
    connection.providerOptions = resolveAtSignRefs(
      connection.providerOptions,
    ) as Record<string, unknown>;
}

/**
 * The values a connection's `@path` credential references resolve to, read
 * ahead of the connection they are applied to (see
 * {@link readConnectionCredentials}). A field is present exactly when the
 * connection read from had one, so applying the record never invents a
 * credential the connection did not set.
 */
export interface ResolvedConnectionCredentials {
  /** The resolved SFTP `server.password`. */
  password?: string;
  /** The resolved SFTP `server.privateKey`. */
  privateKey?: string;
  /** The resolved SFTP `server.privateKeyPassphrase`. */
  privateKeyPassphrase?: string;
}

/**
 * Read the `@path` credential references on a connection without applying them,
 * so every local-file refusal is decided at this call: a missing, unreadable, or
 * empty referenced file is a {@link UsageError} (exit 64) raised here rather
 * than wherever the resolved connection is built.
 *
 * The read is split from the application for a caller whose connection is
 * mutated in between -- `zero-setup`, where `establishHostKeyTrust` pins a
 * first-use host key onto the connection and the clone handed to the exchange
 * must carry that pin while the original keeps its `@path` for persistence.
 * Reading first is what keeps a run refused over its own credential file from
 * reaching the host-key probe's transport; cloning after the pin is what carries
 * the pin into the live connect. A caller with nothing in between uses
 * {@link resolveConnectionCredentials}, which is the two composed.
 *
 * A non-SFTP connection carries no such credential and yields an empty record.
 */
export function readConnectionCredentials(
  connection: ConnectionConfig,
): ResolvedConnectionCredentials {
  if (connection.channel !== "sftp") return {};
  const { server } = connection;
  const credentials: ResolvedConnectionCredentials = {};
  if (server.password !== undefined)
    credentials.password = resolveAtSignRef(server.password);
  if (server.privateKey !== undefined)
    credentials.privateKey = resolveAtSignRef(server.privateKey);
  if (server.privateKeyPassphrase !== undefined)
    credentials.privateKeyPassphrase = resolveAtSignRef(
      server.privateKeyPassphrase,
    );
  return credentials;
}

/**
 * The value read for a credential field the connection sets. Its absence means
 * the record came from a different connection than the one being applied to, a
 * pairing no call site makes; failing loudly here beats connecting with the
 * literal `@path` string as the credential.
 */
function readValueFor(value: string | undefined, field: string): string {
  if (value === undefined)
    throw new Error(
      `internal error: the connection credential ${field} was applied ` +
        `without having been read`,
    );
  return value;
}

/**
 * Return a clone of `connection` carrying the credential values
 * {@link readConnectionCredentials} read from it. The input is NOT mutated, so
 * the caller connects with the clone while persisting the original -- whose
 * `@path` is still in place -- keeping the secret out of `psilink.yaml`. The
 * preserved `@path` is re-resolved (by {@link resolveExchangeSpecRefs}) at the
 * next exchange's config load.
 *
 * Pass the connection as it stands at the moment of the live connect: the clone
 * is taken here, so anything written onto the connection since the read -- a
 * first-use host-key pin above all -- reaches the exchange.
 *
 * A non-SFTP connection is returned as-is rather than cloned, which a caller
 * that then applies its own overrides to the result relies on.
 */
export function applyConnectionCredentials(
  connection: ConnectionConfig,
  credentials: ResolvedConnectionCredentials,
): ConnectionConfig {
  if (connection.channel !== "sftp") return connection;
  const resolved = structuredClone(connection);
  const { server } = resolved;
  if (server.password !== undefined)
    server.password = readValueFor(credentials.password, "password");
  if (server.privateKey !== undefined)
    server.privateKey = readValueFor(credentials.privateKey, "private key");
  if (server.privateKeyPassphrase !== undefined)
    server.privateKeyPassphrase = readValueFor(
      credentials.privateKeyPassphrase,
      "private key passphrase",
    );
  return resolved;
}

/**
 * Resolve `@path` credential references on a connection for live use, returning
 * a clone with the SFTP `server.password` / `server.privateKey` /
 * `server.privateKeyPassphrase` fields read from their referenced files. The
 * read and the clone in one step, for a caller that connects with the result
 * straight away; a caller that must settle the local-file refusals earlier than
 * it can build the clone uses {@link readConnectionCredentials} and
 * {@link applyConnectionCredentials} instead.
 *
 * Only those three fields are resolved: they are the sole credentials a CLI flag
 * (`--server-password` / `--server-private-key` /
 * `--server-private-key-passphrase`) or a connection URL can set on the
 * persistence paths (`--save`, `invite`/`accept`). The passphrase is a companion
 * to `privateKey` (an encrypted key needs it to decrypt) and follows the same
 * @-file-in / @-path-at-rest handling as the key itself. Other `@`-eligible
 * fields (HTTP `bearer`, `turn.credential`, `providerOptions`, ...) are reachable
 * only from a hand-authored config, which {@link resolveExchangeSpecRefs}
 * resolves at load; a future credential flag that persists must be added here.
 * Non-SFTP channels carry no such credential and pass through unchanged.
 */
export function resolveConnectionCredentials(
  connection: ConnectionConfig,
): ConnectionConfig {
  return applyConnectionCredentials(
    connection,
    readConnectionCredentials(connection),
  );
}
