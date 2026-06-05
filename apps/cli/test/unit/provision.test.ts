import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { getDefaultLinkageTerms, UsageError } from "@psilink/core";
import type { ExchangeSpec } from "@psilink/core";
import {
  assertNoProvisionConflicts,
  provisionConfigAndKey,
} from "../../src/commands/provision";
import { loadKeyFile } from "../../src/keyFile";

// 43-char base64url token satisfying the pakeToken format constraint.
const TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function sampleSpec(): ExchangeSpec {
  return {
    connection: { channel: "filedrop", path: "/mnt/share" },
    linkageTerms: getDefaultLinkageTerms("Test Party"),
  };
}

let dir: string;
let configPath: string;
let keyPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-provision-"));
  configPath = path.join(dir, "psilink.yaml");
  keyPath = path.join(dir, ".psilink.key");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- conflict detection ------------------------------------------------------

test("provisionConfigAndKey reports a pre-existing config file and writes nothing", () => {
  fs.writeFileSync(configPath, "channel: filedrop\n");
  expect(() =>
    provisionConfigAndKey(
      sampleSpec(),
      { pakeToken: TOKEN },
      { configPath, keyPath },
    ),
  ).toThrow(configPath);
  // The pre-existing config is left untouched and no key file is created.
  expect(fs.readFileSync(configPath, "utf8")).toBe("channel: filedrop\n");
  expect(fs.existsSync(keyPath)).toBe(false);
});

test("provisionConfigAndKey reports a pre-existing key file and writes nothing", () => {
  fs.writeFileSync(keyPath, JSON.stringify({ pakeToken: TOKEN }));
  expect(() =>
    provisionConfigAndKey(
      sampleSpec(),
      { pakeToken: TOKEN },
      { configPath, keyPath },
    ),
  ).toThrow(keyPath);
  expect(fs.existsSync(configPath)).toBe(false);
});

test("assertNoProvisionConflicts reports the conflicting path before any write", () => {
  fs.writeFileSync(keyPath, JSON.stringify({ pakeToken: TOKEN }));
  expect(() => assertNoProvisionConflicts({ configPath, keyPath })).toThrow(
    keyPath,
  );
});

test("assertNoProvisionConflicts passes when neither target exists", () => {
  expect(() =>
    assertNoProvisionConflicts({ configPath, keyPath }),
  ).not.toThrow();
});

test("provisionConfigAndKey rejects the same path for config and key", () => {
  const both = path.join(dir, "shared.yaml");
  expect(() =>
    provisionConfigAndKey(
      sampleSpec(),
      { pakeToken: TOKEN },
      { configPath: both, keyPath: both },
    ),
  ).toThrow(UsageError);
  // Nothing is written: the key write would otherwise clobber the config.
  expect(fs.existsSync(both)).toBe(false);
});

test("assertNoProvisionConflicts rejects the same path for config and key", () => {
  // Caught up front, before any network activity, with `./x` and `x` treated
  // as the same path.
  const both = path.join(dir, "shared.yaml");
  expect(() =>
    assertNoProvisionConflicts({
      configPath: both,
      keyPath: `${both}/../shared.yaml`,
    }),
  ).toThrow(UsageError);
});

// --- key file writing --------------------------------------------------------

test("provisionConfigAndKey writes a key file with expires when set", () => {
  provisionConfigAndKey(
    sampleSpec(),
    { pakeToken: TOKEN, expires: "2028-06-01T12:00:00.000Z" },
    { configPath, keyPath },
  );
  const key = loadKeyFile(keyPath);
  expect(key?.pakeToken).toBe(TOKEN);
  expect(key?.expires).toBe("2028-06-01T12:00:00.000Z");
});

test("provisionConfigAndKey omits expires when absent", () => {
  provisionConfigAndKey(
    sampleSpec(),
    { pakeToken: TOKEN },
    { configPath, keyPath },
  );
  expect(fs.readFileSync(keyPath, "utf8")).not.toContain("expires");
  expect(loadKeyFile(keyPath)?.expires).toBeUndefined();
});

test("provisionConfigAndKey writes the key file with mode 0600", () => {
  // Windows uses a restricted ACL, not POSIX mode bits; fs.statSync reports a
  // synthetic mode there, so this assertion is Unix-only (mirrors saveKeyFile).
  if (process.platform === "win32") return;
  provisionConfigAndKey(
    sampleSpec(),
    { pakeToken: TOKEN },
    { configPath, keyPath },
  );
  expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
});

// --- both files / defaults ---------------------------------------------------

test("provisionConfigAndKey writes both files and returns the resolved paths", () => {
  const result = provisionConfigAndKey(
    sampleSpec(),
    { pakeToken: TOKEN },
    { configPath, keyPath },
  );
  expect(result).toEqual({ configPath, keyPath });
  expect(fs.existsSync(configPath)).toBe(true);
  expect(loadKeyFile(keyPath)?.pakeToken).toBe(TOKEN);
});

// --- rollback ----------------------------------------------------------------

test("provisionConfigAndKey rolls back the written config when the key write fails", () => {
  // A malformed token makes saveKeyFile throw -- but only after saveConfig has
  // already written the config (config is written first), so this exercises the
  // catch block's rollback rather than the up-front conflict gate.
  expect(() =>
    provisionConfigAndKey(
      sampleSpec(),
      { pakeToken: "too-short" },
      { configPath, keyPath },
    ),
  ).toThrow("base64url-encoded 32-byte value");
  // The config that was written is removed; neither file is left behind.
  expect(fs.existsSync(configPath)).toBe(false);
  expect(fs.existsSync(keyPath)).toBe(false);
});

test("provisionConfigAndKey writes no key file when the config write fails", () => {
  // Induce a config-write failure with a non-writable destination directory.
  // POSIX-permission-based; Windows ignores the directory mode, so Unix-only.
  if (process.platform === "win32") return;
  const ro = path.join(dir, "ro");
  fs.mkdirSync(ro);
  fs.chmodSync(ro, 0o500); // r-x: lstat sees children as absent, but writes EACCES
  try {
    const badConfig = path.join(ro, "psilink.yaml");
    // keyPath is in a writable directory; it must stay unwritten because the
    // config write fails first (saveConfig runs before saveKeyFile).
    expect(() =>
      provisionConfigAndKey(
        sampleSpec(),
        { pakeToken: TOKEN },
        { configPath: badConfig, keyPath },
      ),
    ).toThrow();
    expect(fs.existsSync(badConfig)).toBe(false);
    expect(fs.existsSync(keyPath)).toBe(false);
  } finally {
    fs.chmodSync(ro, 0o700); // restore so afterEach cleanup can remove it
  }
});
