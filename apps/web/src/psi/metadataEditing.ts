import { disclosedColumnNames, inferMetadata } from "@psilink/core";

import type {
  ColumnMetadata,
  Metadata,
  Payload,
  SemanticType,
} from "@psilink/core";

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
 * The disclosure choice a column lands on when its semantic type changes to
 * `type`. The current choice is kept when it still fits the new type -- so a
 * deliberately-sent `payload` column stays sent and a type change never alters
 * disclosure on its own -- EXCEPT a column sitting at `ignored` that is retyped to
 * a matchable type (any linkage type or `identifier`), which is promoted to the
 * type's natural usable choice so the quick-fix remap cannot silently leave a
 * field unsatisfiable (`resolveFieldColumns` binds only `role: linkage`). Otherwise the
 * column falls back to that natural choice: `match` for a linkage type,
 * `identifier` for the identifier type, `ignored` for `other`. The fallback is
 * never `payload`, so a type change can never START disclosing a column.
 */
function chooseDisclosureForType(
  column: ColumnMetadata,
  type: SemanticType,
): DisclosureChoice {
  const allowed = disclosureChoicesForType(type);
  const current = disclosureOf(column);
  // The type's natural usable, not-sent resting state. `other` cannot be matched,
  // so its natural state is `ignored`.
  const natural: DisclosureChoice =
    type === "other"
      ? "ignored"
      : type === "identifier"
        ? "identifier"
        : "match";
  // Keep a still-valid current choice, but treat `ignored` as not-preserved when
  // retyping to a matchable type (so it promotes rather than no-ops). Order
  // matters: this keep-branch wins for `payload`, so a sent column stays sent.
  if (allowed.includes(current) && !(current === "ignored" && type !== "other"))
    return current;
  return natural;
}

/**
 * Demote every `identifier` column other than `keptColumn` to `ignored`, so at
 * most one identifier survives. A no-op unless `keptColumn` is (now) the
 * identifier -- so it fires exactly when an edit lands a column on the identifier
 * role, never auto-resolving an inferred two-identifier seed the operator has not
 * touched. Demoting to `ignored` (not `payload`) keeps a displaced column from
 * being silently transmitted; the demoted names are returned so the caller can
 * announce the displacement.
 */
function enforceSingleIdentifier(
  metadata: Metadata,
  keptColumn: string,
): { metadata: Metadata; demotedIdentifiers: Array<string> } {
  const kept = metadata.find((column) => column.name === keptColumn);
  if (kept?.role !== "identifier") return { metadata, demotedIdentifiers: [] };
  const demotedIdentifiers: Array<string> = [];
  const next = metadata.map((column) => {
    if (column.name === keptColumn || column.role !== "identifier")
      return column;
    demotedIdentifiers.push(column.name);
    return applyDisclosure(column, "ignored");
  });
  return { metadata: next, demotedIdentifiers };
}

/**
 * Set one column's disclosure choice, enforcing the single-identifier rule:
 * choosing `identifier` demotes every other `identifier` column to `ignored` (via
 * {@link enforceSingleIdentifier}) so at most one survives. Returns the new
 * metadata and the demoted names so the caller can announce the displacement; the
 * input is not mutated.
 */
export function setColumnDisclosure(
  metadata: Metadata,
  columnName: string,
  choice: DisclosureChoice,
): { metadata: Metadata; demotedIdentifiers: Array<string> } {
  const applied = metadata.map((column) =>
    column.name === columnName ? applyDisclosure(column, choice) : column,
  );
  return enforceSingleIdentifier(applied, columnName);
}

/**
 * Set one column's semantic type. The disclosure choice is carried across the
 * change by {@link chooseDisclosureForType} (a sent column stays sent, an
 * `ignored` column retyped to a matchable type is promoted so the remap cannot
 * no-op, and the fallback is never `payload`), then the single-identifier rule is
 * enforced exactly as in {@link setColumnDisclosure} -- because a retype to the
 * identifier type can newly land a column on that role. Returns the new metadata
 * and any demoted identifier names so the caller can announce the displacement.
 */
export function setColumnType(
  metadata: Metadata,
  columnName: string,
  type: SemanticType,
): { metadata: Metadata; demotedIdentifiers: Array<string> } {
  const applied = metadata.map((column) =>
    column.name === columnName
      ? applyDisclosure(
          { ...column, type },
          chooseDisclosureForType(column, type),
        )
      : column,
  );
  return enforceSingleIdentifier(applied, columnName);
}

/** Whether a metadata set declares more than one `identifier` column, which the
 * single-identifier rule forbids. The mutators ({@link setColumnDisclosure},
 * {@link setColumnType}) never CREATE this state -- both demote the others when a
 * column becomes the identifier -- but `inferMetadata` can SEED it (an `id` and an
 * `identifier` column both infer to `role: identifier`), so the grid surfaces it
 * as a live error and the host gates launch on it until the operator picks one. */
export function hasMultipleIdentifiers(metadata: Metadata): boolean {
  return metadata.filter((column) => column.role === "identifier").length > 1;
}

/**
 * The columns the quick (name-only) invite path will send to the partner for a
 * file with these column names. Composes the SAME two core primitives the
 * inviter's quick-path exchange runs on -- {@link inferMetadata} (the metadata
 * `prepareForExchange` falls back to when none is authored) filtered by
 * {@link disclosedColumnNames} (the `isDisclosedToPartner` predicate
 * `preparePayload` gathers on) -- so an awareness summary built from it cannot
 * drift from the bytes the quick path actually transmits.
 *
 * This deliberately does NOT apply {@link normalizeForEditor}: the quick path does
 * not normalize, so an inferred row-identifier column it still sends must show as
 * sent here. Routing the quick path's awareness through the editor's normalized
 * view would under-state what leaves the machine -- the exact drift this seam
 * exists to prevent.
 */
export function quickInviteDisclosedColumns(
  columns: Array<string>,
): Array<string> {
  return disclosedColumnNames(inferMetadata(columns));
}

/**
 * Author the `terms.payload.send` data dictionary from the columns `metadata`
 * discloses, or `undefined` when it discloses none (so no empty payload block is
 * minted). The send list is exactly {@link disclosedColumnNames} over `metadata`
 * -- the same `isDisclosedToPartner` predicate {@link preparePayload} gathers the
 * transmitted columns on -- so the declared dictionary equals what actually leaves
 * the machine and can never over-declare (core's `assertPayloadSendDisclosed`
 * accepts it by construction). It NEVER authors `receive`: an inviter does not know
 * the partner's schema, so it declares only its own send and reconciles lazily (the
 * acceptor mirrors this send into its own receive and validates that exactly).
 *
 * Shared by both invite paths so they cannot drift in how they declare what they
 * send: the Advanced editor (`buildAdvancedTerms`) over its edited metadata and the
 * quick path (`generateInvitation`) over the inferred metadata its own exchange
 * falls back to. This declares what already transmits; it does not change which
 * columns flow.
 */
export function payloadSendForMetadata(
  metadata: Metadata,
): Payload | undefined {
  const sent = disclosedColumnNames(metadata);
  if (sent.length === 0) return undefined;
  return { send: sent.map((name) => ({ name })) };
}

export { disclosedColumnNames };
