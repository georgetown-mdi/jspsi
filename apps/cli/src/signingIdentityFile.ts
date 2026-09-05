import fs from "node:fs";

import {
  parseCertificate,
  parseSigningIdentity,
  recordedVersionMatches,
  serializeSigningIdentity,
  SIGNING_IDENTITY_VERSION,
  UsageError,
} from "@psilink/core";
import type { SigningCertificate, SigningIdentity } from "@psilink/core";

import { warnIfFileOverPermissive, writeFileOwnerOnly } from "./fileUtils";
import { parseSensitiveJson } from "./sensitiveFile";

// File custody for the long-lived signing identity (private key + self-signed
// certificate), kept separate from the rotating key file (`.psilink.key`):
// the shared secret rotates every exchange; the signing key must stay stable
// so a partner's pinned fingerprint keeps matching.
//
// The path is always the operator's (`signing.identity_file` /
// `--identity-file`); this module resolves no location of its own. Why:
// docs/notes/signing-identity-custody.md, "What a chosen location costs" and
// "The posture".

// The identity file read both loaders share, parsed only as far as JSON. A read
// failure holds only a path and errno (no file content), safe to show. The
// JSON parse can echo a span of the source, and this file holds the P-256
// private key, so it routes through parseSensitiveJson, which reports path-only
// (see sensitiveFile.ts). The wrapper distinguishes an absent file from one
// whose JSON is `null`.
function readIdentityDocument(
  identityPath: string,
): { document: unknown } | undefined {
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
  // Warned about on the read rather than on a successful parse: a file whose
  // JSON or version a loader goes on to reject was still read off disk, and it
  // holds the private key whether or not this process could make sense of it.
  warnIfFileOverPermissive(identityPath, "signing private key");
  return {
    document: parseSensitiveJson(source, `signing identity at ${identityPath}`),
  };
}

function malformedIdentity(identityPath: string, err: unknown): UsageError {
  // A schema or signing error names paths and types, never the key value, so it
  // is kept.
  return new UsageError(
    `signing identity at ${identityPath} is malformed or unsupported: ` +
      (err instanceof Error ? err.message : String(err)),
  );
}

/**
 * Load and validate the signing identity at `identityPath`. Resolves
 * `undefined` if the file does not exist (so a caller can lazily create it).
 * Rejects with a {@link UsageError} on a malformed, unreadable, or inconsistent
 * file -- the same exit-64 classification a malformed key file gets. Warns
 * (advisory) if the file is readable by other users. Validation reaches
 * `crypto.subtle`, so the load is asynchronous; the file read itself is not.
 *
 * For a caller that will SIGN with the identity. One that only needs to know
 * whose certificate the file holds takes {@link loadSigningCertificate}, which
 * never imports the private key.
 */
export async function loadSigningIdentity(
  identityPath: string,
): Promise<SigningIdentity | undefined> {
  const read = readIdentityDocument(identityPath);
  if (read === undefined) return undefined;
  let identity: SigningIdentity;
  try {
    identity = await parseSigningIdentity(read.document);
  } catch (err: unknown) {
    throw malformedIdentity(identityPath, err);
  }
  return identity;
}

/**
 * Load the CERTIFICATE half of the signing identity at `identityPath`: the
 * file's format version and its certificate (key encoding and self-signature)
 * are checked, the private key stored beside it is neither imported nor
 * compared against the certificate. The whole document is read and parsed
 * either way, so this is a narrower USE of the file, not a narrower read of it.
 * Resolves `undefined` if the file does not exist; rejects and warns on the
 * same terms as {@link loadSigningIdentity}, the permission warning included --
 * the file holds the private key whichever half was taken from it.
 *
 * For a caller that only needs to know WHOSE certificate the file holds -- a
 * fingerprint to compare, an identity to name -- rather than to sign with it.
 * A caller that will sign takes {@link loadSigningIdentity}, whose consistency
 * check is what refuses a private key that no longer matches its certificate.
 */
export async function loadSigningCertificate(
  identityPath: string,
): Promise<SigningCertificate | undefined> {
  const read = readIdentityDocument(identityPath);
  if (read === undefined) return undefined;
  // The certificate holds its own version literal, but the document around it
  // does not have to be an identity file at all; checking it keeps an
  // unrecognized identity format from being mined for a certificate here while
  // loadSigningIdentity refuses it.
  if (!recordedVersionMatches(read.document, SIGNING_IDENTITY_VERSION))
    throw malformedIdentity(
      identityPath,
      new Error(
        `expected version ${SIGNING_IDENTITY_VERSION}; this is not a signing ` +
          "identity file of a recognized format",
      ),
    );
  let certificate: SigningCertificate;
  try {
    certificate = await parseCertificate(
      (read.document as Record<string, unknown>)["certificate"],
    );
  } catch (err: unknown) {
    throw malformedIdentity(identityPath, err);
  }
  return certificate;
}

/**
 * Write `identity` to `identityPath` owner-read-only, via the shared atomic
 * owner-only write path (`0600` on Unix, a restricted ACL on Windows). Creates
 * parent directories as needed. Pass `exclusive` when first creating the
 * identity so a concurrent creator cannot silently overwrite it (a regenerate
 * overwrites by design and omits it).
 */
export function saveSigningIdentity(
  identityPath: string,
  identity: SigningIdentity,
  options: { exclusive?: boolean } = {},
): void {
  writeFileOwnerOnly(identityPath, serializeSigningIdentity(identity), options);
}
