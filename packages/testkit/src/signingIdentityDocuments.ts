// The signing-identity documents a CERTIFICATE-ONLY load is held to, each with
// the party name that load must report for it.
//
// Two implementations answer one question -- whose certificate is in this file?
// The CLI's `loadSigningCertificate` (apps/cli/src/signingIdentityFile.ts) is
// the one the run itself reads through, and the console's `readBoundIdentity`
// (apps/web/src/jobs/signingIdentity.ts) is the one that tells an operator, at
// the control, whether the run would refuse the identity they are about to sign
// with. A name the console reports that the run then refuses is the failure this
// set exists to catch, so both apps' unit projects drive these documents: the
// CLI leg is apps/cli/test/unit/boundIdentityParity.test.ts and the console leg
// is apps/web/test/unit/jobs/boundIdentityParity.test.ts.
//
// The set lives here rather than in either test tree because both apps need it
// and neither may import the other, and rather than behind
// `@psilink/core/testing` because everything there is built into `dist/testing.*`
// and published with `@psilink/core` (docs/TESTING.md, Shared test material):
// these documents are malformed and tampered identity files around a generated
// private key, which is not material to ship to a consumer of the library. It
// holds the documents and the expected answer only; each leg writes the file and
// drives its own loader.
//
// The two loaders differ in how they report "no name": the CLI rejects with a
// UsageError where the console resolves undefined. That difference is not the
// parity -- {@link boundIdentityOf} folds a refusal into "no name" so the legs
// compare the one thing they must agree on, and each app's own suite pins the
// exit shape it owes its own callers.

import {
  SIGNING_IDENTITY_VERSION,
  generateSigningIdentity,
  serializeSigningIdentity,
} from "@psilink/core";

/** One document, keyed so a case added here fails both legs to compile. */
export type CertificateOnlyLoadCaseId =
  | "wellFormed"
  | "privateKeyNotAKey"
  | "absent"
  | "notJson"
  | "unrecognizedVersion"
  | "certificateMissing"
  | "certificateTampered";

/** What one document holds, and the name a certificate-only load owes it. */
export interface CertificateOnlyLoadCase {
  /** The file's content, or null to leave no file at the path. */
  readonly document: string | null;
  /** The party name the load reports, or null where it reports none. */
  readonly bound: string | null;
  /** Why this document answers that, in one line. */
  readonly because: string;
}

/** The party name every document below that names one is bound to. */
export const CERTIFICATE_ONLY_LOAD_IDENTITY = "Agency A, County Registrar";

/**
 * The name a certificate-only load reports for a document, with a refusal read
 * as no name: the question the console asks of the identity file, put to either
 * app's loader by its own leg.
 */
export async function boundIdentityOf(
  load: () => Promise<string | undefined>,
): Promise<string | undefined> {
  try {
    return await load();
  } catch {
    return undefined;
  }
}

/**
 * The documents, built around a freshly generated identity so each leg drives
 * real certificates rather than stand-ins. Asynchronous because generating and
 * self-signing one reaches `crypto.subtle`.
 */
export async function certificateOnlyLoadCases(): Promise<
  Record<CertificateOnlyLoadCaseId, CertificateOnlyLoadCase>
> {
  const identity = await generateSigningIdentity(
    CERTIFICATE_ONLY_LOAD_IDENTITY,
  );
  return {
    wellFormed: {
      document: serializeSigningIdentity(identity),
      bound: CERTIFICATE_ONLY_LOAD_IDENTITY,
      because: "the document is an identity file of the recognized format",
    },
    privateKeyNotAKey: {
      document: JSON.stringify({ ...identity, privateKey: "not a key at all" }),
      bound: CERTIFICATE_ONLY_LOAD_IDENTITY,
      because:
        "a certificate-only load neither imports the private key beside the " +
        "certificate nor checks it against one",
    },
    absent: {
      document: null,
      bound: null,
      because: "there is no file to read a name from",
    },
    notJson: {
      document: "LEAKME1234 not json",
      bound: null,
      because: "the file does not parse",
    },
    unrecognizedVersion: {
      document: JSON.stringify({
        ...identity,
        version: `${SIGNING_IDENTITY_VERSION}-unrecognized`,
      }),
      bound: null,
      because:
        "a document of an unrecognized format is not mined for a certificate",
    },
    certificateMissing: {
      document: JSON.stringify({
        version: SIGNING_IDENTITY_VERSION,
        privateKey: identity.privateKey,
      }),
      bound: null,
      because: "there is no certificate to take a name from",
    },
    certificateTampered: {
      document: JSON.stringify({
        ...identity,
        certificate: { ...identity.certificate, identity: "Someone Else" },
      }),
      bound: null,
      because:
        "the certificate's self-signature no longer ties that name to the key",
    },
  };
}
