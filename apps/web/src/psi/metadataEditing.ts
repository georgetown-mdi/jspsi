import { disclosedColumnNames } from "@psilink/core";

import type { ColumnMetadata, Metadata, SemanticType } from "@psilink/core";

/**
 * The pure model behind the web metadata grid: the collapsed disclosure control,
 * the semantic-type and disclosure label tables, and the metadata-editing helpers
 * both hosts (the acceptor "Prepare your data" screen and the inviter
 * Advanced-options editor) drive their grids from. No React, no I/O -- the single
 * tested boundary, so the disclosure <-> {role, isPayload} mapping is checked here
 * rather than through the UI.
 *
 * Disclosure is expressed as ONE consequence-labeled choice ({@link DisclosureChoice})
 * rather than a raw `role` + `isPayload` pair, so an operator cannot land in the
 * off-diagonal states `inferMetadata` can produce (e.g. `role: identifier` with
 * `isPayload: true`, which {@link isDisclosedToPartner} still transmits). The
 * choice sets BOTH fields deterministically and `isPayload` is a pure function of
 * the chosen role -- only the `payload` choice sends -- so the grid's running
 * disclosure summary ({@link disclosedColumnNames}, the same predicate
 * `preparePayload` uses) cannot drift from what actually leaves the machine.
 */

/**
 * The collapsed, consequence-labeled disclosure of a single column, the one
 * control the grid exposes instead of the underlying `{ role, isPayload }`:
 *
 * - `match` -- used to build linkage keys, NOT sent (`role: linkage`, not payload).
 * - `identifier` -- indexes this party's own matched rows, NOT sent
 *   (`role: identifier`, not payload).
 * - `payload` -- transmitted to the partner for matched rows (`role: payload`,
 *   payload).
 * - `ignored` -- used for nothing: never matched, never indexed, never sent.
 */
export type DisclosureChoice = "match" | "identifier" | "payload" | "ignored";

/** Human label for each semantic type, so the grid never shows raw snake_case.
 * Covers every {@link SemanticType}; `other` reads as the not-for-matching case
 * it is (a column with no linkage field of its type cannot be matched on). */
export const SEMANTIC_TYPE_LABELS: Record<SemanticType, string> = {
  ssn: "Social Security number",
  ssn4: "Last 4 of Social Security number",
  first_name: "First name",
  last_name: "Last name",
  date_of_birth: "Date of birth",
  identifier: "Row identifier",
  phone_number: "Phone number",
  email_address: "Email address",
  other: "Other (not used for matching)",
};

/** Consequence-labeled text for each disclosure choice. The wording states the
 * consequence ("not sent" / "Sent to your partner") so disclosure is conveyed by
 * the label, not by color or by an opaque role name. */
export const DISCLOSURE_LABELS: Record<DisclosureChoice, string> = {
  match: "Used to match - not sent",
  identifier: "Row identifier - not sent",
  payload: "Sent to your partner",
  ignored: "Ignored",
};

/**
 * The disclosure choices offered for a column of `type`, gated so a nonsensical
 * pairing is unreachable rather than merely discouraged: an `identifier`-typed
 * column is offered `identifier` (not `match`); an `other` column, which cannot
 * be matched, is offered neither `match` nor `identifier`; every linkage-typed
 * column is offered `match`. Every type can always be `payload` (sent) or
 * `ignored`.
 */
export function disclosureChoicesForType(
  type: SemanticType,
): Array<DisclosureChoice> {
  if (type === "identifier") return ["identifier", "payload", "ignored"];
  if (type === "other") return ["payload", "ignored"];
  return ["match", "payload", "ignored"];
}

/** The collapsed disclosure choice a column currently sits at, read from its
 * `role`. `isPayload` is not consulted: after {@link normalizeForEditor} it is a
 * pure function of the role, and reading the role alone is what makes the control
 * a faithful inverse of {@link applyDisclosure}. */
export function disclosureOf(column: ColumnMetadata): DisclosureChoice {
  switch (column.role) {
    case "identifier":
      return "identifier";
    case "payload":
      return "payload";
    case "ignored":
      return "ignored";
    case "linkage":
      return "match";
  }
}

