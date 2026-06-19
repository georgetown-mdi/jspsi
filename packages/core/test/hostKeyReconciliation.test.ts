import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { reconcileHostKeyFingerprints } from "../src/hostKeyReconciliation";
import { prepareForExchange, runExchange } from "../src/exchange";
import { createMessagePipe } from "../src/connection/messageConnection";
import type { PresentedHostKey } from "../src/connection/fileSyncConnection";
import type { Output } from "../src/config/linkageTerms";

// Cross-party reconciliation of the SFTP host-key fingerprint (201058119). Each
// party advertises the host key it observed in the authenticated post-handshake
// terms exchange; a divergence is surfaced so a one-sided interception, or a
// server rekey between the two parties' setups, becomes detectable to both.

// Plausible OpenSSH SHA256 fingerprints. reconcileHostKeyFingerprints compares
// the strings verbatim, so the exact bytes do not matter -- only that they
// differ where intended.
const KEY_ED25519: PresentedHostKey = {
  fingerprint: "SHA256:" + "a".repeat(43),
  keyType: "ssh-ed25519",
};
const KEY_ED25519_OTHER: PresentedHostKey = {
  fingerprint: "SHA256:" + "b".repeat(43),
  keyType: "ssh-ed25519",
};
const KEY_RSA: PresentedHostKey = {
  fingerprint: "SHA256:" + "c".repeat(43),
  keyType: "ssh-rsa",
};

// --- reconcileHostKeyFingerprints (pure) -------------------------------------

test("matching fingerprints reconcile to no divergence", () => {
  expect(
    reconcileHostKeyFingerprints(KEY_ED25519, { ...KEY_ED25519 }),
  ).toBeUndefined();
});

test("a missing observed key on either side is not a divergence", () => {
  expect(reconcileHostKeyFingerprints(undefined, KEY_ED25519)).toBeUndefined();
  expect(reconcileHostKeyFingerprints(KEY_ED25519, undefined)).toBeUndefined();
  expect(reconcileHostKeyFingerprints(undefined, undefined)).toBeUndefined();
});

test("a same-type fingerprint difference warns and names both values", () => {
  const msg = reconcileHostKeyFingerprints(KEY_ED25519, KEY_ED25519_OTHER);
  expect(msg).toBeDefined();
  // Names both observed fingerprints.
  expect(msg).toContain(KEY_ED25519.fingerprint);
  expect(msg).toContain(KEY_ED25519_OTHER.fingerprint);
  // Same type: narrowed to rekey-or-interception, with no benign-type clause.
  expect(msg).toMatch(/rotation/);
  expect(msg).toMatch(/interception/);
  expect(msg).not.toMatch(/multiple/);
});

test("a different-type difference adds the benign multiple-host-key case", () => {
  const msg = reconcileHostKeyFingerprints(KEY_ED25519, KEY_RSA);
  expect(msg).toBeDefined();
  expect(msg).toContain(KEY_ED25519.fingerprint);
  expect(msg).toContain(KEY_RSA.fingerprint);
  expect(msg).toContain("ssh-ed25519");
  expect(msg).toContain("ssh-rsa");
  // Different type: the benign multiple-host-key possibility is surfaced
  // alongside rekey/interception, so a routine multi-key server is not
  // mischaracterised as an attack.
  expect(msg).toMatch(/multiple host keys/);
  expect(msg).toMatch(/interception/);
});

test("a server-controlled key type is escaped before display", () => {
  // keyType is decoded from the partner-advertised blob and stored unsanitized;
  // the reconciliation must neutralise control bytes before they reach the
  // operator's terminal.
  const hostile: PresentedHostKey = {
    fingerprint: KEY_RSA.fingerprint,
    keyType: "ssh-rsa\r\nINJECTED",
  };
  const msg = reconcileHostKeyFingerprints(KEY_ED25519, hostile);
  expect(msg).toBeDefined();
  expect(msg).not.toContain("\r");
  expect(msg).not.toContain("\n");
});

// --- runExchange wiring (end to end, real PSI) -------------------------------

const psiLibrary = await PSI();

const firstNameTerms = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi" as const,
  deduplicate: false,
  output: { expectsOutput: true, shareWithPartner: true } as Output,
  linkageFields: [{ name: "firstName", type: "firstName" as const }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};

const rows = [{ first_name: "Bob" }, { first_name: "Carol" }];

function prepared(identity: string) {
  return prepareForExchange(
    { linkageTerms: { ...firstNameTerms, identity } },
    identity,
    rows,
    ["first_name"],
  );
}

/**
 * Run a full exchange over an in-memory pipe, with each party advertising its
 * own observed host key. Returns the divergence message each side reported (or
 * undefined when none).
 */
async function exchangeWithObservedKeys(
  observedInitiator: PresentedHostKey | undefined,
  observedResponder: PresentedHostKey | undefined,
): Promise<[string | undefined, string | undefined]> {
  const [connInitiator, connResponder] = createMessagePipe();
  let initiatorDivergence: string | undefined;
  let responderDivergence: string | undefined;
  await Promise.all([
    runExchange(connInitiator, "initiator", prepared("Initiator Co"), {
      psiLibrary,
      observedHostKey: observedInitiator,
      onHostKeyDivergence: (m) => (initiatorDivergence = m),
    }),
    runExchange(connResponder, "responder", prepared("Responder Co"), {
      psiLibrary,
      observedHostKey: observedResponder,
      onHostKeyDivergence: (m) => (responderDivergence = m),
    }),
  ]);
  return [initiatorDivergence, responderDivergence];
}

test("matching observed host keys pass silently through the exchange", async () => {
  const [a, b] = await exchangeWithObservedKeys(KEY_ED25519, {
    ...KEY_ED25519,
  });
  expect(a).toBeUndefined();
  expect(b).toBeUndefined();
});

test("a divergence is detected by both parties and names both values", async () => {
  const [a, b] = await exchangeWithObservedKeys(KEY_ED25519, KEY_ED25519_OTHER);
  for (const msg of [a, b]) {
    expect(msg).toBeDefined();
    expect(msg).toContain(KEY_ED25519.fingerprint);
    expect(msg).toContain(KEY_ED25519_OTHER.fingerprint);
  }
});

test("a party that observed no host key sees no false divergence", async () => {
  // The responder (a file-drop or proxy path) advertises nothing; the initiator
  // observed a key. Neither side reconciles a divergence.
  const [a, b] = await exchangeWithObservedKeys(KEY_ED25519, undefined);
  expect(a).toBeUndefined();
  expect(b).toBeUndefined();
});

test("a party that advertises no observed key never reports an injected one", async () => {
  // Post-handshake placement: the advertised value is only consulted when a
  // party supplies its own observed key (which the CLI does only on the
  // authenticated path). A party that supplies none -- the unauthenticated path
  // -- advertises nothing and reconciles nothing, so a value the partner puts on
  // the wire cannot induce a divergence on it.
  const [unauthenticated, advertiser] = await exchangeWithObservedKeys(
    undefined,
    KEY_ED25519,
  );
  expect(unauthenticated).toBeUndefined();
  expect(advertiser).toBeUndefined();
});
