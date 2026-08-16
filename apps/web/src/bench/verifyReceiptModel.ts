import {
  EXCHANGE_KEYS_VERSION,
  EXCHANGE_RECORD_VERSION,
  FINGERPRINT_REGEX,
  SIGNED_RECEIPT_VERSION,
  SIGNING_CERTIFICATE_VERSION,
  SIGNING_IDENTITY_VERSION,
  computeCertificateFingerprint,
  computeTermsHash,
  parseCertificate,
  parseDualSignedRecord,
  parseExchangeRecord,
  parseSensitiveJson,
  parseVerificationKeys,
  recordedVersionMatches,
  sanitizeErrorForDisplay,
  sanitizeForDisplay,
  verifyDualSignedRecord,
} from "@psilink/core";

import type {
  AssertedIdentityStatus,
  CertificateAnchorStatus,
  CertificateBindingStatus,
  CommitmentName,
  CommitmentStatus,
  DualSignedRecord,
  DualSignedRecordVerificationInputs,
  DualSignedRecordVerificationReport,
  ExchangeRecord,
  LinkageTerms,
  ReceiptSignatureStatus,
  RecordVerificationReport,
  SignedReceiptPartyReport,
  SigningCertificate,
  TermsHashStatus,
  VerificationKeys,
} from "@psilink/core";

/**
 * The pure model behind the "Verify a receipt" bench: it turns each supplied JSON
 * document into either a named parse failure or a parsed artifact, and each of
 * core's two verification reports -- the unsigned {@link RecordVerificationReport}
 * and the {@link DualSignedRecordVerificationReport} -- into a plain-language
 * verdict view-model. It is React-free and free of any I/O, so the copy discipline
 * the bench requires -- the honest ambiguity of a failed verdict, the "supply your
 * files" framing of an unopened commitment, the wrong-keys signal distinct from
 * tamper, and the anchoring sentences an unanchored certificate does and does not
 * support -- is tested here directly rather than through the DOM.
 *
 * Both verdicts come from `@psilink/core` as-is. In particular the assignment of
 * anchoring values over the dual-signed record's two certificate slots is not
 * re-derived here: this model supplies what the verifier holds and renders the
 * report core returns.
 *
 * No private signing key is accepted, required, imported, or used on any path
 * here. The verifier's own slot is anchored by the fingerprint of a dropped
 * EXPORTED certificate (the public half), and the signing identity file that
 * holds the private key is refused by {@link parseCertificateDocument} on its
 * version alone. A dropped document is read and parsed whichever it turns out to
 * be, so this is a narrower USE of the identity file, not a narrower read of it.
 *
 * Every embedded error string is routed through core's display-boundary
 * sanitizers before it reaches this model's output: a malformed document's parse
 * error through {@link sanitizeErrorForDisplay}, a reconstruction warning (which
 * interpolates a supplied column name) and a certificate identity (free text its
 * holder chose) through {@link sanitizeForDisplay}. Nothing here echoes an
 * unsanitized byte of a supplied file.
 */

// --- Input parse -------------------------------------------------------------

/** A parsed JSON document that is either the recognized artifact or a named
 * reason it is not. `kind: "ok"` carries the parsed value; every other kind is a
 * pre-verification outcome the page renders as a designed alert state. */
export type RecordParseResult =
  | { kind: "ok"; record: ExchangeRecord }
  | { kind: "malformed"; message: string }
  | { kind: "unrecognized-version"; message: string };

export type KeysParseResult =
  | { kind: "ok"; keys: VerificationKeys }
  | { kind: "malformed"; message: string }
  | { kind: "unrecognized-version"; message: string };

/** A parsed dual-signed record: the signed evidence bundle both parties hold,
 * separate from the unsigned record above. */
export type SignedRecordParseResult =
  | { kind: "ok"; record: DualSignedRecord }
  | { kind: "malformed"; message: string }
  | { kind: "unrecognized-version"; message: string };

/**
 * A parsed exported certificate, with the fingerprint recomputed from it -- the
 * anchor for the slot holding the verifier's own certificate. `signing-identity`
 * is the private-key-bearing identity file, refused as its own outcome rather
 * than mined for the certificate inside it.
 */
export type CertificateParseResult =
  | { kind: "ok"; certificate: SigningCertificate; fingerprint: string }
  | { kind: "malformed"; message: string }
  | { kind: "unrecognized-version"; message: string }
  | { kind: "signing-identity"; message: string };

