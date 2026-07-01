import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import YAML from "yaml";
import { getDefaultLinkageTerms, UsageError } from "@psilink/core";
import type { ExchangeSpec, PreparedExchange } from "@psilink/core";

import { buildSaveSpec, finalizeBootstrap } from "../../src/commands/zeroSetup";
import { loadKeyFile } from "../../src/keyFile";

// A 43-char base64url token satisfying the sharedSecret format constraint, as a
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
  // No observation passed: nothing is locked in, the recurring path stays lazy.
  expect(spec.expectedPayloadColumns).toBeUndefined();
});

test("buildSaveSpec records a non-empty observed received set as the lock-in", () => {
  // A zero-setup --save party crystallizes the payload columns it observed in the
  // first exchange so a later `psilink exchange` fails closed on a divergence.
  const prepared = {
    linkageTerms: getDefaultLinkageTerms("Test Party"),
    metadata: [],
  } as unknown as PreparedExchange;

  const spec = buildSaveSpec(
    { channel: "filedrop", path: "/mnt/share" },
    prepared,
    ["dob", "zip"],
  );

  expect(spec.expectedPayloadColumns).toEqual(["dob", "zip"]);
});

test("buildSaveSpec leaves an empty observation lazy, not a strict receive-nothing", () => {
  // The partner transmits an empty payload both when it discloses nothing AND on a
  // zero-match first exchange; the two are indistinguishable here, so persisting []
  // (strict "receive nothing") would false-abort a later matching run. An empty
  // observation therefore records no lock-in (absent field, reconciled lazily).
  const prepared = {
    linkageTerms: getDefaultLinkageTerms("Test Party"),
    metadata: [],
  } as unknown as PreparedExchange;

  const spec = buildSaveSpec(
    { channel: "filedrop", path: "/mnt/share" },
    prepared,
    [],
  );

  expect(spec.expectedPayloadColumns).toBeUndefined();
});

test("both-saved persists the observed received set to disk as expected_payload_columns", () => {
  // End-to-end: the observed set flows through buildSaveSpec -> finalizeBootstrap
  // -> saveConfig, and is serialized snake_case so a later load reconciles on it.
  const { log } = capture();
  const spec = buildSaveSpec(
    { channel: "filedrop", path: "/mnt/share" },
    {
      linkageTerms: getDefaultLinkageTerms("Test Party"),
      metadata: [],
    } as unknown as PreparedExchange,
    ["dob", "zip"],
  );
  finalizeBootstrap({
    save: true,
    bootstrap: { partnerSaveIntent: true, sharedSecret: SECRET },
    spec,
    configFile,
    keyFile,
    log,
  });
  const written = YAML.parse(fs.readFileSync(configFile, "utf8"));
  expect(written.expected_payload_columns).toEqual(["dob", "zip"]);
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
  expect(loadKeyFile(keyFile)?.sharedSecret).toBe(SECRET);
  expect(messages.some((m) => m.includes("established a shared secret"))).toBe(
    true,
  );
});

test("save persists an @path credential as the reference, never the secret contents", () => {
  // End-to-end at-rest check for the --save path: a connection whose password is
  // an @path reference is persisted verbatim, so the referenced file's contents
  // (the secret) never land in psilink.yaml. Read the value back through the YAML
  // parser rather than as a raw substring -- a long quoted scalar may line-wrap.
  const { log } = capture();
  const pwFile = path.join(dir, "pw");
  fs.writeFileSync(pwFile, "s3cret\n");
  const spec = buildSaveSpec(
    {
      channel: "sftp",
      server: { host: "h", username: "u", password: `@${pwFile}` },
    },
    {
      linkageTerms: getDefaultLinkageTerms("Test Party"),
      metadata: [],
    } as unknown as PreparedExchange,
  );
  finalizeBootstrap({
    save: true,
    bootstrap: { partnerSaveIntent: true, sharedSecret: SECRET },
    spec,
    configFile,
    keyFile,
    log,
  });
  const written = fs.readFileSync(configFile, "utf8");
  expect(written).not.toContain("s3cret");
  expect(YAML.parse(written).connection.server.password).toBe(`@${pwFile}`);
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
