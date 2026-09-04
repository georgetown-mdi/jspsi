import { z } from "zod";

import { UsageError } from "../errors.js";
import { SEMANTIC_TYPES } from "../types";
import { COUNT_ONLY_SHAPE_REFUSALS, MAX_NAME_LENGTH } from "./linkageTerms.js";
import { safeParseCamelized } from "./safeParseCamelized.js";

import type { Algorithm, SemanticType } from "../types";

// --- Metadata ----------------------------------------------------------------
/**
 * The role a declared input column plays in an exchange:
 *
 * - `linkage` -- participates in the PSI protocol (matching) via its semantic type.
 * - `identifier` -- indexes this party's matched records in the output.
 * - `payload` -- transmitted to the partner for matched members (the default
 *   for any column not used for linkage or identification).
 * - `ignored` -- present in the input but used for nothing: never linked, never
 *   an identifier, and never transmitted as payload (regardless of `isPayload`).
 *   Opt-in only -- {@link inferMetadata} never assigns it.
 *
 * Two independent axes derive from `role`, each consulted explicitly so neither
 * leaks in via a column's semantic `type` alone:
 *
 * - MATCHING participation requires `role: linkage`. The linkage/key-building
 *   path binds a field to a column only when that column is roled `linkage` and
 *   its `type` matches, so a column roled `identifier`, `payload`, or `ignored`
 *   is never hashed into a PSI key merely because its type matches a linkage
 *   field. Enforced at the one chokepoint {@link resolveFieldColumns} (both
 *   binding rules) and mirrored by `getDefaultLinkageTerms`,
 *   `authoredLinkageFields`, and the date-format inference in `prepareForExchange`.
 * - TRANSMISSION requires `isPayload && role !== "ignored"`
 *   ({@link isDisclosedToPartner}, the single source of truth `preparePayload`
 *   gathers on): an `ignored` column is never sent regardless of `isPayload`.
 *
 * A column can do both -- `role: linkage` with `isPayload: true` both matches and
 * is transmitted -- but each axis is opted into explicitly; neither implies the
 * other.
 */
const ColumnRoleSchema = z.enum([
  "linkage",
  "identifier",
  "payload",
  "ignored",
]);
type ColumnRole = z.infer<typeof ColumnRoleSchema>;

/**
 * Information about a specific input column used to determine its possible
 * roles in linkage.
 */
export interface ColumnMetadata {
  name: string;
  type: SemanticType;
  role: ColumnRole;
  isPayload: boolean;
  description?: string;
}

const ColumnMetadataSchema: z.ZodType<ColumnMetadata> = z.object({
  // Bounded `.min(1).max(MAX_NAME_LENGTH)` to match the `name` fields of the
  // linkage-terms schema. Without the floor an empty name parses cleanly here
  // and surfaces only later as a downstream failure; this rejects it at config
  // parse with a clear, early error instead. This metadata is the operator's
  // own LOCAL config, not partner-supplied input, so it is friendliness/UX
  // hardening, not a partner-threat-model bound. Like the uniqueness refine
  // below, the `.min`/`.max` messages are static and do not echo the
  // operator-authored name.
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  type: z.enum(SEMANTIC_TYPES),
  role: ColumnRoleSchema,
  isPayload: z.boolean(),
  description: z.string().optional(),
});

export type Metadata = Array<ColumnMetadata>;

/**
 * Whether a column's standardized values are transmitted to the exchange partner.
 * This is the single source of truth for "what is disclosed": {@link preparePayload}
 * gathers exactly the columns this returns true for, so any operator-facing
 * disclosure summary MUST derive from this predicate rather than re-deriving its
 * own (e.g. testing `role === "payload"`), or it would mis-state what leaves the
 * machine -- a `role: identifier` column left with `isPayload: true` is still
 * transmitted, and an `ignored` column never is regardless of `isPayload`.
 */
export function isDisclosedToPartner(column: ColumnMetadata): boolean {
  return column.isPayload && column.role !== "ignored";
}

/**
 * The names of the columns disclosed to the partner, in metadata order -- exactly
 * the set {@link preparePayload} transmits. The seam a disclosure summary or
 * launch confirmation reads so it cannot drift from what is actually sent.
 */
export function disclosedColumnNames(metadata: Metadata): Array<string> {
  return metadata.filter(isDisclosedToPartner).map((column) => column.name);
}

/**
 * Whether this party's input metadata would transmit a column under a count-only
 * (`psi-c`) algorithm -- the fifth count-only shape rule
 * (docs/spec/PROTOCOL.md, PSI-C), the one no linkage-terms document carries, so
 * it lives here beside {@link isDisclosedToPartner}, the predicate it asks.
 *
 * False for every `psi` exchange and for an absent metadata block, which resolves
 * from the exchange's input columns and is not known at the boundary that asks.
 * The terms-carried rules are `countOnlyShapeViolation` in `config/linkageTerms.ts`.
 */
