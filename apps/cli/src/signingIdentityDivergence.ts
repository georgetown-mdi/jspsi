import {
  OperatorConfigError,
  certificateAuthorizesIdentity,
  reasonTermsCannotStateIdentity,
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
// sent -- the disposition its sibling certificate-mode fault takes
// (assertCertificateModeNamesLocalParty in @psilink/core).
// packages/core/test/records/signedReceiptEndToEnd.test.ts drives both role
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

// The exit for the one divergence the guidance above cannot resolve: a
// certificate bound to a label the terms refuse in `identity`. No terms
// document may state that label, so the local config edit is closed to its
// holder and a re-key is the only exit left. Which labels those are, and the
// clause naming the class without quoting the label, are core's own answer
// (reasonTermsCannotStateIdentity in @psilink/core), read rather than restated
// so this boundary and the exchange boundary cannot disagree. Core names the
// same exit at that boundary (assertLocalCertificateAuthorizesAgreedIdentity),
// which an exchange reaches only after this one.
const REKEY_GUIDANCE =
  "Re-key the signing identity with 'psilink fingerprint --force --identity' " +
  "under a label the terms admit, then have every partner re-pin the new " +
  "fingerprint before receipts verify again.";

// What a divergence costs the operator, said the same way on both of the
// warning's branches so the remedy is the only thing that differs between them.
const DIVERGENCE_CONSEQUENCE =
  "Your partner verifies a receipt against the identity in the agreed terms, " +
  "so they will reject a receipt signed under this certificate, and an " +
  "exchange configured this way is refused before it runs.";

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
 * A bound label the terms cannot state takes the re-key exit instead and is
 * not named at all (`reasonTermsCannotStateIdentity` in `@psilink/core`).
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
  const termsLabel = redactAndDisplayPartyIdentity(termsIdentity);
  const unstatable = reasonTermsCannotStateIdentity(certificate.identity);
  if (unstatable !== undefined) {
    log.warn(
      "the signing identity is bound to a label the linkage terms cannot " +
        `state -- ${unstatable} -- so it differs from ` +
        `linkage_terms.identity "${termsLabel}" in the config, and no edit ` +
        "of that field can bring the two into agreement. " +
        `${DIVERGENCE_CONSEQUENCE} ${REKEY_GUIDANCE}`,
    );
    return;
  }
  log.warn(
    `the signing identity is bound to "${redactAndDisplayPartyIdentity(
      certificate.identity,
    )}", which differs from linkage_terms.identity "${termsLabel}" in the ` +
      `config. ${DIVERGENCE_CONSEQUENCE} ${RECONCILE_GUIDANCE}`,
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
 * A bound label the terms cannot state takes a refusal of its own, naming the
 * re-key exit and no part of the label (`reasonTermsCannotStateIdentity` in
 * `@psilink/core`). It names one value rather than two, so the room the
 * paragraph above reserves covers it as well.
 *
 * @throws {OperatorConfigError} when the certificate is bound to a different
 *   identity than the run's agreed terms hold.
 */
export function assertIdentityMatchesAgreedTerms(
  certificate: CertificateBody,
  termsIdentity: string | undefined,
): void {
  if (!divergesFromAgreedTerms(certificate, termsIdentity)) return;
  const unstatable = reasonTermsCannotStateIdentity(certificate.identity);
  if (unstatable !== undefined)
    throw new OperatorConfigError(
      "this exchange signs receipts (signing.mode: certificate), but the " +
        "signing identity is bound to a label the linkage terms cannot " +
        `state -- ${unstatable} -- so it cannot finish: your partner ` +
        "authorizes the certificate against the " +
        "agreed terms and rejects it, and no edit of linkage_terms.identity " +
        "can bring the two into agreement, because the terms refuse that " +
        `label too. ${REKEY_GUIDANCE} ` +
        `linkage_terms.identity is "${termsIdentity}".`,
    );
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
