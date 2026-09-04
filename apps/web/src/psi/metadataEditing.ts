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
 * both hosts (the acceptor's Confirm-your-columns step and the inviter's
 * Matching & sharing section) drive their grids from. No React, no I/O -- the single
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

/** Human label for each {@link SemanticType}, so the grid never shows raw
 * snake_case; `other` is labeled as not used for matching, since no linkage
 * field of that type exists to match on. */
export const SEMANTIC_TYPE_LABELS: Record<SemanticType, string> = {
  ssn: "Social Security number",
  ssn4: "Last 4 of Social Security number",
  first_name: "First name",
  last_name: "Last name",
  date_of_birth: "Date of birth",
  identifier: "Unique record identifier",
  phone_number: "Phone number",
  email_address: "Email address",
  zip_code: "ZIP code",
  other: "Other (not used for matching)",
};

/** Consequence-labeled text for each disclosure choice. The wording states the
 * consequence ("not sent" / "Sent to your partner") so disclosure is conveyed by
 * the label, not by color or by an opaque role name. */
export const DISCLOSURE_LABELS: Record<DisclosureChoice, string> = {
  match: "Used to match - not sent",
  identifier: "Unique record identifier - not sent",
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
 * Re-derive every column's `isPayload` from its `role`, collapsing the
 * off-diagonal state `inferMetadata` can produce (`identifier`-typed with
 * `isPayload: true`) to identifier + not-sent, so an inferred identifier
 * column is never silently disclosed.
 */
export function normalizeForEditor(metadata: Metadata): Metadata {
  return metadata.map((column) =>
    applyDisclosure(column, disclosureOf(column)),
  );
}

/**
 * The disclosure choice a column lands on when retyped to `type`. A choice
 * still valid for `type` is kept (a sent `payload` column stays sent), except
 * `ignored` retyped to a matchable type (a linkage type or `identifier`),
 * which promotes to that type's natural choice rather than staying inert.
 * Otherwise falls back to the natural choice for `type` (`match`,
 * `identifier`, or `ignored` for `other`) -- never `payload`, so a type
 * change alone never starts disclosing a column.
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
 * identifier, so an inferred two-identifier seed the operator has not touched
 * is left alone. Demoting to `ignored` (not `payload`) keeps a displaced
 * column from being silently transmitted; the demoted names are returned so
 * the caller can announce the displacement.
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
 * Set one column's semantic type, keeping the disclosure choice across the
 * change ({@link chooseDisclosureForType}), then enforcing the
 * single-identifier rule as in {@link setColumnDisclosure} -- a retype to the
 * identifier type can newly land a column on that role. Returns the new
 * metadata and any demoted identifier names so the caller can announce the
 * displacement.
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

/**
 * Bind a column to a missing linkage field for the "Map a column to each
 * missing field" quick-fix: set its semantic `type` and force the `match`
 * disclosure (`role: linkage`, not sent). Not {@link setColumnType}: that
 * helper preserves an existing disclosure across a type change, which would
 * leave a `payload`-inferred column stuck at `payload` and the field
 * unsatisfiable. No single-identifier enforcement is needed -- `match` is
 * never the identifier role.
 */
export function setColumnTypeForMatching(
  metadata: Metadata,
  columnName: string,
  type: SemanticType,
): Metadata {
  return metadata.map((column) =>
    column.name === columnName
      ? applyDisclosure({ ...column, type }, "match")
      : column,
  );
}

/** Whether a metadata set declares more than one `identifier` column, which the
 * single-identifier rule forbids. The mutators ({@link setColumnDisclosure},
 * {@link setColumnType}) never CREATE this state -- both demote the others when a
 * column becomes the identifier -- but `inferMetadata` can SEED it (an `id` and an
 * `identifier` column both infer to `role: identifier`), so the grid reports it
 * as a live error and the host gates launch on it until the operator picks one. */
export function hasMultipleIdentifiers(metadata: Metadata): boolean {
  return metadata.filter((column) => column.role === "identifier").length > 1;
}

/**
 * The columns the quick (name-only) invite path sends to the partner for a
 * file with these column names. Composes the same two primitives the
 * inviter's quick-path exchange runs on -- {@link inferMetadata} filtered by
 * {@link disclosedColumnNames} -- so this cannot drift from what the quick
 * path actually transmits.
 *
 * Does not apply {@link normalizeForEditor}: the quick path does not
 * normalize, so an inferred row-identifier column it still sends must show
 * as sent here.
 */
export function quickInviteDisclosedColumns(
  columns: Array<string>,
): Array<string> {
  return disclosedColumnNames(inferMetadata(columns));
}

/**
 * Author the `terms.payload.send` data dictionary from the columns `metadata`
 * discloses, or `undefined` when it discloses none (no empty payload block is
 * minted). The send list is exactly {@link disclosedColumnNames} over
 * `metadata` -- the same predicate {@link preparePayload} transmits on -- so
 * the declared dictionary matches what leaves the machine. Never authors
 * `receive`: an inviter does not know the partner's schema, so it declares
 * only its own send; the acceptor mirrors this send into its own receive.
 *
 * Shared by both invite paths (`buildAdvancedTerms` over edited metadata,
 * `generateInvitation` over inferred metadata) so neither can drift in what
 * it declares.
 */
export function payloadSendForMetadata(
  metadata: Metadata,
): Payload | undefined {
  const sent = disclosedColumnNames(metadata);
  if (sent.length === 0) return undefined;
  return { send: sent.map((name) => ({ name })) };
}

export { disclosedColumnNames };
