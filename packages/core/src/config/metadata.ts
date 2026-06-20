import { z } from "zod";

import { SEMANTIC_TYPES } from "../types";
import { camelizeKeys } from "../utils/camelizeKeys.js";

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
  name: z.string(),
  type: z.enum(SEMANTIC_TYPES),
  role: ColumnRoleSchema,
  isPayload: z.boolean(),
  description: z.string().optional(),
});

export type Metadata = Array<ColumnMetadata>;

export const MetadataSchema = z.array(ColumnMetadataSchema);

/**
 * Non-throwing parse of a raw value as {@link Metadata}. Snake_case keys (the
 * on-disk form, e.g. `is_payload`) are converted to camelCase before validation,
 * so a `metadata` block read straight from a YAML/JSON config can be passed
 * directly -- mirroring {@link safeParseLinkageTerms} and
 * {@link safeParseExchangeSpec}. Returns a Zod `SafeParseReturnType`.
 */
export function safeParseMetadata(raw: unknown) {
  return MetadataSchema.safeParse(camelizeKeys(raw));
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