// The parse label handed to parseSensitiveJson: it reports path-only, so this
// fixed string is all that ever reaches an error message -- never the file's
// bytes. The web app's JSON is non-secret here (a receipt carries no values), but
// the chokepoint is used regardless so a syntax error cannot echo source.
const RECORD_LABEL = "the record file";
const KEYS_LABEL = "the verification-keys file";
const SIGNED_RECORD_LABEL = "the dual-signed record file";
const CERTIFICATE_LABEL = "the certificate file";

const MALFORMED_RECORD_MESSAGE =
  "This is not a valid exchange record. Check that you loaded the " +
  "psilink-record-<stamp>.json file (the shareable record), not the keys file " +
  "or another document.";

const MALFORMED_KEYS_MESSAGE =
  "This is not a valid verification-keys file. Check that you loaded the " +
  "psilink-record-<stamp>.keys.json file (the private keys), not the record " +
  "file or another document.";

const MALFORMED_SIGNED_RECORD_MESSAGE =
  "This is not a valid dual-signed record. Check that you loaded the " +
  "psilink-receipt-<stamp>.json file (the record both parties signed), not the " +
  "exchange record or another document.";

const MALFORMED_CERTIFICATE_MESSAGE =
  "This is not a usable signing certificate. Check that you loaded the " +
  "certificate you exported with 'psilink fingerprint --export-certificate', " +
  "and that it has not been edited since -- its own self-signature must verify.";

// The identity file is refused rather than mined for the certificate beside the
// key: the key is what makes the file worth protecting, and nothing this page
// does needs it. The message names the export that replaces it, so the refusal
// leaves the operator somewhere to go.
const SIGNING_IDENTITY_MESSAGE =
  "This is a signing identity file, which holds your private signing key. " +
  "Nothing here needs it and this page never uses one: export your public " +
  "certificate with 'psilink fingerprint --export-certificate <path>' and load " +
  "that instead.";

const RECOGNIZED_VERSIONS = {
  record: { what: "record", version: EXCHANGE_RECORD_VERSION },
  keys: { what: "verification-keys", version: EXCHANGE_KEYS_VERSION },
  "signed-record": {
    what: "dual-signed record",
    version: SIGNED_RECEIPT_VERSION,
  },
  certificate: { what: "certificate", version: SIGNING_CERTIFICATE_VERSION },
} as const;

function unrecognizedVersionMessage(
  kind: keyof typeof RECOGNIZED_VERSIONS,
): string {
  const { what, version } = RECOGNIZED_VERSIONS[kind];
  return (
    `This ${what} file is a version this build does not recognize. It may come ` +
    `from a newer or older psilink, or have been edited. This build recognizes ` +
    `${version}.`
  );
}

/**
 * Parse the record document: through the bounded sensitive-JSON chokepoint (an
 * oversized or syntactically broken file is a `malformed` outcome, its error
 * sanitized), then a version pre-check (an unrecognized version is its own named
 * outcome, not a generic shape error), then the record schema (a wrong-shape file
 * is `malformed`). Mirrors the CLI's read-record semantics.
 */
export function parseRecordDocument(text: string): RecordParseResult {
  let raw: unknown;
  try {
    raw = parseSensitiveJson(text, RECORD_LABEL);
  } catch (error) {
    return {
      kind: "malformed",
      message: `${MALFORMED_RECORD_MESSAGE} ${sanitizeErrorForDisplay(error)}`,
    };
  }
  if (!recordedVersionMatches(raw, EXCHANGE_RECORD_VERSION))
    return {
      kind: "unrecognized-version",
      message: unrecognizedVersionMessage("record"),
    };
  try {
    return { kind: "ok", record: parseExchangeRecord(raw) };
  } catch {
    // The Zod error can quote a parsed value; do not forward it. The static
    // message locates the fault (wrong file / edited record) without an echo.
    return { kind: "malformed", message: MALFORMED_RECORD_MESSAGE };
  }
}

/** Parse the verification-keys document, with the same phased outcomes as
 * {@link parseRecordDocument}. */
export function parseKeysDocument(text: string): KeysParseResult {
  let raw: unknown;
  try {
    raw = parseSensitiveJson(text, KEYS_LABEL);
  } catch (error) {
    return {
      kind: "malformed",
      message: `${MALFORMED_KEYS_MESSAGE} ${sanitizeErrorForDisplay(error)}`,
    };
  }
  if (!recordedVersionMatches(raw, EXCHANGE_KEYS_VERSION))
    return {
      kind: "unrecognized-version",
      message: unrecognizedVersionMessage("keys"),
    };
  try {
    return { kind: "ok", keys: parseVerificationKeys(raw) };
  } catch {
    return { kind: "malformed", message: MALFORMED_KEYS_MESSAGE };
  }
}

