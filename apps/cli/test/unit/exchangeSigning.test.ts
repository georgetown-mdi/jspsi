import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import {
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  OperatorConfigError,
  UsageError,
  generateSigningIdentity,
  computeCertificateFingerprint,
  sanitizeErrorForDisplay,
} from "@psilink/core";
import type { SigningConfig, SigningIdentity } from "@psilink/core";

import { resolveSigningPersist } from "../../src/commands/exchange";
import { saveSigningIdentity } from "../../src/signingIdentityFile";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-signing-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const fixedPrivateKey = {
  kty: "EC",
  crv: "P-256",
  x: "JHWxrL6MWMbpKlF5G-EULYpHJ5M6PnEdleg66V0RCvo",
  y: "ZQuEikGWXN5_AKJYN-xh_HjLnqrQG4QpVkzPocFYbJg",
  d: "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw",
} as const;

const identity = await generateSigningIdentity("Party A", {
  privateKey: fixedPrivateKey,
});

test("returns null when signing is absent (the unsigned path)", async () => {
  await expect(resolveSigningPersist(undefined, "Party A")).resolves.toBeNull();
});

test("returns null for the non-certificate modes", async () => {
  // Neither signs, so neither needs an identity: the identity-file requirement
  // below is certificate mode's alone.
  const none: SigningConfig = { mode: "none" };
  const session: SigningConfig = { mode: "session-derived" };
  await expect(resolveSigningPersist(none, "Party A")).resolves.toBeNull();
  await expect(resolveSigningPersist(session, "Party A")).resolves.toBeNull();
});

test("loads the identity and pin for certificate mode", async () => {
  const identityPath = path.join(dir, "signing-identity.json");
  saveSigningIdentity(identityPath, identity, { exclusive: true });
  const fingerprint = await computeCertificateFingerprint(identity.certificate);
  const config: SigningConfig = {
    mode: "certificate",
    identityFile: identityPath,
    partnerFingerprint: fingerprint,
    receiptOutput: path.join(dir, "receipt.json"),
  };
  const resolved = await resolveSigningPersist(config, "Party A");
  expect(resolved).not.toBeNull();
  expect(resolved!.identity).toEqual(identity);
  expect(resolved!.partnerFingerprint).toBe(fingerprint);
  expect(resolved!.receiptOutput).toEqual({
    receiptFile: path.join(dir, "receipt.json"),
  });
});

test("certificate mode with no identity file at the named path is a usage error", async () => {
  const config: SigningConfig = {
    mode: "certificate",
    identityFile: path.join(dir, "does-not-exist.json"),
  };
  await expect(resolveSigningPersist(config, "Party A")).rejects.toThrow(
    UsageError,
  );
  await expect(resolveSigningPersist(config, "Party A")).rejects.toThrow(
    /no signing identity was found/,
  );
});

test("the not-found refusal names the configured path once", async () => {
  const identityFile = path.join(dir, "does-not-exist.json");
  const message = await resolveSigningPersist(
    { mode: "certificate", identityFile },
    "Party A",
  ).then(
    () => "",
    (err: unknown) => (err as Error).message,
  );
  expect(message.split(identityFile)).toHaveLength(2);
  // The remedy refers back to the one mention rather than repeating it.
  expect(message).toContain("--identity-file <that path>");
});

test("a long configured path leaves the remedy inside the display cap", async () => {
  // signing.identity_file is bounded only by the schema's min(1), while the
  // composed message truncates at COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH: every
  // character of path the refusal spends twice is one the remedy loses. The
  // components stay under NAME_MAX so the read fails ENOENT (an absent file)
  // rather than on the name's length.
  const identityFile = path.join(
    dir,
    ...Array.from({ length: 5 }, () => "d".repeat(100)),
    "psilink-signing-identity.json",
  );
  expect(identityFile.length).toBeGreaterThan(
    COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH / 2,
  );
  const rendered = await resolveSigningPersist(
    { mode: "certificate", identityFile },
    "Party A",
  ).then(
    () => "",
    (err: unknown) => sanitizeErrorForDisplay(err),
  );
  expect(rendered).toContain("point signing.identity_file at the file you");
  expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
});

