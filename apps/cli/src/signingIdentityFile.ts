import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parseSigningIdentity,
  serializeSigningIdentity,
  UsageError,
} from "@psilink/core";
import type { SigningIdentity } from "@psilink/core";

import { warnIfFileOverPermissive, writeFileOwnerOnly } from "./fileUtils";

// File custody for the long-lived signing identity (private key + self-signed
// certificate). Kept in its OWN file, separate from the rotating key file
// (`.psilink.key`): the shared secret rotates every exchange, whereas the signing
// key must be stable for its whole life so a fingerprint a partner pinned once
// keeps matching. The identity is reused across exchanges AND across partners,
// so it defaults to a per-user location rather than the per-directory default
// the key file and config use; an exchange in any working directory loads the
// same identity, and a partner's pin stays valid everywhere. The path is
// overridable (config `signing.identity_file` or `--identity-file`).

/** Directory holding the per-user signing identity by default. */
export const DEFAULT_SIGNING_IDENTITY_DIR = path.join(os.homedir(), ".psilink");

/**
 * Default path for this party's signing identity file. Per-user (under the home
 * directory), not per-working-directory, because one signing identity is reused
 * across every exchange and partner; see the module note.
 */
export function defaultSigningIdentityPath(): string {
  return path.join(DEFAULT_SIGNING_IDENTITY_DIR, "signing-identity.json");
}

/**
 * Load and validate the signing identity at `identityPath`. Returns `undefined`
 * if the file does not exist (so a caller can lazily create it). Throws a
 * {@link UsageError} on a malformed, unreadable, or inconsistent file -- the
 * same exit-64 classification a malformed key file gets. Warns (advisory)
 * if the file is readable by other users.
 */
export function loadSigningIdentity(
  identityPath: string,
): SigningIdentity | undefined {
  // Read and parse in two steps. A filesystem read failure carries only a path
  // and errno (no file content), safe to surface. A JSON parse failure can echo
  // a snippet of the source, and this file holds the Ed25519 private key, so it
  // reports the path only (fail closed) -- suppressing the parser's message
  // entirely rather than relying on how much of the source it includes.
  // parseSigningIdentity's schema error names paths and types, never the key
  // value, so it is kept. (Mirrors the config readers; see loadConfig in
  // commands/exchange.ts.)
  let source: string;
  try {
    source = fs.readFileSync(identityPath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new UsageError(
      `signing identity at ${identityPath} could not be read: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new UsageError(
      `signing identity at ${identityPath} could not be parsed as JSON`,
    );
  }
  let identity: SigningIdentity;
  try {
    identity = parseSigningIdentity(raw);
  } catch (err: unknown) {
    throw new UsageError(
      `signing identity at ${identityPath} is malformed or unsupported: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  warnIfFileOverPermissive(identityPath, "signing private key");
  return identity;
}

/**
 * Write `identity` to `identityPath` owner-read-only, via the shared atomic
 * owner-only write path (`0600` on Unix, a restricted ACL on Windows). Creates
 * parent directories as needed. Pass `exclusive` when first creating the
 * identity so a concurrent creator cannot silently overwrite it (a regenerate
 * deliberately overwrites and omits it).
 */
export function saveSigningIdentity(
  identityPath: string,
  identity: SigningIdentity,
  options: { exclusive?: boolean } = {},
): void {
  writeFileOwnerOnly(identityPath, serializeSigningIdentity(identity), options);
}
