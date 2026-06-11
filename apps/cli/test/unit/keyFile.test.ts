import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { UsageError } from "@psilink/core";
import {
  buildRotatedKeyFile,
  checkKeyFileExpiry,
  loadKeyFile,
  saveKeyFile,
} from "../../src/keyFile";

// 43-char base64url token satisfying the sharedSecret format constraint.
const TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- loadKeyFile -------------------------------------------------------------

test("loadKeyFile returns undefined when the file does not exist", () => {
  const result = loadKeyFile(path.join(dir, "missing.key"));
  expect(result).toBeUndefined();
});

test("loadKeyFile parses a valid key file with sharedSecret and expires", () => {
  const keyPath = path.join(dir, ".psilink.key");
  fs.writeFileSync(
    keyPath,
    JSON.stringify({
      sharedSecret: TOKEN,
      expires: "2027-01-01T00:00:00.000Z",
    }),
  );
  fs.chmodSync(keyPath, 0o600);
  const result = loadKeyFile(keyPath);
  expect(result?.sharedSecret).toBe(TOKEN);
  expect(result?.expires).toBe("2027-01-01T00:00:00.000Z");
});

test("loadKeyFile parses a valid key file with sharedSecret only", () => {
  const keyPath = path.join(dir, ".psilink.key");
  fs.writeFileSync(keyPath, JSON.stringify({ sharedSecret: TOKEN }));
  fs.chmodSync(keyPath, 0o600);
  const result = loadKeyFile(keyPath);
  expect(result?.sharedSecret).toBe(TOKEN);
  expect(result?.expires).toBeUndefined();
});

test("loadKeyFile throws when sharedSecret is missing", () => {
  const keyPath = path.join(dir, ".psilink.key");
  fs.writeFileSync(
    keyPath,
    JSON.stringify({ expires: "2027-01-01T00:00:00.000Z" }),
  );
  expect(() => loadKeyFile(keyPath)).toThrow();
});

test("loadKeyFile throws when sharedSecret is empty", () => {
  const keyPath = path.join(dir, ".psilink.key");
  fs.writeFileSync(keyPath, JSON.stringify({ sharedSecret: "" }));
  expect(() => loadKeyFile(keyPath)).toThrow();
});

test("loadKeyFile throws when expires is not a valid ISO 8601 datetime", () => {
  const keyPath = path.join(dir, ".psilink.key");
  fs.writeFileSync(
    keyPath,
    JSON.stringify({ sharedSecret: TOKEN, expires: "not-a-date" }),
  );
  expect(() => loadKeyFile(keyPath)).toThrow();
});

// --- saveKeyFile -------------------------------------------------------------

test("saveKeyFile writes a file that loadKeyFile can read back", () => {
  const keyPath = path.join(dir, ".psilink.key");
  saveKeyFile(keyPath, {
    sharedSecret: TOKEN,
    expires: "2028-06-01T12:00:00.000Z",
  });
  const result = loadKeyFile(keyPath);
  expect(result?.sharedSecret).toBe(TOKEN);
  expect(result?.expires).toBe("2028-06-01T12:00:00.000Z");
});

test("saveKeyFile writes valid JSON with a trailing newline", () => {
  const keyPath = path.join(dir, ".psilink.key");
  saveKeyFile(keyPath, { sharedSecret: TOKEN });
  const raw = fs.readFileSync(keyPath, "utf8");
  expect(() => JSON.parse(raw)).not.toThrow();
  expect(raw.endsWith("\n")).toBe(true);
});

test("saveKeyFile rejects a malformed sharedSecret before writing to disk", () => {
  const keyPath = path.join(dir, ".psilink.key");
  // UsageError (not a plain Error) so the CLI classifies it as exit 64, not a
  // transport failure (exit 69).
  expect(() => saveKeyFile(keyPath, { sharedSecret: "too-short" })).toThrow(
    UsageError,
  );
  expect(() => saveKeyFile(keyPath, { sharedSecret: "too-short" })).toThrow(
    "base64url-encoded 32-byte value",
  );
  // No file should have been written.
  expect(fs.existsSync(keyPath)).toBe(false);
});

// --- buildRotatedKeyFile -----------------------------------------------------

// A fixed clock so the computed `expires` can be asserted exactly rather than
// within a tolerance (the production caller passes Date.now()).
const FIXED_NOW = Date.parse("2026-01-01T00:00:00.000Z");

test("buildRotatedKeyFile stamps expires = now + tokenMaxAgeDays days when set", () => {
  const result = buildRotatedKeyFile(TOKEN, 30, FIXED_NOW);
  expect(result.sharedSecret).toBe(TOKEN);
  // 2026-01-01 + 30 days = 2026-01-31 (January has 31 days).
  expect(result.expires).toBe("2026-01-31T00:00:00.000Z");
});

test("buildRotatedKeyFile omits expires when tokenMaxAgeDays is undefined", () => {
  const result = buildRotatedKeyFile(TOKEN, undefined, FIXED_NOW);
  expect(result.sharedSecret).toBe(TOKEN);
  expect(result.expires).toBeUndefined();
});

test("buildRotatedKeyFile uses the exact 86_400_000 ms-per-day formula", () => {
  const result = buildRotatedKeyFile(TOKEN, 1, FIXED_NOW);
  expect(Date.parse(result.expires as string) - FIXED_NOW).toBe(86_400_000);
});

