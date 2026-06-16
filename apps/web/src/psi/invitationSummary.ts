import { sanitizeForDisplay } from "@psilink/core";

import type {
  Algorithm,
  InvitationToken,
  LinkageField,
  LinkageKey,
  LinkageKeyElement,
  TransformStep,
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
 * A single transform step applied to an element's value before hashing,
 * reduced to display form: the function name and a bounded, sanitized view of
 * its parameters -- which determine what the function does, and so what
 * matches.
 */
export interface InvitationTransformSummary {
  /** Sanitized name of the transform function. */
  function: string;
  /**
   * One sanitized `key: value` string per declared parameter, in declaration
   * order, capped at {@link MAX_DISPLAYED_PARAMS} (a trailing "... N more"
   * entry marks any overflow). sanitizeForDisplay bounds each entry's length and
   * the count is capped, so an arbitrarily large partner-supplied `params`
   * record cannot flood the screen. Empty when the step declares no parameters.
   */
  params: Array<string>;
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
   * Transform steps applied to the value before hashing, in order; empty when
   * the value is matched as-is. Each carries the sanitized function name and a
   * bounded, sanitized view of its parameters.
   */
  transforms: Array<InvitationTransformSummary>;
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
  /** True when the key declares a swap (two elements matched in either order). */
  hasSwap: boolean;
  /**
   * The two swapped elements' field labels, present only when both swap
   * references resolve to elements with *distinct* labels (the common case,
   * e.g. ["Last name", "First name"]). Absent when an identifier names no
   * element or the two would carry the same label. No identifier, raw or
   * sanitized, ever enters this tuple: in those cases the renderer
   * falls back to a generic swap note keyed off {@link hasSwap} instead.
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
   * Whether a record may match more than one of the partner's records (the
   * inviter's declared deduplicate setting).
   */
  deduplicate: boolean;
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
 * Upper bound on the number of transform parameters surfaced per step. A real
 * function takes a handful; the cap (with an overflow marker) keeps an
 * arbitrarily large partner-supplied `params` record -- the schema bounds
 * neither the entry count nor the value content -- from flooding the screen.
 */
const MAX_DISPLAYED_PARAMS = 16;

/**
 * Render a transform parameter value for display. Primitives become their plain
 * string form; anything structured is JSON-encoded (best effort). The result is
 * sanitized and length-bounded by the caller, so it need not be safe on its own.
 */
function describeParamValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value === null) return "null";
  if (value === undefined) return "";
  try {
    // A value past the checks above is an object/array from a JSON-parsed
    // params record, so JSON.stringify yields a string (and throws only on the
    // unreachable circular/bigint cases, caught below).
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * Reduce one transform step to its display summary: the sanitized function name
 * and a bounded, sanitized `key: value` view of its parameters. Each entry is
 * sanitized as a whole (so a parameter key or value cannot carry control, bidi,
 * or homoglyph characters, and is truncated), and the entry count is capped.
 */
function summarizeTransform(step: TransformStep): InvitationTransformSummary {
  const entries = Object.entries(step.params ?? {});
  const params = entries
    .slice(0, MAX_DISPLAYED_PARAMS)
    .map((entry) =>
      sanitizeForDisplay(`${entry[0]}: ${describeParamValue(entry[1])}`),
    );
  if (entries.length > MAX_DISPLAYED_PARAMS)
    params.push(`... ${entries.length - MAX_DISPLAYED_PARAMS} more`);
  return { function: sanitizeForDisplay(step.function), params };
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
      transforms: (element.transform ?? []).map(summarizeTransform),
      fuzzyComparison:
        element.generateFuzzyComparisons !== undefined
          ? FUZZY_COMPARISON_LABELS[element.generateFuzzyComparisons]
          : undefined,
    }),
  );

  const hasSwap = key.swap !== undefined;
  let swap: [string, string] | undefined;
  if (key.swap !== undefined) {
    // A swap names two elements by their effective identifier (element `name`
    // if present, otherwise `field`); resolve each to its field label so the
    // note reads in the same terms as the element list. The schema enforces
    // that `name ?? field` is unique within a key, so this Map never drops an
    // element. The note names the two fields only when both references resolve
    // to distinct labels; otherwise the renderer shows a generic note (see the
    // `swap` field doc); `swap` is left undefined, never holding a raw or
    // sanitized identifier, since either would mislead rather than inform.
    const labelByIdentifier = new Map(
      key.elements.map((element) => [
        element.name ?? element.field,
        labelForField(element.field),
      ]),
    );
    const first = labelByIdentifier.get(key.swap[0]);
    const second = labelByIdentifier.get(key.swap[1]);
    if (first !== undefined && second !== undefined && first !== second)
      swap = [first, second];
  }

  const hasNonDefaultRule =
    hasSwap ||
    elements.some(
      (element) =>
        element.transforms.length > 0 || element.fuzzyComparison !== undefined,
    );

  return {
    name: sanitizeForDisplay(key.name),
    elements,
    hasSwap,
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

  // Collapse fields that are identical for display -- same semantic-type label
  // and same constraint phrases -- so several fields of one type (the schema
  // permits, e.g., a maiden and a current name both typed `firstName`) do not
  // list the same line twice with nothing to tell them apart (the field `name`
  // that would distinguish them is partner-controlled and deliberately not
  // shown). Fields whose constraints differ stay distinct, since the constraint
  // text then distinguishes them. The dedupe key is the JSON encoding of the
  // (label, constraints) pair, which is injective over that displayed content:
  // a plain join would not be, since a constraint phrase can itself contain the
  // separator (`characters limited to <chars>` carries partner-controlled
  // spaces). The key is built from the already-sanitized display strings, so two
  // fields whose `allowedCharacters` differ only in characters sanitizeForDisplay
  // folds together collapse -- correctly, since they render identically and
  // nothing the acceptor could distinguish is lost.
  const seenFields = new Set<string>();
  const linkageFields: Array<InvitationFieldSummary> = [];
  for (const field of terms.linkageFields) {
    const summary = {
      label: FIELD_TYPE_LABELS[field.type],
      constraints: describeConstraints(field),
    };
    const dedupeKey = JSON.stringify([summary.label, summary.constraints]);
    if (seenFields.has(dedupeKey)) continue;
    seenFields.add(dedupeKey);
    linkageFields.push(summary);
  }

  // The consent screen reflects the inviter's terms as proposed, not only what
  // today's exchange executes: deduplicate and the per-element
  // generateFuzzyComparisons are surfaced even though the run does not yet apply
  // them (matching is currently hard-wired to one-to-one, and fuzzy expansion is
  // unimplemented). Wiring both into the run is tracked on the product board; the
  // displayed terms are what the acceptor agrees to.
  const summary: InvitationSummary = {
    invitingParty: sanitizeForDisplay(terms.identity),
    algorithm: terms.algorithm,
    inviterReceivesOutput: terms.output.expectsOutput,
    inviterSharesResult: terms.output.shareWithPartner,
    deduplicate: terms.deduplicate,
    linkageKeys: terms.linkageKeys.map((key) => summarizeKey(key, fieldByName)),
    linkageFields,
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