// --- read-only custody on the exchange path ----------------------------------

test.skipIf(process.platform === "win32")(
  "the exchange path reads an identity on a read-only directory and writes nothing",
  async () => {
    // The custody property CLI.md, EXCHANGE_REFERENCE.md, SECURITY_DESIGN.md, and
    // DEPLOYMENT.md all publish, and the whole reason the identity gets a mount of
    // its own: an exchange reads the file and writes neither it, its directory,
    // nor anything beside it. verify-receipt's half of the same claim is pinned in
    // verifyReceipt.test.ts; this is the exchange half.
    const mount = fs.mkdtempSync(path.join(dir, "mount-"));
    const identityPath = path.join(mount, "psilink-signing-identity.json");
    saveSigningIdentity(identityPath, identity, { exclusive: true });
    const listing = fs.readdirSync(mount).sort();
    const bytes = fs.readFileSync(identityPath, "utf8");
    const mtimeMs = fs.statSync(identityPath).mtimeMs;
    fs.chmodSync(mount, 0o500);
    try {
      const resolved = await resolveSigningPersist(
        { mode: "certificate", identityFile: identityPath },
        "Party A",
      );
      expect(resolved).not.toBeNull();
      expect(resolved!.identity).toEqual(identity);
      // The artifacts rather than an EACCES: a run with the privilege to ignore
      // the mode still has to leave the directory and the file as it found them.
      expect(fs.readdirSync(mount).sort()).toEqual(listing);
      expect(fs.readFileSync(identityPath, "utf8")).toBe(bytes);
      expect(fs.statSync(identityPath).mtimeMs).toBe(mtimeMs);
    } finally {
      fs.chmodSync(mount, 0o700);
    }
  },
);

// --- certificate mode naming no identity path --------------------------------
// The pre-flight family's newest member: like the unpinned-partner and unnamed-
// party refusals it fires before any credential, terms, or data are sent, as an
// OperatorConfigError (exit 64) composed only of this operator's own content.

test("certificate mode that names no identity file is refused, not defaulted", async () => {
  const config: SigningConfig = { mode: "certificate" };
  await expect(resolveSigningPersist(config, "Party A")).rejects.toThrow(
    OperatorConfigError,
  );
});

test("the refusal names both spellings, a mounted example, and the unsigned exit", async () => {
  const config: SigningConfig = { mode: "certificate" };
  const rendered = await resolveSigningPersist(config, "Party A").then(
    () => "",
    (err: unknown) => sanitizeErrorForDisplay(err),
  );
  expect(rendered).toContain("signing.mode: certificate");
  expect(rendered).toContain("The run reads it and writes nothing to it");
  // Why psilink leaves the location to the operator is contributor-tier, kept in
  // the constant's JSDoc rather than spent on the terminal.
  expect(rendered).not.toContain("yours to decide");
  expect(rendered).toContain("signing.identity_file");
  expect(rendered).toContain("--identity-file");
  expect(rendered).toContain("/run/signing/psilink-signing-identity.json");
  expect(rendered).toContain("read-only mount");
  expect(rendered).toContain('signing.mode to "none"');
  // Read at the sink that caps a composed link, so the whole remedy is what the
  // operator sees rather than the head of it.
  expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
});

test("the refusal names no path of its own beyond the illustrative one", async () => {
  // A message that guessed at a location -- a home directory, a working
  // directory -- would reinstate the default this refusal exists to remove, and
  // would send the operator to a path psilink does not read.
  const config: SigningConfig = { mode: "certificate" };
  const message = await resolveSigningPersist(config, "Party A").then(
    () => "",
    (err: unknown) => (err as Error).message,
  );
  const paths = new Set(message.match(/(~|\.)?\/[\w./-]+/g) ?? []);
  expect([...paths]).toEqual(["/run/signing/psilink-signing-identity.json"]);
  expect(message).not.toContain(os.homedir());
});

