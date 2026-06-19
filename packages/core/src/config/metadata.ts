import { z } from "zod";

import { SEMANTIC_TYPES } from "../types";
import { camelizeKeys } from "../utils/camelizeKeys.js";

import type { SemanticType } from "../types";

// ─── Metadata ────────────────────────────────────────────────────────────────
export const ColumnRoleSchema = z.enum(["linkage", "identifier", "payload"]);
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
    aliases: ["first_name", "fname"],
    role: "linkage",
    isPayload: false,
  },
  {
    type: "last_name",
    aliases: ["last_name", "lname"],
    role: "linkage",
    isPayload: false,
  },
  {
    type: "date_of_birth",
    aliases: ["date_of_birth", "dob"],
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
    aliases: ["phone_number", "phone"],
    role: "linkage",
    isPayload: false,
  },
  {
    type: "email_address",
    aliases: ["email_address", "email"],
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