/** Parse the dual-signed record document, with the same phased outcomes as
 * {@link parseRecordDocument}. Shape only: every signature, certificate, and
 * anchoring check belongs to core's verification, which
 * {@link verifySignedRecord} runs on the parsed record. */
export function parseSignedRecordDocument(
  text: string,
): SignedRecordParseResult {
  let raw: unknown;
  try {
    raw = parseSensitiveJson(text, SIGNED_RECORD_LABEL);
  } catch (error) {
    return {
      kind: "malformed",
      message: `${MALFORMED_SIGNED_RECORD_MESSAGE} ${sanitizeErrorForDisplay(error)}`,
    };
  }
  if (!recordedVersionMatches(raw, SIGNED_RECEIPT_VERSION))
    return {
      kind: "unrecognized-version",
      message: unrecognizedVersionMessage("signed-record"),
    };
  try {
    return { kind: "ok", record: parseDualSignedRecord(raw) };
  } catch {
    return { kind: "malformed", message: MALFORMED_SIGNED_RECORD_MESSAGE };
  }
}

/**
 * Parse the verifier's own EXPORTED certificate -- the public half -- and
 * recompute its fingerprint, which is what anchors the slot holding it. The
 * private-key-bearing signing identity file is refused on its version alone: the
 * document is read and parsed to reach that version, but no key material is
 * imported, compared, or used on this path, and a document of any other version
 * is refused as well rather than searched for a certificate to use.
 *
 * The returned certificate is core's parsed shape, whose schema keeps only the
 * public coordinates: private key material in a supplied document does not
 * survive the parse into this model's output.
 */
export async function parseCertificateDocument(
  text: string,
): Promise<CertificateParseResult> {
  let raw: unknown;
  try {
    raw = parseSensitiveJson(text, CERTIFICATE_LABEL);
  } catch (error) {
    return {
      kind: "malformed",
      message: `${MALFORMED_CERTIFICATE_MESSAGE} ${sanitizeErrorForDisplay(error)}`,
    };
  }
  if (recordedVersionMatches(raw, SIGNING_IDENTITY_VERSION))
    return { kind: "signing-identity", message: SIGNING_IDENTITY_MESSAGE };
  if (!recordedVersionMatches(raw, SIGNING_CERTIFICATE_VERSION))
    return {
      kind: "unrecognized-version",
      message: unrecognizedVersionMessage("certificate"),
    };
  try {
    // parseCertificate self-verifies (key encoding and self-signature), so a
    // certificate that reaches the fingerprint below is internally consistent;
    // what it is NOT is trusted, which is the anchoring's job.
    const certificate = await parseCertificate(raw);
    return {
      kind: "ok",
      certificate,
      fingerprint: await computeCertificateFingerprint(certificate),
    };
  } catch {
    return { kind: "malformed", message: MALFORMED_CERTIFICATE_MESSAGE };
  }
}

const MALFORMED_PIN_MESSAGE =
  "That is not a certificate fingerprint: it is an unpadded base64url SHA-256 " +
  "digest, 43 characters. Your partner reads theirs from 'psilink fingerprint' " +
  "and gives it to you over a channel you already trust.";

/**
 * Why a typed partner fingerprint cannot be used, or `undefined` when it is a
 * fingerprint (or is empty, which is simply not supplied). A malformed pin is
 * reported here rather than passed to the verification, where it would be
 * indistinguishable from a partner certificate that does not match.
 */
export function pinnedFingerprintProblem(value: string): string | undefined {
  const pin = value.trim();
  if (pin.length === 0) return undefined;
  if (!FINGERPRINT_REGEX.test(pin)) return MALFORMED_PIN_MESSAGE;
  return undefined;
}

// --- Verdict view-model ------------------------------------------------------

/** The visual tone of a verdict or a per-check row; maps to an alert color and
 * icon in the view. */
export type VerdictTone = "verified" | "failed" | "incomplete";

/** The headline for each overall outcome, honest about the ambiguity of a
 * mismatch (a failed verdict never asserts tamper alone) and never reporting a
 * not-checked artifact as verified. */
