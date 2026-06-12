import { sanitizeForDisplay } from "@psilink/core";

import type { Algorithm, InvitationToken, LinkageField } from "@psilink/core";

/**
 * Human-readable label for each linkage-field semantic type. The `type` is a
 * fixed enum the schema validates (not partner free-text), so these labels are
 * safe to render verbatim. The field's `name` is partner-controlled free text
 * and is deliberately not shown -- the semantic type is what matters for an
 * acceptor deciding whether to consent, and it cannot carry an injection.
 */
const FIELD_TYPE_LABELS: Record<LinkageField["type"], string> = {
  firstName: "First name",
  lastName: "Last name",
  dateOfBirth: "Date of birth",
  ssn: "Social Security number",
  ssn4: "Last 4 of Social Security number",
  phoneNumber: "Phone number",
  emailAddress: "Email address",
};

/** Legal-agreement context, with the partner-controlled free text sanitized. */
export interface InvitationLegalAgreementSummary {
  /** Agreement identifier (e.g. "MOU-2025-0042"), sanitized for display. */
  reference: string;
  /** Stated purpose of the disclosure, sanitized for display. */
  purpose: string;
  /** ISO 8601 date (YYYY-MM-DD) after which the exchange is refused. */
  expirationDate: string;
}

/** The optional data columns the inviter declares, with names sanitized. */
export interface InvitationPayloadSummary {
  /** Columns the inviter will send for matched records. */
  send: Array<string>;
  /** Columns the inviter requests from the acceptor for matched records. */
  receive: Array<string>;
}

/**
 * A display-ready, injection-safe view of the inviter's linkage terms, derived
 * from a decoded {@link InvitationToken}. Every partner-controlled value (the
 * self-asserted identity, linkage-key names, legal-agreement text, payload
 * column names, and the schema-validated date fields) is passed through
 * {@link sanitizeForDisplay} here, at the one boundary, so renderers can show
 * these fields without each re-deriving the escaping -- React's JSX escaping
 * covers HTML metacharacters but not the control, bidi, zero-width, or homoglyph
 * characters this neutralizes. The dates cannot carry such characters today (the
 * `z.iso` schemas reject them), but routing them through the same boundary keeps
 * the contract uniform rather than depending on that validation staying in place.
 */
export interface InvitationSummary {
  /** The inviter's self-asserted identity, sanitized for display. */
  invitingParty: string;
  /** `psi` reveals matched identifiers; `psi-c` reveals only the count. */
  algorithm: Algorithm;
  /** Whether the inviter expects to receive the intersection result. */
  inviterReceivesOutput: boolean;
  /** Whether the inviter will share the result with the accepting partner. */
  inviterSharesResult: boolean;
  /** Linkage-key names (records are matched on these), sanitized for display. */
  linkageKeyNames: Array<string>;
  /** Distinct PII field types involved, as human-readable labels. */
  linkageFieldLabels: Array<string>;
  /** Present only when the inviter attached a legal agreement. */
  legalAgreement?: InvitationLegalAgreementSummary;
  /** Present only when the inviter declared payload columns to send or receive. */
  payload?: InvitationPayloadSummary;
  /** The invitation's expiry instant (ISO 8601), if the token carries one. */
  expires?: string;
}

/**
 * Build a display-ready {@link InvitationSummary} from a decoded invitation
 * token. Pure and side-effect-free: it derives only what the accept screen
 * renders and sanitizes every partner-controlled string, so it is the single
 * tested boundary for that escaping.
 */
export function summarizeInvitation(token: InvitationToken): InvitationSummary {
  const terms = token.linkageTerms;

  const summary: InvitationSummary = {
    invitingParty: sanitizeForDisplay(terms.identity),
    algorithm: terms.algorithm,
    inviterReceivesOutput: terms.output.expectsOutput,
    inviterSharesResult: terms.output.shareWithPartner,
    linkageKeyNames: terms.linkageKeys.map((key) =>
      sanitizeForDisplay(key.name),
    ),
    // Distinct types, order preserved, so repeated fields of one type collapse
    // to a single label rather than listing it twice.
    linkageFieldLabels: [
      ...new Set(
        terms.linkageFields.map((field) => FIELD_TYPE_LABELS[field.type]),
      ),
    ],
  };

  if (terms.legalAgreement !== undefined) {
    summary.legalAgreement = {
      reference: sanitizeForDisplay(terms.legalAgreement.reference),
      purpose: sanitizeForDisplay(terms.legalAgreement.purpose),
      expirationDate: sanitizeForDisplay(terms.legalAgreement.expirationDate),
    };
  }

  const send = terms.payload?.send ?? [];
  const receive = terms.payload?.receive ?? [];
  if (send.length > 0 || receive.length > 0) {
    summary.payload = {
      send: send.map((column) => sanitizeForDisplay(column.name)),
      receive: receive.map((column) => sanitizeForDisplay(column.name)),
    };
  }

  if (token.expires !== undefined)
    summary.expires = sanitizeForDisplay(token.expires);

  return summary;
}
