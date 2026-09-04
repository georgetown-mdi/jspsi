import {
  OperatorConfigError,
  certificateAuthorizesIdentity,
  redactAndDisplayPartyIdentity,
} from "@psilink/core";
import type { CertificateBody } from "@psilink/core";

// The one place the CLI compares the identity a signing certificate is bound to
// against the party's `linkage_terms.identity`, shared by the commands that
// resolve an identity for an exchange (fingerprint and exchange; verify-receipt
// checks against the record, not the run's terms) so the two cannot drift apart
// in wording or in rule.
//
// Why the comparison matters: a partner verifies a receipt against the identity
// in the AGREED TERMS, not the one the presented certificate holds
// (verifyPresentedCertificate in @psilink/core), so a certificate bound to
// anything other than linkage_terms.identity signs receipts the partner rejects.
//
// The two commands dispose of the same comparison differently, because only one
// of them runs an exchange.
//
// `psilink exchange` REFUSES: this party's own certificate against its own
// agreed terms (assertLocalCertificateAuthorizesAgreedIdentity in
// @psilink/core), refused here before any credential, terms, or data are
// sent -- the disposition its sibling certificate-mode faults take
// (assertCertificateModePinsPartner and assertCertificateModeNamesLocalParty
// in @psilink/core).
// packages/core/test/signedReceiptEndToEnd.test.ts drives both role
// assignments, backing this refusal's assumption with a check.
//
// `psilink fingerprint` WARNS. It runs no exchange and sends nothing, and
// binding a name before editing the configuration to match is an authoring order
// an operator may legitimately work in, so it reports the divergence and still
// prints the fingerprint.
//
// The comparison is the partner's own predicate rather than a local `!==`, so a
// local prediction of the remote check cannot drift from what that check does.

// The two ways out, shared by both dispositions so they cannot come to disagree
// on the remedy. The local config edit is offered first: it is the cheaper of
// the two, and regeneration invalidates a fingerprint the partner has pinned.
const RECONCILE_GUIDANCE =
  "Make the two match: set linkage_terms.identity to the bound identity (a " +
  "local config edit), or regenerate the identity with 'psilink fingerprint " +
  "--force --identity' naming the terms identity -- regeneration changes the " +
  "fingerprint your partner pins, so it needs a coordinated re-pin.";

/**
 * Whether `certificate` is bound to an identity other than `termsIdentity`.
 *
 * False when the two agree, and when the config has no identity to compare
 * against (absent or empty) -- there is nothing the certificate could diverge
 * from. A `certificate`-mode run that names no party is refused earlier, for
 * its own reason, ahead of either disposition below
 * (`assertCertificateModeNamesLocalParty` in `@psilink/core`).
 */
function divergesFromAgreedTerms(
  certificate: CertificateBody,
  termsIdentity: string | undefined,
): termsIdentity is string {
  if (termsIdentity === undefined || termsIdentity.length === 0) return false;
  return !certificateAuthorizesIdentity(certificate, termsIdentity);
}

/**
 * Warn when `certificate` is bound to an identity other than `termsIdentity`,
 * naming both values and the two ways to reconcile them. Silent when they agree
 * and when there is nothing to diverge from (see {@link divergesFromAgreedTerms}).
 * `psilink fingerprint`'s disposition of the divergence.
 *
 * Both identities are escaped here, the single escape site since neither
 * value ever becomes an `Error` on this path (CONTRIBUTING.md,
 * Operator-facing escaping). They are locally authored, not
 * partner-supplied, so this is display hygiene -- the shared helper's own
 * per-value length bound, not an injection boundary.
 */
export function warnOnIdentityDivergence(
  certificate: CertificateBody,
  termsIdentity: string | undefined,
  log: { warn: (message: string) => void },
): void {
  if (!divergesFromAgreedTerms(certificate, termsIdentity)) return;
  log.warn(
    `the signing identity is bound to "${redactAndDisplayPartyIdentity(
      certificate.identity,
    )}", which differs from linkage_terms.identity "${redactAndDisplayPartyIdentity(
      termsIdentity,
    )}" in the config. Your partner verifies a receipt against the identity ` +
      "in the agreed terms, so they will reject a receipt signed under this " +
      "certificate, and an exchange configured this way is refused before it " +
      `runs. ${RECONCILE_GUIDANCE}`,
  );
}

/**
 * Refuse a `certificate`-mode exchange whose signing identity is bound to an
 * identity other than `termsIdentity`, this run's `linkage_terms.identity`.
 * Silent when they agree and when there is nothing to diverge from (see
 * {@link divergesFromAgreedTerms}).
 *
 * `psilink exchange`'s disposition, raised as soon as the certificate is in
 * hand, before any credential, terms, or data are sent -- the earliest point
 * possible: `prepareForExchange`, which its siblings use, reads the
 * `signing` block, which has only a path to the identity file, so no
 * certificate exists there yet to compare.
 *
 * An {@link OperatorConfigError} for the reason its siblings are: both values
 * are the local operator's own -- one bound into a file this party wrote, the
 * other a field in this party's own config -- so the message is actionable
 * to them and discloses nothing beyond their own values, classified as a
 * configuration error (exit 64).
 *
 * The two values are composed RAW and land last: raw because a fragment
 * interpolated into an `Error` is escaped once where the chain is rendered
 * (CONTRIBUTING.md, Operator-facing escaping), and last because the schema's
 * own text cap can consume the renderer's whole per-link budget
 * (docs/spec/CHANNEL_SECURITY.md, "Display sanitization escape format"). The
 * fixed prose is kept short enough that a realistic pair still renders whole
 * inside that cap, pinned by a check on this message's length rather than by
 * this paragraph (`exchangeSigning.test.ts`).
 *
 * @throws {OperatorConfigError} when the certificate is bound to a different
 *   identity than the run's agreed terms hold.
 */
export function assertIdentityMatchesAgreedTerms(
  certificate: CertificateBody,
  termsIdentity: string | undefined,
): void {
  if (!divergesFromAgreedTerms(certificate, termsIdentity)) return;
  throw new OperatorConfigError(
    "this exchange signs receipts (signing.mode: certificate), but the " +
      "signing identity is bound to a party name the agreed terms do not " +
      "state, so it cannot finish: your partner authorizes the certificate " +
      "against the agreed terms and rejects it, so the exchange refuses the " +
      "divergence at the terms exchange, before your data crosses. " +
      `${RECONCILE_GUIDANCE} ` +
      `The certificate is bound to "${certificate.identity}"; ` +
      `linkage_terms.identity is "${termsIdentity}".`,
  );
}
