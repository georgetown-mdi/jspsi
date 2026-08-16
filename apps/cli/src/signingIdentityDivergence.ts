import { certificateAuthorizesIdentity } from "@psilink/core";
import type { CertificateBody } from "@psilink/core";

// The one place the CLI compares the identity a signing certificate is bound to
// against the party's `linkage_terms.identity`, shared by every command that
// resolves an identity so the two cannot drift apart in wording or in rule.
//
// Why the comparison matters: a partner verifies a receipt against the identity
// in the AGREED TERMS, not the one the presented certificate carries
// (verifyPresentedCertificate in @psilink/core), so a certificate bound to
// anything other than linkage_terms.identity signs receipts the partner rejects.
// Surfacing it locally is the difference between a run that says why up front
// and one that spends a whole exchange producing receipts nobody can verify.
//
// It warns rather than blocks: which identity to bind is the operator's own
// choice, and the config may legitimately be edited to match afterwards. The
// warning therefore fires on EVERY resolution while the divergence stands --
// including a scheduled exchange, which logs it each cycle. Warning once, or
// only when the config changed, would need state the CLI does not carry.
//
// The comparison is the partner's own predicate rather than a local `!==`, so a
// local prediction of the remote check cannot drift from what that check does.

/**
 * Warn when `certificate` is bound to an identity other than `termsIdentity`,
 * the party's `linkage_terms.identity` for this run, naming both values and the
 * two ways to reconcile them. Silent when the two agree, and when the config
 * carries no identity to compare against (absent or empty) -- there is nothing
 * the certificate could diverge from.
 *
 * The certificate may equally have just been generated or been loaded off disk:
 * what a partner rejects is the divergence itself, not the act of binding it.
 */
export function warnOnIdentityDivergence(
  certificate: CertificateBody,
  termsIdentity: string | undefined,
  log: { warn: (message: string) => void },
): void {
  if (termsIdentity === undefined || termsIdentity.length === 0) return;
  if (certificateAuthorizesIdentity(certificate, termsIdentity)) return;
  log.warn(
    `the signing identity is bound to "${certificate.identity}", which ` +
      `differs from linkage_terms.identity "${termsIdentity}" in the config. ` +
      "Your partner verifies a receipt against the identity in the agreed " +
      "terms, so they will reject a receipt signed under this certificate. " +
      "Make the two match: regenerate the identity with 'psilink fingerprint " +
      "--force --identity' naming the terms identity, or set " +
      "linkage_terms.identity to the bound identity.",
  );
}
