import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { getDefaultLinkageTerms, UsageError } from "@psilink/core";
import type { ExchangeSpec, PreparedExchange } from "@psilink/core";

import { buildSaveSpec, finalizeBootstrap } from "../../src/commands/zeroSetup";
import { loadKeyFile } from "../../src/keyFile";

// A 43-char base64url token satisfying the pakeToken format constraint, as a
// stand-in for a secret the initiator would have generated in-band.
const SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function sampleSpec(): ExchangeSpec {
  return {
    connection: { channel: "filedrop", path: "/mnt/share" },
    linkageTerms: getDefaultLinkageTerms("Test Party"),
  };
}

function capture(): { log: { info: (m: string) => void }; messages: string[] } {
  const messages: string[] = [];
  return { messages, log: { info: (m: string) => messages.push(m) } };
}

let dir: string;
let configFile: string;
let keyFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-zerosave-"));
  configFile = path.join(dir, "psilink.yaml");
  keyFile = path.join(dir, ".psilink.key");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- buildSaveSpec -----------------------------------------------------------

test("buildSaveSpec carries the connection, terms and metadata, omitting standardization", () => {
  const connection = { channel: "filedrop", path: "/mnt/share" } as const;
  const linkageTerms = getDefaultLinkageTerms("Test Party");
  const metadata = [{ name: "ssn", type: "ssn" }];
  const prepared = {
    linkageTerms,
    metadata,
  } as unknown as PreparedExchange;

  const spec = buildSaveSpec(connection, prepared);

  expect(spec.connection).toBe(connection);
  expect(spec.linkageTerms).toBe(linkageTerms);
  expect(spec.metadata).toBe(metadata);
  expect(spec.standardization).toBeUndefined();
});

// --- both parties saved ------------------------------------------------------

test("both-saved: writes config and key, and reports the shared secret", () => {
  const { log, messages } = capture();
  finalizeBootstrap({
    save: true,
    bootstrap: { partnerSaveIntent: true, sharedSecret: SECRET },
    spec: sampleSpec(),
    configFile,
    keyFile,
    log,
  });

  expect(fs.existsSync(configFile)).toBe(true);
  expect(loadKeyFile(keyFile)?.pakeToken).toBe(SECRET);
  expect(messages.some((m) => m.includes("established a shared secret"))).toBe(
    true,
  );
});

// --- only this party saved ---------------------------------------------------

test("we-saved-partner-did-not: writes config only and instructs to invite", () => {
  const { log, messages } = capture();
  finalizeBootstrap({
    save: true,
    bootstrap: { partnerSaveIntent: false },
    spec: sampleSpec(),
    configFile,
    keyFile,
    log,
  });

  expect(fs.existsSync(configFile)).toBe(true);
  // No secret was established, so no key file is written.
  expect(fs.existsSync(keyFile)).toBe(false);
  const joined = messages.join("\n");
  expect(joined).toContain("did not also choose to save");
  expect(joined).toContain("psilink invite");
});

// --- this party did not save -------------------------------------------------

test("partner-saved-we-did-not: saves nothing and reports nothing was saved", () => {
  const { log, messages } = capture();
  finalizeBootstrap({
    save: false,
    bootstrap: { partnerSaveIntent: true },
    spec: sampleSpec(),
    configFile,
    keyFile,
    log,
  });

  expect(fs.existsSync(configFile)).toBe(false);
  expect(fs.existsSync(keyFile)).toBe(false);
  expect(
    messages.some((m) => m.includes("nothing was saved on your end")),
  ).toBe(true);
});

test("neither-saved: saves nothing and emits the standard recurring hint", () => {
  const { log, messages } = capture();
  finalizeBootstrap({
    save: false,
    bootstrap: { partnerSaveIntent: false },
    spec: sampleSpec(),
    configFile,
    keyFile,
    log,
  });

  expect(fs.existsSync(configFile)).toBe(false);
  expect(fs.existsSync(keyFile)).toBe(false);
  expect(
    messages.some((m) => m.includes("psilink invite URL INPUT_FILE")),
  ).toBe(true);
});

// --- post-exchange conflict re-check (TOCTOU window) -------------------------

test("we-saved-partner-did-not: aborts without clobbering a config that appeared after the pre-flight check", () => {
  const { log } = capture();
  // Simulate a file materializing at the config path in the window between the
  // handler's up-front conflict gate and this post-exchange write. The
  // both-saved branch gets this re-check from provisionConfigAndKey; the
  // config-only branch must match it rather than silently overwrite.
  fs.writeFileSync(configFile, "preexisting: true\n");
  expect(() =>
    finalizeBootstrap({
      save: true,
      bootstrap: { partnerSaveIntent: false },
      spec: sampleSpec(),
      configFile,
      keyFile,
      log,
    }),
  ).toThrow(UsageError);
  // The pre-existing file is left untouched, not clobbered.
  expect(fs.readFileSync(configFile, "utf8")).toContain("preexisting");
});

// --- invariant guard ---------------------------------------------------------

test("refuses a shared secret when this party did not save, rather than dropping it silently", () => {
  const { log } = capture();
  // Unreachable from real exchange code (the secret frame is gated on this
  // party's own intent), but the guard turns the contradiction into a loud
  // failure instead of a silently discarded secret.
  expect(() =>
    finalizeBootstrap({
      save: false,
      bootstrap: { partnerSaveIntent: true, sharedSecret: SECRET },
      spec: sampleSpec(),
      configFile,
      keyFile,
      log,
    }),
  ).toThrow("internal error");
  expect(fs.existsSync(configFile)).toBe(false);
  expect(fs.existsSync(keyFile)).toBe(false);
});
