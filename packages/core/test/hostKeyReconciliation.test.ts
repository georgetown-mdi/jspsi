import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { reconcileHostKeyFingerprints } from "../src/hostKeyReconciliation";
import { redactPrivateKeyMaterial } from "../src/utils/sanitizeErrorForDisplay";
import { keyTypeFromBlob } from "../src/utils/sshHostKey";
import { prepareForExchange, runExchange } from "../src/exchange";
import { createMessagePipe } from "../src/connection/messageConnection";
import type { PresentedHostKey } from "../src/connection/fileSyncConnection";
import type { Output } from "../src/config/linkageTerms";

// Cross-party reconciliation of the SFTP host-key fingerprint. Each party
// advertises the host key it observed in the authenticated post-handshake
// terms exchange; a divergence is reported so a one-sided interception, or a
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

// What a party observes when the server names its key type `blobType`: the value
// keyTypeFromBlob composes from those wire bytes, not a string chosen here, so
// the reconciliation is driven with exactly what the verifier records.
function observedKeyType(blobType: string): string {
  const type = new TextEncoder().encode(blobType);
  const blob = new Uint8Array(4 + type.length + 32);
  new DataView(blob.buffer).setUint32(0, type.length);
  blob.set(type, 4);
  return keyTypeFromBlob(blob);
}

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
  // Different type: the benign multiple-host-key possibility is shown
  // alongside rekey/interception, so a routine multi-key server is not
  // mischaracterised as an attack.
  expect(msg).toMatch(/multiple host keys/);
  expect(msg).toMatch(/interception/);
});

// --- the four fragments against the sinks' own private-key pass ---------------
// Fragments (the partner's advertised fingerprint and key type) are composed
// before the explanation and re-pin instruction. Both sinks -- the log line
// and the fd-3 warning event -- redact the whole string fail-closed past a
// BEGIN marker with no END, so a marker planted in a fragment could delete
// everything after it, including the warning itself. The partner's values
// are bounded only by length (100 for the fingerprint, 64 for the key
// type) -- room enough for the 35-character marker.

const PEM_MARKER = "-----BEGIN OPENSSH PRIVATE KEY-----";
const REPIN_INSTRUCTION = "re-pin it on both sides";

function expectSurvivesTheSinkPass(msg: string | undefined): void {
  expect(msg).toBeDefined();
  // The sink applies exactly this function to the whole rendered line.
  const atSink = redactPrivateKeyMaterial(msg!);
  expect(atSink).toMatch(/interception/);
  expect(atSink).toContain(REPIN_INSTRUCTION);
  expect(atSink).toContain("[redacted private key]");
}

test("a marker planted in the partner's key type keeps the warning whole", () => {
  expectSurvivesTheSinkPass(
    reconcileHostKeyFingerprints(KEY_ED25519, {
      fingerprint: KEY_RSA.fingerprint,
      keyType: PEM_MARKER,
    }),
  );
});

test("a marker planted in the partner's fingerprint keeps the warning whole", () => {
  expectSurvivesTheSinkPass(
    reconcileHostKeyFingerprints(KEY_ED25519, {
      fingerprint: PEM_MARKER,
      keyType: KEY_RSA.keyType,
    }),
  );
});

test("markers planted in every fragment at once keep the warning whole", () => {
  // The same-type branch, whose two fragments are both fingerprints, with the
  // local side holding a marker too -- unreachable through keyTypeFromBlob's
  // charset bound for a key type, but nothing bounds a caller of this function.
  expectSurvivesTheSinkPass(
    reconcileHostKeyFingerprints(
      { fingerprint: `${PEM_MARKER}-local`, keyType: PEM_MARKER },
      { fingerprint: `${PEM_MARKER}-partner`, keyType: PEM_MARKER },
    ),
  );
});

test("a charset-conforming marker lookalike reaches the operator verbatim", () => {
  // `keyTypeFromBlob` admits `[A-Za-z0-9._@-]` only, so a real marker (which
  // has spaces) can never arrive in a LOCAL key type. Its hyphenated
  // lookalike passes that bound AND matches no redaction pattern, so it renders
  // as itself. The cost is operator confusion, not disclosure; a stated limit in
  // docs/spec/CHANNEL_SECURITY.md, not a bug the patterns should widen to catch.
  const lookalike = observedKeyType("-----BEGIN-OPENSSH-PRIVATE-KEY-----");
  expect(lookalike).toBe("-----BEGIN-OPENSSH-PRIVATE-KEY-----");
  const msg = reconcileHostKeyFingerprints(
    { fingerprint: KEY_ED25519.fingerprint, keyType: lookalike },
    KEY_RSA,
  );
  expect(msg).toContain(lookalike);
  expect(redactPrivateKeyMaterial(msg!)).toContain(REPIN_INSTRUCTION);
});