export function countOnlyTransmitsColumn(
  algorithm: Algorithm,
  metadata: Metadata | undefined,
): boolean {
  if (algorithm !== "psi-c" || metadata === undefined) return false;
  return metadata.some(isDisclosedToPartner);
}

/**
 * Refuse a count-only exchange whose input metadata would transmit a column, at
 * the boundaries that hold this party's own metadata beside the agreed
 * algorithm: where an invitation is minted over it, and where one is accepted.
 *
 * Fail-closed like its terms-carried siblings ({@link assertCountOnlyTermsShape}):
 * the marked columns are never quietly dropped to bring the run into the
 * count-only shape, since the payload is exactly what the operator is deciding
 * about when they mark a column. Stating it at the choice is also where the
 * specification puts it, rather than as a surprise once the run aborts.
 *
 * A no-op on `psi` and on an unresolved metadata block. Plain {@link UsageError},
 * for the reason `assertCountOnlyTermsShape` carries; the message names no
 * column.
 */
export function assertCountOnlyTransmitsNoColumn(
  algorithm: Algorithm,
  metadata: Metadata | undefined,
): void {
  if (!countOnlyTransmitsColumn(algorithm, metadata)) return;
  throw new UsageError(COUNT_ONLY_SHAPE_REFUSALS.transmittedColumns);
}

/**
 * The 1-based metadata positions of the DISCLOSED columns whose name is longer
 * than {@link MAX_NAME_LENGTH}, in metadata order -- empty when every disclosed
 * name fits. The single predicate behind every gate on that ceiling, so a front
 * end that refuses before it transmits and the {@link assertDisclosedNamesCarriable}
 * backstop that refuses at prepare time cannot disagree about which names are
 * carryable.
 *
 * Scoped to {@link isDisclosedToPartner} rather than to every column: an oversized
 * name on a column that is never sent costs nothing, is fully usable for matching
 * and ignoring, and belongs to a vendor export the operator often cannot rewrite.
 *
 * Counted in UTF-16 code units (`name.length`), which is the unit both ceilings on
 * a carried name count: the payload frame's per-element `columns` predicate and the
 * `name` bounds of the exchange record and the linkage terms are all Zod
 * `.max(MAX_NAME_LENGTH)` over a string. A code-POINT count would pass a name of
 * astral characters that those bounds refuse.
 *
 * Positions rather than names: an offending name is by construction longer than
 * any message wants to carry. The position is the entry's 1-based place in the
 * METADATA, not in any file header. Metadata inferred from a header preserves the
 * header's order, so the two agree on that path; a hand-authored metadata block
 * is matched to columns by name and may list entries in any order, so there the
 * position locates the entry in the block itself.
 */
export function overlongDisclosedColumnPositions(
  metadata: Metadata,
): Array<number> {
  return metadata
    .map((column, index) =>
      isDisclosedToPartner(column) && column.name.length > MAX_NAME_LENGTH
        ? index + 1
        : 0,
    )
    .filter((position) => position > 0);
}

// Column names must be unique. Every consumer treats metadata as keyed by name
// (`metadata.find((c) => c.name === ...)`), so a duplicate name makes "the
// metadata for column X" position-dependent -- e.g. a `role: ignored` entry and a
// `role: payload` entry for the same name would resolve differently depending on
// which `find` reaches first, silently defeating the ignored exclusion. Reject it
// at the schema, mirroring the linkage-field / linkage-key name-uniqueness refines.
// The message is static and does not echo the user-controlled name, matching the
// type-enum errors (a name can carry control/ANSI/bidi bytes; see the no-echo test).
export const MetadataSchema = z.array(ColumnMetadataSchema).refine(
  (cols) => {
    const names = cols.map((c) => c.name);
    return names.length === new Set(names).size;
  },
  { message: "metadata column names must be unique" },
);

/**
 * Non-throwing parse of a raw value as {@link Metadata}. Snake_case keys (the
 * on-disk form, e.g. `is_payload`) are converted to camelCase before validation,
 * so a `metadata` block read straight from a YAML/JSON config can be passed
 * directly -- mirroring {@link safeParseLinkageTerms} and
 * {@link safeParseExchangeSpec}. Returns a Zod `SafeParseReturnType`. Honors the
 * "safe" contract for the camelize bounds too -- a depth- or node-count-tripping
 * input yields a `{ success: false }` result rather than throwing (see
 * {@link safeParseCamelized}).
 */
export function safeParseMetadata(raw: unknown) {
  return safeParseCamelized(MetadataSchema, raw);
}

// --- Metadata Inference ------------------------------------------------------
interface TypeMeta {
  type: SemanticType;
  aliases: Array<string>;
  role: ColumnRole;
  isPayload: boolean;
}

type TypeMetaMapped = Omit<TypeMeta, "aliases">;

