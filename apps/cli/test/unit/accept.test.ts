import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";
import logLibrary from "loglevel";
import {
  encodeInvitation,
  getDefaultLinkageTerms,
  getLogger,
  UsageError,
} from "@psilink/core";
import type { InvitationToken } from "@psilink/core";

import {
  decodeAndValidateInvitation,
  resolveAcceptPositionals,
  validateAccept,
} from "../../src/commands/accept";
import { generatePakeToken } from "../../src/commands/bootstrap";
import type { CommonBootstrapOptions } from "../../src/commands/bootstrap";

const silentLog = getLogger("accept-test");
silentLog.setLevel("silent");

let optionsCounter = 0;
// Minimal options pointing config/key at fresh, non-existent temp paths so the
// conflict gate passes and validateAccept reaches the step under test.
function testOptions(
  overrides: Partial<CommonBootstrapOptions> = {},
): CommonBootstrapOptions {
  const id = `${process.pid}-${optionsCounter++}`;
  return {
    configFile: path.join(tmpdir(), `psilink-accept-test-${id}.yaml`),
    keyFile: path.join(tmpdir(), `psilink-accept-test-${id}.key`),
    record: false,
    logLevel: logLibrary.levels.SILENT,
    verbosity: 0,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

function sampleToken(expires?: string): InvitationToken {
  return {
    version: "1",
    linkageTerms: getDefaultLinkageTerms("Inviter Org"),
    pakeToken: generatePakeToken(),
    expires,
  };
}

// --- offline vs online dispatch ----------------------------------------------

test("a leading invitation dispatches offline", () => {
  const r = resolveAcceptPositionals(["abc123def456ghi", "input.csv"]);
  expect(r.mode).toBe("offline");
  if (r.mode !== "offline") return;
  expect(r.invitation).toBe("abc123def456ghi");
  expect(r.input).toBe("input.csv");
});

test("a leading URL dispatches online", () => {
  const r = resolveAcceptPositionals([
    "sftp://host/drop",
    "INVITE",
    "input.csv",
    "out.csv",
  ]);
  expect(r.mode).toBe("online");
  if (r.mode !== "online") return;
  expect(r.url.hostname).toBe("host");
  expect(r.invitation).toBe("INVITE");
  expect(r.input).toBe("input.csv");
  expect(r.output).toBe("out.csv");
});

test("no positionals is a usage error", () => {
  expect(() => resolveAcceptPositionals([])).toThrow(UsageError);
  expect(() => resolveAcceptPositionals([])).toThrow("invitation is required");
});

test("online acceptance without an input file is a usage error", () => {
  expect(() =>
    resolveAcceptPositionals(["sftp://host/drop", "INVITE"]),
  ).toThrow("requires an invitation and an input file");
});

// --- a '-'-leading invitation is taken as the positional, not a flag ---------

test("an invitation beginning with '-' is parsed as the positional invitation", () => {
  const r = resolveAcceptPositionals([
    "-eyJ2ZXJzaW9uIjoiMSJ9abcDEF",
    "input.csv",
  ]);
  expect(r.mode).toBe("offline");
  if (r.mode !== "offline") return;
  expect(r.invitation).toBe("-eyJ2ZXJzaW9uIjoiMSJ9abcDEF");
  expect(r.input).toBe("input.csv");
});

// --- decode + validate (the gate before the prompt) --------------------------

test("encode/decode round-trips an invitation at the command level", async () => {
  const token = sampleToken(new Date(Date.now() + 3_600_000).toISOString());
  const encoded = await encodeInvitation(token);
  const decoded = await decodeAndValidateInvitation(encoded);
  expect(decoded.pakeToken).toBe(token.pakeToken);
  expect(decoded.linkageTerms.identity).toBe("Inviter Org");
  expect(decoded.linkageTerms.linkageKeys.map((k) => k.name)).toEqual(
    token.linkageTerms.linkageKeys.map((k) => k.name),
  );
});

test("a checksum mismatch is rejected (before any prompt) with a usage error", async () => {
  const encoded = await encodeInvitation(
    sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
  );
  // Corrupt the final checksum character; the 4-byte checksum no longer matches.
  const last = encoded.slice(-1);
  const tampered = encoded.slice(0, -1) + (last === "A" ? "B" : "A");
  await expect(decodeAndValidateInvitation(tampered)).rejects.toBeInstanceOf(
    UsageError,
  );
  await expect(decodeAndValidateInvitation(tampered)).rejects.toThrow(
    /checksum mismatch/,
  );
});

test("a schema-invalid invitation is rejected with a usage error", async () => {
  await expect(
    decodeAndValidateInvitation("not-a-valid-invitation"),
  ).rejects.toBeInstanceOf(UsageError);
});

test("an expired invitation is rejected, naming the expiry time", async () => {
  const realNow = Date.now();
  const expires = new Date(realNow + 60_000).toISOString();
  // Encode while the token is still in the future (encodeInvitation requires it).
  const encoded = await encodeInvitation(sampleToken(expires));
  // Advance past the expiry; decode + validate must now reject by name.
  vi.useFakeTimers();
  vi.setSystemTime(new Date(realNow + 120_000));
  await expect(decodeAndValidateInvitation(encoded)).rejects.toThrow(expires);
});

// --- validateAccept (the no-commit phase, before the prompt) -----------------

test("validateAccept: an invalid invitation is rejected before the prompt", async () => {
  await expect(
    validateAccept({
      resolved: { mode: "offline", invitation: "not-a-valid-invitation" },
      options: testOptions(),
      log: silentLog,
    }),
  ).rejects.toBeInstanceOf(UsageError);
});

test("validateAccept: online rejects a missing input file before the prompt, preserving its exit code", async () => {
  const encoded = await encodeInvitation(
    sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
  );
  await expect(
    validateAccept({
      resolved: {
        mode: "online",
        url: new URL("sftp://host/drop"),
        invitation: encoded,
        input: "/nonexistent/psilink-input.csv",
      },
      options: testOptions(),
      log: silentLog,
    }),
  ).rejects.toMatchObject({ exitCode: 69 });
});
