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
  // already accepted the non-empty @path string (resolution now runs after
  // parse, so e.g. turn.credential's min(1) has validated the literal "@path",
  // not the file contents) and surface only later as an opaque network-layer
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
 * Use this only where every contained string is genuinely `@`-eligible: a
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
 * `retentionDisposition`, ...) is carried through unread rather than exfiltrating
 * a local file into the self-attested exchange record. A local-path field such as
 * `signing.identityFile` is likewise left alone: its consumer opens that path, so
 * resolving it to the file's contents would corrupt it. This replaces a former
 * blanket recursion over the whole config that contradicted the documented
 * exemption.
 *
 * A missing or unreadable referenced file is a {@link UsageError} (exit 64); the
 * caller runs this outside the schema-parse try/catch so the error propagates
 * naming the reference rather than being re-wrapped as an invalid-spec error. The
 * input is not mutated.
 */
export function resolveExchangeSpecRefs(spec: ExchangeSpec): ExchangeSpec {
  return { ...spec, connection: resolveConnectionAtSignRefs(spec.connection) };
}

/** Resolve `@path` refs in the supported fields of one parsed connection. */
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
      // flag resolver) correctly omits it -- dead code there would never run.
      {
        const fpRef = resolved.server.hostKeyFingerprint;
        resolved.server.hostKeyFingerprint = resolveOptionalAtSignRef(fpRef);
        // A literal fingerprint was format-validated at parse; an @-file one was
        // not (the @path could not match the SHA256: format, so the schema
        // skipped it). Re-validate the resolved value so a malformed secrets
        // file fails here as a clear UsageError (exit 64) naming the reference,
        // rather than later as a confusing host-key "mismatch" at connect time.
        const fp = resolved.server.hostKeyFingerprint;
        if (
          fpRef?.startsWith("@") &&
          fp !== undefined &&
          !HOST_KEY_FINGERPRINT_REGEX.test(fp)
        )
          throw new UsageError(
            `the @-file reference ${fpRef} resolved to a value that is not a ` +
              `valid OpenSSH SHA256 host-key fingerprint ` +
              `(SHA256:<43 standard base64 chars>)`,
          );
      }
      resolveHttpAuthAtSignRefs(resolved.server.provision?.auth);
      resolveHttpAuthAtSignRefs(resolved.proxy?.auth);
      resolveProviderOptionsAtSignRefs(resolved);
      break;
    case "webrtc":
      // A WebRTC server carries no password/privateKey -- only the provisioning
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

/** Resolve an optional `@path` field; `undefined` passes through unchanged. */
function resolveOptionalAtSignRef(
  value: string | undefined,
): string | undefined {
  return value === undefined ? value : resolveAtSignRef(value);
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
 * Resolve `@path` credential references on a connection for live use, returning
 * a clone with the SFTP `server.password` / `server.privateKey` fields read from
 * their referenced files. The input is NOT mutated, so a caller can connect with
 * the resolved clone while persisting the original -- whose `@path` is still in
 * place -- keeping the secret out of `psilink.yaml`. The preserved `@path` is
 * re-resolved (by {@link resolveExchangeSpecRefs}) at the next exchange's config
 * load.
 *
 * Only those two fields are resolved: they are the sole credential a CLI flag
 * (`--server-password` / `--server-private-key`) or a connection URL can set on
 * the persistence paths (`--save`, `invite`/`accept`). Other `@`-eligible fields
 * (HTTP `bearer`, `turn.credential`, `providerOptions`, ...) are reachable only
 * from a hand-authored config, which {@link resolveExchangeSpecRefs} resolves at
 * load; a future credential flag that persists must be added here. Non-SFTP
 * channels carry no such credential and pass through unchanged.
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