export interface VerdictHeadline {
  tone: VerdictTone;
  title: string;
  detail: string;
}

/** One plain-language row: a commitment or the terms hash, with a status label
 * and the tone that colors it. `explanation` carries the "supply your files"
 * framing for a not-opened commitment. */
export interface VerdictRow {
  label: string;
  status: string;
  tone: VerdictTone;
  explanation?: string;
}

/** The full verdict view-model the page renders. */
export interface VerdictViewModel {
  headline: VerdictHeadline;
  commitments: Array<VerdictRow>;
  termsHash: VerdictRow;
  /** Reconstruction caveats, each already sanitized for display. */
  warnings: Array<string>;
  /** The standing caveat: the unsigned-record path does not check partner
   * receipt signatures. Fixed copy, mirrored from the CLI. */
  signatureNote: string;
}

// The verbatim headline copy per outcome. The failed headline states the honest
// ambiguity core's own type docs require (recordVerification.ts): a mismatch means
// the record was altered OR the keys/input/result do not belong to this exchange
// -- cryptographically indistinguishable -- so it never asserts "tampered" alone.
const HEADLINES: Record<RecordVerificationReport["outcome"], VerdictHeadline> =
  {
    verified: {
      tone: "verified",
      title: "Verified",
      detail:
        "The record is internally consistent: every commitment opened against " +
        "the files you supplied, and the agreed-terms hash re-derives.",
    },
    incomplete: {
      tone: "incomplete",
      title: "Incomplete",
      detail:
        "Nothing contradicted the record, but not everything could be checked. " +
        "See the rows below for what is still open.",
    },
    failed: {
      tone: "failed",
      title: "Verification failed",
      detail:
        "A check did not match. This means one of two things, and they cannot be " +
        "told apart here: the record was altered, or a file you re-supplied (an " +
        "input, a result, or the linkage terms) does not belong to this exchange.",
    },
  };

// The per-commitment status label and tone. `unopenable` here is the missing-salt
// signal -- a wrong or drifted keys file -- stated distinctly from a mismatch and
// from a not-supplied commitment. Not a failure: it leaves the outcome incomplete.
const COMMITMENT_ROWS: Record<
  CommitmentStatus,
  { status: string; tone: VerdictTone; explanation?: string }
> = {
  verified: { status: "Opened and matches", tone: "verified" },
  mismatch: { status: "Does not match", tone: "failed" },
  "not-supplied": {
    status: "Not opened",
    tone: "incomplete",
    explanation:
      "Supply your retained files to open this commitment. Without them it " +
      "cannot be checked -- this is not a failure.",
  },
  unopenable: {
    status: "Cannot be opened",
    tone: "incomplete",
    explanation:
      "The keys file has no salt for this commitment, so it cannot be opened. " +
      "This is likely a wrong or drifted keys file, not a problem with the " +
      "record.",
  },
};

const TERMS_ROWS: Record<
  TermsHashStatus,
  { status: string; tone: VerdictTone; explanation?: string }
> = {
  verified: { status: "Re-derives and matches", tone: "verified" },
  mismatch: { status: "Does not match", tone: "failed" },
  "not-checked": {
    status: "Not checked",
    tone: "incomplete",
    explanation:
      "Supply both parties' linkage terms to check the agreed-terms hash. The " +
      "partner's terms are not retained by default, so this is the common case.",
  },
};

// The readable name of each commitment, in the record's committed order. Fixed
// strings owned by this page, never a value from a supplied file.
const COMMITMENT_LABELS: Record<CommitmentName, string> = {
  localPayloadSent: "The payload you sent",
  partnerPayloadReceived: "The payload you received",
  associationTable: "The matched-pairs table",
};

const COMMITMENT_ORDER: ReadonlyArray<CommitmentName> = [
  "localPayloadSent",
  "partnerPayloadReceived",
  "associationTable",
];

const SIGNATURE_NOTE =
  "Partner receipt signatures are not checked here. This confirms the record is " +
  "internally consistent, not that your partner signed it.";

// The record is self-attested either way, so this section says nothing about the
// partner; what changes when a dual-signed record was verified in the same run is
// where the evidence against the partner is, not whether this section carries it.
const SIGNATURE_NOTE_WITH_SIGNED_RECORD =
  "Partner receipt signatures are checked separately below, against the " +
  "dual-signed record.";

