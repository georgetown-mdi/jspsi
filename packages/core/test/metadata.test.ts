import { expect, test } from "vitest";

import {
  inferMetadata,
  ALIAS_TYPE_META_MAP,
  safeParseMetadata,
} from "../src/config/metadata";

// ─── inferMetadata: linkage columns ──────────────────────────────────────────

test("ssn: linkage role, not payload by default", () => {
  const [col] = inferMetadata(["ssn"]);
  expect(col.type).toBe("ssn");
  expect(col.role).toBe("linkage");
  expect(col.isPayload).toBe(false);
});

test("phone and email: linkage role, not payload by default", () => {
  const [phone] = inferMetadata(["phone_number"]);
  const [email] = inferMetadata(["email_address"]);
  expect(phone.role).toBe("linkage");
  expect(phone.isPayload).toBe(false);
  expect(email.role).toBe("linkage");
  expect(email.isPayload).toBe(false);
});

// ─── inferMetadata: identifier column ────────────────────────────────────────

test("identifier canonical name: identifier role, not linkage", () => {
  const [col] = inferMetadata(["identifier"]);
  expect(col.type).toBe("identifier");
  expect(col.role).toBe("identifier");
  expect(col.isPayload).toBe(true);
});

test("identifier alias 'id': identifier role, not linkage", () => {
  const [col] = inferMetadata(["id"]);
  expect(col.type).toBe("identifier");
  expect(col.role).toBe("identifier");
  expect(col.isPayload).toBe(true);
});

// ─── inferMetadata: _id suffix ──────────────────────────────────────────────

test("column ending in _id: inferred as identifier type, isPayload true", () => {
  const [col] = inferMetadata(["client_id"]);
  expect(col.type).toBe("identifier");
  expect(col.isPayload).toBe(true);
});

test("single _id column: promoted to identifier role", () => {
  const [col] = inferMetadata(["client_id"]);
  expect(col.role).toBe("identifier");
});

test("multiple _id columns: no promotion, all remain payload role", () => {
  const result = inferMetadata(["client_id", "member_id"]);
  expect(result[0].type).toBe("identifier");
  expect(result[0].role).toBe("payload");
  expect(result[1].type).toBe("identifier");
  expect(result[1].role).toBe("payload");
});

test("canonical id column alongside _id column: id keeps identifier role, _id stays payload", () => {
  const result = inferMetadata(["id", "client_id"]);
  const idCol = result.find((c) => c.name === "id");
  const clientIdCol = result.find((c) => c.name === "client_id");
  expect(idCol?.role).toBe("identifier");
  expect(clientIdCol?.role).toBe("payload");
});

// ─── inferMetadata: unknown columns ──────────────────────────────────────────

test("unknown column: payload role and isPayload true", () => {
  const [col] = inferMetadata(["program_start_date"]);
  expect(col.type).toBe("other");
  expect(col.role).toBe("payload");
  expect(col.isPayload).toBe(true);
});

// ─── inferMetadata: name is preserved ────────────────────────────────────────

test("original column name casing is preserved", () => {
  const [upper] = inferMetadata(["LAST_NAME"]);
  const [mixed] = inferMetadata(["First_Name"]);
  expect(upper.name).toBe("LAST_NAME");
  expect(mixed.name).toBe("First_Name");
});

// ─── inferMetadata: alias resolution ─────────────────────────────────────────

test.each([
  ["first_name", "first_name"],
  ["fname", "first_name"],
  ["last_name", "last_name"],
  ["lname", "last_name"],
  ["date_of_birth", "date_of_birth"],
  ["dob", "date_of_birth"],
  ["social_security_number", "ssn"],
  ["social", "ssn"],
  ["phone_number", "phone_number"],
  ["phone", "phone_number"],
  ["email_address", "email_address"],
  ["email", "email_address"],
  ["id", "identifier"],
  // No-separator spellings: a single-token column export still infers. Pinned
  // because the map builder keys on `type.toLowerCase()`, which equals the
  // snake_case type and so no longer yields the no-separator key as a side
  // effect -- these must stay explicit aliases.
  ["firstname", "first_name"],
  ["lastname", "last_name"],
  ["dateofbirth", "date_of_birth"],
  ["phonenumber", "phone_number"],
  ["emailaddress", "email_address"],
] as const)('alias "%s" resolves to type "%s"', (alias, expectedType) => {
  const [col] = inferMetadata([alias]);
  expect(col.type).toBe(expectedType);
});

