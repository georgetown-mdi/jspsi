import { z } from "zod";

import { UsageError } from "../errors.js";
import { SEMANTIC_TYPES } from "../types";
import { COUNT_ONLY_SHAPE_REFUSALS } from "../linkageTermsPolicy.js";
import { MAX_NAME_LENGTH } from "./linkageTermsSchema.js";
import { safeParseCamelized } from "./safeParseCamelized.js";

import type { Algorithm, SemanticType } from "../types";

// --- Metadata ----------------------------------------------------------------
/**
 * The role a declared input column plays in an exchange:
 *
 * - `linkage` -- participates in PSI matching via its semantic type.
 * - `identifier` -- indexes this party's matched records in the output.
 * - `payload` -- transmitted to the partner for matched members (the
 *   default for a column not used for linkage or identification).
 * - `ignored` -- never linked, never an identifier, never transmitted as
 *   payload, regardless of `isPayload`. Opt-in only: {@link inferMetadata}
 *   never assigns it.
 *
 * Two independent axes, each checked explicitly rather than inferred from
 * `type` alone:
 * - MATCHING requires `role: linkage` (enforced at
 *   {@link resolveFieldColumns}).
 * - TRANSMISSION requires `isPayload && role !== "ignored"`
 *   ({@link isDisclosedToPartner}, the source `preparePayload` uses).
 *
 * A column can do both: `role: linkage` with `isPayload: true` matches and
 * is transmitted.
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
  // Bounded `.min(1).max(MAX_NAME_LENGTH)` to match the linkage-terms
  // schema's `name` fields, rejecting an empty name at config parse rather
  // than as a later downstream failure. This is the operator's own LOCAL
  // config, not partner-supplied input, so it is UX hardening, not a
  // threat-model bound. Like the uniqueness refine below, the messages are
  // static and do not echo the operator-authored name.
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  type: z.enum(SEMANTIC_TYPES),
  role: ColumnRoleSchema,
  isPayload: z.boolean(),
  description: z.string().optional(),
});

export type Metadata = Array<ColumnMetadata>;

/**
 * Whether a column's standardized values are transmitted to the exchange
 * partner. The single source of truth for "what is disclosed":
 * {@link preparePayload} gathers exactly the columns this returns true
 * for -- a disclosure summary must derive from this predicate, not
 * `role === "payload"` (a `role: identifier` column with `isPayload: true`
 * is still transmitted; `ignored` never is regardless of `isPayload`).
 */
export function isDisclosedToPartner(column: ColumnMetadata): boolean {
  return column.isPayload && column.role !== "ignored";
}

/**
 * The names of the columns disclosed to the partner, in metadata order -- exactly
 * the set {@link preparePayload} transmits. The boundary a disclosure summary or
 * launch confirmation reads so it cannot drift from what is actually sent.
 */
export function disclosedColumnNames(metadata: Metadata): Array<string> {
  return metadata.filter(isDisclosedToPartner).map((column) => column.name);
}

/**
 * Whether this party's input metadata would transmit a column under a
 * count-only (`psi-c`) algorithm -- the fifth count-only shape rule
 * (docs/spec/PROTOCOL.md, PSI-C), the one no linkage-terms document
 * has, so it lives here beside {@link isDisclosedToPartner}.
 *
 * False for every `psi` exchange and for an absent metadata block. The
 * terms-held rules are `countOnlyShapeViolation` in
 * `config/linkageTermsSchema.ts`.
 */
export function countOnlyTransmitsColumn(
  algorithm: Algorithm,
  metadata: Metadata | undefined,
): boolean {
  if (algorithm !== "psi-c" || metadata === undefined) return false;
  return metadata.some(isDisclosedToPartner);
}

/**
 * Refuse a count-only exchange whose input metadata would transmit a
 * column, at the boundaries that hold this party's own metadata beside the
 * agreed algorithm: where an invitation is minted, and where one is
 * accepted.
 *
 * Fail-closed like its terms-held siblings
 * ({@link assertCountOnlyTermsShape}): marked columns are never quietly
 * dropped to fit the count-only shape. A no-op on `psi` and on an
 * unresolved metadata block. Plain {@link UsageError}; the message names
 * no column.
 */
