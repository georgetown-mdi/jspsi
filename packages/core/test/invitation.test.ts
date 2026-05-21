import { ZodError } from "zod";
import { expect, test } from "vitest";

import { encodeInvitation, decodeInvitation } from "../src/config/invitation";
import type { InvitationToken } from "../src/config/invitation";

const baseTerms = {
  version: "1.0.0",
  identity: "Test Party",
  date: "2025-01-01",
  algorithm: "psi" as const,
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [{ name: "ssn", semanticType: "ssn" as const }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

const baseToken: InvitationToken = {
  version: "1",
  linkageTerms: baseTerms,
  pakeToken: "abc123",
};

// Reproduces the encoding step without schema validation so that tests can
// craft valid-checksum / invalid-schema strings. Cannot delegate to
// encodeInvitation because that function validates the token first, which would
// prevent testing decodeInvitation's own schema-rejection behavior.
async function encodeRaw(obj: unknown): Promise<string> {
  const toBase64Url = (b: Uint8Array): string => {
    const s = Array.from(b, (byte) => String.fromCharCode(byte)).join("");
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  };
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const body = toBase64Url(bytes);
  const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const checksum = toBase64Url(new Uint8Array(hashBuf).slice(0, 4));
  return body + checksum;
}

// --- Round-trip --------------------------------------------------------------

test("round-trips a token without expires", async () => {
  const encoded = await encodeInvitation(baseToken);
  const decoded = await decodeInvitation(encoded);
  expect(decoded.pakeToken).toBe("abc123");
  expect(decoded.expires).toBeUndefined();
  expect(decoded.linkageTerms.version).toBe("1.0.0");
  expect(decoded.linkageTerms.identity).toBe("Test Party");
});

test("round-trips a token with expires", async () => {
  const token: InvitationToken = {
    ...baseToken,
    expires: "2030-12-31T23:59:59Z",
  };
  const encoded = await encodeInvitation(token);
  const decoded = await decodeInvitation(encoded);
  expect(decoded.expires).toBe("2030-12-31T23:59:59Z");
  expect(decoded.pakeToken).toBe("abc123");
});

test("round-trips full linkage terms including all fields", async () => {
  const token: InvitationToken = {
    linkageTerms: {
      ...baseTerms,
      linkageFields: [
        { name: "firstName", semanticType: "firstName" },
        { name: "dob", semanticType: "dateOfBirth" },
      ],
      linkageKeys: [
        {
          name: "Name + DOB",
          elements: [{ field: "firstName" }, { field: "dob" }],
        },
      ],
    },
    pakeToken: "tok-xyz",
    expires: "2030-01-01T00:00:00.000Z",
    version: "1",
  };
  const decoded = await decodeInvitation(await encodeInvitation(token));
  expect(decoded.linkageTerms.linkageFields).toHaveLength(2);
  expect(decoded.linkageTerms.linkageKeys[0].name).toBe("Name + DOB");
  expect(decoded.expires).toBe("2030-01-01T00:00:00.000Z");
});

// --- Checksum ----------------------------------------------------------------

test("rejects a corrupted checksum", async () => {
  const encoded = await encodeInvitation(baseToken);
  const lastChar = encoded[encoded.length - 1];
  const corruptChar = lastChar === "A" ? "B" : "A";
  const corrupted = encoded.slice(0, -1) + corruptChar;
  await expect(decodeInvitation(corrupted)).rejects.toThrow("checksum");
});

test("rejects a string that is too short to contain a checksum", async () => {
  await expect(decodeInvitation("short")).rejects.toThrow();
});

test("rejects a string of exactly checksum length", async () => {
  await expect(decodeInvitation("AAAAAA")).rejects.toThrow();
});

test("rejects invalid base64url characters in the body", async () => {
  // '!' is not a valid base64url character; pad to exceed CHECKSUM_CHARS
  await expect(decodeInvitation("!!!!!!!!!!!!")).rejects.toThrow(
    "not valid base64url",
  );
});

// --- Expiry field ------------------------------------------------------------

test("accepts a datetime with milliseconds", async () => {
  const token: InvitationToken = {
    ...baseToken,
    expires: "2030-06-15T12:00:00.000Z",
  };
  const decoded = await decodeInvitation(await encodeInvitation(token));
  expect(decoded.expires).toBe("2030-06-15T12:00:00.000Z");
});

test("rejects encoding a token with a past expires", async () => {
  const token: InvitationToken = {
    ...baseToken,
    expires: "2020-01-01T00:00:00Z",
  };
  await expect(encodeInvitation(token)).rejects.toThrow("future");
});

test("rejects an invalid expires value", async () => {
  const encoded = await encodeRaw({ ...baseToken, expires: "not-a-datetime" });
  await expect(decodeInvitation(encoded)).rejects.toThrow();
});

test("rejects a date-only expires (not a datetime)", async () => {
  const encoded = await encodeRaw({ ...baseToken, expires: "2025-12-31" });
  await expect(decodeInvitation(encoded)).rejects.toThrow();
});

// --- Schema validation -------------------------------------------------------

test("encodeInvitation rejects an empty pakeToken", async () => {
  await expect(
    encodeInvitation({ ...baseToken, pakeToken: "" }),
  ).rejects.toThrow(ZodError);
});

test("rejects a token with an empty pakeToken", async () => {
  const encoded = await encodeRaw({ ...baseToken, pakeToken: "" });
  await expect(decodeInvitation(encoded)).rejects.toThrow(ZodError);
});

test("rejects a token with missing pakeToken", async () => {
  const { pakeToken: _, ...withoutToken } = baseToken;
  const encoded = await encodeRaw(withoutToken);
  await expect(decodeInvitation(encoded)).rejects.toThrow(ZodError);
});

test("rejects a token with missing linkageTerms", async () => {
  const encoded = await encodeRaw({ pakeToken: "abc123" });
  await expect(decodeInvitation(encoded)).rejects.toThrow(ZodError);
});

test("rejects a token with invalid linkage terms (bad version)", async () => {
  const encoded = await encodeRaw({
    ...baseToken,
    linkageTerms: { ...baseTerms, version: "not-semver" },
  });
  await expect(decodeInvitation(encoded)).rejects.toThrow(ZodError);
});

test("rejects a token with an unknown token version", async () => {
  const encoded = await encodeRaw({ ...baseToken, version: "2" });
  await expect(decodeInvitation(encoded)).rejects.toThrow(ZodError);
});

// --- Expiry enforcement is the caller's responsibility -----------------------

test("decodeInvitation succeeds on a token with a past expires", async () => {
  // Expiry is not checked at decode time; callers must compare expires themselves.
  const encoded = await encodeRaw({
    ...baseToken,
    expires: "2020-01-01T00:00:00Z",
  });
  const decoded = await decodeInvitation(encoded);
  expect(decoded.expires).toBe("2020-01-01T00:00:00Z");
});
