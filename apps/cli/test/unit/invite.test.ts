import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";
import logLibrary from "loglevel";
import { getLogger, UsageError } from "@psilink/core";

import {
  resolveInvitePositionals,
  validateInvite,
} from "../../src/commands/invite";
import type { CommonBootstrapOptions } from "../../src/commands/bootstrap";

const silentLog = getLogger("invite-test");
silentLog.setLevel("silent");

let optionsCounter = 0;
// Minimal options pointing config/key at fresh, non-existent temp paths so the
// conflict gate passes and validateInvite reaches the step under test.
function testOptions(
  overrides: Partial<CommonBootstrapOptions> = {},
): CommonBootstrapOptions {
  const id = `${process.pid}-${optionsCounter++}`;
  return {
    configFile: path.join(tmpdir(), `psilink-invite-test-${id}.yaml`),
    keyFile: path.join(tmpdir(), `psilink-invite-test-${id}.key`),
    record: false,
    logLevel: logLibrary.levels.SILENT,
    verbosity: 0,
    ...overrides,
  };
}

// --- offline vs online dispatch ----------------------------------------------

test("no positionals dispatches offline with no input file", () => {
  const r = resolveInvitePositionals([]);
  expect(r.mode).toBe("offline");
  if (r.mode !== "offline") return;
  expect(r.input).toBeUndefined();
});

test("a lone input file dispatches offline", () => {
  const r = resolveInvitePositionals(["input.csv"]);
  expect(r.mode).toBe("offline");
  if (r.mode !== "offline") return;
  expect(r.input).toBe("input.csv");
});

test("a leading URL dispatches online with input and output", () => {
  const r = resolveInvitePositionals([
    "sftp://host/drop",
    "input.csv",
    "out.csv",
  ]);
  expect(r.mode).toBe("online");
  if (r.mode !== "online") return;
  expect(r.url.hostname).toBe("host");
  expect(r.input).toBe("input.csv");
  expect(r.output).toBe("out.csv");
});

test("an online invitation without an input file is a usage error", () => {
  expect(() => resolveInvitePositionals(["sftp://host/drop"])).toThrow(
    UsageError,
  );
  expect(() => resolveInvitePositionals(["sftp://host/drop"])).toThrow(
    "requires an input file",
  );
});

// --- validateInvite (the no-commit phase) ------------------------------------

test("validateInvite: an unsupported (webrtc) URL is rejected with no side effect", async () => {
  // Online dispatch validates the URL before reading input or minting a token,
  // so an unrunnable scheme aborts before the caller can disclose anything.
  await expect(
    validateInvite({
      resolved: {
        mode: "online",
        url: new URL("ws://host/path"),
        input: "input.csv",
      },
      options: testOptions(),
      acceptTimeout: 900,
      log: silentLog,
    }),
  ).rejects.toBeInstanceOf(UsageError);
});

test("validateInvite: offline rejects a missing input file, preserving its exit code", async () => {
  await expect(
    validateInvite({
      resolved: { mode: "offline", input: "/nonexistent/psilink-input.csv" },
      options: testOptions(),
      acceptTimeout: 900,
      log: silentLog,
    }),
  ).rejects.toMatchObject({ exitCode: 69 });
});

test("validateInvite: offline requires an input file", async () => {
  await expect(
    validateInvite({
      resolved: { mode: "offline" },
      options: testOptions(),
      acceptTimeout: 900,
      log: silentLog,
    }),
  ).rejects.toBeInstanceOf(UsageError);
});

test("validateInvite: a non-positive accept-timeout is rejected", async () => {
  await expect(
    validateInvite({
      resolved: {
        mode: "online",
        url: new URL("sftp://host/drop"),
        input: "input.csv",
      },
      options: testOptions(),
      acceptTimeout: 0,
      log: silentLog,
    }),
  ).rejects.toBeInstanceOf(UsageError);
});

// --- pre-existing config/key on the online path ------------------------------

// 43-char base64url token satisfying the key-file format constraint.
const KEY_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

/** A scratch directory with a small valid CSV; config/key default to fresh
 *  (non-existent) paths inside it so each test can occupy just what it needs. */
function onlineFixture(): { input: string; options: CommonBootstrapOptions } {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-online-"));
  tmpDirs.push(dir);
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  return {
    input,
    options: testOptions({
      configFile: path.join(dir, "psilink.yaml"),
      keyFile: path.join(dir, ".psilink.key"),
    }),
  };
}

test("validateInvite: online warns (does not error) on a pre-existing key file", async () => {
  const { input, options } = onlineFixture();
  fs.writeFileSync(options.keyFile, JSON.stringify({ pakeToken: KEY_TOKEN }));
  const log = getLogger("invite-key-warn-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  // Completes without throwing: the pre-existing key is a warning on this path.
  await validateInvite({
    resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
    options,
    acceptTimeout: 900,
    log,
  });
  expect(
    warnSpy.mock.calls.some(
      (c) =>
        typeof c[0] === "string" && c[0].includes("key file already exists"),
    ),
  ).toBe(true);
  warnSpy.mockRestore();
});

test("validateInvite: online still aborts on a pre-existing config file", async () => {
  const { input, options } = onlineFixture();
  fs.writeFileSync(options.configFile, "channel: filedrop\npath: /mnt/share\n");
  // A pre-existing config remains a hard conflict for invite (reusing it as the
  // terms source is a separate task); the config gate runs before the input read.
  await expect(
    validateInvite({
      resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
      options,
      acceptTimeout: 900,
      log: silentLog,
    }),
  ).rejects.toThrow(options.configFile);
});