// ─── inferMetadata: case-insensitive lookup ───────────────────────────────────

test.each([
  ["SSN", "ssn"],
  ["FIRST_NAME", "first_name"],
  ["Email", "email_address"],
  ["DOB", "date_of_birth"],
] as const)(
  'column name "%s" is matched case-insensitively',
  (name, expectedType) => {
    const [col] = inferMetadata([name]);
    expect(col.type).toBe(expectedType);
  },
);

// ─── inferMetadata: mixed columns ────────────────────────────────────────────

test("known and unknown columns are inferred correctly in a single call", () => {
  const result = inferMetadata(["ssn", "program_start_date", "first_name"]);
  expect(result[0]).toMatchObject({
    type: "ssn",
    role: "linkage",
    isPayload: false,
  });
  expect(result[1]).toMatchObject({
    type: "other",
    role: "payload",
    isPayload: true,
  });
  expect(result[2]).toMatchObject({
    type: "first_name",
    role: "linkage",
    isPayload: false,
  });
});

// ─── ALIAS_TYPE_META_MAP ──────────────────────────────────────────────────────

test("ALIAS_TYPE_META_MAP entries have type, role, and isPayload", () => {
  const entry = ALIAS_TYPE_META_MAP["ssn"];
  expect(entry).toHaveProperty("type", "ssn");
  expect(entry).toHaveProperty("role", "linkage");
  expect(entry).toHaveProperty("isPayload", false);
});

test("ALIAS_TYPE_META_MAP identifier entry has role identifier, not linkage", () => {
  const entry = ALIAS_TYPE_META_MAP["identifier"];
  expect(entry.role).toBe("identifier");
});

// ─── safeParseMetadata ────────────────────────────────────────────────────────

test("safeParseMetadata camelizes the on-disk snake_case keys", () => {
  // The form saveConfig writes (is_payload, not isPayload).
  const result = safeParseMetadata([
    { name: "SSN", type: "ssn", role: "linkage", is_payload: false },
  ]);
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.data[0]).toEqual({
    name: "SSN",
    type: "ssn",
    role: "linkage",
    isPayload: false,
  });
});

test("safeParseMetadata also accepts the camelCase form", () => {
  const result = safeParseMetadata([
    { name: "SSN", type: "ssn", role: "linkage", isPayload: false },
  ]);
  expect(result.success).toBe(true);
});

test("safeParseMetadata fails on an invalid semantic type", () => {
  const result = safeParseMetadata([
    { name: "X", type: "not_a_type", role: "linkage", is_payload: false },
  ]);
  expect(result.success).toBe(false);
});

// The metadata `type` shares the semantic-type enum with linkage fields, so it
// accepts the same snake_case values -- including the single-word identifier and
// other that are not linkage-field types -- and rejects the old camelCase ones.
test.each([
  "ssn",
  "ssn4",
  "first_name",
  "last_name",
  "date_of_birth",
  "identifier",
  "phone_number",
  "email_address",
  "other",
] as const)('safeParseMetadata accepts semantic type "%s"', (type) => {
  const result = safeParseMetadata([
    { name: "c", type, role: "linkage", is_payload: false },
  ]);
  expect(result.success).toBe(true);
});

test.each([
  "firstName",
  "lastName",
  "dateOfBirth",
  "phoneNumber",
  "emailAddress",
] as const)('safeParseMetadata rejects the old camelCase type "%s"', (type) => {
  const result = safeParseMetadata([
    { name: "c", type, role: "linkage", is_payload: false },
  ]);
  expect(result.success).toBe(false);
});

test("a rejected metadata type is not echoed in the parse error", () => {
  // The metadata `type` is a z.enum(SEMANTIC_TYPES) reached by the operator-config
  // path (loadConfigLinkageSource), which relays the Zod issue message verbatim.
  // Like the linkage-terms discriminator, the z.enum mismatch reports only the
  // expected options and the issue path, never the received value -- pin that so
  // an offending value carrying control/ANSI/bidi bytes cannot leak through.
  const evil = "\x1b[31mfirstName\x1b[0m‮";
  const result = safeParseMetadata([
    { name: "c", type: evil, role: "linkage", is_payload: false },
  ]);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.message).not.toContain("firstName");
    expect(result.error.message).not.toContain("\x1b");
    expect(result.error.message).not.toContain("‮");
  }
});