/**
 * Build the verdict view-model from a {@link RecordVerificationReport} and any
 * reconstruction warnings. Each warning is sanitized here (it interpolates a
 * supplied column name), so the caller passes the raw warnings straight from
 * {@link reconstructCommittedData}. Only the commitments the report carries are
 * shown; the mandatory pair is always present in a parsed record, and the
 * association table appears only when the record holds it.
 *
 * Pass `signedRecordSupplied` when the same run also verified a dual-signed
 * record, so the standing caveat points at that verdict rather than telling the
 * reader signatures went unchecked beside a verdict that checked them.
 */
export function verdictViewModel(
  report: RecordVerificationReport,
  warnings: ReadonlyArray<string>,
  signedRecordSupplied = false,
): VerdictViewModel {
  const commitments: Array<VerdictRow> = [];
  for (const name of COMMITMENT_ORDER) {
    const status = report.commitments[name];
    if (status === undefined) continue;
    const row = COMMITMENT_ROWS[status];
    commitments.push({
      label: COMMITMENT_LABELS[name],
      status: row.status,
      tone: row.tone,
      explanation: row.explanation,
    });
  }
  const termsRow = TERMS_ROWS[report.termsHash];
  return {
    headline: HEADLINES[report.outcome],
    commitments,
    termsHash: {
      label: "The agreed-terms hash",
      status: termsRow.status,
      tone: termsRow.tone,
      explanation: termsRow.explanation,
    },
    warnings: warnings.map((warning) => sanitizeForDisplay(warning)),
    signatureNote: signedRecordSupplied
      ? SIGNATURE_NOTE_WITH_SIGNED_RECORD
      : SIGNATURE_NOTE,
  };
}

// --- Signed-record verification ----------------------------------------------

/**
 * What the verifier holds outside the dual-signed record, one value per slot:
 * the partner's certificate reached by a fingerprint pinned out-of-band, the
 * verifier's own by the certificate it exported. Each is optional, and a record
 * checked with neither is checked for internal consistency only.
 */
export interface SignedRecordAnchors {
  /** The partner's certificate fingerprint, as the verifier pinned it
   * out-of-band. Must satisfy {@link pinnedFingerprintProblem}; empty or
   * whitespace-only is not supplied. */
  pinnedFingerprint?: string;
  /** The fingerprint of the verifier's own exported certificate, recomputed
   * from it by {@link parseCertificateDocument} rather than restated. */
  ownCertificateFingerprint?: string;
}

/**
 * Where the two identities the certificates must authorize and the agreed-terms
 * hash the receipt content must carry come from. The exchange record holds both
 * already, so a party checking its own exchange supplies them by loading it; a
 * verifier without the record restates them from both parties' linkage terms.
 * With neither, both checks are reported as not performed rather than assumed --
 * which also holds the verdict short of verified.
 */
export interface SignedRecordExpectationSources {
  record?: ExchangeRecord;
  localTerms?: LinkageTerms;
  partnerTerms?: LinkageTerms;
}

async function signedRecordExpectations(
  sources: SignedRecordExpectationSources,
): Promise<
  Pick<
    DualSignedRecordVerificationInputs,
    "expectedIdentities" | "expectedTermsHash"
  >
> {
  const { record, localTerms, partnerTerms } = sources;
  if (record !== undefined)
    return {
      expectedIdentities: [record.localIdentity, record.partnerIdentity],
      expectedTermsHash: record.termsHash,
    };
  if (localTerms === undefined || partnerTerms === undefined) return {};
  return {
    expectedIdentities: [localTerms.identity, partnerTerms.identity],
    expectedTermsHash: await computeTermsHash(localTerms, partnerTerms),
  };
}

/**
 * Verify a parsed dual-signed record against what the verifier holds outside it.
 * The verdict is core's: this assembles the anchoring values and the expected
 * identities/terms hash and returns
 * {@link verifyDualSignedRecord}'s report unmodified, so which slot an anchoring
 * value reaches is decided in one place rather than re-derived per surface.
 *
 * The verifier's own certificate is supplied as a `named` anchor: the operator
 * chose that file for this run, which asserts the record is one they signed, so
 * a certificate matching neither slot fails the verification rather than
 * quietly leaving a slot unanchored.
 */
