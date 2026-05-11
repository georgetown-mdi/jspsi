export type ColumnType =
  | "ssn"
  | "ssn4"
  | "firstName"
  | "lastName"
  | "dateOfBirth"
  | "identifier"
  | "phoneNumber"
  | "emailAddress"
  | "other";

export type ColumnRole = "linkage" | "identifier" | "payload";

export interface ColumnMetadata {
  name: string;
  type: ColumnType;
  role: ColumnRole;
  isPayload: boolean;
  description?: string;
}

interface TypeMeta {
  type: ColumnType;
  aliases: Array<string>;
  role: ColumnRole;
  isPayload: boolean;
}

interface TypeMetaMapped {
  type: ColumnType;
  role: ColumnRole;
  isPayload: boolean;
}

const columnTypesAndAliases: Array<TypeMeta> = [
  {
    type: "ssn",
    aliases: ["social_security_number", "social"],
    role: "linkage",
    isPayload: false,
  },
  { type: "ssn4", aliases: [], role: "linkage", isPayload: false },
  { type: "firstName", aliases: ["first_name", "fname"], role: "linkage", isPayload: false },
  { type: "lastName", aliases: ["last_name", "lname"], role: "linkage", isPayload: false },
  {
    type: "dateOfBirth",
    aliases: ["date_of_birth", "dob"],
    role: "linkage",
    isPayload: false,
  },
  { type: "identifier", aliases: ["id"], role: "identifier", isPayload: false },
  {
    type: "phoneNumber",
    aliases: ["phone_number", "phone"],
    role: "linkage",
    isPayload: false,
  },
  {
    type: "emailAddress",
    aliases: ["email_address", "email"],
    role: "linkage",
    isPayload: false,
  },
];

export const ALIAS_TYPE_META_MAP = columnTypesAndAliases.reduce(
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

export function inferMetadata(names: Array<string>): Array<ColumnMetadata> {
  return names.map((name) => {
    const lookupName = name.toLowerCase();
    if (!(lookupName in ALIAS_TYPE_META_MAP)) {
      return { name, type: "other", role: "payload", isPayload: true };
    }
    const { type, role, isPayload } = ALIAS_TYPE_META_MAP[lookupName];
    return { name, type, role, isPayload };
  });
}