export function assertCountOnlyTransmitsNoColumn(
  algorithm: Algorithm,
  metadata: Metadata | undefined,
): void {
  if (!countOnlyTransmitsColumn(algorithm, metadata)) return;
  throw new UsageError(COUNT_ONLY_SHAPE_REFUSALS.transmittedColumns);
}

/**
 * The 1-based metadata positions of the DISCLOSED columns whose name is
 * longer than {@link MAX_NAME_LENGTH}, in metadata order -- empty when
 * every disclosed name fits. The single predicate behind every gate on
 * that ceiling, shared by a front end that refuses before transmit and the
 * {@link assertDisclosedNamesCarriable} safety check at prepare time.
 *
 * Scoped to {@link isDisclosedToPartner}: an oversized name on a column
 * that is never sent costs nothing and is often a vendor export the
 * operator cannot rewrite.
 *
 * Counted in UTF-16 code units (`name.length`), matching the `.max` bound
 * on every other transmitted-name schema; a code-point count would pass a
 * name of astral characters those bounds refuse.
 *
 * Positions, not names -- an offending name is by construction too long
 * to include in a message. The position is the entry's place in the
 * METADATA; inferred metadata preserves header order, while a
 * hand-authored block is matched by name and may list entries in any
 * order, so there the position locates the entry in the block itself.
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

// Column names must be unique. Every consumer treats metadata as keyed by
// name (`metadata.find((c) => c.name === ...)`), so a duplicate name makes
// "the metadata for column X" position-dependent -- a `role: ignored` and
// a `role: payload` entry for the same name could resolve differently,
// silently defeating the ignored exclusion. Rejected at the schema; the
// message is static and does not echo the user-controlled name (it can
// hold control/ANSI/bidi bytes).
export const MetadataSchema = z.array(ColumnMetadataSchema).refine(
  (cols) => {
    const names = cols.map((c) => c.name);
    return names.length === new Set(names).size;
  },
  { message: "metadata column names must be unique" },
);

/**
 * Non-throwing parse of a raw value as {@link Metadata}. Snake_case keys
 * (e.g. `is_payload`) are converted to camelCase before validation, so a
 * `metadata` block read straight from YAML/JSON can be passed directly --
 * mirroring {@link safeParseLinkageTerms} and
 * {@link safeParseExchangeSpec}. Honors the "safe" contract for the
 * camelize bounds too: a depth- or node-count-tripping input yields
 * `{ success: false }` rather than throwing (see {@link safeParseCamelized}).
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

// Each multi-word type lists both its snake_case spelling and its
// no-separator spelling (e.g. `first_name` and `firstname`) so a
// single-token column export still infers. The no-separator form must be
// explicit: the map builder keys on `type.toLowerCase()`, which equals the
// snake_case type itself, so it does not also yield the no-separator key.
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
 * Assigns default roles to columns based on their names, using aliases
 * where appropriate. Columns ending in `_id` are also treated as
 * identifiers.
 *
 * A single identifier column gets `role: identifier`, used to index
 * observations. With more than one, only a column literally named `id` or
 * `identifier` gets that role; otherwise no identifier role is assigned.
 *
 * @throws {UsageError} when any column name is empty. Downstream name
 *   fields (metadata, payload, wire, exchange-record schemas) all floor at
 *   `.min(1)`, so an inferred empty name would otherwise appear only
 *   later, disclosed and sent before a non-fatal guard silently drops the
 *   audit record at record build. Rejected here instead, at the intake
 *   chokepoint where raw CSV columns become metadata. A {@link UsageError}
 *   so the CLI classifies it as a configuration error (exit 64); the
 *   message names the offending positions only, never the (empty) names.
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

  // id/identifier columns already have role: "identifier" via
  // ALIAS_TYPE_META_MAP
  return result;
}