export async function verifySignedRecord(
  record: DualSignedRecord,
  anchors: SignedRecordAnchors,
  expectations: SignedRecordExpectationSources,
): Promise<DualSignedRecordVerificationReport> {
  // Trimmed to the value the surface validated, so a fingerprint pasted with
  // surrounding whitespace is the pin it looks like rather than one that
  // matches nothing.
  const pin = anchors.pinnedFingerprint?.trim() ?? "";
  // A malformed pin matches no certificate, which would be reported as a
  // partner whose certificate does not match -- a confusing diagnosis of the
  // record rather than of the value. The surface rejects one before it can be
  // verified with; this refuses to render that confusion if it ever does not.
  if (pinnedFingerprintProblem(pin) !== undefined)
    throw new Error(
      "a pinned fingerprint that is not a fingerprint reached the signed-record " +
        "verification, where it would be reported as a certificate that does " +
        "not match",
    );
  return await verifyDualSignedRecord(record, {
    pinnedFingerprints: pin.length === 0 ? [] : [pin],
    localIdentity:
      anchors.ownCertificateFingerprint === undefined
        ? undefined
        : { fingerprint: anchors.ownCertificateFingerprint, source: "named" },
    ...(await signedRecordExpectations(expectations)),
  });
}

// --- Signed-record verdict view-model ----------------------------------------

/** One party's slot in the signed verdict: who the record says they are, the
 * fingerprint recomputed from their certificate, and the per-check rows. */
export interface SignedPartyViewModel {
  /** The handshake role whose slot this is. */
  label: string;
  /** The identity the certificate carries -- free text its holder chose,
   * sanitized for display here. */
  identity: string;
  /** The fingerprint recomputed from the record, or a stated stand-in for a
   * certificate whose canonical bytes cannot be produced. */
  fingerprint: string;
  rows: Array<VerdictRow>;
}

/** The signed verdict view-model the page renders. */
export interface SignedVerdictViewModel {
  headline: VerdictHeadline;
  parties: Array<SignedPartyViewModel>;
  termsHash: VerdictRow;
  /** What to do about a slot nothing outside the record anchors, and what an
   * anchoring value that reached neither certificate means. Empty when neither
   * applies. */
  guidance: Array<string>;
  /** The standing note that the per-exchange binder is reported, not
   * recomputed. */
  binderNote: string;
}

const SIGNED_ROLE_LABELS: Record<SignedReceiptPartyReport["role"], string> = {
  initiator: "Initiator",
  responder: "Responder",
};

// core reports an empty fingerprint for a certificate whose canonical bytes
// cannot be produced (an identity string the canonical encoder refuses); that
// certificate is reported with a failed binding, and this stands in for the
// blank value rather than rendering nothing where a fingerprint belongs.
const UNCOMPUTABLE_FINGERPRINT = "could not be computed";

const SIGNED_FAILED_HEADLINE: VerdictHeadline = {
  tone: "failed",
  title: "Signed receipt verification failed",
  detail:
    "A check did not match. This means one of two things, and they cannot be " +
    "told apart here: the dual-signed record was altered, or it is not the " +
    "exchange or the partner you are checking it against.",
};

const CERTIFICATE_BINDING_ROWS: Record<
  CertificateBindingStatus,
  { status: string; tone: VerdictTone; explanation: string }
> = {
  verified: {
    status: "Self-signature verifies",
    tone: "verified",
    explanation: "The certificate binds this identity to this key.",
  },
  failed: {
    status: "Self-signature does not verify",
    tone: "failed",
    explanation:
      "The certificate does not bind this identity to this key, so nothing it " +
      "carries can be attributed to that identity.",
  },
};

const RECEIPT_SIGNATURE_ROWS: Record<
  ReceiptSignatureStatus,
  { status: string; tone: VerdictTone; explanation?: string }
> = {
  verified: {
    status: "Verifies over this receipt's content",
    tone: "verified",
    explanation:
      "The signature is bound to this party's role and to the certificate " +
      "above it.",
  },
  failed: { status: "Does not verify", tone: "failed" },
};

// Where the two identities and the agreed-terms hash come from, named the same
// way in both rows that can be waiting on them.
const EXPECTATIONS_REMEDIATION =
  "Load the exchange record for this exchange, or paste both parties' linkage " +
  "terms, to supply it.";

const ASSERTED_IDENTITY_ROWS: Record<
  AssertedIdentityStatus,
  { status: string; tone: VerdictTone; explanation?: string }
> = {
  verified: {
    status: "Matches an identity expected for this exchange",
    tone: "verified",
  },
  mismatch: {
    status: "Does not match an identity expected for this exchange",
    tone: "failed",
  },
  "not-checked": {
    status: "Not checked",
    tone: "incomplete",
    explanation:
      "Nothing outside the record states who this exchange was between. " +
      EXPECTATIONS_REMEDIATION,
  },
};

