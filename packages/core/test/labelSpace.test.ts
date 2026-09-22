import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { ABORT_TOKEN_ROLES, AEAD_CONTEXTS } from "../src/auth";
import { RENDEZVOUS_ROLES } from "../src/rendezvous";

// The domain-separation label space of docs/spec/PROTOCOL.md ("The
// domain-separation label space"), every member expanded over its fixed suffix
// set. The HKDF info strings are not length-prefixed, so they must be
// prefix-free; the three JSON-field domains at the end are held to it as well.
const LABELS: readonly string[] = [
  "psilink-kex-v1:session",
  "psilink-kex-v1:confirm",
  "psilink-kex-v1:initiator-confirm",
  "psilink-kex-v1:responder-confirm",
  ...AEAD_CONTEXTS.map((context) => `psilink-aead-v1:${context}`),
  "psilink-shared-secret-rotation-v1",
  ...ABORT_TOKEN_ROLES.map((role) => `psilink-abort-token-v1:${role}`),
  ...RENDEZVOUS_ROLES.map((role) => `psilink-webrtc-peerid-v1:${role}`),
  "psilink-signed-receipt-payload-v1:initiator-to-responder",
  "psilink-signed-receipt-payload-v1:responder-to-initiator",
  "psilink-signed-receipt-binder-v1:initiator",
  "psilink-signed-receipt-binder-v1:responder",
  "psilink-relay-key-v1",
  "psilink-signed-receipt-content/v2",
  "psilink-signing-cert-signature/v1",
  "psilink-signing-cert-fingerprint/v1",
];

// `psilink-kex-v2:NNpsk0_P256_SHA256` is the key exchange's protocol name,
// hashed into the transcript rather than used as a derivation label.
const NOT_DERIVATION_LABELS = new Set(["psilink-kex-v2"]);

const CORE_SRC = fileURLToPath(new URL("../src", import.meta.url));

function coreSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return coreSourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("the domain-separation label space", () => {
  test("no label equals or is a prefix of another", () => {
    const clashes: string[] = [];
    for (const [i, a] of LABELS.entries()) {
      for (const [j, b] of LABELS.entries()) {
        if (i !== j && b.startsWith(a)) clashes.push(`${a} / ${b}`);
      }
    }
    expect(clashes).toEqual([]);
  });

  test("every versioned psilink- family in core's source is enumerated", () => {
    const families = new Set<string>();
    for (const file of coreSourceFiles(CORE_SRC)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/["'`](psilink-[a-z0-9-]+-v\d+)/g)) {
        families.add(match[1] as string);
      }
    }
    const unlisted = [...families].filter(
      (family) =>
        !NOT_DERIVATION_LABELS.has(family) &&
        !LABELS.some(
          (label) => label === family || label.startsWith(`${family}:`),
        ),
    );
    expect(families.size).toBeGreaterThan(0);
    expect(unlisted).toEqual([]);
  });
});