/** Apply a disclosure choice to a column, setting BOTH `role` and `isPayload`
 * deterministically. Only `payload` sends, so `isPayload` is `true` for exactly
 * that choice -- the property that keeps {@link disclosedColumnNames} (and so the
 * disclosure summary) equal to what `preparePayload` transmits. */
export function applyDisclosure(
  column: ColumnMetadata,
  choice: DisclosureChoice,
): ColumnMetadata {
  switch (choice) {
    case "match":
      return { ...column, role: "linkage", isPayload: false };
    case "identifier":
      return { ...column, role: "identifier", isPayload: false };
    case "payload":
      return { ...column, role: "payload", isPayload: true };
    case "ignored":
      return { ...column, role: "ignored", isPayload: false };
  }
}

/**
 * Re-derive every column's `isPayload` from its `role` so the grid opens on the
 * diagonal the collapsed control can represent. `inferMetadata` marks an
 * `identifier`-typed column `isPayload: true` (and `preparePayload` would transmit
 * it), an off-diagonal state the four-way control has no cell for; normalizing on
 * entry collapses it to `identifier` + not-sent, so an inferred identifier column
 * is NOT silently disclosed and the displayed choice round-trips through
 * {@link applyDisclosure}. The disclosure-relevant effect is intentional and
 * minimizing: a column the operator did not choose to send is not sent.
 */
export function normalizeForEditor(metadata: Metadata): Metadata {
  return metadata.map((column) =>
    applyDisclosure(column, disclosureOf(column)),
  );
}

/**
 * Set one column's disclosure choice, enforcing the single-identifier rule live:
 * choosing `identifier` for one column demotes any other `identifier` column to
 * `ignored` (not sent, not indexed) so at most one identifier survives. Demoting
 * to `ignored` rather than `payload` keeps the displaced column from being
 * silently transmitted; the caller announces the demotion. Returns a new metadata
 * array (the input is not mutated).
 */
export function setColumnDisclosure(
  metadata: Metadata,
  columnName: string,
  choice: DisclosureChoice,
): { metadata: Metadata; demotedIdentifier?: string } {
  let demotedIdentifier: string | undefined;
  const next = metadata.map((column) => {
    if (column.name === columnName) return applyDisclosure(column, choice);
    if (choice === "identifier" && column.role === "identifier") {
      demotedIdentifier = column.name;
      return applyDisclosure(column, "ignored");
    }
    return column;
  });
  return { metadata: next, demotedIdentifier };
}

/**
 * Set one column's semantic type, keeping its disclosure intent across the change.
 * The current choice is kept when it remains valid for the new type; otherwise the
 * column stays sent if it was sent (`payload`) and the new type allows it, and
 * otherwise falls back to a not-sent choice -- so a type change never turns a
 * not-sent column into a sent one. Returns a new metadata array.
 */
export function setColumnType(
  metadata: Metadata,
  columnName: string,
  type: SemanticType,
): Metadata {
  return metadata.map((column) => {
    if (column.name !== columnName) return column;
    const allowed = disclosureChoicesForType(type);
    const current = disclosureOf(column);
    let next: DisclosureChoice;
    if (allowed.includes(current)) {
      next = current;
    } else if (current === "payload" && allowed.includes("payload")) {
      next = "payload";
    } else {
      // The current choice does not fit the new type and the column was not
      // already sent: prefer `match` for a linkage type, else `ignored` -- never
      // `payload`, so a type change cannot start disclosing a column.
      next = allowed.includes("match") ? "match" : "ignored";
    }
    return applyDisclosure({ ...column, type }, next);
  });
}

/** Whether a metadata set declares more than one `identifier` column, which the
 * single-identifier rule forbids. Used by the grid to surface a live error;
 * {@link setColumnDisclosure} prevents reaching this state through the control,
 * so it only bites on externally-supplied metadata. */
export function hasMultipleIdentifiers(metadata: Metadata): boolean {
  return metadata.filter((column) => column.role === "identifier").length > 1;
}

export { disclosedColumnNames };
