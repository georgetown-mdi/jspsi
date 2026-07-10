import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  encodeInvitation,
  getDefaultLinkageTerms,
  UsageError,
} from "@psilink/core";
import type { InvitationToken } from "@psilink/core";
import {
  buildRotatedKeyFile,
  checkKeyFileExpiry,
  loadKeyFile,
  provisionKeyFileFromInvitation,
  saveKeyFile,
} from "../../src/keyFile";

// 43-char base64url token satisfying the sharedSecret format constraint.
const TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// A distinct 43-char base64url secret, to prove the provisioned key carries the
// token's secret rather than a coincidental default.
const INVITE_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM";

function inviteToken(expires?: string): InvitationToken {
  return {
    version: "1",
    linkageTerms: getDefaultLinkageTerms("Inviter Org"),
    sharedSecret: INVITE_SECRET,
    expires,
  };
}

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

test("loadKeyFile does not echo file content on an invalid-JSON key file", () => {
  // The key file holds the shared secret. A JSON parse failure must report
  // path-only: Node's JSON.parse echoes a snippet of the source start in its
  // message (here exactly the leading 10 chars), so a file that begins with the
  // secret would otherwise leak it. The 10-char marker leads the file so the old
  // (content-echoing) path would surface it; the guard must not.
  const keyPath = path.join(dir, ".psilink.key");
  const MARKER = "LEAKME1234";
  fs.writeFileSync(keyPath, `${MARKER} not json`);
  let caught: unknown;
  try {
    loadKeyFile(keyPath);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  expect((caught as Error).message).toContain(keyPath);
  expect((caught as Error).message).toContain("could not be parsed as JSON");
  expect((caught as Error).message).not.toContain(MARKER);
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

// --- provisionKeyFileFromInvitation ------------------------------------------

test("provisionKeyFileFromInvitation writes the token's secret and expiry, owner-only", async () => {
  // The inviter-side (composing-party) copy carries BOTH the shared secret and
  // the invitation's expiry -- matching `psilink invite`, contrast accept's copy
  // which strips the expiry. Owner-only permissions match saveKeyFile's write.
  const keyPath = path.join(dir, ".psilink.key");
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  const encoded = await encodeInvitation(inviteToken(expires));
  await provisionKeyFileFromInvitation(encoded, keyPath);
  const key = loadKeyFile(keyPath);
  expect(key?.sharedSecret).toBe(INVITE_SECRET);
  expect(key?.expires).toBe(expires);
  if (process.platform !== "win32")
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
});

test("provisionKeyFileFromInvitation resolves an @path invitation reference", async () => {
  // The @-file form (`--invitation @code.txt`) reads the code from a file so it
  // stays out of shell history; the resolved code provisions identically.
  const keyPath = path.join(dir, ".psilink.key");
  const codePath = path.join(dir, "code.txt");
  const encoded = await encodeInvitation(inviteToken());
  fs.writeFileSync(codePath, `${encoded}\n`);
  await provisionKeyFileFromInvitation(`@${codePath}`, keyPath);
  expect(loadKeyFile(keyPath)?.sharedSecret).toBe(INVITE_SECRET);
});

test("provisionKeyFileFromInvitation errors when a key file already exists and leaves it untouched", async () => {
  // A pre-existing key file is a clean, actionable error, never an overwrite:
  // the secret rotates after the first exchange, so re-supplying the original
  // code must not resurrect a stale secret.
  const keyPath = path.join(dir, ".psilink.key");
  const existing = JSON.stringify({ sharedSecret: TOKEN }) + "\n";
  fs.writeFileSync(keyPath, existing);
  const encoded = await encodeInvitation(inviteToken());
  await expect(
    provisionKeyFileFromInvitation(encoded, keyPath),
  ).rejects.toBeInstanceOf(UsageError);
  await expect(
    provisionKeyFileFromInvitation(encoded, keyPath),
  ).rejects.toThrow("already exists");
  // The pre-existing file is byte-for-byte unchanged.
  expect(fs.readFileSync(keyPath, "utf8")).toBe(existing);
});

test("provisionKeyFileFromInvitation refuses even when a concurrent writer wins the race after the pre-check passes", async () => {
  // Defeat detectFileConflicts's pre-check by making its lstatSync report ENOENT
  // exactly once (the path is genuinely free at that instant), then create the
  // real key file -- simulating a second process that provisions between the
  // pre-check and this call's write -- before letting lstatSync behave normally
  // again. The write-side guard (the exclusive create in saveKeyFile) must be the
  // one that catches this: it should refuse with the identical "already exists"
  // UsageError the pre-check itself raises, and must not overwrite the
  // concurrent writer's content.
  const keyPath = path.join(dir, ".psilink.key");
  const concurrentWriterContent =
    JSON.stringify({ sharedSecret: TOKEN }) + "\n";
  const realLstatSync = fs.lstatSync;
  let bypassedOnce = false;
  const lstatSpy = vi
    .spyOn(fs, "lstatSync")
    .mockImplementation((p: fs.PathLike, opts?: object) => {
      if (!bypassedOnce && p === keyPath) {
        bypassedOnce = true;
        fs.writeFileSync(keyPath, concurrentWriterContent);
        fs.chmodSync(keyPath, 0o600);
        const err = new Error(
          "ENOENT: no such file or directory",
        ) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- forwarding to the real overload
      return (realLstatSync as any)(p, opts);
    });
  try {
    const encoded = await encodeInvitation(inviteToken());
    await expect(
      provisionKeyFileFromInvitation(encoded, keyPath),
    ).rejects.toThrow("already exists");
    expect(bypassedOnce).toBe(true);
    // The concurrent writer's content survives untouched -- the invitation's
    // secret was never written over it.
    expect(fs.readFileSync(keyPath, "utf8")).toBe(concurrentWriterContent);
  } finally {
    lstatSpy.mockRestore();
  }
});

test("provisionKeyFileFromInvitation fails closed on a malformed code, writing nothing", async () => {
  const keyPath = path.join(dir, ".psilink.key");
  await expect(
    provisionKeyFileFromInvitation("not-a-valid-invitation", keyPath),
  ).rejects.toBeInstanceOf(UsageError);
  expect(fs.existsSync(keyPath)).toBe(false);
});

test("provisionKeyFileFromInvitation fails closed on an expired code, writing nothing", async () => {
  const keyPath = path.join(dir, ".psilink.key");
  const realNow = Date.now();
  const expires = new Date(realNow + 60_000).toISOString();
  // Encode while still in the future (encodeInvitation requires it), then advance
  // past the expiry so the decode rejects it by name.
  const encoded = await encodeInvitation(inviteToken(expires));
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(realNow + 120_000));
    await expect(
      provisionKeyFileFromInvitation(encoded, keyPath),
    ).rejects.toThrow(expires);
  } finally {
    vi.useRealTimers();
  }
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
