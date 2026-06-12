import { expect, test } from "vitest";

import {
  deriveAbortToken,
  ABORT_TOKEN_ROLES,
  deriveAeadKey,
  AEAD_CONTEXTS,
} from "../src/auth";
import {
  isAbortMarkerName,
  isExpectedAbortName,
} from "../src/connection/fileSyncConnection";
import { toBase64Url, fromBase64Url, bytesEqual } from "../src/utils/crypto";

const sessionKeyA = new Uint8Array(32).fill(0xa1);
const sessionKeyB = new Uint8Array(32).fill(0xb2);

// --- deriveAbortToken --------------------------------------------------------

test("deriveAbortToken is deterministic for the same session key and role", async () => {
  const t1 = await deriveAbortToken(sessionKeyA, "initiator");
  const t2 = await deriveAbortToken(sessionKeyA, "initiator");
  expect(t1).toHaveLength(32);
  expect(bytesEqual(t1, t2)).toBe(true);
});

test("deriveAbortToken yields distinct tokens per role (per-direction binding)", async () => {
  const initiator = await deriveAbortToken(sessionKeyA, "initiator");
  const responder = await deriveAbortToken(sessionKeyA, "responder");
  // A captured marker renamed to the other party's name carries the wrong-role
  // token, which the reader rejects -- this distinctness is what makes that safe.
  expect(bytesEqual(initiator, responder)).toBe(false);
});

test("deriveAbortToken yields distinct tokens per session key (no cross-session replay)", async () => {
  const a = await deriveAbortToken(sessionKeyA, "initiator");
  const b = await deriveAbortToken(sessionKeyB, "initiator");
  expect(bytesEqual(a, b)).toBe(false);
});

test("deriveAbortToken outputs never collide with the AEAD key from the same session key (domain separation)", async () => {
  // Both derivations take the session key as IKM; only their HKDF labels
  // ("psilink-abort-token-v1:<role>" vs "psilink-aead-v1:<context>") separate
  // them. If those labels ever collided, an abort token could substitute for an
  // AEAD key (or vice versa). Cross every abort role against every AEAD context
  // from one session key and assert no output coincides -- a real falsifier for a
  // label collision, not merely the per-role divergence checked above.
  for (const role of ABORT_TOKEN_ROLES) {
    const abortToken = await deriveAbortToken(sessionKeyA, role);
    expect(abortToken).toHaveLength(32);
    expect(abortToken.every((b) => b === 0)).toBe(false);
    for (const context of AEAD_CONTEXTS) {
      const aeadKey = await deriveAeadKey(sessionKeyA, context);
      expect(bytesEqual(abortToken, aeadKey)).toBe(false);
    }
  }
});

test("deriveAbortToken rejects an untyped role outside the frozen allowlist", async () => {
  await expect(
    // Cast past the compile-time type to exercise the runtime guard a plain-JS
    // caller would hit.
    deriveAbortToken(sessionKeyA, "attacker" as "initiator"),
  ).rejects.toThrow(/unknown abort-token role/);
});

// --- on-disk envelope roundtrip ----------------------------------------------

test("the abort envelope round-trips token bytes through base64url", async () => {
  const token = await deriveAbortToken(sessionKeyA, "responder");
  const envelope = { version: 1, token: toBase64Url(token) };
  const serialized = JSON.stringify(envelope);

  const parsed = JSON.parse(serialized) as { version: number; token: string };
  expect(parsed.version).toBe(1);
  const decoded = fromBase64Url(parsed.token);
  expect(bytesEqual(decoded, token)).toBe(true);
});

test("bytesEqual rejects a wrong-length decoded token without a separate length check", () => {
  const token = new Uint8Array(32).fill(7);
  const tooShort = new Uint8Array(16).fill(7);
  const tooLong = new Uint8Array(48).fill(7);
  expect(bytesEqual(token, tooShort)).toBe(false);
  expect(bytesEqual(token, tooLong)).toBe(false);
  expect(bytesEqual(token, new Uint8Array(32).fill(7))).toBe(true);
});

// --- recognizer subset invariant ---------------------------------------------

test("isExpectedAbortName is a subset of isAbortMarkerName", () => {
  const ids = [
    "self-id",
    "peer-id",
    "a",
    "11111111-1111-4111-8111-111111111111",
    "id-with-dashes-and-more",
  ];
  for (const selfId of ids) {
    for (const peerId of ids) {
      // Every name the exact-name recognizer accepts must also satisfy the
      // grammar-level recognizer, so the entry guard (isProtocolGrammarName, via
      // isAbortMarkerName) and the poll loop (isRecognizedLoopFile, via
      // isExpectedAbortName) cannot silently diverge.
      for (const name of [`${selfId}-abort.json`, `${peerId}-abort.json`]) {
        expect(isExpectedAbortName(name, selfId, peerId)).toBe(true);
        expect(isAbortMarkerName(name)).toBe(true);
      }
    }
  }
});

test("isExpectedAbortName rejects a foreign abort marker that isAbortMarkerName still accepts", () => {
  // A planted `<other>-abort.json` is grammar-recognized (so the entry guard
  // treats it as a protocol file, not a foreign one) but is NOT exact-name, so
  // the poll loop does not exempt it from the unexpected-files policy.
  expect(isAbortMarkerName("attacker-abort.json")).toBe(true);
  expect(isExpectedAbortName("attacker-abort.json", "self", "peer")).toBe(
    false,
  );
  // A bare suffix recovers no id and is neither expected nor (for the entry
  // guard's purposes) attributable to a party.
  expect(isExpectedAbortName("-abort.json", "self", "peer")).toBe(false);
});