// Each multi-word type lists both its snake_case spelling and its no-separator
// spelling (e.g. `first_name` and `firstname`) so a single-token column export
// still infers. The no-separator form is explicit because the map builder keys
// on `type.toLowerCase()`, which now equals the snake_case type itself -- it no
// longer yields the no-separator key as a side effect, as it did when the type
// values were camelCase.
const DEFAULT_COLUMN_TYPES_AND_ALIASES: Array<TypeMeta> = [
  {
    type: "ssn",
    aliases: ["social_security_number", "social"],
    role: "linkage",
    isPayload: false,
  },
  { type: "ssn4", aliases: [], role: "linkage", isPayload: false },
  {
    type: "first_name",
    aliases: ["first_name", "firstname", "fname"],
    role: "linkage",
    isPayload: false,
  },
  {
    type: "last_name",
    aliases: ["last_name", "lastname", "lname"],
    role: "linkage",
    isPayload: false,
  },
  {
    type: "date_of_birth",
    aliases: ["date_of_birth", "dateofbirth", "dob"],
    role: "linkage",
    isPayload: false,
  },
  /**
   * Identifier columns are also inferred if a column ends in _id, which can't
   * be represented as a simple alias. See {@link inferMetadata}.
   */
  { type: "identifier", aliases: ["id"], role: "identifier", isPayload: true },
  {
    type: "phone_number",
    aliases: ["phone_number", "phonenumber", "phone"],
    role: "linkage",
    isPayload: false,
  },
  {
    type: "email_address",
    aliases: ["email_address", "emailaddress", "email"],
    role: "linkage",
    isPayload: false,
  },
  {
    type: "zip_code",
    aliases: ["zip_code", "zipcode", "zip", "zip5", "zip_5"],
    role: "linkage",
    isPayload: false,
  },
];

export const ALIAS_TYPE_META_MAP = DEFAULT_COLUMN_TYPES_AND_ALIASES.reduce(
  (acc, { type, aliases, role, isPayload }) => {
    const entries = [type.toLowerCase(), ...aliases].map((alias) => [
      alias,
      { type, role, isPayload },
    ]);
    return {
      ...acc,
      ...Object.fromEntries(entries),
    };
  },
  {} as Record<string, TypeMetaMapped>,
);

/**
 * Assigns default roles to columns based on their names, using aliases where
 * appropriate. Columns that end in _id are also treated as identifiers.
 *
 * If there is only one identifier column, it will be given the role of
 * `identifier`, which implies that it will be used to index observations. If
 * there is more than one identifier column, the `identifier` role will be given
 * to the column `id` or `identifier` if it exists. If not, no identifier role
 * will be assigned.
 *
 * @throws {UsageError} when any column name is empty (zero-length). Every name
 *   field downstream -- the metadata, payload, wire, and exchange-record schemas
 *   -- floors at `.min(1)`, so an inferred empty name would otherwise surface only
 *   later: disclosed and sent, then caught at record build by the non-fatal guard
 *   that silently drops the audit record while the exchange still completes. This
 *   is the intake chokepoint where raw CSV columns become metadata, so an unnamed
 *   header (a trailing comma, a blank cell, or a leading delimiter in the header
 *   row) is rejected here as a clear local error instead, mirroring
 *   {@link ColumnMetadataSchema}'s `name` floor for authored metadata. A
 *   {@link UsageError} so the CLI classifies it as a configuration error (exit
 *   64), not a transport failure; the message names the offending column
 *   positions only and never echoes input (the names are empty).
 */
export function inferMetadata(columnNames: Array<string>): Metadata {
  const emptyPositions = columnNames
    .map((name, index) => (name.length === 0 ? index + 1 : 0))
    .filter((position) => position > 0);
  if (emptyPositions.length > 0) {
    const plural = emptyPositions.length > 1;
    throw new UsageError(
      `input column${plural ? "s" : ""} ${emptyPositions.join(", ")} ` +
        `${plural ? "have" : "has"} an empty name. A column used for linkage, ` +
        `identification, or payload must be named; a trailing comma, a blank ` +
        `cell, or a leading delimiter in the CSV header row produces an unnamed ` +
        `column. Name the column${plural ? "s" : ""}, or remove the empty ` +
        `header field${plural ? "s" : ""}.`,
    );
  }

  const result: Metadata = columnNames.map((name) => {
    const lookupName = name.toLowerCase();
    if (!(lookupName in ALIAS_TYPE_META_MAP)) {
      if (lookupName.endsWith("_id"))
        return { name, type: "identifier", role: "payload", isPayload: true };
      return { name, type: "other", role: "payload", isPayload: true };
    }
    const { type, role, isPayload } = ALIAS_TYPE_META_MAP[lookupName];
    return { name, type, role, isPayload };
  });

  const numIdentifiers = result.filter(
    (column) => column.type === "identifier",
  ).length;

  if (numIdentifiers === 1) {
    return result.map((column) =>
      column.type === "identifier" ? { ...column, role: "identifier" } : column,
    );
  }

  // id/identifier columns already carry role: "identifier" via
  // ALIAS_TYPE_META_MAP
  return result;
}