test("certificate mode with no pin resolves (the run is refused before this boundary)", async () => {
  const identityPath = path.join(dir, "signing-identity.json");
  saveSigningIdentity(identityPath, identity, { exclusive: true });
  const config: SigningConfig = {
    mode: "certificate",
    identityFile: identityPath,
  };
  const resolved = await resolveSigningPersist(config, "Party A");
  // This resolver states no pin rule of its own: an unpinned certificate-mode
  // config is refused by core's single gate (assertCertificateModePinsPartner,
  // inside prepareForExchange), which the exchange handler reaches before it
  // resolves signing at all -- exchange.test.ts drives that ordering. Restating
  // the rule here would put two spellings of one refusal on the path.
  expect(resolved).not.toBeNull();
  expect(resolved!.partnerFingerprint).toBeUndefined();
});

// --- divergence from the run's linkage_terms.identity ------------------------
// The loaded certificate is bound to "Party A" throughout; only the terms
// identity handed to the resolver varies. A diverging run cannot leave both
// parties holding a verifiable receipt on either handshake role -- driven end to
// end in packages/core/test/signedReceiptEndToEnd.test.ts -- so this boundary
// refuses it before any credential, terms, or data are sent.

/** A certificate-mode block over the identity saved for this test. */
function certificateModeOver(
  identityPath: string,
  bound: SigningIdentity = identity,
): SigningConfig {
  saveSigningIdentity(identityPath, bound, { exclusive: true });
  return { mode: "certificate", identityFile: identityPath };
}

test("refuses when the loaded identity diverges from the run's terms identity", async () => {
  const config = certificateModeOver(path.join(dir, "signing-identity.json"));
  const rejection = resolveSigningPersist(
    config,
    "Party A, Agency A, a@agency-a.gov",
  );
  // An OperatorConfigError, as its certificate-mode siblings in core are: the
  // CLI classifies it as a configuration error (exit 64) and the message is
  // composed only of this operator's own content.
  await expect(rejection).rejects.toThrow(OperatorConfigError);
  const message = await rejection.catch(
    (err: unknown) => (err as Error).message,
  );
  expect(message).toContain('"Party A"');
  expect(message).toContain('"Party A, Agency A, a@agency-a.gov"');
  expect(message).toContain("linkage_terms.identity");
  expect(message).toContain("cannot finish");
});

test("the refusal offers the local config edit before the regeneration remedy, with the re-pin caution", async () => {
  const config = certificateModeOver(path.join(dir, "signing-identity.json"));
  const message = await resolveSigningPersist(
    config,
    "Party A, Agency A, a@agency-a.gov",
  ).then(
    () => "",
    (err: unknown) => (err as Error).message,
  );
  // The local config edit is offered before the certificate-regeneration
  // remedy: an operator reading top to bottom sees the cheaper fix first.
  const editIndex = message.indexOf("a local config edit");
  const regenerateIndex = message.indexOf("regenerate the identity");
  expect(editIndex).toBeGreaterThan(-1);
  expect(regenerateIndex).toBeGreaterThan(editIndex);
  // Regeneration changes the fingerprint the partner has pinned; the caution
  // is what keeps an operator from silently breaking that pin.
  expect(message).toContain("coordinated re-pin");
  // Both remedies precede the two values they are about. The renderer caps a
  // composed link and `linkage_terms.identity` is bounded only by the terms
  // schema's text cap, so a long name has to truncate the values rather than the
  // remedy the operator acts on.
  expect(message.indexOf('is bound to "Party A"')).toBeGreaterThan(
    regenerateIndex,
  );
});

// The two identities land LAST in the refusal, so whatever the fixed prose
// spends of the renderer's per-link budget comes out of them -- and they are the
// values an operator has to compare to act on it. What erodes that room is copy
// rather than code, so both halves are checks: the fixed prose is held to a
// budget, and a realistic pair is driven through the display boundary whole.

/** Room the refusal must leave for the two identities together, in characters. */
const IDENTITY_PAIR_DISPLAY_BUDGET = 350;

// One realistic pair: the same person and agency written two ways, which is how
// the divergence arises -- an operator rewords `linkage_terms.identity` after
// the certificate was bound. At or past the longest shapes measured against this
// refusal (100 characters bound, 113 in the terms).
const REWORDED_BOUND_IDENTITY =
  "Dana Whitfield, Program Integrity Office, Kentucky State Health Agency, " +
  "dana.whitfield@health.example.gov";