test("buildRotatedKeyFile rejects a non-positive tokenMaxAgeDays", () => {
  // Belt-and-suspenders against a caller bypassing schema validation: 0 or a
  // negative would stamp an immediately-expired token. UsageError -> exit 64.
  expect(() => buildRotatedKeyFile(TOKEN, 0, FIXED_NOW)).toThrow(UsageError);
  expect(() => buildRotatedKeyFile(TOKEN, -5, FIXED_NOW)).toThrow(UsageError);
});

test("buildRotatedKeyFile rejects a non-integer tokenMaxAgeDays", () => {
  // A float would stamp a sub-day boundary the schema's z.int() forbids.
  expect(() => buildRotatedKeyFile(TOKEN, 1.5, FIXED_NOW)).toThrow(UsageError);
});

test("buildRotatedKeyFile rejects a tokenMaxAgeDays that overflows the date range", () => {
  // Backstop for a caller bypassing the config-schema cap (MAX_TOKEN_MAX_AGE_DAYS):
  // a value whose `now + N days` stamp leaves the representable Date range fails
  // as a UsageError (exit 64) here, not as an opaque RangeError from toISOString()
  // after a handshake. ~1e8 days overflows the Date range; ~5e6 days stays in
  // range but stamps a >4-digit ISO year that loadKeyFile could not parse back.
  expect(() => buildRotatedKeyFile(TOKEN, 100_000_000, FIXED_NOW)).toThrow(
    UsageError,
  );
  expect(() => buildRotatedKeyFile(TOKEN, 5_000_000, FIXED_NOW)).toThrow(
    UsageError,
  );
});

// --- checkKeyFileExpiry ------------------------------------------------------

test("checkKeyFileExpiry returns ok when there is no expires", () => {
  expect(checkKeyFileExpiry({ sharedSecret: TOKEN }, FIXED_NOW)).toBe("ok");
});

test("checkKeyFileExpiry returns expired when expires is at or before now", () => {
  expect(
    checkKeyFileExpiry(
      { sharedSecret: TOKEN, expires: "2025-12-31T23:59:59.000Z" },
      FIXED_NOW,
    ),
  ).toBe("expired");
  // Exactly now counts as expired.
  expect(
    checkKeyFileExpiry(
      { sharedSecret: TOKEN, expires: new Date(FIXED_NOW).toISOString() },
      FIXED_NOW,
    ),
  ).toBe("expired");
});

test("checkKeyFileExpiry returns ok for a future token when no threshold is given", () => {
  // Without a threshold (no max-age policy in force) an unexpired token is ok,
  // never expiring-soon; only the unconditional expired stop applies.
  expect(
    checkKeyFileExpiry(
      { sharedSecret: TOKEN, expires: "2026-01-02T00:00:00.000Z" },
      FIXED_NOW,
    ),
  ).toBe("ok");
});

test("checkKeyFileExpiry returns expiring-soon within the threshold window", () => {
  // 5 days remaining, threshold 10 days -> expiring soon.
  expect(
    checkKeyFileExpiry(
      { sharedSecret: TOKEN, expires: "2026-01-06T00:00:00.000Z" },
      FIXED_NOW,
      { warnThresholdDays: 10 },
    ),
  ).toBe("expiring-soon");
});

test("checkKeyFileExpiry returns ok beyond the threshold window", () => {
  // 20 days remaining, threshold 10 days -> ok.
  expect(
    checkKeyFileExpiry(
      { sharedSecret: TOKEN, expires: "2026-01-21T00:00:00.000Z" },
      FIXED_NOW,
      { warnThresholdDays: 10 },
    ),
  ).toBe("ok");
});

test("checkKeyFileExpiry treats an unparseable expires as expired (fail closed)", () => {
  // Defense-in-depth for a caller bypassing loadKeyFile's ISO-datetime validation:
  // a malformed timestamp must not be classified as "ok" (NaN <= now is false).
  expect(
    checkKeyFileExpiry(
      { sharedSecret: TOKEN, expires: "not-a-date" },
      FIXED_NOW,
    ),
  ).toBe("expired");
});

test("checkKeyFileExpiry returns expired even when a threshold is given", () => {
  // The expired hard stop takes precedence over the expiring-soon window.
  expect(
    checkKeyFileExpiry(
      { sharedSecret: TOKEN, expires: "2025-06-01T00:00:00.000Z" },
      FIXED_NOW,
      { warnThresholdDays: 10 },
    ),
  ).toBe("expired");
});

test("checkKeyFileExpiry handles a fractional threshold (non-multiple of 3)", () => {
  // token_max_age_days / 3 is fractional for non-multiples (10 / 3 = 3.333...);
  // the millisecond comparison handles it without rounding. 3 days remaining is
  // within 3.333 days (expiring soon); 4 days remaining is beyond it (ok).
  const threshold = 10 / 3;
  expect(
    checkKeyFileExpiry(
      { sharedSecret: TOKEN, expires: "2026-01-04T00:00:00.000Z" },
      FIXED_NOW,
      { warnThresholdDays: threshold },
    ),
  ).toBe("expiring-soon");
  expect(
    checkKeyFileExpiry(
      { sharedSecret: TOKEN, expires: "2026-01-05T00:00:00.000Z" },
      FIXED_NOW,
      { warnThresholdDays: threshold },
    ),
  ).toBe("ok");
});
