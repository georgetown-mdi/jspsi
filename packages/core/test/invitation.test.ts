import { ZodError } from "zod";
import { expect, test } from "vitest";

import {
  encodeInvitation,
  decodeInvitation,
  isInvitationExpired,
  INVITATION_LIFETIME_SECONDS,
  MAX_INVITATION_LIFETIME_SECONDS,
  MAX_ENCODED_INVITATION_LENGTH,
  MAX_ENDPOINT_HOST_LENGTH,
  MAX_ENDPOINT_PATH_LENGTH,
} from "../src/config/invitation";
import type {
  ConnectionEndpoint,
  InvitationToken,
} from "../src/config/invitation";
import {
  MAX_NAME_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_LINKAGE_ENTRIES,
} from "../src/config/linkageTerms";
import { describeDecodeError } from "../src/utils/describeDecodeError";

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

// Appends a valid 4-byte checksum over an ARBITRARY payload string, reproducing
// encodeInvitation's body+checksum encoding without its schema validation. The
// payload-string form (rather than an object) lets a test craft a checksum-valid
// invitation whose decoded bytes are deliberately NOT valid JSON, to exercise
// decodeInvitation's JSON.parse swallow -- a path encodeRaw cannot reach because
// it always emits well-formed JSON.
async function encodeRawPayload(payload: string): Promise<string> {
  const toBase64Url = (b: Uint8Array): string => {
    const s = Array.from(b, (byte) => String.fromCharCode(byte)).join("");
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  };
  const bytes = new TextEncoder().encode(payload);
  const body = toBase64Url(bytes);
  const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const checksum = toBase64Url(new Uint8Array(hashBuf).slice(0, 4));
  return body + checksum;
}

// Reproduces the encoding step without schema validation so that tests can
// craft valid-checksum / invalid-schema strings. Cannot delegate to
// encodeInvitation because that function validates the token first, which would
// prevent testing decodeInvitation's own schema-rejection behavior.
async function encodeRaw(obj: unknown): Promise<string> {
  return encodeRawPayload(JSON.stringify(obj));
}

// --- Lifetime policy ---------------------------------------------------------

test("invitation lifetime default is one hour and the ceiling is one year", () => {
  // The single values both inviters (the CLI and the web app) share.
  // docs/SECURITY_DESIGN.md states the default expiration window of 1 hour and
  // the hard one-year maximum; pinning them here guards the documented policy
  // against accidental change.
  expect(INVITATION_LIFETIME_SECONDS).toBe(60 * 60);
  expect(MAX_INVITATION_LIFETIME_SECONDS).toBe(365 * 24 * 60 * 60);
});

test("isInvitationExpired: absent expires is never expired (unbounded token)", () => {
  expect(isInvitationExpired(undefined, new Date("2026-01-01T00:00:00Z"))).toBe(
    false,
  );
});

test("isInvitationExpired: a future expires is not expired", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  expect(isInvitationExpired("2026-01-01T01:00:00Z", now)).toBe(false);
});

test("isInvitationExpired: a past expires is expired", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  expect(isInvitationExpired("2025-12-31T23:59:59Z", now)).toBe(true);
});

test("isInvitationExpired: equal to now fails closed (expired at the boundary)", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  expect(isInvitationExpired("2026-01-01T00:00:00Z", now)).toBe(true);
});

test("isInvitationExpired: an unparseable expires fails closed (rejected)", () => {
  // Defense in depth: decodeInvitation's schema already rejects a non-ISO
  // `expires`, but the helper must not honor a token whose expiry is `NaN` (which
  // a bare `<=` comparison would treat as not-expired).
  const now = new Date("2026-01-01T00:00:00Z");
  for (const bad of ["not-a-date", "", "2026-13-99T99:99:99Z"]) {
    expect(isInvitationExpired(bad, now)).toBe(true);
  }
});

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
        { name: "firstName", type: "first_name" },
        { name: "dob", type: "date_of_birth" },
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

