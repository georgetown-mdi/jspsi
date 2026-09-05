import { ZodError } from "zod";
import { expect, test } from "vitest";

import {
  encodeInvitation,
  decodeInvitation,
  hasExpiryInstantPassed,
  isInvitationExpired,
  INVITATION_LIFETIME_SECONDS,
  MAX_INVITATION_LIFETIME_SECONDS,
  MAX_ENCODED_INVITATION_LENGTH,
  MAX_RAW_INVITATION_LENGTH,
  MAX_ENDPOINT_HOST_LENGTH,
  MAX_ENDPOINT_PATH_LENGTH,
  stripInvitationWhitespace,
} from "../src/config/invitation";
import type {
  ConnectionEndpoint,
  InvitationToken,
} from "../src/config/invitation";
import {
  MAX_NAME_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_LINKAGE_ENTRIES,
  MAX_DATE_FORMAT_LENGTH,
  MAX_TRANSFORM_PARAM_LENGTH,
} from "../src/config/linkageTermsSchema";
import { summarizeInvitation } from "../src/consent/invitationSummary";
import { NestingDepthExceededError } from "../src/utils/camelizeKeys";
import { describeDecodeError } from "../src/utils/describeDecodeError";
import { sanitizeErrorForDisplay } from "../src/utils/sanitizeErrorForDisplay";
import { DISPLAY_TRUNCATION_MARKER } from "../src/utils/sanitizeForDisplay";

// A SHARED_SECRET_REGEX-valid placeholder (43 base64url chars = 32 zero bytes).
// InvitationTokenSchema enforces that shape, so test tokens hold a real one
// rather than a short literal.
const VALID_SECRET = "A".repeat(43);

const baseTerms = {
  version: "1.0.0",
  identity: "Test Party",
  date: "2025-01-01",
  algorithm: "psi" as const,
  linkageStrategy: "cascade" as const,
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
// invitation whose decoded bytes are NOT valid JSON, to exercise
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

test("hasExpiryInstantPassed: the verdict decides only the unparseable case", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  for (const onUnparseable of ["fail-closed", "fail-open"] as const) {
    const passed = (expires: string | undefined) =>
      hasExpiryInstantPassed(expires, now, { onUnparseable });
    expect(passed(undefined)).toBe(false);
    expect(passed("2025-12-31T23:59:59Z")).toBe(true);
    expect(passed("2026-01-01T00:00:00Z")).toBe(true);
    expect(passed("2026-01-01T01:00:00Z")).toBe(false);
  }
});

test("hasExpiryInstantPassed: fail-closed treats an unparseable expires as passed", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  for (const bad of ["not-a-date", "", "2026-13-99T99:99:99Z"]) {
    expect(
      hasExpiryInstantPassed(bad, now, { onUnparseable: "fail-closed" }),
    ).toBe(true);
  }
});

test("hasExpiryInstantPassed: fail-open treats an unparseable expires as not passed", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  for (const bad of ["not-a-date", "", "2026-13-99T99:99:99Z"]) {
    expect(
      hasExpiryInstantPassed(bad, now, { onUnparseable: "fail-open" }),
    ).toBe(false);
  }
});

test("hasExpiryInstantPassed: an unreadable now takes the verdict, not a silent not-passed", () => {
  const unreadableNow = new Date("not-a-date");
  const expires = "2025-12-31T23:59:59Z";
  expect(
    hasExpiryInstantPassed(expires, unreadableNow, {
      onUnparseable: "fail-closed",
    }),
  ).toBe(true);
  expect(
    hasExpiryInstantPassed(expires, unreadableNow, {
      onUnparseable: "fail-open",
    }),
  ).toBe(false);
  // An absent bound is no bound in force, whatever the clock reads.
  expect(
    hasExpiryInstantPassed(undefined, unreadableNow, {
      onUnparseable: "fail-closed",
    }),
  ).toBe(false);
});