test("a server-controlled key type is escaped before display", () => {
  // A partner's advertised keyType is parsed under a length bound alone and
  // stored unsanitized, so the reconciliation must neutralise control bytes
  // before they reach the operator's terminal.
  const hostile: PresentedHostKey = {
    fingerprint: KEY_RSA.fingerprint,
    keyType: "ssh-rsa\r\nINJECTED",
  };
  const msg = reconcileHostKeyFingerprints(KEY_ED25519, hostile);
  expect(msg).toBeDefined();
  expect(msg).not.toContain("\r");
  expect(msg).not.toContain("\n");
});

// The two parties' key types are compared verbatim, and equality is what selects
// the narrower "rekey or interception" wording. The bound each party's locally
// observed type passes through must therefore keep two DIFFERENT rejected types
// apart -- a single shared placeholder would make a server show one party one
// hostile type and the other a different one, and have the warning display
// as if both had observed the same key type.
test("two different rejected key types do not collapse into a same-type warning", () => {
  const first: PresentedHostKey = {
    fingerprint: KEY_ED25519.fingerprint,
    keyType: observedKeyType("\x00first"),
  };
  const second: PresentedHostKey = {
    fingerprint: KEY_RSA.fingerprint,
    keyType: observedKeyType("\x00second"),
  };

  expect(first.keyType).not.toBe(second.keyType);
  const msg = reconcileHostKeyFingerprints(first, second);
  expect(msg).toBeDefined();
  // The different-type branch: the benign multiple-host-key possibility is kept
  // on the table, exactly as it is for two different legitimate types.
  expect(msg).toMatch(/multiple host keys/);
});

test("one rejected key type observed by both parties is treated as a same-type divergence", () => {
  // The other half of the same property: the SAME rejected type on both sides
  // still compares equal, so the narrower wording is not lost to the bound.
  const keyType = observedKeyType("\x00same");
  const msg = reconcileHostKeyFingerprints(
    { fingerprint: KEY_ED25519.fingerprint, keyType },
    { fingerprint: KEY_RSA.fingerprint, keyType },
  );
  expect(msg).toBeDefined();
  expect(msg).not.toMatch(/multiple host keys/);
  expect(msg).toMatch(/rotation/);
});

// --- runExchange wiring (end to end, real PSI) -------------------------------

const psiLibrary = await PSI();

const firstNameTerms = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi" as const,
  linkageStrategy: "cascade" as const,
  deduplicate: false,
  output: { expectsOutput: true, shareWithPartner: true } as Output,
  linkageFields: [{ name: "firstName", type: "first_name" as const }],
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

test("a marker advertised over the wire cannot delete the re-pin instruction", async () => {
  // Reachability determined by the real terms exchange rather than by restating
  // the advertisement's bounds: the partner puts a BEGIN marker in both of its
  // advertised fields, and what each party reconciles is what its own parse
  // admitted.
  const [initiator, responder] = await exchangeWithObservedKeys(KEY_ED25519, {
    fingerprint: PEM_MARKER,
    keyType: PEM_MARKER,
  });

  for (const msg of [initiator, responder]) expectSurvivesTheSinkPass(msg);
});

test("a rejected key type survives the partner's parse of the advertisement", async () => {
  // The placeholder has to fit the bound the partner reads an advertised key
  // type under, or the whole advertisement is treated as malformed and the
  // partner reconciles nothing -- which the real terms exchange, not a
  // restated bound, is what decides here.
  const observed: PresentedHostKey = {
    fingerprint: KEY_ED25519.fingerprint,
    keyType: observedKeyType("\x00".repeat(4096)),
  };
  const [initiator, responder] = await exchangeWithObservedKeys(
    observed,
    KEY_RSA,
  );

  for (const msg of [initiator, responder]) {
    expect(msg).toBeDefined();
    expect(msg).toContain(observed.keyType);
    expect(msg).toContain(KEY_RSA.fingerprint);
  }
});
