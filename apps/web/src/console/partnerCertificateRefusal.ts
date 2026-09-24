import { PARTNER_CERTIFICATE_REFUSAL_MESSAGES } from "@alcove/core";

import type { PartnerCertificateRefusalKind } from "@alcove/core";

/**
 * What the console says about each of the five refusals the terms-time
 * partner-certificate pin raises.
 *
 * Core's own messages state the cause and then a remedy in configuration keys
 * -- replace `signing.partner_fingerprint`, set `signing.mode` -- which is the
 * command line's instruction and not one a console operator can take: the
 * console writes the configuration each run is driven by itself, and the
 * controls the operator does hold are the receipts card's own fields. Each
 * message here states the same cause in the console's words and names those
 * controls instead.
 *
 * The refusal is identified from the whole literal core raised, found in the
 * failure text the relay delivered. That text holds the refusal whole on the
 * path the seat reads -- the relayed cause chain, whose per-link budget is
 * wider than any of the five (docs/spec/SERVER_JOB_API.md, the terminal error's
 * cause chain) -- and a refusal that arrives cut reaches the operator in core's
 * own words, which name the cause correctly and a remedy they have to translate.
 */

/**
 * The console's remedy copy, one per refusal. Declared over core's union, so a
 * refusal added there is a compile error here rather than a case that reaches
 * the operator naming a configuration key.
 */
const CONSOLE_REFUSAL_COPY: Record<PartnerCertificateRefusalKind, string> = {
  unreadable:
    "Your partner presented a signing certificate Alcove cannot read, so the " +
    "exchange stopped and sent none of your data: there was nothing to pin " +
    "and nothing to check a receipt against. Ask your partner to run " +
    "'alcove fingerprint' and send you the identity it produces, then run " +
    "the exchange again. To exchange without a receipt instead, choose 'No " +
    "receipt' under what this exchange produces.",
  absent:
    "Your partner is not signing receipts, so the exchange stopped and sent " +
    "none of your data: this exchange produces a signed receipt and your " +
    "partner presented no signing certificate, so there was no receipt to " +
    "produce. Ask them to sign receipts with a signing identity of their own " +
    "and run the exchange again, or choose 'No receipt' under what this " +
    "exchange produces to run it unsigned.",
  unverified:
    "Your partner's signing certificate does not verify under its own key, so " +
    "nothing was pinned, and the exchange stopped and sent none of your data: " +
    "a certificate that is not internally consistent could never sign a " +
    "receipt this exchange would accept. Ask your partner to run " +
    "'alcove fingerprint' and send you the identity it produces, then run " +
    "the exchange again.",
  unauthorizedIdentity:
    "Your partner's signing certificate does not cover the name they agreed " +
    "terms under, so nothing was pinned, and the exchange stopped and sent " +
    "none of your data: a certificate bound to another party could never sign " +
    "a receipt this exchange would accept. Ask your partner to present the " +
    "certificate bound to the name they agree terms under, or to agree terms " +
    "under the name their certificate holds, then run the exchange again.",
  divergent:
    "Your partner presented a signing certificate that is not the one you " +
    "pinned, so the exchange stopped and sent none of your data, and the " +
    "fingerprint you entered is unchanged. Confirm the value with your " +
    "partner over a channel you trust -- a phone call, not the same email as " +
    "the invitation -- and they produce it by running " +
    "'alcove fingerprint'. Where they have made a new signing identity, " +
    "replace the value under your partner's fingerprint before you run again.",
};

/**
 * The console's copy for whichever terms-time pin refusal the relayed failure
 * text holds, or `undefined` for a failure that is none of them -- which the
 * seat then shows as it arrived.
 */
export function consolePartnerCertificateRefusal(
  failureText: string,
): string | undefined {
  for (const [kind, message] of Object.entries(
    PARTNER_CERTIFICATE_REFUSAL_MESSAGES,
  ))
    if (failureText.includes(message))
      return CONSOLE_REFUSAL_COPY[kind as PartnerCertificateRefusalKind];
  return undefined;
}