const SIGNED_TERMS_ROWS: Record<
  TermsHashStatus,
  { status: string; tone: VerdictTone; explanation?: string }
> = {
  verified: {
    status: "Matches the terms this exchange agreed",
    tone: "verified",
  },
  mismatch: {
    status: "Does not match the terms this exchange agreed",
    tone: "failed",
  },
  "not-checked": {
    status: "Not checked",
    tone: "incomplete",
    explanation:
      "Nothing outside the record states the terms this exchange agreed. " +
      EXPECTATIONS_REMEDIATION,
  },
};

const ANCHORED_CERTIFICATE_ROWS: Record<
  Exclude<CertificateAnchorStatus, "unanchored">,
  { status: string; explanation: string }
> = {
  "partner-pin": {
    status: "Matches the fingerprint you pinned out-of-band",
    explanation:
      "The pin is what ties this certificate to a party you know, and it came " +
      "from outside this record.",
  },
  "local-identity": {
    status: "Is the certificate you supplied as your own",
    explanation:
      "Certificates are public, so this says whose certificate sits in this " +
      "slot and nothing more. What refuses a slot its holder did not sign is " +
      "the receipt signature below, which only that certificate's private key " +
      "could have produced.",
  },
};

function signedParties(
  report: DualSignedRecordVerificationReport,
): Array<SignedReceiptPartyReport> {
  return [report.initiator, report.responder];
}

/**
 * What an unanchored slot says, in the clauses the report supports and no
 * others: a check that did not run, or one that ran and matched this very
 * certificate, must not be narrated as a check this certificate failed. A pinned
 * value that matches this certificate and no other would have anchored this
 * slot, so while the other slot carries a different certificate the report does
 * support "no pinned value matches it"; when both slots carry one certificate it
 * does not, because what left this slot unanchored is that each value claims a
 * single slot.
 */
function unanchoredExplanation(
  party: SignedReceiptPartyReport,
  other: SignedReceiptPartyReport,
  report: DualSignedRecordVerificationReport,
): string {
  const clauses: Array<string> = [];
  if (
    report.pinnedFingerprints !== "not-supplied" &&
    other.fingerprint !== party.fingerprint
  )
    clauses.push("no fingerprint you pinned matches it");
  if (report.localIdentity === "unmatched")
    clauses.push("it is not the certificate you supplied as your own");
  const supported = clauses.length === 0 ? "" : ` -- ${clauses.join(", and ")}`;
  return (
    `Nothing you supplied anchors it${supported}. Whoever assembled this ` +
    "record could have minted this certificate, so the verdict cannot speak " +
    "for this slot."
  );
}

function signedPartyViewModel(
  party: SignedReceiptPartyReport,
  other: SignedReceiptPartyReport,
  report: DualSignedRecordVerificationReport,
): SignedPartyViewModel {
  const anchorRow =
    party.certificateAnchor === "unanchored"
      ? {
          status: "Not anchored",
          tone: "incomplete" as VerdictTone,
          explanation: unanchoredExplanation(party, other, report),
        }
      : {
          ...ANCHORED_CERTIFICATE_ROWS[party.certificateAnchor],
          tone: "verified" as VerdictTone,
        };
  const binding = CERTIFICATE_BINDING_ROWS[party.certificateBinding];
  const signature = RECEIPT_SIGNATURE_ROWS[party.signature];
  const identity = ASSERTED_IDENTITY_ROWS[party.assertedIdentity];
  return {
    label: SIGNED_ROLE_LABELS[party.role],
    identity: sanitizeForDisplay(party.identity),
    fingerprint:
      party.fingerprint.length === 0
        ? UNCOMPUTABLE_FINGERPRINT
        : party.fingerprint,
    rows: [
      { label: "What anchors this certificate", ...anchorRow },
      { label: "Certificate identity binding", ...binding },
      { label: "Receipt signature", ...signature },
      { label: "Asserted identity", ...identity },
    ],
  };
}

// Name what anchored each certificate, for the verified verdict's sentence.
const ANCHOR_SOURCE_PHRASES: Partial<Record<CertificateAnchorStatus, string>> =
  {
    "partner-pin": "a fingerprint you pinned out-of-band",
    "local-identity": "the certificate you supplied as your own",
  };

