import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";
import type { Arguments } from "yargs";
import { UsageError } from "@psilink/core";

import {
  connectionOverridesFrom,
  hostKeyFingerprintFlag,
} from "../../src/optionDefinitions";

function argv(extra: Record<string, unknown>): Arguments {
  return { _: [], $0: "psilink", ...extra } as unknown as Arguments;
}

const FP = "SHA256:" + "A".repeat(43);

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-optdefs-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Write a fingerprint file under the test dir and return its `@path` reference. */
function atFile(name: string, contents: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, contents);
  return `@${p}`;
}

// --- hostKeyFingerprintFlag ---------------------------------------------------

test("hostKeyFingerprintFlag: an absent flag is undefined", () => {
  expect(hostKeyFingerprintFlag(argv({}))).toBeUndefined();
});

test("hostKeyFingerprintFlag: a well-formed literal fingerprint is returned unchanged", () => {
  expect(
    hostKeyFingerprintFlag(argv({ "server-host-key-fingerprint": FP })),
  ).toBe(FP);
});

test("hostKeyFingerprintFlag: a malformed fingerprint is a UsageError naming the flag and format", () => {
  const run = (): string | undefined =>
    hostKeyFingerprintFlag(
      argv({ "server-host-key-fingerprint": "not-a-fingerprint" }),
    );
  expect(run).toThrow(UsageError);
  expect(run).toThrow(/--server-host-key-fingerprint/);
  expect(run).toThrow(/SHA256/);
});

test("hostKeyFingerprintFlag: a base64url signing-fingerprint-shaped value is rejected", () => {
  // The same confusable shape core's schema names specially (a signing
  // partner_fingerprint pasted in by mistake) must still be rejected here --
  // the CLI parser need not replicate the specific "looks like a signing
  // fingerprint" message, only refuse to let it through.
  const signingShaped = "B".repeat(42) + "A"; // base64url, 43 chars, no prefix
  expect(() =>
    hostKeyFingerprintFlag(
      argv({ "server-host-key-fingerprint": signingShaped }),
    ),
  ).toThrow(UsageError);
});

test("hostKeyFingerprintFlag: reads and validates an @file reference", () => {
  const ref = atFile("fp.txt", FP + "\n");
  expect(
    hostKeyFingerprintFlag(argv({ "server-host-key-fingerprint": ref })),
  ).toBe(FP);
});

test("hostKeyFingerprintFlag: an @file reference resolving to a malformed value is a UsageError naming the reference", () => {
  const ref = atFile("bad-fp.txt", "garbage\n");
  const run = (): string | undefined =>
    hostKeyFingerprintFlag(argv({ "server-host-key-fingerprint": ref }));
  expect(run).toThrow(UsageError);
  expect(run).toThrow(ref);
});

test("hostKeyFingerprintFlag: a missing @file reference is a UsageError naming the reference", () => {
  const ref = `@${path.join(dir, "absent.txt")}`;
  const run = (): string | undefined =>
    hostKeyFingerprintFlag(argv({ "server-host-key-fingerprint": ref }));
  expect(run).toThrow(UsageError);
  expect(run).toThrow(ref);
});

test("hostKeyFingerprintFlag: a repeated flag is rejected before format validation", () => {
  expect(() =>
    hostKeyFingerprintFlag(argv({ "server-host-key-fingerprint": [FP, FP] })),
  ).toThrow(/may be given only once/);
});

// --- connectionOverridesFrom ---------------------------------------------------

test("connectionOverridesFrom: fans serverHostKeyFingerprint into the server override block", () => {
  const overrides = connectionOverridesFrom({
    connectionTimeout: undefined,
    peerTimeout: undefined,
    pollingFrequencyMs: undefined,
    maxReconnectAttempts: undefined,
    serverUsername: undefined,
    serverPassword: undefined,
    serverPrivateKey: undefined,
    serverPrivateKeyPassphrase: undefined,
    serverKeyboardInteractive: undefined,
    serverHostKeyFingerprint: FP,
    serverPort: undefined,
    locklessRendezvous: undefined,
    peerId: undefined,
    timestampInFilename: undefined,
    retainFiles: undefined,
    outboundPath: undefined,
  });
  expect(overrides.server?.hostKeyFingerprint).toBe(FP);
});

test("connectionOverridesFrom: an absent serverHostKeyFingerprint stays absent", () => {
  const overrides = connectionOverridesFrom({
    connectionTimeout: undefined,
    peerTimeout: undefined,
    pollingFrequencyMs: undefined,
    maxReconnectAttempts: undefined,
    serverUsername: undefined,
    serverPassword: undefined,
    serverPrivateKey: undefined,
    serverPrivateKeyPassphrase: undefined,
    serverKeyboardInteractive: undefined,
    serverHostKeyFingerprint: undefined,
    serverPort: undefined,
    locklessRendezvous: undefined,
    peerId: undefined,
    timestampInFilename: undefined,
    retainFiles: undefined,
    outboundPath: undefined,
  });
  expect(overrides.server?.hostKeyFingerprint).toBeUndefined();
});
