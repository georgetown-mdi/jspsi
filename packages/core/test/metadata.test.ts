import { expect, test } from "vitest";

import { inferMetadata, ALIAS_TYPE_META_MAP } from "../src/config/metadata";

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
  ["first_name", "firstName"],
  ["fname", "firstName"],
  ["last_name", "lastName"],
  ["lname", "lastName"],
  ["date_of_birth", "dateOfBirth"],
  ["dob", "dateOfBirth"],
  ["social_security_number", "ssn"],
  ["social", "ssn"],
  ["phone_number", "phoneNumber"],
  ["phone", "phoneNumber"],
  ["email_address", "emailAddress"],
  ["email", "emailAddress"],
  ["id", "identifier"],
] as const)('alias "%s" resolves to type "%s"', (alias, expectedType) => {
  const [col] = inferMetadata([alias]);
  expect(col.type).toBe(expectedType);
});

// ─── inferMetadata: case-insensitive lookup ───────────────────────────────────

test.each([
  ["SSN", "ssn"],
  ["FIRST_NAME", "firstName"],
  ["Email", "emailAddress"],
  ["DOB", "dateOfBirth"],
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
    type: "firstName",
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
