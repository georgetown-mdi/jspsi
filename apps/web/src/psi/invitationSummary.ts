import { sanitizeForDisplay } from "@psilink/core";

import type {
  Algorithm,
  InvitationToken,
  LinkageField,
  LinkageKey,
  LinkageKeyElement,
} from "@psilink/core";

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

/**
 * Plain-language label for each fuzzy-comparison expansion. Like the field
 * type, the value is a fixed enum the schema validates (not partner free text),
 * so these are safe to render verbatim. Each expands one value into several
 * match candidates, loosening the match -- and, under `psi`, widening what is
 * disclosed -- so the acceptor must see it.
 */
const FUZZY_COMPARISON_LABELS: Record<
  NonNullable<LinkageKeyElement["generateFuzzyComparisons"]>,
  string
> = {
  transpositions: "two-digit transpositions",
  editDistances: "single-character edits",
  adjacentYears: "adjacent years",
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
 * One element of a linkage key, reduced to what determines whether records
 * match on it: the field it derives from and any non-default matching rule it
 * carries (a value transform or a fuzzy-comparison expansion).
 */
export interface InvitationKeyElementSummary {
  /** Human-readable label for the field this element derives from. */
  fieldLabel: string;
  /**
   * Sanitized function names of the transform steps applied to the value, in
   * order; empty when the value is matched as-is. The function name is a short,
   * length-bounded string; the partner-controlled `params` are not surfaced (an
   * arbitrary, unbounded record), only that a transform is present and which.
   */
  transforms: Array<string>;
  /** Plain-language label for the fuzzy-comparison expansion, if any. */
  fuzzyComparison?: string;
}

/**
 * A single linkage key, with the ordered elements and matching rules that
 * decide which records match -- and, under `psi`, which shared identifiers are
 * disclosed. Surfaced in full so no transform, swap, or fuzzy rule is silently
 * consented to.
 */
export interface InvitationKeySummary {
  /** The key's name, sanitized for display. */
  name: string;
  /** Ordered elements combined to form the key. */
  elements: Array<InvitationKeyElementSummary>;
  /**
   * The two elements the receiver matches in either order, resolved to their
   * field labels (or the sanitized raw identifier when one does not resolve to
   * an element); present only when the key declares a swap.
   */
  swap?: [string, string];
  /**
   * True when the key carries any non-default matching rule -- a transform, a
   * fuzzy comparison, or a swap. The visible flag that must never be silently
   * consented to.
   */
  hasNonDefaultRule: boolean;
}

/**
 * A linkage field, reduced to its display label and any declared constraints.
 * Constraints are data standards both parties commit to (advisory -- the
 * application warns rather than enforces), surfaced so the acceptor sees every
 * rule attached to the matched data.
 */
export interface InvitationFieldSummary {
  /** Human-readable label for the field's semantic type. */
  label: string;
  /**
   * Plain-language descriptions of the declared constraints, if any. The
   * `exclude` denylist is summarized as a count rather than listing its values:
   * it is advisory and can hold hundreds of entries.
   */
  constraints: Array<string>;
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
  /**
   * Linkage keys (records are matched on these), in the inviter's order, each
   * carrying its ordered elements and matching rules.
   */
  linkageKeys: Array<InvitationKeySummary>;
  /** PII fields involved, each with its label and declared constraints. */
  linkageFields: Array<InvitationFieldSummary>;
  /** Present only when the inviter attached a legal agreement. */
  legalAgreement?: InvitationLegalAgreementSummary;
  /** Present only when the inviter declared payload columns to send or receive. */
  payload?: InvitationPayloadSummary;
  /** The invitation's expiry instant (ISO 8601), if the token carries one. */
  expires?: string;
}

/**
 * Plain-language descriptions of a field's declared constraints, in a stable
 * order. The `exclude` denylist is reported as a count, not its values: it is
 * advisory and may hold hundreds of entries. `allowedCharacters` is a short,
 * length-bounded, partner-controlled string, so it is sanitized before display.
 */
function describeConstraints(field: LinkageField): Array<string> {
  const constraints = field.constraints;
  if (constraints === undefined) return [];

  const descriptions: Array<string> = [];
  if ("validOnly" in constraints && constraints.validOnly === true)
    descriptions.push("values must be valid");
  if ("affixesAllowed" in constraints && constraints.affixesAllowed === false)
    descriptions.push("honorifics and suffixes removed");
  if (
    "allowedCharacters" in constraints &&
    constraints.allowedCharacters !== undefined
  )
    descriptions.push(
      `characters limited to ${sanitizeForDisplay(constraints.allowedCharacters)}`,
    );
  const exclude = constraints.exclude ?? [];
  if (exclude.length > 0)
    descriptions.push(
      `${exclude.length} excluded value${exclude.length === 1 ? "" : "s"}`,
    );
  return descriptions;
}

/**
 * Reduce one linkage key to its display summary, resolving each element's field
 * reference to a human-readable label and surfacing every non-default matching
 * rule. `fieldByName` maps a field `name` to its semantic type; an element or
 * swap reference that does not resolve falls back to the sanitized raw string.
 */
function summarizeKey(
  key: LinkageKey,
  fieldByName: Map<string, LinkageField["type"]>,
): InvitationKeySummary {
  const labelForField = (fieldName: string): string => {
    const type = fieldByName.get(fieldName);
    return type !== undefined
      ? FIELD_TYPE_LABELS[type]
      : sanitizeForDisplay(fieldName);
  };

  const elements: Array<InvitationKeyElementSummary> = key.elements.map(
    (element) => ({
      fieldLabel: labelForField(element.field),
      transforms: (element.transform ?? []).map((step) =>
        sanitizeForDisplay(step.function),
      ),
      fuzzyComparison:
        element.generateFuzzyComparisons !== undefined
          ? FUZZY_COMPARISON_LABELS[element.generateFuzzyComparisons]
          : undefined,
    }),
  );

  let swap: [string, string] | undefined;
  if (key.swap !== undefined) {
    // A swap names two elements by their effective identifier (element `name`
    // if present, otherwise `field`); resolve each to its field label so the
    // note reads in the same terms as the element list.
    const labelByIdentifier = new Map(
      key.elements.map((element) => [
        element.name ?? element.field,
        labelForField(element.field),
      ]),
    );
    const resolve = (identifier: string): string =>
      labelByIdentifier.get(identifier) ?? sanitizeForDisplay(identifier);
    swap = [resolve(key.swap[0]), resolve(key.swap[1])];
  }

  const hasNonDefaultRule =
    swap !== undefined ||
    elements.some(
      (element) =>
        element.transforms.length > 0 || element.fuzzyComparison !== undefined,
    );

  return {
    name: sanitizeForDisplay(key.name),
    elements,
    swap,
    hasNonDefaultRule,
  };
}

/**
 * Build a display-ready {@link InvitationSummary} from a decoded invitation
 * token. Pure and side-effect-free: it derives only what the accept screen
 * renders and sanitizes every partner-controlled string, so it is the single
 * tested boundary for that escaping.
 */
export function summarizeInvitation(token: InvitationToken): InvitationSummary {
  const terms = token.linkageTerms;

  const fieldByName = new Map(
    terms.linkageFields.map((field) => [field.name, field.type]),
  );

  const summary: InvitationSummary = {
    invitingParty: sanitizeForDisplay(terms.identity),
    algorithm: terms.algorithm,
    inviterReceivesOutput: terms.output.expectsOutput,
    inviterSharesResult: terms.output.shareWithPartner,
    linkageKeys: terms.linkageKeys.map((key) => summarizeKey(key, fieldByName)),
    linkageFields: terms.linkageFields.map((field) => ({
      label: FIELD_TYPE_LABELS[field.type],
      constraints: describeConstraints(field),
    })),
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