const REWORDED_TERMS_IDENTITY =
  "Dana Whitfield, Office of Program Integrity, Records Unit, State Health " +
  "Agency, dana.whitfield@health.example.gov";

const rewordedIdentity = await generateSigningIdentity(
  REWORDED_BOUND_IDENTITY,
  {
    privateKey: fixedPrivateKey,
  },
);

test("the refusal's fixed prose leaves the identity pair room inside the display cap", async () => {
  const config = certificateModeOver(path.join(dir, "signing-identity.json"));
  const terms = "Party A, Agency A, a@agency-a.gov";
  const message = await resolveSigningPersist(config, terms).then(
    () => "",
    (err: unknown) => (err as Error).message,
  );
  // The composed message less the two values it names; the certificate this
  // helper saves is bound to "Party A".
  const fixedProse = message.length - "Party A".length - terms.length;
  expect(fixedProse).toBeLessThanOrEqual(
    COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH - IDENTITY_PAIR_DISPLAY_BUDGET,
  );
});

test("a realistic identity pair reaches the operator un-truncated", async () => {
  expect(REWORDED_BOUND_IDENTITY.length).toBeGreaterThanOrEqual(100);
  expect(REWORDED_TERMS_IDENTITY.length).toBeGreaterThanOrEqual(113);
  const config = certificateModeOver(
    path.join(dir, "signing-identity.json"),
    rewordedIdentity,
  );
  const rendered = await resolveSigningPersist(
    config,
    REWORDED_TERMS_IDENTITY,
  ).then(
    () => "",
    (err: unknown) => sanitizeErrorForDisplay(err),
  );
  // Through the sink that caps the link, not the raw message: the cap is what
  // would cut them, and it is the only place the operator ever sees them.
  expect(rendered).toContain(`"${REWORDED_BOUND_IDENTITY}"`);
  expect(rendered).toContain(`"${REWORDED_TERMS_IDENTITY}"`);
  expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
});

test("a control-character label reaches the operator escaped, once", async () => {
  // The refusal composes both identities RAW; the single escape is the error
  // sink the CLI reports through (exitWithError -> sanitizeErrorForDisplay).
  // Escaping here as well would double every backslash the operator sees, so
  // both halves are asserted: the control bytes are gone, and the escape that
  // removed them ran exactly once.
  const config = certificateModeOver(path.join(dir, "signing-identity.json"));
  const esc = String.fromCharCode(0x1b);
  const label = `Party ${esc}[31mA\nAgency A`;
  const rendered = await resolveSigningPersist(config, label).then(
    () => "",
    (err: unknown) => sanitizeErrorForDisplay(err),
  );
  expect(rendered).toContain("Party \\x1b[31mA\\x0aAgency A");
  expect(rendered).not.toContain("\\\\x1b");
  // Nothing outside printable ASCII survives to the operator's terminal. The
  // renderer frames a cause chain with its own newline, which is removed first
  // so the assertion is about the escaped fragment rather than that framing.
  expect(/[^\t\x20-\x7e]/.test(rendered.split("\n").join(" "))).toBe(false);
});

test("resolves when the loaded identity matches the run's terms identity", async () => {
  const config = certificateModeOver(path.join(dir, "signing-identity.json"));
  await expect(
    resolveSigningPersist(config, "Party A"),
  ).resolves.not.toBeNull();
});

test("resolves when the run has no terms identity", async () => {
  // Nothing to diverge from. A certificate-mode run that names no party is
  // unrunnable for its own reason and is refused ahead of this boundary, by core's
  // assertCertificateModeNamesLocalParty inside prepareForExchange -- so this
  // branch must not restate that refusal in a second spelling.
  const config = certificateModeOver(path.join(dir, "signing-identity.json"));
  await expect(
    resolveSigningPersist(config, undefined),
  ).resolves.not.toBeNull();
  await expect(resolveSigningPersist(config, "")).resolves.not.toBeNull();
});
