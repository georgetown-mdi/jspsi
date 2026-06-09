import { ZodError } from "zod";
import { expect, test } from "vitest";

import { encodeInvitation, decodeInvitation } from "../src/config/invitation";
import type {
  ConnectionEndpoint,
  InvitationToken,
} from "../src/config/invitation";

// A SHARED_SECRET_REGEX-valid placeholder (43 base64url chars = 32 zero bytes).
// InvitationTokenSchema now enforces that shape, so test tokens carry a real
// one rather than a short literal.
const VALID_SECRET = "A".repeat(43);

const baseTerms = {
  version: "1.0.0",
  identity: "Test Party",
  date: "2025-01-01",
  algorithm: "psi" as const,
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" as const }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

const baseToken: InvitationToken = {
  version: "1",
  linkageTerms: baseTerms,
  sharedSecret: VALID_SECRET,
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
  expect(decoded.sharedSecret).toBe(VALID_SECRET);
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
  expect(decoded.sharedSecret).toBe(VALID_SECRET);
});

test("round-trips full linkage terms including all fields", async () => {
  const token: InvitationToken = {
    linkageTerms: {
      ...baseTerms,
      linkageFields: [
        { name: "firstName", type: "firstName" },
        { name: "dob", type: "dateOfBirth" },
      ],
      linkageKeys: [
        {
          name: "Name + DOB",
          elements: [{ field: "firstName" }, { field: "dob" }],
        },
      ],
    },
    sharedSecret: VALID_SECRET,
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

test("encodeInvitation rejects an empty sharedSecret", async () => {
  await expect(
    encodeInvitation({ ...baseToken, sharedSecret: "" }),
  ).rejects.toThrow(ZodError);
});

test("rejects a token with an empty sharedSecret", async () => {
  const encoded = await encodeRaw({ ...baseToken, sharedSecret: "" });
  await expect(decodeInvitation(encoded)).rejects.toThrow(ZodError);
});

test("rejects a token whose sharedSecret is not a base64url-encoded 32-byte value", async () => {
  // A non-empty but wrong-shape secret is now caught at decode (matching the
  // KeyFile and Authentication schemas) instead of slipping through to fail
  // later at saveKeyFile / authenticateConnection.
  const encoded = await encodeRaw({ ...baseToken, sharedSecret: "abc123" });
  await expect(decodeInvitation(encoded)).rejects.toThrow(ZodError);
});

test("rejects a token with missing sharedSecret", async () => {
  const { sharedSecret: _, ...withoutToken } = baseToken;
  const encoded = await encodeRaw(withoutToken);
  await expect(decodeInvitation(encoded)).rejects.toThrow(ZodError);
});

test("rejects a token with missing linkageTerms", async () => {
  const encoded = await encodeRaw({ sharedSecret: VALID_SECRET });
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

// --- Connection endpoint -----------------------------------------------------

// The endpoint tests are matrix-driven so coverage is complete by construction:
// adding a channel to CHANNEL_SHAPES or a name to FORBIDDEN_FIELDS auto-covers
// every generated combination (a positive round-trip per shape; a credential
// rejection per channel on both the encode and decode paths), instead of
// relying on a reviewer to notice a missing cell.

// Locator shapes per channel: a minimal form (only required fields) and a full
// form (every optional locator field set). The filedrop full form uses a
// RELATIVE path on purpose -- the endpoint schema intentionally accepts a
// relative file-drop path (the acceptor remaps it to its own mount), unlike
// FileDropConnectionConfigSchema in connection.ts which requires absolute; this
// row guards that decision against a silent tightening. The type annotation
// makes the compiler reject any shape that is not a valid, credential-free
// ConnectionEndpoint.
const CHANNEL_SHAPES: Record<
  string,
  { minimal: ConnectionEndpoint; full: ConnectionEndpoint }
> = {
  webrtc: {
    minimal: { channel: "webrtc", host: "signal.example" },
    full: {
      channel: "webrtc",
      host: "signal.example",
      port: 9000,
      path: "/psilink",
    },
  },
  sftp: {
    minimal: { channel: "sftp", host: "sftp.example" },
    full: {
      channel: "sftp",
      host: "sftp.example",
      port: 2222,
      path: "/exchange",
    },
  },
  filedrop: {
    minimal: { channel: "filedrop", path: "/mnt/shared" },
    full: { channel: "filedrop", path: "relative/drop" },
  },
};

// Non-locator fields a real connection config carries that an endpoint must
// reject -- both credentials and server-identity material -- using the actual
// SFTP and PeerJS field identifiers from connection.ts. `certificate` is SSH
// cert-based auth material; `hostKeyFingerprint`/`knownHosts` are the
// server-identity fields SECURITY_DESIGN.md names as excluded (not secret, but
// not locators either). Every name is rejected by the same strictObject
// unrecognized-keys branch, so this matrix documents the invariant and guards
// against the allowlist being loosened (e.g. strictObject -> looseObject); it
// is not additional branch coverage. This list is a curated regression sample,
// not an exhaustive denylist -- the binding rule is the locator allowlist.
const FORBIDDEN_FIELDS = [
  "password",
  "privateKey",
  "privateKeyPassphrase",
  "certificate",
  "hostKeyFingerprint",
  "knownHosts",
  "key",
];

const positiveCases = Object.entries(CHANNEL_SHAPES).flatMap(
  ([channel, shapes]) =>
    Object.entries(shapes).map(([shape, endpoint]) => ({
      channel,
      shape,
      endpoint,
    })),
);

const credentialCases = Object.entries(CHANNEL_SHAPES).flatMap(
  ([channel, { minimal }]) =>
    FORBIDDEN_FIELDS.map((field) => ({ channel, field, minimal })),
);

test("round-trips a token without a connection endpoint", async () => {
  const decoded = await decodeInvitation(await encodeInvitation(baseToken));
  expect(decoded.connectionEndpoint).toBeUndefined();
});

test.each(positiveCases)(
  "round-trips a credential-free $channel endpoint ($shape)",
  async ({ endpoint }) => {
    const decoded = await decodeInvitation(
      await encodeInvitation({ ...baseToken, connectionEndpoint: endpoint }),
    );
    expect(decoded.connectionEndpoint).toEqual(endpoint);
  },
);

test.each(credentialCases)(
  "encodeInvitation rejects a $channel endpoint carrying $field",
  async ({ field, minimal }) => {
    const token = {
      ...baseToken,
      connectionEndpoint: { ...minimal, [field]: "secret" },
    } as unknown as InvitationToken;
    await expect(encodeInvitation(token)).rejects.toThrow(
      /credential-free locator/,
    );
  },
);

test.each(credentialCases)(
  "decodeInvitation rejects a $channel endpoint carrying $field",
  async ({ field, minimal }) => {
    const encoded = await encodeRaw({
      ...baseToken,
      connectionEndpoint: { ...minimal, [field]: "secret" },
    });
    await expect(decodeInvitation(encoded)).rejects.toThrow(
      /credential-free locator/,
    );
  },
);

// username is not a credential but is still outside the locator allowlist. It
// must be rejected on every channel and on both paths, and the message must
// frame it as an unrecognized locator field (naming the field) rather than as
// an attempted credential.
const nonLocatorCases = Object.entries(CHANNEL_SHAPES).map(
  ([channel, { minimal }]) => ({ channel, minimal }),
);

test.each(nonLocatorCases)(
  "encodeInvitation rejects a $channel endpoint with a non-credential extra field",
  async ({ minimal }) => {
    const token = {
      ...baseToken,
      connectionEndpoint: { ...minimal, username: "alice" },
    } as unknown as InvitationToken;
    await expect(encodeInvitation(token)).rejects.toThrow(
      /credential-free locator.*username/s,
    );
  },
);

test.each(nonLocatorCases)(
  "decodeInvitation rejects a $channel endpoint with a non-credential extra field",
  async ({ minimal }) => {
    const encoded = await encodeRaw({
      ...baseToken,
      connectionEndpoint: { ...minimal, username: "alice" },
    });
    await expect(decodeInvitation(encoded)).rejects.toThrow(
      /credential-free locator.*username/s,
    );
  },
);

// Structural rejections are an explicit table rather than a generated product:
// each row's expectation is channel-specific (the required field differs, and
// the discriminator and null cases are not per-channel).
test.each([
  { name: "a webrtc endpoint missing its host", bad: { channel: "webrtc" } },
  {
    name: "an sftp endpoint missing its host",
    bad: { channel: "sftp", port: 2222 },
  },
  {
    name: "a filedrop endpoint missing its path",
    bad: { channel: "filedrop" },
  },
  { name: "an unknown channel", bad: { channel: "carrier-pigeon", host: "h" } },
  { name: "an endpoint missing its channel discriminator", bad: { host: "h" } },
  {
    name: "a null endpoint (null is not the same as an omitted field)",
    bad: null,
  },
])("rejects $name", async ({ bad }) => {
  const encoded = await encodeRaw({ ...baseToken, connectionEndpoint: bad });
  await expect(decodeInvitation(encoded)).rejects.toThrow(ZodError);
});

// Boundary rejections for the constrained locator fields. These pin the
// deliberate min(1) choices (port and path) so an accidental loosening to
// min(0) or an empty string would fail a test.
test.each([
  {
    name: "a webrtc endpoint with port 0",
    bad: { channel: "webrtc", host: "h", port: 0 },
  },
  {
    name: "an sftp endpoint with port 0",
    bad: { channel: "sftp", host: "h", port: 0 },
  },
  {
    name: "a webrtc endpoint with an empty path",
    bad: { channel: "webrtc", host: "h", path: "" },
  },
  {
    name: "an sftp endpoint with an empty path",
    bad: { channel: "sftp", host: "h", path: "" },
  },
  {
    name: "a filedrop endpoint with an empty path",
    bad: { channel: "filedrop", path: "" },
  },
])("rejects $name", async ({ bad }) => {
  const encoded = await encodeRaw({ ...baseToken, connectionEndpoint: bad });
  await expect(decodeInvitation(encoded)).rejects.toThrow(ZodError);
});

test("strips an unknown top-level field rather than embedding it", async () => {
  // encodeInvitation serializes the parse() result, so a field a caller adds by
  // bypassing the types is not carried onto the wire. decode would re-strip, so
  // this asserts on the encoded bytes: encoding with the extra field must
  // produce the identical string as encoding the clean token.
  const withExtra = await encodeInvitation({
    ...baseToken,
    smuggledSecret: "leak",
  } as unknown as InvitationToken);
  const clean = await encodeInvitation(baseToken);
  expect(withExtra).toBe(clean);
});