function anchorsPhrase(
  parties: ReadonlyArray<SignedReceiptPartyReport>,
): string {
  return parties
    .map((party) => {
      const source = ANCHOR_SOURCE_PHRASES[party.certificateAnchor];
      // A verified verdict means every certificate was anchored, and core
      // withholds that verdict while either slot is unanchored. An unanchored
      // slot here would leave the sentence claiming an anchor that does not
      // exist -- evidence overstated -- so it is refused rather than phrased.
      if (source === undefined)
        throw new Error(
          `a verified dual-signed record leaves the ${party.role}'s certificate ` +
            "unanchored: the verdict would claim both certificates were " +
            "anchored when one was not",
        );
      return `the ${party.role}'s by ${source}`;
    })
    .join(", and ");
}

function signedHeadline(
  report: DualSignedRecordVerificationReport,
): VerdictHeadline {
  if (report.outcome === "failed") return SIGNED_FAILED_HEADLINE;
  const parties = signedParties(report);
  if (report.outcome === "incomplete") {
    // The record carries two certificates and a verdict speaks for both, so the
    // headline names the slot nothing outside the record reaches rather than
    // leaving the reader to find it in the rows.
    const unanchored = parties
      .filter((party) => party.certificateAnchor === "unanchored")
      .map(
        (party) =>
          ` Nothing outside the record anchors the ${party.role}'s certificate.`,
      )
      .join("");
    return {
      tone: "incomplete",
      title: "Signed receipt incomplete",
      detail:
        "Nothing contradicted the dual-signed record, but not everything could " +
        "be checked. See the rows below for what is still open." +
        unanchored,
    };
  }
  return {
    tone: "verified",
    title: "Signed receipt verified",
    detail:
      "Both signatures verify, and both certificates are anchored outside the " +
      `record -- ${anchorsPhrase(parties)}.`,
  };
}

// What to do about a certificate nothing outside the record vouches for, and
// what a supplied anchor that reached neither certificate means. Each line
// stands on its own: the run may be short one anchor, or hold one that belongs
// to another exchange entirely. Telling the operator to supply more while a
// value they did supply reached neither certificate would talk past that value,
// so a contradicted anchor ends the guidance.
function anchoringGuidance(
  report: DualSignedRecordVerificationReport,
): Array<string> {
  const lines: Array<string> = [];
  if (report.pinnedFingerprints === "unmatched")
    lines.push(
      "The fingerprint you pinned matches neither certificate in this record: " +
        "this is not the record of the party you pinned.",
    );
  if (report.localIdentity === "unmatched")
    lines.push(
      "The certificate you supplied as your own is neither certificate in " +
        "this record: this is not a receipt you signed.",
    );
  if (lines.length > 0) return lines;
  const parties = signedParties(report);
  const unanchored = parties.filter(
    (party) => party.certificateAnchor === "unanchored",
  );
  if (unanchored.length === 0) return lines;
  if (unanchored.length === parties.length)
    lines.push(
      "Certificate fingerprint trust is not established: nothing you supplied " +
        "ties either certificate to a party you know. Enter your partner's " +
        "pinned fingerprint, and load your own exported certificate when one " +
        "of these slots is yours.",
    );
  else
    lines.push(
      `The ${unanchored[0].role}'s certificate is anchored by nothing outside ` +
        "this record, which is what holds the verdict short of verified: enter " +
        "that party's pinned fingerprint, or load your own exported " +
        "certificate when that slot is yours.",
    );
  return lines;
}

/**
 * Build the signed verdict view-model from core's
 * {@link DualSignedRecordVerificationReport}. Pure over the report: every tier,
 * per-slot sentence, and remediation line is decided by what the report states,
 * so nothing here can claim an anchor or a check the verification did not make.
 */
export function signedVerdictViewModel(
  report: DualSignedRecordVerificationReport,
): SignedVerdictViewModel {
  const termsRow = SIGNED_TERMS_ROWS[report.termsHash];
  return {
    headline: signedHeadline(report),
    parties: [
      signedPartyViewModel(report.initiator, report.responder, report),
      signedPartyViewModel(report.responder, report.initiator, report),
    ],
    termsHash: { label: "The agreed-terms hash", ...termsRow },
    guidance: anchoringGuidance(report),
    binderNote:
      `The per-exchange binder ${sanitizeForDisplay(report.binder)} is covered ` +
      "by both signatures and is not recomputed here: deriving it needs the " +
      "exchange session key, which only the two parties held.",
  };
}
