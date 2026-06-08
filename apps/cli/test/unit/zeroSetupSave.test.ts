import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { getDefaultLinkageTerms } from "@psilink/core";
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
