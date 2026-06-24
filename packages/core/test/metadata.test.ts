import { expect, test } from "vitest";

import {
  inferMetadata,
  ALIAS_TYPE_META_MAP,
  safeParseMetadata,
  disclosedColumnNames,
} from "../src/config/metadata";
import { UsageError } from "../src/errors";

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

test("zip_code: linkage role, not payload by default", () => {
  // A recognized PII type defaults to linkage and is NOT disclosed: an inferred
  // ZIP column participates in matching only if a key references it, and is never
  // silently shipped as payload (unlike an unrecognized `other` column, which is).
  const [zip] = inferMetadata(["zip"]);
  expect(zip.type).toBe("zip_code");
  expect(zip.role).toBe("linkage");
  expect(zip.isPayload).toBe(false);
});

test("an inferred zip column is excluded from the disclosed set", () => {
  // The observable disclosure consequence, pinned at the boundary preparePayload
  // gathers on (disclosedColumnNames over isDisclosedToPartner): a `zip` column is
  // NOT sent to the partner, while an unrecognized `notes` column still is. This is
  // the behavior change a `zip` column previously inferred as `other` (and sent);
  // pin it so a regression in the alias mapping cannot silently start disclosing it.
  const disclosed = disclosedColumnNames(
    inferMetadata(["first_name", "last_name", "zip", "notes"]),
  );
  expect(disclosed).not.toContain("zip");
  expect(disclosed).toContain("notes");
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
  ["zip_code", "zip_code"],
  ["zip", "zip_code"],
  ["zip5", "zip_code"],
  ["zip_5", "zip_code"],
  ["zipcode", "zip_code"],
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

// ─── column-name uniqueness ───────────────────────────────────────────────────

test("safeParseMetadata rejects duplicate column names", () => {
  const result = safeParseMetadata([
    { name: "X", type: "other", role: "ignored", is_payload: false },
    { name: "X", type: "other", role: "payload", is_payload: true },
  ]);
  expect(result.success).toBe(false);
});

test("safeParseMetadata does not echo a duplicated name in the error", () => {
  // The name is operator-authored and may carry control/ANSI/bidi bytes; the
  // uniqueness refine reports a static message, never the offending name.
  const evil = "\x1b[31mDUP\x1b[0m‮";
  const result = safeParseMetadata([
    { name: evil, type: "other", role: "payload", is_payload: true },
    { name: evil, type: "other", role: "payload", is_payload: true },
  ]);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.message).not.toContain("DUP");
    expect(result.error.message).not.toContain("\x1b");
    expect(result.error.message).not.toContain("‮");
  }
});

test("safeParseMetadata accepts names differing only in case (matching is exact)", () => {
  // Column identity is case-sensitive everywhere a column is read by name, so
  // "X" and "x" are distinct columns, not a duplicate.
  const result = safeParseMetadata([
    { name: "X", type: "other", role: "payload", is_payload: true },
    { name: "x", type: "other", role: "payload", is_payload: true },
  ]);
  expect(result.success).toBe(true);
});

// ─── column-name length bound ─────────────────────────────────────────────────

test("safeParseMetadata rejects an empty column name", () => {
  // An empty name is now rejected at config parse rather than parsing cleanly and
  // being skipped later at record build (the build-time governance validation).
  const result = safeParseMetadata([
    { name: "", type: "other", role: "payload", is_payload: true },
  ]);
  expect(result.success).toBe(false);
});

test("safeParseMetadata rejects a column name over the length bound", () => {
  // MAX_NAME_LENGTH is 256; 257 characters exceeds it.
  const result = safeParseMetadata([
    { name: "a".repeat(257), type: "other", role: "payload", is_payload: true },
  ]);
  expect(result.success).toBe(false);
});

test("safeParseMetadata accepts a column name at the length bound", () => {
  const result = safeParseMetadata([
    { name: "a".repeat(256), type: "other", role: "payload", is_payload: true },
  ]);
  expect(result.success).toBe(true);
});

test("safeParseMetadata accepts a normal column name (no regression)", () => {
  const result = safeParseMetadata([
    { name: "COUNTY", type: "other", role: "payload", is_payload: true },
  ]);
  expect(result.success).toBe(true);
});

test("safeParseMetadata does not echo an over-long name in the error", () => {
  // The name is operator-authored and may carry control/ANSI/bidi bytes; the
  // length bound reports a static message, never the offending name.
  const evil = "\x1b[31m" + "D".repeat(300) + "\x1b[0m‮";
  const result = safeParseMetadata([
    { name: evil, type: "other", role: "payload", is_payload: true },
  ]);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.message).not.toContain("D".repeat(300));
    expect(result.error.message).not.toContain("\x1b");
    expect(result.error.message).not.toContain("‮");
  }
});

// ─── role: ignored ────────────────────────────────────────────────────────────

test("safeParseMetadata accepts role: ignored", () => {
  const result = safeParseMetadata([
    { name: "COUNTY", type: "other", role: "ignored", is_payload: false },
  ]);
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.data[0].role).toBe("ignored");
});

test("safeParseMetadata accepts role: ignored with is_payload: true (accept-but-ignore)", () => {
  // The is_payload + ignored open question is resolved as accept-but-ignore: the
  // schema accepts any is_payload on an ignored column; transmission is suppressed
  // at the preparePayload chokepoint (see payloadExchange.test.ts), not at parse.
  const result = safeParseMetadata([
    { name: "COUNTY", type: "other", role: "ignored", is_payload: true },
  ]);
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.data[0]).toEqual({
    name: "COUNTY",
    type: "other",
    role: "ignored",
    isPayload: true,
  });
});

test("safeParseMetadata rejects an unknown role", () => {
  const result = safeParseMetadata([
    { name: "c", type: "other", role: "excluded", is_payload: false },
  ]);
  expect(result.success).toBe(false);
});

test("inferMetadata never assigns role: ignored", () => {
  // ignored is opt-in (user intent, not inferable): inference only ever emits
  // linkage, identifier, or payload. Exercise linkage, canonical-identifier,
  // _id-suffix, promoted-single-id, and unknown columns together.
  const result = inferMetadata([
    "ssn",
    "first_name",
    "identifier",
    "client_id",
    "member_id",
    "program_start_date",
  ]);
  expect(result.every((c) => c.role !== "ignored")).toBe(true);
});

// ─── inferMetadata: empty column name ─────────────────────────────────────────

test("inferMetadata rejects an empty column name at intake", () => {
  // An empty (zero-length) name -- a trailing comma, a blank cell, or a leading
  // delimiter in the CSV header -- cannot be used for linkage, identification, or
  // payload (every downstream name floors at .min(1)). Reject it at this intake
  // chokepoint as a clear UsageError rather than disclosing it and losing the audit
  // record to the non-fatal record-build guard. A UsageError so the CLI exits 64.
  expect(() => inferMetadata([""])).toThrow(UsageError);
  expect(() => inferMetadata(["ssn", "", "first_name"])).toThrow(UsageError);
});

test("inferMetadata empty-name error names the positions, not input", () => {
  // The message reports the 1-based positions (not operator-controlled content) so
  // the operator can find the unnamed headers; both empty columns are named.
  let message = "";
  try {
    inferMetadata(["ssn", "", "first_name", ""]);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  expect(message).toContain("2");
  expect(message).toContain("4");
});

test("inferMetadata accepts a fully-named header (no regression)", () => {
  expect(() =>
    inferMetadata(["ssn", "first_name", "last_name", "dob"]),
  ).not.toThrow();
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