test("decodeInvitation rejects linkage terms carrying a catastrophic-backtracking regex", async () => {
  // A crafted invitation -- valid checksum (the checksum is a transcription-error
  // detector, not an authenticity guarantee, so anyone can recompute it over a
  // hostile payload) whose linkage terms embed a ReDoS pattern in an element
  // transform. InvitationTokenSchema embeds LinkageTermsSchema, so the
  // catastrophic-backtracking check fires at decode, before any pattern executes.
  const malicious = {
    ...baseToken,
    linkageTerms: {
      ...baseTerms,
      linkageKeys: [
        {
          name: "SSN",
          elements: [
            {
              field: "ssn",
              transform: [
                { function: "filter_regex", params: { pattern: "(a+)+$" } },
              ],
            },
          ],
        },
      ],
    },
  };
  const encoded = await encodeRaw(malicious);
  await expect(decodeInvitation(encoded)).rejects.toThrow(ZodError);
  await expect(decodeInvitation(encoded)).rejects.toThrow(
    /catastrophic backtracking/,
  );
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

// --- Decode-error message swallows (display-injection backstop) --------------

// decodeInvitation deliberately catches the JSON.parse and atob failures and
// rethrows a FIXED string rather than the engine's message, because those
// messages can quote partner-controlled input bytes. That thrown .message is
// relayed verbatim by describeDecodeError for a non-Zod Error. Its load-bearing
// consumer is the web accept page's operator-facing alert (apps/web
// AcceptInvitation), which renders describeDecodeError's output in a React text
// node with no further sanitize pass: React neutralizes HTML markup but NOT the
// deceptive-Unicode / terminal-control / bidi-override / zero-width bytes below.
// (The CLI accept path renders the same decode error to a terminal but escapes
// it independently via sanitizeErrorForDisplay, so the swallow is
// belt-and-suspenders there, not the sole guard.) For the web alert the swallows
// are the only thing keeping partner bytes out of that .message; these tests pin
// them so a future "improve the error by relaying the original" refactor fails
// loudly here instead of silently reopening the vector. See board item 199895565.

// Representative partner-controllable bytes, one per class the display-boundary
// hardening neutralizes. Written as explicit escapes -- never pasted glyphs --
// so the diff is reviewable and no editor or formatter can silently mangle an
// invisible literal.
const PLANTED_DISPLAY_BYTES = [
  "\x1b", // ESC -- ANSI / terminal control
  "\x07", // BEL -- terminal control
  "\x00", // NUL -- control
  "\u0430", // Cyrillic letter a -- deceptive homoglyph
  "\u200b", // zero-width space
  "\u200d", // zero-width joiner
  "\u202e", // RIGHT-TO-LEFT OVERRIDE -- bidi
  "\u202d", // LEFT-TO-RIGHT OVERRIDE -- bidi
];

test("decodeInvitation swallows the JSON.parse error, never relaying partner bytes", async () => {
  // A checksum-valid token whose decoded bytes are not valid JSON. The hostile
  // bytes lead the payload so JSON.parse fails on the first token and emits its
  // input-quoting "Unexpected token X, \"...\" is not valid JSON" form, which
  // embeds a span of the offending input verbatim.
  const hostile = PLANTED_DISPLAY_BYTES.join("") + "not valid json";
  const encoded = await encodeRawPayload(hostile);

  const err = await decodeInvitation(encoded).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  // The fixed string, not JSON.parse's message: a relay would change this.
  expect((err as Error).message).toBe("invitation payload is not valid JSON");
  for (const byte of PLANTED_DISPLAY_BYTES) {
    expect((err as Error).message).not.toContain(byte);
  }

  // Proves the swallow is load-bearing rather than the assertion vacuous: the
  // SAME bytes parsed raw DO leak into the engine's message, so without the
  // swallow at least one would reach the operator-facing alert. If a future
  // engine stopped quoting input this would fail here, signaling the swallow's
  // premise (not just our code) needs re-examination -- the right place to learn
  // it, rather than a silently toothless test elsewhere.
  let rawMessage = "";
  try {
    JSON.parse(hostile);
  } catch (e) {
    rawMessage = (e as Error).message;
  }
  expect(PLANTED_DISPLAY_BYTES.some((byte) => rawMessage.includes(byte))).toBe(
    true,
  );
});

test("decodeInvitation swallows the atob error, throwing only the fixed string", async () => {
  // Reach the atob catch through the real decode path: the body (everything but
  // the trailing 6-char checksum slot) carries the planted bytes, all outside the
  // base64url alphabet, so atob throws. Deliberately NO planted-bytes loop here,
  // unlike the JSON test: Node's atob never echoes its input (its message is the
  // fixed "Invalid character"), so no input byte can reach the thrown message
  // even with the swallow removed -- a not.toContain assertion would pass
  // vacuously and falsely imply this path is as load-bearing as the JSON one. The
  // regression guard is the fixed string itself: relaying atob's message (or one
  // that interpolated the offending input) changes it and fails the toBe below.
  const encoded = PLANTED_DISPLAY_BYTES.join("") + "AAAAAA";

  const err = await decodeInvitation(encoded).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toBe(
    "invitation string is not valid base64url",
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
// not locators either). `providerOptions` is the opaque transport-options map:
// it is operator-local-only by design and an invitation must never carry it, so
// this case pins that invariant -- a future change that let an invitation smuggle
// a `providerOptions` (and thus reach the SFTP connect path) would fail this test
// loudly. Every name is rejected by the same strictObject unrecognized-keys
// branch, so this matrix documents the invariant and guards against the allowlist
// being loosened (e.g. strictObject -> looseObject); it is not additional branch
// coverage. This list is a curated regression sample, not an exhaustive denylist
// -- the binding rule is the locator allowlist.
const FORBIDDEN_FIELDS = [
  "password",
  "privateKey",
  "privateKeyPassphrase",
  "certificate",
  "hostKeyFingerprint",
  "knownHosts",
  "key",
  "providerOptions",
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

test("escapes a hostile unrecognized endpoint key name in the rejection message", async () => {
  // The unrecognized-key rejection echoes the key NAME, which the inviter
  // controls; the shared describeDecodeError surfaces that message (the issue's
  // message string) to the accepting operator (CLI terminal or web accept
  // screen), relaying it as is. A name carrying control/ANSI bytes must be
  // escaped at this source, not relayed raw.
  const hostileKey = "\x1b[31mFAKE";
  const encoded = await encodeRaw({
    ...baseToken,
    connectionEndpoint: { ...CHANNEL_SHAPES.sftp.minimal, [hostileKey]: "x" },
  });
  const err = await decodeInvitation(encoded).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ZodError);
  const messages = (err as ZodError).issues.map((i) => i.message).join("\n");
  expect(messages).not.toContain("\x1b");
  expect(messages).toContain("\\x1b");
});

test("does not relay a hostile partner VALUE raw through describeDecodeError", async () => {
  // Sibling to the unrecognized-key test above, from the other direction: that
  // pins a partner-controlled KEY escaped at its source; this pins a
  // partner-controlled VALUE. An over-long identity (the inviter controls the
  // token) is rejected with a default Zod message, which reports the constraint
  // (a length) and not the offending value, so describeDecodeError -- which
  // relays the issue message verbatim -- must not surface the planted control
  // bytes. Pins that invariant end to end through the real schema: a future Zod
  // that began interpolating the rejected value into its default message would
  // trip this even though no source-level escape changed.
  const hostileValue = "\x1b[31m" + "A".repeat(MAX_TEXT_LENGTH);
  const encoded = await encodeRaw({
    ...baseToken,
    linkageTerms: { ...baseTerms, identity: hostileValue },
  });
  const err = await decodeInvitation(encoded).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ZodError);
  expect(describeDecodeError(err)).not.toContain("\x1b");
});

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

// --- Split-directory endpoint ------------------------------------------------

// A split sftp/filedrop endpoint carries the inviter's own inbound/outbound pair
// (the acceptor mirror-swaps it at connectionFromEndpoint, not here), so the
// token round-trips the pair verbatim -- the token stays a faithful record of
// the inviter's config. The directory-mode refines reject a half pair, both
// forms at once, or (filedrop) no directory at all.

const splitRoundTripCases: { name: string; endpoint: ConnectionEndpoint }[] = [
  {
    name: "sftp",
    endpoint: {
      channel: "sftp",
      host: "sftp.example",
      port: 2222,
      inboundPath: "/exchange/in",
      outboundPath: "/exchange/out",
    },
  },
  {
    name: "filedrop",
    endpoint: {
      channel: "filedrop",
      inboundPath: "/mnt/share/from-partner",
      outboundPath: "/mnt/share/to-partner",
    },
  },
];

test.each(splitRoundTripCases)(
  "round-trips a split-directory $name endpoint verbatim (no swap at the wire)",
  async ({ endpoint }) => {
    const decoded = await decodeInvitation(
      await encodeInvitation({ ...baseToken, connectionEndpoint: endpoint }),
    );
    expect(decoded.connectionEndpoint).toEqual(endpoint);
  },
);

test.each([
  {
    name: "an sftp endpoint with both a path and a split pair",
    bad: {
      channel: "sftp",
      host: "h",
      path: "/shared",
      inboundPath: "/in",
      outboundPath: "/out",
    },
  },
  {
    name: "a filedrop endpoint with both a path and a split pair",
    bad: {
      channel: "filedrop",
      path: "/shared",
      inboundPath: "/in",
      outboundPath: "/out",
    },
  },
  {
    name: "an sftp endpoint with only inbound_path (a half pair)",
    bad: { channel: "sftp", host: "h", inboundPath: "/in" },
  },
  {
    name: "an sftp endpoint with only outbound_path (a half pair)",
    bad: { channel: "sftp", host: "h", outboundPath: "/out" },
  },
  {
    name: "a filedrop endpoint with only inbound_path (a half pair)",
    bad: { channel: "filedrop", inboundPath: "/in" },
  },
  {
    name: "a filedrop endpoint with only outbound_path (a half pair)",
    bad: { channel: "filedrop", outboundPath: "/out" },
  },
  {
    name: "an sftp endpoint whose split halves are identical",
    bad: { channel: "sftp", host: "h", inboundPath: "/x", outboundPath: "/x" },
  },
  {
    name: "a filedrop endpoint whose split halves are identical",
    bad: { channel: "filedrop", inboundPath: "/x", outboundPath: "/x" },
  },
  {
    // Distinctness uses the same pathsResolveToSameDir rule as connection.ts, so
    // halves that differ only by a trailing slash resolve to one directory and
    // are rejected -- the swap would otherwise hand the acceptor an equal pair.
    name: "a filedrop endpoint whose split halves differ only by a trailing slash",
    bad: { channel: "filedrop", inboundPath: "/x", outboundPath: "/x/" },
  },
])("rejects $name", async ({ bad }) => {
  const encoded = await encodeRaw({ ...baseToken, connectionEndpoint: bad });
  await expect(decodeInvitation(encoded)).rejects.toThrow(ZodError);
});

test("encodeInvitation also rejects a malformed split endpoint (half pair)", async () => {
  // Symmetry with the decode-path rejections above: encodeInvitation validates
  // the token before serializing, so an inviter cannot mint a half-pair endpoint.
  const token = {
    ...baseToken,
    connectionEndpoint: { channel: "filedrop", inboundPath: "/in" },
  } as unknown as InvitationToken;
  await expect(encodeInvitation(token)).rejects.toThrow(ZodError);
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

// --- Untrusted-input bounds --------------------------------------------------

// The decoder accepts attacker-influenceable fields from a token whose only
// integrity check is a transcription checksum anyone can recompute, so each
// bound is exercised at the decode boundary -- the path both apps/cli and
// apps/web share. encodeRaw crafts a valid-checksum string that violates a bound
// (encodeInvitation could not, since it validates first).

test("rejects an encoded string longer than the maximum, before parsing", async () => {
  // A string over the cap is refused at the boundary before any base64-decode,
  // hash, or schema work. It is not even valid base64url, so a length-cap
  // rejection (rather than a downstream parse error) proves the early exit.
  const tooLong = "A".repeat(MAX_ENCODED_INVITATION_LENGTH + 1);
  await expect(decodeInvitation(tooLong)).rejects.toThrow(/maximum length/);
});

test("admits an encoded string at exactly the maximum length", async () => {
  // At exactly the cap the length gate passes and decode proceeds; this all-'A'
  // string then fails the checksum, NOT the length check, pinning the bound as
  // `>` rather than `>=`.
  const atMax = "A".repeat(MAX_ENCODED_INVITATION_LENGTH);
  await expect(decodeInvitation(atMax)).rejects.toThrow(/checksum/);
});

test("rejects a token whose identity exceeds the maximum length", async () => {
  const encoded = await encodeRaw({
    ...baseToken,
    linkageTerms: { ...baseTerms, identity: "x".repeat(MAX_TEXT_LENGTH + 1) },
  });
  await expect(decodeInvitation(encoded)).rejects.toThrow(ZodError);
});

test("rejects a token with more linkageKeys than the maximum count", async () => {
  const linkageKeys = Array.from(
    { length: MAX_LINKAGE_ENTRIES + 1 },
    (_, i) => ({ name: `K${i}`, elements: [{ field: "ssn" }] }),
  );
  const encoded = await encodeRaw({
    ...baseToken,
    linkageTerms: { ...baseTerms, linkageKeys },
  });
  await expect(decodeInvitation(encoded)).rejects.toThrow(ZodError);
});

test("rejects a token with more linkageFields than the maximum count", async () => {
  const linkageFields = Array.from(
    { length: MAX_LINKAGE_ENTRIES + 1 },
    (_, i) => ({ name: `f${i}`, type: "ssn" as const }),
  );
  const encoded = await encodeRaw({
    ...baseToken,
    linkageTerms: { ...baseTerms, linkageFields },
  });
  await expect(decodeInvitation(encoded)).rejects.toThrow(ZodError);
});

test("rejects a token whose linkage key name exceeds the maximum length", async () => {
  const encoded = await encodeRaw({
    ...baseToken,
    linkageTerms: {
      ...baseTerms,
      linkageKeys: [
        { name: "x".repeat(MAX_NAME_LENGTH + 1), elements: [{ field: "ssn" }] },
      ],
    },
  });
  await expect(decodeInvitation(encoded)).rejects.toThrow(ZodError);
});

test.each(["webrtc", "sftp"])(
  "rejects a %s endpoint whose host exceeds the maximum length",
  async (channel) => {
    const encoded = await encodeRaw({
      ...baseToken,
      connectionEndpoint: {
        channel,
        host: "h".repeat(MAX_ENDPOINT_HOST_LENGTH + 1),
      },
    });
    await expect(decodeInvitation(encoded)).rejects.toThrow(ZodError);
  },
);

test.each([
  {
    channel: "webrtc",
    endpoint: {
      channel: "webrtc",
      host: "h",
      path: "p".repeat(MAX_ENDPOINT_PATH_LENGTH + 1),
    },
  },
  {
    channel: "sftp",
    endpoint: {
      channel: "sftp",
      host: "h",
      path: "p".repeat(MAX_ENDPOINT_PATH_LENGTH + 1),
    },
  },
  {
    channel: "filedrop",
    endpoint: {
      channel: "filedrop",
      path: "p".repeat(MAX_ENDPOINT_PATH_LENGTH + 1),
    },
  },
])(
  "rejects a $channel endpoint whose path exceeds the maximum length",
  async ({ endpoint }) => {
    const encoded = await encodeRaw({
      ...baseToken,
      connectionEndpoint: endpoint,
    });
    await expect(decodeInvitation(encoded)).rejects.toThrow(ZodError);
  },
);

test("encodeInvitation rejects a token whose encoded output exceeds the maximum length", async () => {
  // Every field is within its per-field bound, but an unbounded exclude list
  // (bounded only by the encoded-length cap) inflates the token past the cap in
  // aggregate. encodeInvitation must refuse to produce a token it could not
  // decode, failing on the inviter's side rather than at the partner's decode.
  const exclude = Array.from({ length: 80 }, () => "x".repeat(MAX_TEXT_LENGTH));
  const token: InvitationToken = {
    ...baseToken,
    linkageTerms: {
      ...baseTerms,
      linkageFields: [
        { name: "ssn", type: "ssn" as const, constraints: { exclude } },
      ],
    },
  };
  await expect(encodeInvitation(token)).rejects.toThrow(/maximum length/);
});

test("round-trips an endpoint host and path at exactly the maximum length", async () => {
  // Pins the accept side of the endpoint bounds: a too-tight host or path cap
  // would fail this, which the over-long rejection tests above cannot catch.
  const endpoint = {
    channel: "webrtc" as const,
    host: "h".repeat(MAX_ENDPOINT_HOST_LENGTH),
    path: "/" + "p".repeat(MAX_ENDPOINT_PATH_LENGTH - 1),
  };
  const decoded = await decodeInvitation(
    await encodeInvitation({ ...baseToken, connectionEndpoint: endpoint }),
  );
  expect(decoded.connectionEndpoint).toEqual(endpoint);
});

test("decodes a large but legitimate invitation at the upper end of real size", async () => {
  // A maximal real token -- a long identity, several fields, many keys, a
  // payload, a legal agreement, and an endpoint, every value within its bound --
  // must round-trip unchanged, proving the caps clear any real invitation.
  const linkageFields = [
    { name: "ssn", type: "ssn" as const },
    { name: "ssn4", type: "ssn4" as const },
    { name: "firstName", type: "first_name" as const },
    { name: "lastName", type: "last_name" as const },
    { name: "dateOfBirth", type: "date_of_birth" as const },
    { name: "phone", type: "phone_number" as const },
    { name: "email", type: "email_address" as const },
  ];
  const linkageKeys = Array.from({ length: 30 }, (_, i) => ({
    name: `Key ${i}`,
    elements: [
      { field: "ssn" },
      { field: "lastName" },
      { field: "dateOfBirth" },
    ],
  }));
  const token: InvitationToken = {
    version: "1",
    sharedSecret: VALID_SECRET,
    linkageTerms: {
      version: "1.0.0",
      identity: "A".repeat(MAX_TEXT_LENGTH),
      date: "2025-01-01",
      algorithm: "psi",
      output: { expectsOutput: true, shareWithPartner: true },
      deduplicate: false,
      linkageFields,
      linkageKeys,
      payload: {
        send: [{ name: "score", description: "x".repeat(MAX_TEXT_LENGTH) }],
        receive: [{ name: "match" }],
      },
      legalAgreement: {
        reference: "x".repeat(MAX_NAME_LENGTH),
        purpose: "x".repeat(MAX_TEXT_LENGTH),
        expirationDate: "2099-01-01",
      },
    },
    connectionEndpoint: {
      channel: "webrtc",
      host: "h".repeat(MAX_ENDPOINT_HOST_LENGTH),
      port: 9000,
      path: "/psilink",
    },
  };
  const decoded = await decodeInvitation(await encodeInvitation(token));
  expect(decoded.linkageTerms.linkageKeys).toHaveLength(30);
  expect(decoded.linkageTerms.identity).toHaveLength(MAX_TEXT_LENGTH);
  expect(decoded.connectionEndpoint).toEqual(token.connectionEndpoint);
});