test("isInvitationExpired: an unreadable now is expired, not usable", () => {
  expect(
    isInvitationExpired("2099-01-01T00:00:00Z", new Date("not-a-date")),
  ).toBe(true);
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

test("decodeInvitation rejects linkage terms holding an out-of-dialect transform regex", async () => {
  // A crafted invitation -- valid checksum (the checksum is a transcription-error
  // detector, not an authenticity guarantee, so anyone can recompute it over a
  // hostile payload) whose linkage terms embed a transform pattern outside the
  // linear-time dialect (a backreference, which the engine cannot compile).
  // InvitationTokenSchema embeds LinkageTermsSchema, so the dialect-conformance
  // check fires at decode, before any pattern executes. (A pattern that merely
  // backtracks catastrophically on `new RegExp`, like `(a+)+$`, is in-dialect
  // and accepted -- the linear-time engine runs it safely; see standardization
  // and linearRegex tests.)
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
                { function: "filter_regex", params: { pattern: "(a)\\1" } },
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
    /linear-time dialect/,
  );
});

// --- transform.params key-casing normalization at decode ---------------------
// The invitation decode path is the chokepoint that folds partner-controlled
// transform.params keys to camelCase (InvitationLinkageTermsSchema), so a
// decoded token's params match the form every other parse path produces and the
// per-step length and dialect screens run on the normalized form.

test("decodeInvitation normalizes snake_case transform.params keys to camelCase", async () => {
  // A hand-crafted token can hold snake_case params (the params record is
  // z.unknown() content with no key-form constraint). The decode chokepoint folds
  // them to camelCase, so a third-party token converges with a psilink-minted one
  // and the standardization runtime (which reads params.inputFormat) sees them.
  const token = {
    ...baseToken,
    linkageTerms: {
      ...baseTerms,
      linkageKeys: [
        {
          name: "DOB",
          elements: [
            {
              field: "ssn",
              transform: [
                {
                  function: "parse_date",
                  params: {
                    input_format: "MM/DD/YYYY",
                    output_format: "YYYYMMDD",
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };
  const decoded = await decodeInvitation(await encodeRaw(token));
  expect(
    decoded.linkageTerms.linkageKeys[0].elements[0].transform?.[0].params,
  ).toEqual({ inputFormat: "MM/DD/YYYY", outputFormat: "YYYYMMDD" });
});

test("decodeInvitation screens a snake_case parse_date inputFormat for length (the fold precedes the screen)", async () => {
  // The per-step length screen reads the camelCase `inputFormat`. Because the
  // decode fold runs BEFORE validation, a snake_case `input_format` over the
  // format-length cap is normalized first and then screened, so it is rejected --
  // not folded into effect after the screen already passed over the absent
  // camelCase key. (parse_date's catastrophic-backtracking exposure is closed by
  // the linear-time engine, not a screen; the residual the fold protects is the
  // length cap on the regex parse_date expands per row.)
  const token = {
    ...baseToken,
    linkageTerms: {
      ...baseTerms,
      linkageKeys: [
        {
          name: "DOB",
          elements: [
            {
              field: "ssn",
              transform: [
                {
                  function: "parse_date",
                  params: {
                    input_format: "M".repeat(MAX_DATE_FORMAT_LENGTH + 1),
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };
  await expect(decodeInvitation(await encodeRaw(token))).rejects.toThrow(
    /must not exceed/,
  );
});

test("decodeInvitation: a param spelling the fold leaves non-canonical is inert (screen and runtime read the same name)", async () => {
  // The complement of the length-screen test above: the per-step length screen
  // and the standardization runtime (parseDateFactory) both read the same
  // camelCase param name, `inputFormat`. A spelling the snake->camel fold does
  // NOT canonicalize to that name -- here SCREAMING_SNAKE `INPUT_FORMAT`, whose
  // `_F` the fold leaves intact (camelizeKeys only collapses `_` followed by a
  // lowercase letter) -- reaches neither: the length screen does not fire, and
  // the runtime never reads it (`params.inputFormat` is absent, so parse_date
  // falls back to its default format). The over-cap format is the same payload
  // the length-screen test rejects under the canonical key; under this
  // non-canonical key it parses cleanly and is left verbatim.
  const overCap = "M".repeat(MAX_DATE_FORMAT_LENGTH + 1);
  const token = {
    ...baseToken,
    linkageTerms: {
      ...baseTerms,
      linkageKeys: [
        {
          name: "DOB",
          elements: [
            {
              field: "ssn",
              transform: [
                {
                  function: "parse_date",
                  params: { INPUT_FORMAT: overCap },
                },
              ],
            },
          ],
        },
      ],
    },
  };
  const decoded = await decodeInvitation(await encodeRaw(token));
  const params =
    decoded.linkageTerms.linkageKeys[0].elements[0].transform?.[0].params;
  // The over-cap format stayed under the non-canonical key, untouched; the
  // canonical name the runtime reads is absent, so parse_date sees no format and
  // uses its default.
  expect(params).toEqual({ INPUT_FORMAT: overCap });
  expect(params).not.toHaveProperty("inputFormat");
});

test("decodeInvitation refuses a transform param over the content bound", async () => {
  // The content bound on a string-valued transform param sits on the params
  // record's value stage within LinkageTermsSchema, so the invitation-token decode
  // -- a partner's document, checksum-verified but not authenticated -- refuses it
  // like the other parse paths, before any row runs.
  const token = {
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
                {
                  function: "replace_regex",
                  params: {
                    pattern: "\\d",
                    replacement: "x".repeat(MAX_TRANSFORM_PARAM_LENGTH + 1),
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };
  await expect(decodeInvitation(await encodeRaw(token))).rejects.toThrow(
    /transform param must not exceed/,
  );
});

test("decodeInvitation rejects a deeply-nested transform.params at decode (bounded fold)", async () => {
  // transform.params is z.unknown() content, so a one-key-per-level params decodes
  // structurally (parseBoundedJson admits up to 4096 levels). The camelCase fold is
  // the bounded camelizeKeys walk, so params nested past MAX_NESTING_DEPTH is a clean
  // NestingDepthExceededError (a UsageError) at decode rather than a stack overflow
  // from a raw recursion. Build the value iteratively so the test does not recurse.
  let deep: Record<string, unknown> = { leaf: "x" };
  for (let i = 0; i < 3000; i++) deep = { a: deep };
  const token = {
    ...baseToken,
    linkageTerms: {
      ...baseTerms,
      linkageKeys: [
        {
          name: "K",
          elements: [
            { field: "ssn", transform: [{ function: "noop", params: deep }] },
          ],
        },
      ],
    },
  };
  await expect(decodeInvitation(await encodeRaw(token))).rejects.toThrow(
    NestingDepthExceededError,
  );
});

test("decodeInvitation accepts snake_case structural linkage-terms keys, like the config path", async () => {
  // Folding before validation makes the invitation path read snake_case
  // linkage-terms keys the same way a hand-authored config does (parseLinkageTerms
  // camelizes), so a token spelled snake_case at the structural level is accepted
  // and normalized, not rejected. Only the linkage-terms field is folded; the
  // token's other fields and the strict connection-endpoint allowlist are
  // unaffected (covered by their own tests).
  const token = {
    version: "1",
    sharedSecret: VALID_SECRET,
    linkageTerms: {
      version: "1.0.0",
      identity: "Test Party",
      date: "2025-01-01",
      algorithm: "psi",
      output: { expects_output: true, share_with_partner: false },
      deduplicate: false,
      linkage_fields: [{ name: "ssn", type: "ssn" }],
      linkage_keys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
    },
  };
  const decoded = await decodeInvitation(await encodeRaw(token));
  expect(decoded.linkageTerms.linkageFields[0].name).toBe("ssn");
  expect(decoded.linkageTerms.output.expectsOutput).toBe(true);
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

test("rejects invalid base64url characters in the body", async () => {
  // '!' is not a valid base64url character; pad to exceed CHECKSUM_CHARS
  await expect(decodeInvitation("!!!!!!!!!!!!")).rejects.toThrow(
    "not valid base64url",
  );
});

test("rejects an out-of-alphabet body character before the checksum comparison", async () => {
  // Everything else about this token is well-formed, so a decoder that reached
  // the checksum would report a mismatch instead.
  const encoded = await encodeInvitation(baseToken);
  const planted = encoded.slice(0, 4) + "!" + encoded.slice(5);
  await expect(decodeInvitation(planted)).rejects.toThrow(
    "invitation string is not valid base64url",
  );
});

test("rejects a body whose length is not a valid base64 length", async () => {
  // Seven characters: a one-character body ahead of the six-character checksum
  // slot, a length no base64 encoding produces.
  await expect(decodeInvitation("AAAAAAA")).rejects.toThrow(
    "invitation string is not valid base64url",
  );
});

test("rejects a body holding the whitespace a wrapped paste leaves", async () => {
  // The strictness the accept call sites normalize for: whitespace inside the
  // token is refused here, and stripInvitationWhitespace is what makes the same
  // paste decode. Pinning both halves keeps the call sites and the decoder in
  // agreement.
  const encoded = await encodeInvitation(baseToken);
  const wrapped = `${encoded.slice(0, 20)}\n  ${encoded.slice(20)}`;
  await expect(decodeInvitation(wrapped)).rejects.toThrow(
    "invitation string is not valid base64url",
  );
  const decoded = await decodeInvitation(stripInvitationWhitespace(wrapped));
  expect(decoded.sharedSecret).toBe(baseToken.sharedSecret);
});

test("stripInvitationWhitespace removes the ECMAScript whitespace class", () => {
  expect(stripInvitationWhitespace(" ab\n c\td\r\ne ")).toBe("abcde");
  // The trim-set code points a hard-wrapped or NBSP-padded paste can hold,
  // stripped at interior positions the same as at the edges.
  expect(stripInvitationWhitespace("ab\u00a0cd")).toBe("abcd");
  expect(stripInvitationWhitespace("ab\u2028cd")).toBe("abcd");
});

test("strips a raw input at exactly the raw bound", () => {
  // All whitespace, so the assertion separates a strip that ran from one the
  // bound check skipped: a skip would return the input untouched.
  const atBound = " ".repeat(MAX_RAW_INVITATION_LENGTH);
  expect(stripInvitationWhitespace(atBound)).toBe("");
});

test("passes a raw input one character over the raw bound through unchanged", () => {
  // All whitespace: a strip that ran anyway would return "", not the input
  // untouched.
  const overBound = " ".repeat(MAX_RAW_INVITATION_LENGTH + 1);
  expect(stripInvitationWhitespace(overBound)).toBe(overBound);
});

test("decodeInvitation refuses an over-bound raw input with the length message", async () => {
  const overBound = "a".repeat(MAX_RAW_INVITATION_LENGTH + 1);
  await expect(
    decodeInvitation(stripInvitationWhitespace(overBound)),
  ).rejects.toThrow(/exceeds the maximum length/);
});

// --- Decode-error message swallows (display-injection safety check) ----------

// decodeInvitation catches the JSON.parse and base64url-decode failures and
// rethrows a FIXED string rather than the underlying message, since that
// message can quote partner-controlled bytes. describeDecodeError relays it
// verbatim to the web accept page's alert (apps/web AcceptorBench), which
// renders it with no further escaping. These tests pin the swallow so a
// future refactor cannot relay the original message and reopen it.

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

  // Proves the swallow is required rather than the assertion vacuous: the
  // SAME bytes parsed raw DO leak into the engine's message, so without the
  // swallow at least one would reach the operator-facing alert. If a future
  // engine stopped quoting input this would fail here, signaling the swallow's
  // assumption (not just our code) needs re-examination -- the right place to
  // learn it, rather than a silently toothless test elsewhere.
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

test("decodeInvitation swallows the base64url decode error, throwing only the fixed string", async () => {
  // Reach the decode catch through the real path: the body (everything but the
  // trailing 6-char checksum slot) holds the planted bytes, all outside the
  // base64url alphabet, so the shared primitive rejects it. No planted-bytes
  // loop here, unlike the JSON test: neither the primitive's message nor
  // Node's atob beneath it echoes the input, so no input byte can reach the
  // thrown message even with the swallow removed -- a not.toContain assertion
  // would pass vacuously and falsely imply this path is as critical as the
  // JSON one. The regression guard is the fixed string
  // itself: relaying the primitive's message (or one that interpolated the
  // offending input) changes it and fails the toBe below.
  const encoded = PLANTED_DISPLAY_BYTES.join("") + "AAAAAA";

  const err = await decodeInvitation(encoded).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toBe(
    "invitation string is not valid base64url",
  );
});

// --- Expiry field ------------------------------------------------------------

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

test("rejects a token whose sharedSecret is not a base64url-encoded 32-byte value", async () => {
  // A non-empty but wrong-shape secret is caught at decode (matching the
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

// Locator shapes per channel: a minimal form (only required fields) and a
// full form (every optional field set). The filedrop full form uses a
// RELATIVE path on purpose -- the endpoint schema accepts one, since the
// acceptor remaps it to its own mount, unlike FileDropConnectionConfigSchema
// in connection.ts, which requires absolute. The type annotation holds every
// shape here to a valid, credential-free ConnectionEndpoint.
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

// Non-locator fields (credentials and server-identity material) named after
// the actual SFTP/PeerJS identifiers in connection.ts, which an endpoint must
// reject. `providerOptions` is the operator-local transport-options map an
// invitation must never hold, since it would reach the SFTP connect path. A
// curated regression sample, not exhaustive -- the binding rule is the locator
// allowlist.
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

// --- Disclosed-columns subset ------------------------------------------------

test("round-trips the inviter's disclosed-columns subset on the token", async () => {
  const token: InvitationToken = {
    ...baseToken,
    disclosedPayloadColumns: ["county", "enrollment_id"],
  };
  const decoded = await decodeInvitation(await encodeInvitation(token));
  expect(decoded.disclosedPayloadColumns).toEqual(["county", "enrollment_id"]);
  // An optional TOP-LEVEL addition does not bump the token version.
  expect(decoded.version).toBe("1");
});

test("a token minted without the disclosed-columns field still decodes (top-level back-compat)", async () => {
  // The field is an optional top-level addition on the non-strict token schema,
  // so a token shaped as one minted before it existed (no such key) decodes
  // unchanged -- the backward-compatibility property that licenses the
  // no-version-bump, exactly as connectionEndpoint took.
  const decoded = await decodeInvitation(
    await encodeRaw({
      version: "1",
      linkageTerms: baseTerms,
      sharedSecret: VALID_SECRET,
    }),
  );
  expect(decoded.disclosedPayloadColumns).toBeUndefined();
});

// --- Retain-mode declaration -------------------------------------------------

test("round-trips the inviter's retain-mode declaration on the token", async () => {
  const decoded = await decodeInvitation(
    await encodeInvitation({ ...baseToken, inviterRetainsFiles: true }),
  );
  expect(decoded.inviterRetainsFiles).toBe(true);
  // An optional TOP-LEVEL addition does not bump the token version.
  expect(decoded.version).toBe("1");
});

test("a token minted without the retain declaration still decodes (top-level back-compat)", async () => {
  // The case an invitation minted before the field existed presents: no such
  // key at all. The non-strict token schema ignores its absence, and the field
  // arrives undefined -- "nothing declared", which is not "delete mode".
  const decoded = await decodeInvitation(
    await encodeRaw({
      version: "1",
      linkageTerms: baseTerms,
      sharedSecret: VALID_SECRET,
    }),
  );
  expect(decoded.inviterRetainsFiles).toBeUndefined();
});

test("decodeInvitation returns a declared-false retain mode verbatim", async () => {
  // A foreign implementation may state the negative. It decodes rather than
  // being rejected, and stays distinguishable from an absent declaration on the
  // token; what neither states on a consent surface is the summary's business.
  const decoded = await decodeInvitation(
    await encodeRaw({ ...baseToken, inviterRetainsFiles: false }),
  );
  expect(decoded.inviterRetainsFiles).toBe(false);
});

test("decodeInvitation rejects a non-boolean retain declaration", async () => {
  const encoded = await encodeRaw({
    ...baseToken,
    inviterRetainsFiles: "true",
  });
  await expect(decodeInvitation(encoded)).rejects.toThrow(ZodError);
});

test.each([
  { half: "encodeInvitation", run: encodeInvitation },
  {
    half: "decodeInvitation",
    run: async (token: InvitationToken) =>
      decodeInvitation(await encodeRaw(token)),
  },
])(
  "$half refuses a retain declaration on a webrtc endpoint",
  async ({ run }) => {
    // retain_files is a file-sync option the webrtc channel does not have (the
    // connection schema rejects the same pairing), so a token declaring one is
    // stating a mode no run of it could be in. Refused at both halves, so
    // neither a mint path nor a consent surface can hold it.
    const token: InvitationToken = {
      ...baseToken,
      connectionEndpoint: { channel: "webrtc", host: "example.test" },
      inviterRetainsFiles: true,
    };
    await expect(run(token)).rejects.toThrow(/not valid for a webrtc/);
  },
);

test("a webrtc endpoint may still hold an explicit false or no declaration", async () => {
  // The refusal is scoped to the claim, not to the field: a webrtc token that
  // declares nothing (the ordinary web mint) and one that states the negative
  // both encode, so the guard cannot become a reason to strip the field.
  const withFalse = await decodeInvitation(
    await encodeInvitation({
      ...baseToken,
      connectionEndpoint: { channel: "webrtc", host: "example.test" },
      inviterRetainsFiles: false,
    }),
  );
  expect(withFalse.inviterRetainsFiles).toBe(false);
  const withNone = await decodeInvitation(
    await encodeInvitation({
      ...baseToken,
      connectionEndpoint: { channel: "webrtc", host: "example.test" },
    }),
  );
  expect(withNone.inviterRetainsFiles).toBeUndefined();
});

test("a file-sync invitation with no endpoint may declare retain mode", async () => {
  // The offline invite path mints terms and a declaration with no locator
  // beside them, so the webrtc guard must not read an absent endpoint as one.
  const decoded = await decodeInvitation(
    await encodeInvitation({ ...baseToken, inviterRetainsFiles: true }),
  );
  expect(decoded.connectionEndpoint).toBeUndefined();
  expect(decoded.inviterRetainsFiles).toBe(true);
});

// A split inbound/outbound endpoint on each file-sync channel: a shape that puts
// every connection built from it in retain mode, so it is the endpoint an
// explicit `inviterRetainsFiles: false` contradicts.
const splitRetainEndpoints: { name: string; endpoint: ConnectionEndpoint }[] = [
  {
    name: "sftp",
    endpoint: {
      channel: "sftp",
      host: "sftp.example",
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

test.each(
  splitRetainEndpoints.flatMap(({ name, endpoint }) => [
    { name, half: "encodeInvitation", endpoint, run: encodeInvitation },
    {
      name,
      half: "decodeInvitation",
      endpoint,
      run: async (token: InvitationToken) =>
        decodeInvitation(await encodeRaw(token)),
    },
  ]),
)(
  "$half refuses a declared-false retain mode on a split $name endpoint",
  async ({ endpoint, run }) => {
    // The endpoint's shape seeds the acceptor into retain mode whatever the
    // token says, so the negative declares a mode no run of it could be in --
    // refused at both halves rather than left to the consent summary to render
    // the safe side over it.
    const token: InvitationToken = {
      ...baseToken,
      connectionEndpoint: endpoint,
      inviterRetainsFiles: false,
    };
    await expect(run(token)).rejects.toThrow(/cannot be false/);
  },
);

test.each(splitRetainEndpoints)(
  "a split $name endpoint may declare retain mode",
  async ({ endpoint }) => {
    const decoded = await decodeInvitation(
      await encodeInvitation({
        ...baseToken,
        connectionEndpoint: endpoint,
        inviterRetainsFiles: true,
      }),
    );
    expect(decoded.inviterRetainsFiles).toBe(true);
  },
);

test.each(splitRetainEndpoints)(
  "encodeInvitation refuses to mint a split $name endpoint with no retain declaration",
  async ({ endpoint }) => {
    // The mint-only half of the asymmetry: psilink never EMITS a rendezvous whose
    // permanent transcript is readable from the locator's shape alone, since any
    // artifact composed from the declaration -- an accept kit's file-handling
    // disclosure -- would then state nothing. Held at this one call site rather
    // than at each producer's own gate, so no mint path can reach the state by
    // omission.
    await expect(
      encodeInvitation({ ...baseToken, connectionEndpoint: endpoint }),
    ).rejects.toThrow(/inviterRetainsFiles must be true/);
  },
);

test.each(splitRetainEndpoints)(
  "the same undeclared split $name token still decodes and summarizes as retaining",
  async ({ endpoint }) => {
    // The decode half of the very shape the mint above refuses: a foreign or
    // older implementation may emit it, psilink handles it correctly today, and
    // tightening the shared schema would reject it on a public protocol surface
    // for nothing. Absence stays "nothing declared" rather than a contradicted
    // negative, so neither the mint rule nor the false-declaration refusal may
    // swallow it -- and the summary states the retention on the endpoint's shape
    // regardless, so nothing an acceptor is shown depends on the mint-side rule.
    const token = { ...baseToken, connectionEndpoint: endpoint };
    const decoded = await decodeInvitation(await encodeRaw(token));
    expect(decoded.inviterRetainsFiles).toBeUndefined();
    expect(decoded.connectionEndpoint).toEqual(endpoint);
    expect(summarizeInvitation(decoded).disclosesRetainedFiles).toBe(true);
  },
);

// The same two channels using a single shared directory: a shape that
// requires nothing of the mode, so it is the control the refusal must not catch.
const sharedDirEndpoints: { name: string; endpoint: ConnectionEndpoint }[] = [
  {
    name: "sftp",
    endpoint: { channel: "sftp", host: "sftp.example", path: "/exchange" },
  },
  {
    name: "filedrop",
    endpoint: { channel: "filedrop", path: "/mnt/share" },
  },
];

test.each(sharedDirEndpoints)(
  "a single-directory $name endpoint may still declare a false retain mode",
  async ({ endpoint }) => {
    // The refusal is keyed on the shape that requires retention, not on the
    // channel: a shared directory runs in either mode, so the negative is a
    // statable (if unstated) fact there and must still decode.
    const decoded = await decodeInvitation(
      await encodeInvitation({
        ...baseToken,
        connectionEndpoint: endpoint,
        inviterRetainsFiles: false,
      }),
    );
    expect(decoded.inviterRetainsFiles).toBe(false);
  },
);

test("encodeInvitation rejects a disclosed-columns entry with an empty name", async () => {
  const token = {
    ...baseToken,
    disclosedPayloadColumns: [""],
  } as unknown as InvitationToken;
  await expect(encodeInvitation(token)).rejects.toThrow(ZodError);
});

test("decodeInvitation rejects a disclosed-columns entry with an empty name", async () => {
  const encoded = await encodeRaw({
    ...baseToken,
    disclosedPayloadColumns: [""],
  });
  await expect(decodeInvitation(encoded)).rejects.toThrow(ZodError);
});

test.each(credentialCases)(
  "encodeInvitation rejects a $channel endpoint holding $field",
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
  "decodeInvitation rejects a $channel endpoint holding $field",
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
  // controls; the shared describeDecodeError exposes that message (the issue's
  // message string) to the accepting operator (CLI terminal or web accept
  // screen), relaying it as is. A name holding control/ANSI bytes must be
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

test("the locator rejection's guidance survives the display boundary whole", async () => {
  // The guidance is the whole point of this rejection: it says what a locator may
  // hold, why every other field is refused, and what to remove. It is fixed
  // first-party copy longer than one VALUE's budget, and the boundary an operator
  // reads it through is sanitizeErrorForDisplay over the composed rejection --
  // where a per-value cap would deliver a prefix of the sentence instead. Driven
  // through the real schema and the real renderer, over the composition the CLI's
  // decode wrapper makes, so a copy edit that outgrows the link budget fails here
  // rather than silently landing cut in front of an operator.
  //
  // The prefix below is core's restatement of that wrapper -- core cannot import
  // the CLI -- so it holds the guidance against THIS budget and not against a
  // later edit to what the CLI composes ahead of it. That half is driven from the
  // side that can call it: apps/cli/test/unit/invitationDecodeBudget.test.ts runs
  // the real decodeAndValidateInvitation over the same rejection.
  const encoded = await encodeRaw({
    ...baseToken,
    connectionEndpoint: { ...CHANNEL_SHAPES.sftp.minimal, username: "alice" },
  });
  const err = await decodeInvitation(encoded).catch((e: unknown) => e);
  const rendered = sanitizeErrorForDisplay(
    new Error(`invalid invitation string: ${describeDecodeError(err)}`),
  );
  expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
  expect(rendered).toContain("a connection endpoint may carry only a");
  expect(rendered).toContain(
    "can ride along. Remove unexpected field(s): username",
  );
});

test("does not relay a hostile partner VALUE raw through describeDecodeError", async () => {
  // Sibling to the unrecognized-key test above, from the other direction: that
  // pins a partner-controlled KEY escaped at its source; this pins a
  // partner-controlled VALUE. An over-long identity (the inviter controls the
  // token) is rejected with a default Zod message, which reports the constraint
  // (a length) and not the offending value, so describeDecodeError -- which
  // relays the issue message verbatim -- must not expose the planted control
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

// A split sftp/filedrop endpoint holds the inviter's own inbound/outbound pair
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
    // Minted with the retain declaration the mint schema requires beside this
    // shape; what this case pins is the directory pair surviving the wire
    // unswapped, not the declaration's own rules.
    const decoded = await decodeInvitation(
      await encodeInvitation({
        ...baseToken,
        connectionEndpoint: endpoint,
        inviterRetainsFiles: true,
      }),
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
  // bypassing the types does not reach the wire. decode would re-strip, so
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
      linkageStrategy: "cascade",
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
