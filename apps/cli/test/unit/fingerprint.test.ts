import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { UsageError, computeCertificateFingerprint } from "@psilink/core";
import {
  readConfigHints,
  resolveSigningIdentity,
} from "../../src/commands/fingerprint";
import { loadSigningIdentity } from "../../src/signingIdentityFile";

let dir: string;
const noopLog = { warn: () => {} };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-fp-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- resolveSigningIdentity (lazy create / load / regenerate) ----------------

test("creates the identity on first use and persists it", () => {
  const idPath = path.join(dir, "id.json");
  const { identity, action } = resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A, Agency A",
    force: false,
    log: noopLog,
  });
  expect(action).toBe("Created");
  expect(identity.certificate.identity).toBe("Party A, Agency A");
  expect(fs.existsSync(idPath)).toBe(true);
});

test("loads the existing identity on a second run (same fingerprint)", async () => {
  const idPath = path.join(dir, "id.json");
  const first = resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A",
    force: false,
    log: noopLog,
  });
  const second = resolveSigningIdentity({
    identityPath: idPath,
    force: false,
    log: noopLog,
  });
  expect(second.action).toBe("Loaded");
  expect(await computeCertificateFingerprint(second.identity.certificate)).toBe(
    await computeCertificateFingerprint(first.identity.certificate),
  );
});

test("ignores --identity when an identity already exists, and warns", () => {
  const idPath = path.join(dir, "id.json");
  resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A",
    force: false,
    log: noopLog,
  });
  const warn = vi.fn();
  const { identity, action } = resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Someone Else",
    force: false,
    log: { warn },
  });
  expect(action).toBe("Loaded");
  expect(identity.certificate.identity).toBe("Party A");
  expect(warn).toHaveBeenCalledOnce();
});

test("--force regenerates a new key with a new fingerprint", async () => {
  const idPath = path.join(dir, "id.json");
  const first = resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A",
    force: false,
    log: noopLog,
  });
  const regenerated = resolveSigningIdentity({
    identityPath: idPath,
    force: true,
    log: noopLog,
  });
  expect(regenerated.action).toBe("Regenerated");
  // same bound identity (re-key), different fingerprint
  expect(regenerated.identity.certificate.identity).toBe("Party A");
  expect(
    await computeCertificateFingerprint(regenerated.identity.certificate),
  ).not.toBe(await computeCertificateFingerprint(first.identity.certificate));
  // the new identity is the one now persisted
  const onDisk = loadSigningIdentity(idPath);
  expect(onDisk).toEqual(regenerated.identity);
});

test("--force with --identity rebinds to a new identity string", () => {
  const idPath = path.join(dir, "id.json");
  resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A",
    force: false,
    log: noopLog,
  });
  const { identity, action } = resolveSigningIdentity({
    identityPath: idPath,
    identityArg: "Party A, renamed",
    force: true,
    log: noopLog,
  });
  expect(action).toBe("Regenerated");
  expect(identity.certificate.identity).toBe("Party A, renamed");
});

test("errors when no identity is available to create one", () => {
  const idPath = path.join(dir, "id.json");
  expect(() =>
    resolveSigningIdentity({
      identityPath: idPath,
      force: false,
      log: noopLog,
    }),
  ).toThrow(UsageError);
  expect(fs.existsSync(idPath)).toBe(false);
});

test("falls back to the config identity when --identity is absent", () => {
  const idPath = path.join(dir, "id.json");
  const { identity, action } = resolveSigningIdentity({
    identityPath: idPath,
    configIdentity: "Configured Party",
    force: false,
    log: noopLog,
  });
  expect(action).toBe("Created");
  expect(identity.certificate.identity).toBe("Configured Party");
});

// --- readConfigHints ---------------------------------------------------------

test("readConfigHints returns empty when the default config is absent", () => {
  // run from a dir with no psilink.yaml
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    expect(readConfigHints(undefined, false)).toEqual({});
  } finally {
    process.chdir(cwd);
  }
});

test("readConfigHints throws when an explicit config file is missing", () => {
  expect(() => readConfigHints(path.join(dir, "nope.yaml"), true)).toThrow(
    UsageError,
  );
});

test("readConfigHints reads identity and identity_file from YAML", () => {
  const cfg = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    cfg,
    [
      "linkage_terms:",
      "  identity: Party From Config",
      "signing:",
      "  identity_file: /keys/id.json",
    ].join("\n"),
  );
  expect(readConfigHints(cfg, true)).toEqual({
    identity: "Party From Config",
    identityFile: "/keys/id.json",
  });
});
