import { z } from "zod";

import { SEMANTIC_TYPES } from "../types";
import { MAX_NAME_LENGTH } from "./linkageTerms.js";
import { safeParseCamelized } from "./safeParseCamelized.js";

import type { SemanticType } from "../types";

// ─── Metadata ────────────────────────────────────────────────────────────────
/**
 * The role a declared input column plays in an exchange:
 *
 * - `linkage` -- participates in the PSI protocol via its semantic type.
 * - `identifier` -- indexes this party's matched records in the output.
 * - `payload` -- transmitted to the partner for matched members (the default
 *   for any column not used for linkage or identification).
 * - `ignored` -- present in the input but used for nothing: never linked, never
 *   an identifier, and never transmitted as payload (regardless of `isPayload`).
 *   Opt-in only -- {@link inferMetadata} never assigns it.
 *
 * Nothing in the linkage/key-building path consults `role` (it branches on the
 * column's semantic `type`), so an `ignored` column is not coerced out of
 * linkage by a role default -- it would otherwise leak in via its `type`. Each
 * type- or payload-driven consumer therefore excludes `ignored` explicitly:
 * `preparePayload`, `resolveFieldColumns` (both binding rules), `getDefaultLinkageTerms`,
 * and the date-format inference in `prepareForExchange`.
 */
export const ColumnRoleSchema = z.enum([
  "linkage",
  "identifier",
  "payload",
  "ignored",
]);
export type ColumnRole = z.infer<typeof ColumnRoleSchema>;

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

// ─── Metadata Inference ──────────────────────────────────────────────────────
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
 */
export function inferMetadata(columnNames: Array<string>): Metadata {
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

  const numIdentifiers = result.reduce(
    (acc, x) => acc + Number(x.type === "identifier"),
    0,
  );

  if (numIdentifiers === 1) {
    return result.map((x) => {
      if (x.type !== "identifier") return x;
      x.role = "identifier";
      return x;
    });
  }

  // id/identifier columns already carry role: "identifier" via
  // ALIAS_TYPE_META_MAP
  return result;
}
