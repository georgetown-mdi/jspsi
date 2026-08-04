import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import logLibrary from "loglevel";
import YAML from "yaml";
import {
  CONSENT_FACTS,
  encodeInvitation,
  getDefaultLinkageTerms,
  getLogger,
  parseExchangeSpec,
  reconcileReceivedPayload,
  sanitizeForDisplay,
  summarizeInvitation,
  UsageError,
} from "@psilink/core";
import {
  BEL,
  CONSENT_PROBE_TERMS,
  ESC,
  PRINTABLE_ASCII,
  RLO,
  consentRepresentationProbes,
  hostileVariants,
} from "@psilink/core/testing";
import type {
  ConnectionConfig,
  ConnectionEndpoint,
  ConsentFact,
  InvitationToken,
  LinkageTerms,
  TransformStep,
} from "@psilink/core";

// Mock only promptConfirm; every other cli.ts export (openInputSource, which the
// `-` stdin tests exercise for real, configureLogFile, etc.) is the genuine
// implementation. This lets the handler tests assert whether the confirmation
// prompt ran without driving a real readline over the test runner's stdin.
vi.mock("../../src/util/cli", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/util/cli")>(
      "../../src/util/cli",
    );
  return { ...actual, promptConfirm: vi.fn() };
});

// Mock only runOnlineBootstrap, so the online-handler wiring can be asserted
// without opening a connection or running a real exchange; every other
// onlineBootstrap export (generateSharedSecret, and the buildDataSpec/
// prepareForOnlineExchange chain validateAccept drives) is the genuine
// implementation.
vi.mock("../../src/onlineBootstrap", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/onlineBootstrap")
  >("../../src/onlineBootstrap");
  return { ...actual, runOnlineBootstrap: vi.fn() };
});

import {
  decodeAndValidateInvitation,
  displayInvitation,
  handler as acceptHandler,
  resolveAcceptPositionals,
  validateAccept,
} from "../../src/commands/accept";
import { logDecisionFacts } from "../../src/invitationDisplay";
import {
  generateSharedSecret,
  runOnlineBootstrap,
} from "../../src/onlineBootstrap";
import type { CommonBootstrapOptions } from "../../src/optionDefinitions";
import { saveConfig } from "../../src/config";
import { promptConfirm } from "../../src/util/cli";
import { captureStdio } from "../loggingTestSupport";

const promptConfirmMock = vi.mocked(promptConfirm);

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
    eventStream: false,
    logLevel: logLibrary.levels.SILENT,
    verbosity: 0,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  // Reset the shared promptConfirm mock after every test so none inherits a stale
  // implementation or call count from a prior one -- the guarantee lives here
  // rather than each handler test having to remember to reset it.
  promptConfirmMock.mockReset();
});

function sampleToken(
  expires?: string,
  connectionEndpoint?: ConnectionEndpoint,
): InvitationToken {
  return {
    version: "1",
    linkageTerms: getDefaultLinkageTerms("Inviter Org"),
    sharedSecret: generateSharedSecret(),
    expires,
    connectionEndpoint,
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
  expect(decoded.sharedSecret).toBe(token.sharedSecret);
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

// accept reads its y/N confirmation from stdin, so it cannot also take the CSV
// there. validateAccept runs before promptConfirm, so a `-` input is rejected up
// front (a UsageError naming a file path) instead of a stdin CSV starving the
// prompt into a silent EOF decline. Both positional modes pass allowStdin: false.
async function expectStdinRejection(
  resolved: Parameters<typeof validateAccept>[0]["resolved"],
): Promise<void> {
  let caught: unknown;
  try {
    await validateAccept({ resolved, options: testOptions(), log: silentLog });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  // Match the stdin-specific phrasing, not just "file path": several unrelated
  // UsageErrors on this path (e.g. config reconciliation) also mention a file
  // path, so require the stdin rejection's own wording to avoid a pass for the
  // wrong reason.
  expect((caught as Error).message).toMatch(/stdin/);
  expect((caught as Error).message).toMatch(/file path/);
}

test("validateAccept: online `-` input is rejected as a usage error before the prompt, not silently declined", async () => {
  const encoded = await encodeInvitation(
    sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
  );
  await expectStdinRejection({
    mode: "online",
    url: new URL("sftp://host/drop"),
    invitation: encoded,
    input: "-",
  });
});

test("validateAccept: offline `-` input is rejected as a usage error before the prompt, not silently declined", async () => {
  const encoded = await encodeInvitation(
    sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
  );
  await expectStdinRejection({
    mode: "offline",
    invitation: encoded,
    input: "-",
  });
});

// --- `--consent-to-terms` (consentToTerms) relaxes the `-` rejection ---------
// With the prompt skipped, stdin is free for the CSV, so `-` is read rather than
// rejected. Run validateAccept with process.stdin replaced by a byte stream that
// emits a CSV then EOF, mirroring `cat data.csv | psilink accept --consent-to-terms - INVITE`.

/** A byte-stream stand-in for process.stdin that emits `csv` then ends. */
function makeStdin(csv: string): Readable {
  const stream = new Readable({ read() {} });
  stream.push(Buffer.from(csv, "utf8"));
  stream.push(null);
  return stream;
}

/** Run `fn` with process.stdin replaced by a stream emitting `csv`, restoring it. */
async function withStdin<T>(csv: string, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", {
    value: makeStdin(csv),
    configurable: true,
  });
  try {
    return await fn();
  } finally {
    if (original !== undefined)
      Object.defineProperty(process, "stdin", original);
  }
}

test("validateAccept: offline `-` with consentToTerms reads the CSV from stdin and proceeds", async () => {
  // A CSV the default linkage terms can satisfy, so the satisfiability pre-flight
  // passes and the dataSpec carries metadata inferred from the stdin header --
  // proof the CSV was actually read from stdin rather than `-` being rejected.
  const csv =
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n";
  const encoded = await encodeInvitation(
    sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
  );
  const ready = await withStdin(csv, () =>
    validateAccept({
      resolved: { mode: "offline", invitation: encoded, input: "-" },
      options: testOptions(),
      consentToTerms: true,
      log: silentLog,
    }),
  );
  expect(ready.mode).toBe("offline");
  // The metadata names match the stdin header, so the stdin CSV reached the spec.
  expect(ready.dataSpec.metadata?.map((c) => c.name)).toEqual(
    expect.arrayContaining(["first_name", "last_name", "dob", "ssn"]),
  );
});

test("validateAccept: offline `-` with consentToTerms false is still rejected", async () => {
  // The gate flips on consentToTerms: with it off (the default the prompt path
  // uses), `-` stays an up-front UsageError, the unchanged no-flag behavior.
  const encoded = await encodeInvitation(
    sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
  );
  let caught: unknown;
  try {
    await validateAccept({
      resolved: { mode: "offline", invitation: encoded, input: "-" },
      options: testOptions(),
      consentToTerms: false,
      log: silentLog,
    });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  expect((caught as Error).message).toMatch(/stdin/);
});

test("validateAccept: online `-` with consentToTerms reads the CSV from stdin and proceeds", async () => {
  // The online path gates stdin on consentToTerms exactly as the offline path
  // does; exercise it through the same stdin swap so the symmetric `-` relaxation
  // is covered on both branches, not just offline.
  const csv =
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n";
  const dir = fs.mkdtempSync(
    path.join(tmpdir(), "psilink-accept-online-stdin-"),
  );
  const encoded = await encodeInvitation(
    sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
  );
  try {
    const ready = await withStdin(csv, () =>
      validateAccept({
        resolved: {
          mode: "online",
          url: new URL("sftp://host/drop"),
          invitation: encoded,
          input: "-",
        },
        options: testOptions({
          configFile: path.join(dir, "psilink.yaml"),
          keyFile: path.join(dir, ".psilink.key"),
        }),
        consentToTerms: true,
        log: silentLog,
      }),
    );
    expect(ready.mode).toBe("online");
    // The metadata names match the stdin header, so the stdin CSV reached the spec.
    expect(ready.dataSpec.metadata?.map((c) => c.name)).toEqual(
      expect.arrayContaining(["first_name", "last_name", "dob", "ssn"]),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateAccept: an unsupported URL is rejected before the input file is read", async () => {
  const encoded = await encodeInvitation(
    sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
  );
  // Both the URL is unsupported and the input file is missing; the URL is now
  // checked first (mirroring validateInvite), so the UsageError wins over the
  // file's exitCode-69 error -- proving the URL is validated before the read.
  await expect(
    validateAccept({
      resolved: {
        mode: "online",
        url: new URL("ws://host/path"),
        invitation: encoded,
        input: "/nonexistent/psilink-input.csv",
      },
      options: testOptions(),
      log: silentLog,
    }),
  ).rejects.toBeInstanceOf(UsageError);
});

// --- connection_per_poll ignored on a non-sftp online URL --------------------
// A file:// URL resolves to filedrop, which holds no session, so an online accept
// carrying --connection-per-poll must warn it is ignored rather than silently
// drop it. connectionFromURL applies the override only on sftp, so on filedrop the
// raw flag is the sole carrier of the operator's intent; validateAccept reads it
// and warns. On sftp the mode is valid, so the ignored-warning stays silent.

const CPP_CSV =
  "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n";

test("validateAccept: online file:// URL with --connection-per-poll warns it is ignored", async () => {
  const dir = fs.mkdtempSync(
    path.join(tmpdir(), "psilink-accept-cpp-filedrop-"),
  );
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(input, CPP_CSV);
  const encoded = await encodeInvitation(
    sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
  );
  const log = getLogger("accept-cpp-filedrop-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    await validateAccept({
      resolved: {
        mode: "online",
        url: new URL(`file://${dir}`),
        invitation: encoded,
        input,
      },
      options: testOptions({
        configFile: path.join(dir, "psilink.yaml"),
        keyFile: path.join(dir, ".psilink.key"),
        connectionPerPoll: true,
      }),
      log,
    });
    expect(
      warnSpy.mock.calls.some(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes("--connection-per-poll") &&
          c[0].includes("will be ignored") &&
          c[0].includes("only supported on sftp"),
      ),
    ).toBe(true);
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateAccept: online sftp URL with --connection-per-poll does not warn it is ignored", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-accept-cpp-sftp-"));
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(input, CPP_CSV);
  const encoded = await encodeInvitation(
    sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
  );
  const log = getLogger("accept-cpp-sftp-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    await validateAccept({
      resolved: {
        mode: "online",
        url: new URL("sftp://host/drop"),
        invitation: encoded,
        input,
      },
      options: testOptions({
        configFile: path.join(dir, "psilink.yaml"),
        keyFile: path.join(dir, ".psilink.key"),
        connectionPerPoll: true,
        // A long poll interval keeps the wasteful-short-interval advisory silent
        // too, so no connection_per_poll warning of any kind appears on sftp.
        pollingFrequencyMs: 3_600_000,
      }),
      log,
    });
    expect(
      warnSpy.mock.calls.some(
        (c) =>
          typeof c[0] === "string" && c[0].includes("--connection-per-poll"),
      ),
    ).toBe(false);
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- linkage pre-flight (block vs warn) --------------------------------------

const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();

// Write a temp CSV with the given header columns (one filler data row; the
// pre-flight reasons about column names, not values). Returns the path.
function writeInputCSV(columns: string[]): string {
  const id = `${process.pid}-${optionsCounter++}`;
  const file = path.join(tmpdir(), `psilink-accept-input-${id}.csv`);
  fs.writeFileSync(
    file,
    `${columns.join(",")}\n${columns.map(() => "x").join(",")}\n`,
  );
  return file;
}

test("validateAccept: offline blocks (UsageError) when the CSV satisfies no linkage key", async () => {
  // The default terms (from sampleToken) need ssn/last name/dob/etc.; a CSV with
  // only first_name can complete no key, so the pre-flight aborts before the
  // prompt rather than running a silent empty exchange.
  const options = testOptions();
  const input = writeInputCSV(["first_name"]);
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    await expect(
      validateAccept({
        resolved: { mode: "offline", invitation: encoded, input },
        options,
        log: silentLog,
      }),
    ).rejects.toThrow(/cannot satisfy any of the invitation's linkage keys/);
  } finally {
    fs.rmSync(input, { force: true });
  }
});

test("validateAccept: offline warns but proceeds when the CSV satisfies only some keys", async () => {
  // last/first name + dob satisfy the name+dob keys but not the ssn keys, so the
  // pre-flight warns (naming the unsatisfied fields) and the acceptance proceeds.
  const options = testOptions();
  const input = writeInputCSV(["last_name", "first_name", "dob"]);
  const log = getLogger("accept-partial-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const ready = await validateAccept({
      resolved: { mode: "offline", invitation: encoded, input },
      options,
      log,
    });
    expect(ready.mode).toBe("offline");
    expect(
      warnSpy.mock.calls.some(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes(
            "cannot satisfy all of the invitation's linkage fields",
          ),
      ),
    ).toBe(true);
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(input, { force: true });
  }
});

test("validateAccept: offline warns that a --server-* override is ignored", async () => {
  // The offline path builds the connection block from connectionFromEndpoint (a
  // placeholder here, since sampleToken carries no endpoint; or an endpoint seed
  // when one is present -- the warning reads only `options`, so it fires the same
  // way either way), so a --server-* override cannot take effect; it must be
  // surfaced rather than silently dropped.
  const input = writeInputCSV(["first_name", "last_name", "dob", "ssn"]);
  const log = getLogger("accept-offline-override-warn");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const ready = await validateAccept({
      resolved: { mode: "offline", invitation: encoded, input },
      options: testOptions({ serverUsername: "alice" }),
      log,
    });
    expect(ready.mode).toBe("offline");
    expect(
      warnSpy.mock.calls.some(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes("--server-username") &&
          c[0].includes("no effect on an offline invite/accept"),
      ),
    ).toBe(true);
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(input, { force: true });
  }
});

test("validateAccept: online does not warn about a --server-* override (it is applied)", async () => {
  // The online path builds the connection from the URL through
  // applyConnectionOverrides, so the override takes effect and no
  // ignored-override warning is emitted.
  const dir = fs.mkdtempSync(
    path.join(tmpdir(), "psilink-accept-online-override-"),
  );
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  const log = getLogger("accept-online-override-nowarn");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const ready = await validateAccept({
      resolved: {
        mode: "online",
        url: new URL("sftp://host/drop"),
        invitation: encoded,
        input,
      },
      options: testOptions({
        configFile: path.join(dir, "psilink.yaml"),
        keyFile: path.join(dir, ".psilink.key"),
        serverUsername: "alice",
      }),
      log,
    });
    expect(ready.mode).toBe("online");
    if (ready.mode !== "online") return;
    if (ready.connection.channel !== "sftp") throw new Error("expected sftp");
    expect(ready.connection.server.username).toBe("alice");
    expect(
      warnSpy.mock.calls.some(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes("no effect on an offline invite/accept"),
      ),
    ).toBe(false);
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateAccept: offline warns that a connection-options override is ignored", async () => {
  // The offline path builds the connection block from connectionFromEndpoint
  // (placeholder or endpoint seed), which has no `options` block, so a
  // connection-options override cannot take effect; it must be surfaced with a
  // remedy pointing at connection.options, distinct from the server warning.
  const input = writeInputCSV(["first_name", "last_name", "dob", "ssn"]);
  const log = getLogger("accept-offline-opt-override-warn");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const ready = await validateAccept({
      resolved: { mode: "offline", invitation: encoded, input },
      options: testOptions({ retainFiles: true }),
      log,
    });
    expect(ready.mode).toBe("offline");
    expect(
      warnSpy.mock.calls.some(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes("--retain-files") &&
          c[0].includes("connection.options"),
      ),
    ).toBe(true);
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(input, { force: true });
  }
});

test("validateAccept: offline does not warn about connection.options when no options flag is set", async () => {
  // No connection-options flag is set, so the connection.options warning must
  // stay silent on the offline accept path.
  const input = writeInputCSV(["first_name", "last_name", "dob", "ssn"]);
  const log = getLogger("accept-offline-no-opt-warn");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const ready = await validateAccept({
      resolved: { mode: "offline", invitation: encoded, input },
      options: testOptions(),
      log,
    });
    expect(ready.mode).toBe("offline");
    expect(
      warnSpy.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes("connection.options"),
      ),
    ).toBe(false);
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(input, { force: true });
  }
});

test("validateAccept: online does not warn about a connection-options override (it is applied)", async () => {
  // The online path builds the connection from the URL through
  // applyConnectionOverrides, so a connection-options override takes effect and
  // no ignored-override warning is emitted.
  const dir = fs.mkdtempSync(
    path.join(tmpdir(), "psilink-accept-online-opt-override-"),
  );
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  const log = getLogger("accept-online-opt-override-nowarn");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const ready = await validateAccept({
      resolved: {
        mode: "online",
        url: new URL("sftp://host/drop"),
        invitation: encoded,
        input,
      },
      options: testOptions({
        configFile: path.join(dir, "psilink.yaml"),
        keyFile: path.join(dir, ".psilink.key"),
        maxReconnectAttempts: 5,
      }),
      log,
    });
    expect(ready.mode).toBe("online");
    if (ready.mode !== "online") return;
    expect(ready.connection.options?.maxReconnectAttempts).toBe(5);
    expect(
      warnSpy.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes("connection.options"),
      ),
    ).toBe(false);
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateAccept: offline split-seed accept does not warn on --no-retain-files (seed forces retain on)", async () => {
  // A split-directory endpoint seeds the connection with SPLIT_SEED_OPTIONS (the
  // retain trio = true) and applies no override, so an explicit --no-retain-files
  // (retainFiles === false) is dropped and the seed's retain_files: true stands.
  // The `=== true` gate declines to warn on the negated form -- it is not an
  // enabling override, and warning would name --retain-files for a flag the
  // operator typed as --no-retain-files. This mirrors the online split path,
  // which also forces retain on and warns nothing. Pins the SPLIT_SEED_OPTIONS x
  // gate interaction the helper-level tests do not reach.
  const input = writeInputCSV(["first_name", "last_name", "dob", "ssn"]);
  const endpoint: ConnectionEndpoint = {
    channel: "sftp",
    host: "inviter-host",
    inboundPath: "/exchange/inviter-in",
    outboundPath: "/exchange/inviter-out",
  };
  const log = getLogger("accept-offline-split-seed-no-retain");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE(), endpoint));
    const ready = await validateAccept({
      resolved: { mode: "offline", invitation: encoded, input },
      options: testOptions({ retainFiles: false }),
      log,
    });
    expect(ready.mode).toBe("offline");
    if (ready.mode !== "offline") return;
    if (ready.connection.channel !== "sftp") throw new Error("expected sftp");
    // The seed forces retain on despite --no-retain-files.
    expect(ready.connection.options?.retainFiles).toBe(true);
    // No --retain-files warning: the gate declines on the negated form.
    expect(
      warnSpy.mock.calls.some(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes("--retain-files") &&
          c[0].includes("connection.options"),
      ),
    ).toBe(false);
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(input, { force: true });
  }
});

// --- reconciling a pre-existing config ---------------------------------------

/** Write a config whose linkage terms agree with the invitation's by default
 *  (same default terms, identity aside), so a test perturbs only what it means
 *  to test. */
function writeExistingConfig(
  configPath: string,
  overrides: {
    terms?: LinkageTerms;
    connection?: ConnectionConfig;
  } = {},
): void {
  saveConfig(configPath, {
    connection: overrides.connection ?? {
      channel: "filedrop",
      path: "/mnt/share",
    },
    linkageTerms: overrides.terms ?? getDefaultLinkageTerms("Acceptor Org"),
  });
}

test("validateAccept: offline reuses a config whose linkage terms match the invitation", async () => {
  const options = testOptions();
  writeExistingConfig(options.configFile);
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const ready = await validateAccept({
      resolved: { mode: "offline", invitation: encoded },
      options,
      log: silentLog,
    });
    expect(ready.reuseExistingConfig).toBe(true);
    expect(ready.mode).toBe("offline");
  } finally {
    fs.rmSync(options.configFile, { force: true });
  }
});

test("validateAccept: a matching config is reconciled but a pre-existing key file still hard-aborts", async () => {
  // The reconcile path (#61) makes a pre-existing CONFIG reusable, but a
  // pre-existing KEY file must still abort -- a stale authentication token must
  // never be silently reused. The config here matches the invitation (so on its
  // own it would be reused), proving the key gate fires independently of, and
  // ahead of, config reconciliation.
  const options = testOptions();
  writeExistingConfig(options.configFile);
  fs.writeFileSync(options.keyFile, "stale-key-file");
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const run = () =>
      validateAccept({
        resolved: { mode: "offline", invitation: encoded },
        options,
        log: silentLog,
      });
    await expect(run()).rejects.toBeInstanceOf(UsageError);
    // The abort is the key-file overwrite refusal naming the key path, not a
    // terms diff (which would name a linkage field and the config path).
    await expect(run()).rejects.toThrow(/refusing to overwrite/);
    await expect(run()).rejects.toThrow(options.keyFile);
  } finally {
    fs.rmSync(options.configFile, { force: true });
    fs.rmSync(options.keyFile, { force: true });
  }
});

test("validateAccept: offline fails with a diff when the config's terms disagree", async () => {
  const options = testOptions();
  const terms = getDefaultLinkageTerms("Acceptor Org");
  // The invitation's algorithm is the default "psi"; make the config disagree.
  terms.algorithm = "psi-c";
  writeExistingConfig(options.configFile, { terms });
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const run = () =>
      validateAccept({
        resolved: { mode: "offline", invitation: encoded },
        options,
        log: silentLog,
      });
    await expect(run()).rejects.toBeInstanceOf(UsageError);
    // The error names the differing field and points at the config file.
    await expect(run()).rejects.toThrow(/algorithm/);
    await expect(run()).rejects.toThrow(options.configFile);
  } finally {
    fs.rmSync(options.configFile, { force: true });
  }
});

test("validateAccept: a pre-existing config that cannot be parsed aborts with guidance", async () => {
  const options = testOptions();
  // Well-formed YAML that is not a valid exchange spec: parseExchangeSpec throws.
  fs.writeFileSync(options.configFile, "connection: 123\n");
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    await expect(
      validateAccept({
        resolved: { mode: "offline", invitation: encoded },
        options,
        log: silentLog,
      }),
    ).rejects.toThrow(/could not be parsed/);
  } finally {
    fs.rmSync(options.configFile, { force: true });
  }
});

test("validateAccept: a schema-invalid pre-existing config renders readably, not as a raw ZodError blob", async () => {
  const options = testOptions();
  // Well-formed YAML that fails schema validation: the embedded detail must be
  // the describeDecodeError one-liner (`<path>: <message>` with an `(and N
  // more)` suffix), not Zod's multi-line JSON dump of every issue.
  fs.writeFileSync(options.configFile, "connection: 123\n");
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    let message = "";
    try {
      await validateAccept({
        resolved: { mode: "offline", invitation: encoded },
        options,
        log: silentLog,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    // The surrounding UsageError wrapper text is preserved.
    expect(message).toContain("could not be parsed to compare against");
    // The readable `<path>: <message>` form appears, with the multi-issue suffix.
    expect(message).toMatch(/connection: /);
    expect(message).toContain("(and 1 more)");
    // The raw multi-line ZodError JSON blob does not: no newlines, no JSON keys.
    expect(message).not.toContain("\n");
    expect(message).not.toContain('"code"');
  } finally {
    fs.rmSync(options.configFile, { force: true });
  }
});

test("validateAccept: a malformed-YAML config does not echo an inline credential", async () => {
  const options = testOptions();
  const SECRET = "S3cr3tSFTPPassw0rd";
  // Syntactically invalid YAML (an unclosed flow map) with an inline credential
  // on the offending line. YAML.parse's error embeds a snippet of the source
  // lines; the reconcile must report only the path, never that snippet, or the
  // credential leaks into the (logged) error message.
  fs.writeFileSync(
    options.configFile,
    `connection:\n  channel: sftp\n  server:\n    password: {${SECRET}\n    host: h\n`,
  );
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    let caught: unknown;
    try {
      await validateAccept({
        resolved: { mode: "offline", invitation: encoded },
        options,
        log: silentLog,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as Error).message).toMatch(/not valid YAML/);
    // The credential must not appear anywhere in the surfaced message.
    expect((caught as Error).message).not.toContain(SECRET);
  } finally {
    fs.rmSync(options.configFile, { force: true });
  }
});

test("validateAccept: online aborts (no acceptance sent) when the connection block disagrees with the URL", async () => {
  const options = testOptions();
  // Linkage terms agree; only the connection host disagrees with the URL.
  writeExistingConfig(options.configFile, {
    connection: {
      channel: "sftp",
      server: { host: "other-host", username: "alice" },
    },
  });
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const run = () =>
      validateAccept({
        resolved: {
          mode: "online",
          url: new URL("sftp://expected-host/drop"),
          invitation: encoded,
          // Never read: the reconcile check throws before the input is loaded,
          // which is also before any network activity (so no acceptance is sent).
          input: "/nonexistent/psilink-input.csv",
        },
        options,
        log: silentLog,
      });
    await expect(run()).rejects.toBeInstanceOf(UsageError);
    await expect(run()).rejects.toThrow(/connection\.server\.host/);
  } finally {
    fs.rmSync(options.configFile, { force: true });
  }
});

test("validateAccept: online reuse warns (does not abort) on a differing --server-port override", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-accept-online-"));
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  const configFile = path.join(dir, "psilink.yaml");
  const keyFile = path.join(dir, ".psilink.key");
  // Terms and host (the abort fields) agree, so reconcile proceeds; only the
  // overridden port differs from the saved 22 -- a "how you reach it" detail
  // that must warn and apply, not abort.
  saveConfig(configFile, {
    connection: { channel: "sftp", server: { host: "host", port: 22 } },
    linkageTerms: getDefaultLinkageTerms("Acceptor Org"),
  });
  const log = getLogger("accept-port-warn-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  const infoSpy = vi.spyOn(log, "info");
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const ready = await validateAccept({
      resolved: {
        mode: "online",
        url: new URL("sftp://host"),
        invitation: encoded,
        input,
      },
      options: testOptions({ configFile, keyFile, serverPort: 2222 }),
      log,
    });
    expect(ready.reuseExistingConfig).toBe(true);
    expect(
      warnSpy.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes("2222"),
      ),
    ).toBe(true);
    // With connection warnings emitted, the summary must not claim the config
    // "matches" -- that would contradict the just-emitted divergence.
    expect(
      infoSpy.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes("matches"),
      ),
    ).toBe(false);
  } finally {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- online accept: invitation-endpoint split directories --------------------

// A CSV the default linkage terms can fully satisfy, so the online path reaches
// prepareForOnlineExchange without a satisfiability abort. Returns a temp dir
// holding the input, config, and key paths (the caller removes the dir).
function onlineSplitFixture(): {
  dir: string;
  input: string;
  configFile: string;
  keyFile: string;
} {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-accept-split-"));
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  return {
    dir,
    input,
    configFile: path.join(dir, "psilink.yaml"),
    keyFile: path.join(dir, ".psilink.key"),
  };
}

test("validateAccept: online auto-applies a split endpoint's mirror-swapped directories", async () => {
  const { dir, input, configFile, keyFile } = onlineSplitFixture();
  const endpoint: ConnectionEndpoint = {
    channel: "sftp",
    host: "inviter-host",
    inboundPath: "/exchange/inviter-in",
    outboundPath: "/exchange/inviter-out",
  };
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE(), endpoint));
    const ready = await validateAccept({
      resolved: {
        mode: "online",
        // Credentials + reachable host come from the acceptor's own URL.
        url: new URL("sftp://acceptor:pw@reach-host/ignored-url-path"),
        invitation: encoded,
        input,
      },
      options: testOptions({ configFile, keyFile }),
      log: silentLog,
    });
    expect(ready.mode).toBe("online");
    if (ready.mode !== "online") return;
    const { connection } = ready;
    if (connection.channel !== "sftp") throw new Error("expected sftp");
    expect(connection.server.host).toBe("reach-host");
    expect(connection.server.username).toBe("acceptor");
    // Mirror-swapped from the endpoint (inviter outbound -> acceptor inbound);
    // the URL's single path is dropped in favor of the split pair.
    expect(connection.server.inboundPath).toBe("/exchange/inviter-out");
    expect(connection.server.outboundPath).toBe("/exchange/inviter-in");
    expect(connection.server.path).toBeUndefined();
    expect(connection.options?.retainFiles).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateAccept: online --outbound-path overrides the endpoint's split pair", async () => {
  const { dir, input, configFile, keyFile } = onlineSplitFixture();
  const endpoint: ConnectionEndpoint = {
    channel: "sftp",
    host: "inviter-host",
    inboundPath: "/exchange/inviter-in",
    outboundPath: "/exchange/inviter-out",
  };
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE(), endpoint));
    const ready = await validateAccept({
      resolved: {
        mode: "online",
        url: new URL("sftp://reach-host/my-inbound"),
        invitation: encoded,
        input,
      },
      // Explicit --outbound-path (with the retain mode a split requires) wins:
      // the URL path is the inbound and the flag is the outbound, never the
      // endpoint's swapped pair.
      options: testOptions({
        configFile,
        keyFile,
        outboundPath: "/my-outbound",
        retainFiles: true,
      }),
      log: silentLog,
    });
    expect(ready.mode).toBe("online");
    if (ready.mode !== "online") return;
    const { connection } = ready;
    if (connection.channel !== "sftp") throw new Error("expected sftp");
    expect(connection.server.inboundPath).toBe("/my-inbound");
    expect(connection.server.outboundPath).toBe("/my-outbound");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateAccept: online is unchanged by a non-split invitation endpoint", async () => {
  const { dir, input, configFile, keyFile } = onlineSplitFixture();
  const endpoint: ConnectionEndpoint = {
    channel: "sftp",
    host: "inviter-host",
    path: "/inviter/drop",
  };
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE(), endpoint));
    const ready = await validateAccept({
      resolved: {
        mode: "online",
        url: new URL("sftp://reach-host/url-drop"),
        invitation: encoded,
        input,
      },
      options: testOptions({ configFile, keyFile }),
      log: silentLog,
    });
    expect(ready.mode).toBe("online");
    if (ready.mode !== "online") return;
    const { connection } = ready;
    if (connection.channel !== "sftp") throw new Error("expected sftp");
    // The connection is exactly what the URL builds: a single shared path, no
    // split pair, no seeded retain mode.
    expect(connection.server.path).toBe("/url-drop");
    expect(connection.server.inboundPath).toBeUndefined();
    expect(connection.server.outboundPath).toBeUndefined();
    expect(connection.options?.retainFiles).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- partner-string sanitization on the accept path --------------------------
// The invitation is crafted by the mutually-distrusting inviter; the fields it
// renders to the operator before acceptance must be escaped. These mirror the
// sanitizeForDisplay categories: control/ANSI and deceptive Unicode neutralized,
// ordinary values unchanged.

// Encodes a token WITHOUT schema validation (encodeInvitation would reject a
// malicious token), reproducing decodeInvitation's checksum + base64url framing
// so the decode path runs on attacker-shaped input.
async function encodeRaw(obj: unknown): Promise<string> {
  const toBase64Url = (b: Uint8Array): string =>
    btoa(Array.from(b, (byte) => String.fromCharCode(byte)).join(""))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return toBase64Url(bytes) + toBase64Url(new Uint8Array(hashBuf).slice(0, 4));
}

test("decode error escapes a hostile unrecognized endpoint key name end to end", async () => {
  // A malicious inviter adds an endpoint key whose NAME carries control/ANSI
  // bytes; strictObject rejects it, echoing the name into the message that
  // decodeAndValidateInvitation surfaces to the operator as a UsageError.
  const encoded = await encodeRaw({
    ...sampleToken(FUTURE()),
    connectionEndpoint: {
      channel: "sftp",
      host: "h",
      "\x1b[2J\x1b[31mFAKE": 1,
    },
  });
  const err = await decodeAndValidateInvitation(encoded).catch(
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UsageError);
  const msg = (err as Error).message;
  expect(msg).not.toContain("\x1b");
  expect(msg).toContain("\\x1b");
});

// Renders displayInvitation into the joined info-log output, through the same
// log-writing sink the unattended path renders to and spying on the given logger
// so each test can assert against its own logger instance. The acceptor's own
// outbound-send set defaults to undefined (the not-yet-known case), so a test
// exercising an unrelated line need not supply one.
function renderDisplayInvitation(
  log: ReturnType<typeof getLogger>,
  token: InvitationToken,
  ownOutboundSend?: ReadonlyArray<string>,
  promptFollows = true,
): string {
  const infoSpy = vi.spyOn(log, "info");
  try {
    displayInvitation({
      token,
      ownOutboundSend,
      emit: (line) => {
        log.info(line);
      },
      promptFollows,
    });
    return infoSpy.mock.calls.map((c) => String(c[0])).join("\n");
  } finally {
    infoSpy.mockRestore();
  }
}

/**
 * The bullet entries listed directly under `heading`, sliced out of the rendered
 * lines so an assertion about one list cannot be satisfied -- or broken -- by a
 * bullet belonging to another block at the same depth. An entry is a bullet line
 * one indent level deeper than the heading; an entry's own nested detail (a
 * linkage key's `matches on:` and `elements:` sub-list) sits deeper still and is
 * skipped rather than ending the run, so every sibling entry is collected and a
 * single displayed entry is distinguishable from two. The block ends at the first
 * line back at the heading's own level or shallower, or at an entry-level line
 * that is not a bullet.
 */
function entriesUnder(
  lines: ReadonlyArray<string>,
  heading: string,
): Array<string> {
  const index = lines.indexOf(heading);
  if (index < 0) return [];
  const indentOf = (line: string): number =>
    line.length - line.trimStart().length;
  const headingIndent = indentOf(heading);
  const entryIndent = headingIndent + 2;
  const bullet = `${" ".repeat(entryIndent)}- `;
  const entries: Array<string> = [];
  for (const line of lines.slice(index + 1)) {
    if (line.startsWith(bullet)) {
      entries.push(line.slice(bullet.length));
      continue;
    }
    if (indentOf(line) <= entryIndent) break;
  }
  return entries;
}

// The display's marked labels, spelled out rather than derived from CONSENT_FACTS,
// so a marker that silently changed vocabulary reddens the assertions using them
// instead of following the table.
const OUTBOUND_SEND_LABEL = "columns you will send (enforced)";
const INVITING_PARTY_LABEL = "inviting party (your partner's word)";

/** The acceptor's own outbound-send columns, as displayed. */
function outboundSendEntries(lines: ReadonlyArray<string>): Array<string> {
  return entriesUnder(lines, `  ${OUTBOUND_SEND_LABEL}:`);
}

test("displayInvitation escapes a hostile inviter identity and key names", () => {
  const token: InvitationToken = {
    ...sampleToken(FUTURE()),
    linkageTerms: {
      ...getDefaultLinkageTerms("Inviter Org"),
      identity: "\x1b[31mEVIL\u202e",
      linkageKeys: [{ name: "k\x1b[0m", elements: [{ field: "ssn" }] }],
      // A hostile requested-from-you column name reaches the new "requests from
      // you" line; it must be escaped there too.
      payload: { receive: [{ name: "req\x1b[0m\u202e" }] },
    },
  };
  const log = getLogger("accept-display-test");
  log.setLevel("silent");
  // A hostile acceptor-file column name reaches the new "columns you will send"
  // line; it must be escaped there too. The acceptor's own outbound-send names
  // are operator-file strings rather than partner-controlled, but they still pass
  // through the same escaping, so the assertion covers that line as well.
  const joined = renderDisplayInvitation(log, token, ["send\x1b[0m\u202e"]);
  expect(joined).not.toContain("\x1b");
  expect(joined).not.toContain("\u202e");
  expect(joined).toContain("\\x1b");
  expect(joined).toContain("\\u202e");
});

test("displayInvitation: the carried disclosed subset shows names, '(none)' when empty, and nothing when absent", () => {
  // The acceptor's "columns you will receive" line. A present subset is shown
  // (an empty one as "(none)", since the empty set is a real "receive nothing"
  // lock-in); an absent subset (an older or metadata-unknown mint, reconciled
  // lazily) shows no line at all.
  const log = getLogger("accept-display-receive-test");
  log.setLevel("silent");
  const lines = (token: InvitationToken): string =>
    renderDisplayInvitation(log, token);
  const base = sampleToken(FUTURE());
  const named = lines({
    ...base,
    disclosedPayloadColumns: ["diagnosis", "notes"],
  });
  expect(named).toContain("columns you will receive (enforced):");
  expect(named).toContain("\n    - diagnosis");
  expect(named).toContain("\n    - notes");
  // The empty-set lock-in names the party that aborts. The two directions are not
  // symmetric in who that is: this one is enforced by THIS party's own received-
  // payload reconciliation, so a subject-less "would abort the exchange" would
  // leave the acceptor unable to tell it apart from the opposite direction below.
  expect(lines({ ...base, disclosedPayloadColumns: [] })).toContain(
    "columns you will receive (enforced): (none) -- your side aborts the " +
      "exchange if the inviting party sends any",
  );
  expect(lines({ ...base, disclosedPayloadColumns: undefined })).not.toContain(
    "columns you will receive",
  );
});

test("displayInvitation: the inviter's request-from-acceptor receive shows names, '(none)' when empty, and nothing when absent", () => {
  // The opposite direction from "columns you will receive": the inviter's
  // payload.receive is what it requests FROM this party. A declared receive
  // (present, even if empty) is shown -- an empty one as "(none)", since it
  // strictly asserts this party sends nothing -- while an absent receive (lazy)
  // shows no line at all. CLI counterpart of the web "requests from you" line.
  const log = getLogger("accept-display-request-test");
  log.setLevel("silent");
  const lines = (token: InvitationToken): string =>
    renderDisplayInvitation(log, token);
  const base = sampleToken(FUTURE());
  const withReceive = (
    receive: { name: string }[] | undefined,
  ): InvitationToken => ({
    ...base,
    linkageTerms: { ...base.linkageTerms, payload: { receive } },
  });
  const named = lines(withReceive([{ name: "dose" }, { name: "outcome" }]));
  expect(named).toContain(
    "columns the inviting party requests from you (your partner's word):",
  );
  expect(named).toContain("\n    - dose");
  expect(named).toContain("\n    - outcome");
  // The mirror of the lock-in above, and the aborting party is the other one: the
  // inviter locked this empty set in as what it will receive, so its side is what
  // fails when this party transmits anything.
  expect(lines(withReceive([]))).toContain(
    "columns the inviting party requests from you (your partner's word): " +
      "(none) -- the inviting party aborts the exchange if you send any",
  );
  expect(lines(withReceive(undefined))).not.toContain(
    "the inviting party requests from you",
  );
});

test("displayInvitation: shows the acceptor's own outbound send, one column per line", () => {
  // The columns THIS party will disclose to the partner for matched records -- its
  // own outbound disclosure. A non-empty set is shown one column per line (so a name
  // containing the list separator is not misread as two entries), leading the
  // details before the inviter's proposed terms.
  const log = getLogger("accept-display-outbound-test");
  log.setLevel("silent");
  const joined = renderDisplayInvitation(log, sampleToken(FUTURE()), [
    "diagnosis",
    "medication",
  ]);
  const lines = joined.split("\n");
  // The heading is present and the columns appear one per line, before the
  // inviter's "columns you will receive"/"linkage keys" terms.
  const headingIndex = lines.findIndex((l) =>
    l.includes(`${OUTBOUND_SEND_LABEL}:`),
  );
  expect(headingIndex).toBeGreaterThanOrEqual(0);
  expect(lines).toContain("    - diagnosis");
  expect(lines).toContain("    - medication");
  // No presupposing empty/unknown phrasing when the set is a real non-empty
  // disclosure.
  expect(joined).not.toContain("(none)");
  expect(joined).not.toContain("not yet known");
});

test("displayInvitation: a column name containing the list separator is not split into two entries", () => {
  // sanitizeForDisplay does not escape a printable ASCII comma, so a joined list
  // would misread a single column named "last, first" as two columns. Rendering one
  // per line keeps it a single entry.
  const log = getLogger("accept-display-outbound-comma-test");
  log.setLevel("silent");
  const lines = renderDisplayInvitation(log, sampleToken(FUTURE()), [
    "last, first",
    "notes",
  ]).split("\n");
  // The comma-bearing name is one entry on its own line, not split at the comma,
  // and the separator did not create a third entry.
  expect(outboundSendEntries(lines)).toEqual(["last, first", "notes"]);
});

test("displayInvitation: the empty and not-yet-known outbound-send cases avoid a presupposing phrase", () => {
  // Empty (the acceptor discloses nothing) and not-yet-known (no metadata resolved
  // at prompt time) must both stay truthful: neither asserts a definite non-empty
  // outbound send.
  const log = getLogger("accept-display-outbound-empty-test");
  log.setLevel("silent");
  const base = sampleToken(FUTURE());
  // Empty: a real "you disclose nothing", shown as a truthful (none) line, not a
  // list and not a forward-reference.
  const empty = renderDisplayInvitation(log, base, []);
  expect(empty).toContain(
    `${OUTBOUND_SEND_LABEL}: (none) -- only matched records`,
  );
  expect(outboundSendEntries(empty.split("\n"))).toEqual([]);
  // Not-yet-known: no metadata at prompt time, so the line says the set is not
  // known rather than claiming any count -- and names what actually settles it.
  // Nothing on this path asks the acceptor to confirm the set later, unlike the
  // web acceptor, which chooses its file on the consent screen itself, so the line
  // must not point ahead to a confirmation psilink never gives.
  const unknown = renderDisplayInvitation(log, base, undefined);
  expect(unknown).toContain(`${OUTBOUND_SEND_LABEL}: not yet known`);
  expect(unknown).toContain(
    "    Determined from your input file when the exchange runs; psilink does " +
      "not ask you to confirm it again.",
  );
  expect(unknown).not.toContain("(none)");
  expect(unknown).not.toContain("you will confirm");
  expect(outboundSendEntries(unknown.split("\n"))).toEqual([]);
});

test("displayInvitation: shows the linkage strategy and, for single-pass, the disclosure note", () => {
  const log = getLogger("accept-display-strategy-test");
  log.setLevel("silent");
  const lines = (token: InvitationToken): string =>
    renderDisplayInvitation(log, token);
  const base = sampleToken(FUTURE());
  // The default (cascade) is shown plainly, with no disclosure note.
  const cascade = lines(base);
  expect(cascade).toContain("linkage strategy (enforced): cascade");
  expect(cascade).not.toContain("consented disclosure tradeoff");
  // single-pass is the disclosure-affecting choice the acceptor consents to, so
  // it carries the shared tradeoff note (with the operator-facing doc pointer).
  const singlePass = lines({
    ...base,
    linkageTerms: { ...base.linkageTerms, linkageStrategy: "single-pass" },
  });
  expect(singlePass).toContain("linkage strategy (enforced): single-pass");
  expect(singlePass).toContain("consented disclosure tradeoff");
  expect(singlePass).toContain("docs/EXCHANGE_REFERENCE.md");
});

test("displayInvitation: represents every consent-relevant linkage term, bar the recorded gaps", () => {
  // Which terms an acceptor's consent turns on is judged once, in core's shared
  // classification, so this prompt and the web consent summary cannot drift on
  // the answer. A term is represented here when two sets of terms differing at
  // that term alone print differently; one the prompt omits prints identically
  // and has to be recorded as a gap in that same classification.
  const log = getLogger("accept-display-coverage-test");
  log.setLevel("silent");
  // One token, reused across every rendering, so only the terms move -- minting
  // a fresh one per render would vary the displayed `expires` too. Its
  // `disclosedPayloadColumns` is left absent deliberately: it is a token field
  // the inviter derives from its own metadata, not a linkage term, and supplying
  // one would answer the question about it rather than about `payload.send`. The
  // acceptor's own outbound-send set is held at the not-yet-known case for the
  // same reason.
  const token = sampleToken(FUTURE());
  const render = (linkageTerms: LinkageTerms): string =>
    renderDisplayInvitation(log, { ...token, linkageTerms });

  const probes = consentRepresentationProbes();
  expect(probes.length).toBeGreaterThan(0);
  expect(
    probes
      .filter((probe) => render(probe.base) === render(probe.variant))
      .map((probe) => probe.path)
      .sort(),
  ).toEqual(
    probes
      .filter((probe) => probe.unrepresented.cli !== undefined)
      .map((probe) => probe.path)
      .sort(),
  );
});

test("displayInvitation: shows each matching rule the acceptor is consenting to", () => {
  // The representation check above proves each term MOVES the output; these pin
  // what it actually says, so a term cannot satisfy that check while reading as
  // something else. The probe terms carry one of everything: a parameterized
  // transform, a fuzzy comparison, a swap, field constraints, a payload in both
  // directions, and a legal agreement.
  const log = getLogger("accept-display-rules-test");
  log.setLevel("silent");
  const out = renderDisplayInvitation(log, {
    ...sampleToken(FUTURE()),
    linkageTerms: CONSENT_PROBE_TERMS,
  });

  expect(out).toContain("    - given name, family name, and date of birth");
  // The elements the key combines, each under its declared semantic type -- the
  // partner-authored field name is deliberately not shown.
  expect(out).toContain("        - First name");
  expect(out).toContain("        - Last name");
  expect(out).toContain("        - Date of birth");
  // A transform with its plain-language consequence and every declared parameter.
  expect(out).toContain("          transform: to_upper_case");
  expect(out).toContain("          transform: substring");
  expect(out).toContain("            - start: 1");
  expect(out).toContain("            - length: 3");
  // The fuzzy-comparison expansion, marked as proposed: the run does not yet
  // apply it, so the prompt must not state a looser match than it performs.
  expect(out).toContain(
    "          also matches approximate variants (adjacent years) (proposed; not yet applied)",
  );
  // The swap, and the cross-application of the transform-carrier's rules onto the
  // other element's value that the generic swap note alone does not convey.
  expect(out).toContain(
    "      swap: First name and Last name may be matched in either order",
  );
  expect(out).toContain(
    "note: when matched in that order, the transforms shown for First name are " +
      "applied to Last name's value",
  );
  // The per-field data standards, under a heading marking them as the inviter's
  // own undertaking rather than rules the exchange applies, with the
  // partner-authored character class shown raw after a fixed first-party label
  // rather than paraphrased as a vetted allow-list.
  expect(out).toContain("      declared data standards (your partner's word):");
  expect(out).toContain("        - honorifics and suffixes removed");
  expect(out).toContain("        - 1 excluded value");
  expect(out).toContain("        - values must be valid");
  expect(out).toContain("        - allowed characters: A-Za-z");
  // Both payload directions, and the attached agreement.
  expect(out).toContain("    - risk_score");
  expect(out).toContain("    - program_outcome");
  expect(out).toContain("    reference: MOU-2026-0001");
  expect(out).toContain(
    "    stated purpose: Evaluation of the county tutoring program",
  );
  expect(out).toContain("    agreement valid through: 2027-12-31");
});

test("displayInvitation: a proposed setting the run does not apply is marked, not stated as in force", () => {
  // deduplicate and psi-c are declarable but unimplemented, and core refuses both
  // on every run path. Printing either as a plain fact would have the operator
  // consent to a behavior the run does not perform.
  const log = getLogger("accept-display-proposed-test");
  log.setLevel("silent");
  const base = sampleToken(FUTURE());
  const render = (overrides: Partial<LinkageTerms>): string =>
    renderDisplayInvitation(log, {
      ...base,
      linkageTerms: { ...base.linkageTerms, ...overrides },
    });

  const oneToOne = render({});
  expect(oneToOne).toContain(
    "duplicate matches (enforced): each record matches at most one of the " +
      "partner's records",
  );
  expect(oneToOne).not.toContain("proposes this");

  const deduplicating = render({ deduplicate: true });
  expect(deduplicating).toContain(
    "duplicate matches (enforced): a record may match more than one of the " +
      "partner's records",
  );
  expect(deduplicating).toContain(
    "    Your partner proposes this, but this version of the exchange does " +
      "not yet apply it and will refuse to run; ask your partner for an " +
      "invitation without deduplication.",
  );
});

test("displayInvitation: every classified fact is marked, and carries core's caveat verbatim", () => {
  // An acceptor meets two unlike kinds of fact here: ones the exchange holds
  // itself, and ones that are only what the inviting party declared. Reading a
  // cooperative undertaking as a cryptographic guarantee is the error this
  // marking exists to prevent, so an enforced line is marked positively rather
  // than told apart by the absence of a marker on the other.
  const log = getLogger("accept-display-basis-test");
  log.setLevel("silent");
  const render = (output: LinkageTerms["output"], receive: boolean): string =>
    renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: {
        ...CONSENT_PROBE_TERMS,
        output,
        // A party that receives no output may request no payload columns, so the
        // request is dropped alongside expectsOutput rather than left to fail the
        // schema.
        payload: receive
          ? CONSENT_PROBE_TERMS.payload
          : { ...CONSENT_PROBE_TERMS.payload, receive: [] },
      },
    });
  // Between them these two raise every caveat the shared table carries: this
  // party receives nothing while the inviter does, then the reverse.
  const acceptorWithheld = render(
    { expectsOutput: true, shareWithPartner: false },
    true,
  );
  const inviterWithheld = render(
    { expectsOutput: false, shareWithPartner: true },
    false,
  );
  const rendered = `${acceptorWithheld}\n${inviterWithheld}`;

  // The whole table, rather than a list restated here: a caveat this renderer
  // authored for itself instead of reading is absent from the rendering and fails,
  // and one the web reworded on its own side fails there for the same reason.
  const classified: Array<ConsentFact> = Object.values(CONSENT_FACTS);
  const notes = classified
    .map((fact) => fact.note)
    .filter((note) => note !== undefined);
  expect(notes.length).toBeGreaterThan(0);
  for (const note of notes) expect(rendered).toContain(`\n    ${note}`);

  // Both classes marked, on the pair whose difference in register is the whole
  // reason for marking: this party's own non-receipt is a hard fact the run holds,
  // and withholding a result from the partner is not.
  expect(acceptorWithheld).toContain(
    "  you will receive the result (enforced): no",
  );
  expect(acceptorWithheld).toContain(
    "  the inviting party will receive the result (your partner's word): yes",
  );
  expect(inviterWithheld).toContain(
    "  you will receive the result (enforced): yes",
  );
  expect(inviterWithheld).toContain(
    "  the inviting party will receive the result (your partner's word): no",
  );
  // The honest-helper disclosure is its own fact, not a rider on the cooperative
  // caveat: it holds however honestly the partner behaves, so it carries the
  // opposite basis and may not inherit that line's marker.
  expect(inviterWithheld).toContain(
    "  what your partner learns either way (enforced):",
  );
  // The remaining marked lines, each on the register it belongs to.
  expect(rendered).toContain(`  ${INVITING_PARTY_LABEL}: `);
  expect(rendered).toContain(
    "      declared data standards (your partner's word):",
  );
  expect(rendered).toContain(
    "  allowed-character patterns (your partner's word):",
  );
});

test("the psi-c caveat states the refusal, on both surfaces, from one terms document", () => {
  // psi-c is refused outright on every run path (assertAlgorithmImplemented), so
  // the exchange aborts before any identifier is revealed. A caveat saying the
  // matched identifiers are still revealed would describe a run that does not
  // happen.
  //
  // apps/web/test/browser/invitationTerms pins the same sentence against the same
  // terms document, so the pair cannot drift apart silently. When the count-only
  // run path lands, both flip together and both pins have to be edited -- which is
  // the point of pinning them.
  const log = getLogger("accept-display-psi-c-test");
  log.setLevel("silent");
  const countOnly = renderDisplayInvitation(log, {
    ...sampleToken(FUTURE()),
    linkageTerms: { ...CONSENT_PROBE_TERMS, algorithm: "psi-c" },
  });
  expect(countOnly).toContain("PSI algorithm (enforced): psi-c");
  expect(countOnly).toContain(
    "    Your partner proposes a count-only exchange, but this version of the " +
      "exchange does not yet apply it and will refuse to run; ask your partner " +
      'for an invitation using the "psi" algorithm.',
  );
  // The consequence neither surface may state: nothing is revealed, because
  // nothing runs.
  expect(countOnly).not.toContain(
    "the shared identifiers of matched records are still revealed",
  );
});

/**
 * The probe terms carrying a single linkage key whose one element applies
 * `transform`, so a transform-rendering assertion reads that key's detail with no
 * other key's rules at the same indent. The probe's own fields are reused as-is.
 */
function probeTermsWithTransform(
  transform: Array<TransformStep>,
): LinkageTerms {
  return {
    ...CONSENT_PROBE_TERMS,
    linkageKeys: [
      { name: "probe key", elements: [{ field: "given_name", transform }] },
    ],
  };
}

test("displayInvitation: a transform this version cannot explain is marked as unrecognized", () => {
  // A declared function name core does not recognize has neither a literal slice
  // phrase nor a glossary description, so unmarked it prints in exactly the shape
  // of a recognized rule minus one line -- indistinguishable from a rule psilink
  // understands. A rule this version cannot explain earns the same explicitness as
  // one it cannot apply.
  const log = getLogger("accept-display-unknown-transform-test");
  log.setLevel("silent");
  const render = (transform: Array<TransformStep>): string =>
    renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: probeTermsWithTransform(transform),
    });

  const unrecognized = render([{ function: "org_internal_rule" }]);
  expect(unrecognized).toContain("          transform: org_internal_rule");
  expect(unrecognized).toContain(
    "            not recognized by this version; its effect on matching is not shown",
  );
  // A recognized function carries its plain-language consequence and no marker, so
  // the marker tells the two apart rather than decorating both.
  const recognized = render([{ function: "to_upper_case" }]);
  expect(recognized).toContain(
    "            Upper-cases the value before matching, so values differing only in letter case can match.",
  );
  expect(recognized).not.toContain("not recognized by this version");
});

test("displayInvitation: a coerced transform parameter names the parameter and the value it runs as", () => {
  // `replace_regex` with `replacement: null` executes as the empty string. The
  // declared parameter is shown verbatim and the coercion is its own line, so
  // partner text placed inside a parameter value cannot impersonate it; this pins
  // the CLI's own rendering of that line, including which half is the parameter.
  const log = getLogger("accept-display-coercion-test");
  log.setLevel("silent");
  const lines = renderDisplayInvitation(log, {
    ...sampleToken(FUTURE()),
    linkageTerms: probeTermsWithTransform([
      {
        function: "replace_regex",
        params: { pattern: "-", replacement: null },
      },
    ]),
  }).split("\n");

  const coercion = "            replacement runs as the empty string";
  const param = "            - replacement: null";
  expect(lines).toContain(param);
  expect(lines).toContain(coercion);
  // The parameter names itself first: a swapped interpolation would read as a
  // parameter called "the empty string".
  expect(lines).not.toContain(
    "            the empty string runs as replacement",
  );
  expect(lines.indexOf(coercion)).toBeGreaterThan(lines.indexOf(param));
});

test("displayInvitation: names the fields matched on, once at the top and under each key", () => {
  // The key `name` is partner free text and would otherwise be the only line at a
  // key's own level, so an operator scanning key headings would read nothing but
  // strings the inviter chose. The derived field one-liner is the honest anchor,
  // and it carries the breadth the rules alone do not spell out.
  const log = getLogger("accept-display-matched-fields-test");
  log.setLevel("silent");
  const lines = renderDisplayInvitation(log, {
    ...sampleToken(FUTURE()),
    linkageTerms: CONSENT_PROBE_TERMS,
  }).split("\n");

  expect(lines).toContain(
    "  matched on (enforced): first name, last name, date of birth",
  );
  // The swap re-attributes each element's marker to its partner's field, so the
  // truncating element's "partial" is shown on the field it will actually read.
  const keyIndex = lines.indexOf(
    "    - given name, family name, and date of birth",
  );
  expect(keyIndex).toBeGreaterThanOrEqual(0);
  expect(lines[keyIndex + 1]).toBe(
    "      matches on: first name - last name (partial) - " +
      "date of birth (fuzzy) (matched in either order)",
  );
  expect(lines[keyIndex + 2]).toBe("      elements:");
});

test("displayInvitation: the operator's own outbound heading sits level with the other payload headings", () => {
  // Indentation carries hierarchy in this outline, so the operator's own outbound
  // disclosure must not be the one heading a level below its two counterparts, at
  // the depth of a linkage-key entry.
  const log = getLogger("accept-display-indent-test");
  log.setLevel("silent");
  const lines = renderDisplayInvitation(
    log,
    {
      ...sampleToken(FUTURE()),
      linkageTerms: CONSENT_PROBE_TERMS,
      disclosedPayloadColumns: ["risk_score"],
    },
    ["diagnosis"],
  ).split("\n");

  expect(lines).toContain(`  ${OUTBOUND_SEND_LABEL}:`);
  expect(lines).toContain("  columns you will receive (enforced):");
  expect(lines).toContain(
    "  columns the inviting party requests from you (your partner's word):",
  );
  expect(outboundSendEntries(lines)).toEqual(["diagnosis"]);
});

test("displayInvitation: the short field list precedes the long key list", () => {
  // The keys enumerate combinations OF the fields and run many times longer, so on
  // a terminal the block printed second is the one that scrolls the first away.
  const log = getLogger("accept-display-order-test");
  log.setLevel("silent");
  const lines = renderDisplayInvitation(log, {
    ...sampleToken(FUTURE()),
    linkageTerms: CONSENT_PROBE_TERMS,
  }).split("\n");

  const fields = lines.indexOf("  personal data used (enforced):");
  const keys = lines.indexOf("  linkage keys (enforced):");
  expect(fields).toBeGreaterThanOrEqual(0);
  expect(keys).toBeGreaterThan(fields);
});

// The two headings the repeated decision block can sit under. Only the framing
// differs: a prompt follows on one path and nothing does on the other.
const REPEAT_HEADING = "Before you accept, repeated from above:";
const REPEAT_HEADING_UNATTENDED = "Repeated from above:";

test("displayInvitation: the decision facts are repeated verbatim immediately before the prompt", () => {
  // The terms run well past a screen, so an operator answering the prompt reads the
  // tail: the columns they send, who they disclose to, and the algorithm have all
  // scrolled away. They are printed again last, by the same renderer that prints
  // them first, and this measures the property that makes the second printing a
  // repetition rather than a second account -- the two are byte-identical, so
  // neither can state a fact the other does not. A recap composing its own wording
  // is what would need a check that its facts appear above; this needs only that
  // the bytes match.
  const log = getLogger("accept-display-repeat-test");
  log.setLevel("silent");
  const defaultTerms = getDefaultLinkageTerms("Inviter Org");
  const cases: Array<{
    linkageTerms: LinkageTerms;
    ownOutboundSend: ReadonlyArray<string> | undefined;
  }> = [
    { linkageTerms: defaultTerms, ownOutboundSend: ["diagnosis", "notes"] },
    { linkageTerms: defaultTerms, ownOutboundSend: [] },
    { linkageTerms: defaultTerms, ownOutboundSend: undefined },
    { linkageTerms: CONSENT_PROBE_TERMS, ownOutboundSend: ["diagnosis"] },
    {
      linkageTerms: { ...CONSENT_PROBE_TERMS, algorithm: "psi-c" },
      ownOutboundSend: [],
    },
    // The hostile fixtures, so the repetition is measured on a partner identity
    // carrying escapes rather than only on well-behaved text.
    ...hostileVariants.map(({ source }) => ({
      linkageTerms: source.linkageTerms,
      ownOutboundSend: [`own${BEL}column`],
    })),
  ];

  for (const { linkageTerms, ownOutboundSend } of cases) {
    // The block is rendered independently rather than read off either printing, so
    // its LENGTH is measured too. Slicing the tail and comparing it to an
    // equal-length window at the head is a sliding comparison: it cannot see a line
    // appended after the repetition that happens to match the head's next line,
    // which leaves the end of the output unmeasured.
    const block: Array<string> = [];
    logDecisionFacts(
      (entry) => block.push(entry),
      summarizeInvitation({ ...sampleToken(FUTURE()), linkageTerms }),
      ownOutboundSend,
    );

    // Both paths through the consent decision. The heading differs -- under
    // --consent-to-terms no prompt follows, so a heading framing the block as
    // something to decide on would be asking for a decision already recorded --
    // and the block below it does not, which is what keeps the two printings one
    // wording rather than two.
    for (const [promptFollows, expectedHeading] of [
      [true, REPEAT_HEADING],
      [false, REPEAT_HEADING_UNATTENDED],
    ] as const) {
      const lines = renderDisplayInvitation(
        log,
        { ...sampleToken(FUTURE()), linkageTerms },
        ownOutboundSend,
        promptFollows,
      ).split("\n");

      expect(lines.filter((line) => line === expectedHeading)).toHaveLength(1);
      const heading = lines.indexOf(expectedHeading);
      // Exact equality, not a prefix: a line printed after the repetition makes
      // the tail longer than the block and fails here, whatever that line says.
      expect(lines.slice(heading + 1)).toEqual(block);
      // The same block, byte for byte, at the head of the display -- where index 0
      // is the "Invitation details:" heading the facts open under.
      expect(lines.slice(1, 1 + block.length)).toEqual(block);
      // The unattended heading asks nothing, so the prompting path's framing must
      // not survive anywhere on it.
      if (!promptFollows) expect(lines).not.toContain(REPEAT_HEADING);
    }

    // Non-vacuous: the block carries the decisive partner-controlled fact rather
    // than being an empty tail that trivially matches.
    expect(
      block.some((line) => line.startsWith(`  ${INVITING_PARTY_LABEL}: `)),
    ).toBe(true);
    expect(
      block.some((line) => line.startsWith(`  ${OUTBOUND_SEND_LABEL}`)),
    ).toBe(true);
  }
});

test("displayInvitation: every linkage key is listed, including one after an entry with nested detail", () => {
  // entriesUnder backs the separator-safety assertions, so it must collect
  // siblings across an entry's own nested block (a key's derived one-liner and its
  // elements) rather than halting there and silently under-checking. The first key
  // also carries the list separator in its name, which a joined list would misread
  // as two keys.
  const log = getLogger("accept-display-key-siblings-test");
  log.setLevel("silent");
  const lines = renderDisplayInvitation(log, {
    ...sampleToken(FUTURE()),
    linkageTerms: {
      ...CONSENT_PROBE_TERMS,
      linkageKeys: [
        {
          name: "surname, given name",
          elements: [{ field: "family_name" }, { field: "given_name" }],
        },
        { name: "date of birth", elements: [{ field: "birth_date" }] },
      ],
    },
  }).split("\n");

  expect(entriesUnder(lines, "  linkage keys (enforced):")).toEqual([
    "surname, given name",
    "date of birth",
  ]);
});

test.each(hostileVariants)(
  "displayInvitation: every line stays printable ASCII on hostile terms ($name)",
  ({ source }) => {
    // The prompt renders every partner-controlled position the summary holds --
    // transform function names and parameters, the allowed-character class, the
    // legal agreement, the expiry -- so the escaping claim is checked over the
    // whole output rather than the few fields an enumeration would list. The
    // fixture is the same one the web app's consent screen is walked with, so the
    // two surfaces cannot drift on what a hostile invitation looks like. This also
    // pins that a key's raw `id` never reaches the prompt: it carries the
    // unsanitized key name, which would fail here.
    const log = getLogger("accept-display-hostile-test");
    log.setLevel("silent");
    const lines = renderDisplayInvitation(
      log,
      { ...sampleToken(FUTURE()), ...source },
      [`own${BEL}column`],
    ).split("\n");
    // Guard against a vacuous pass: the prompt must have reached the nested
    // rules, and each hostile code point must appear in its escaped form -- so
    // an output that collapsed, or one the partner text never flowed into,
    // fails here rather than satisfying the assertion below by having nothing
    // to check.
    expect(lines.length).toBeGreaterThan(20);
    for (const hostile of [ESC, RLO, BEL])
      expect(
        lines.filter((line) => line.includes(sanitizeForDisplay(hostile)))
          .length,
      ).toBeGreaterThan(0);
    expect(lines.filter((line) => !PRINTABLE_ASCII.test(line))).toEqual([]);
  },
);

test("displayInvitation: a linkage key name containing the list separator is one entry", () => {
  // sanitizeForDisplay leaves a printable ASCII comma intact, so a comma-joined
  // key list would read a single key named "surname, given name" as two keys.
  const log = getLogger("accept-display-key-comma-test");
  log.setLevel("silent");
  const base = sampleToken(FUTURE());
  const lines = renderDisplayInvitation(log, {
    ...base,
    linkageTerms: {
      ...base.linkageTerms,
      linkageKeys: [
        { name: "surname, given name", elements: [{ field: "last_name" }] },
      ],
    },
  }).split("\n");
  expect(entriesUnder(lines, "  linkage keys (enforced):")).toEqual([
    "surname, given name",
  ]);
});

// --- handler: repeated single-value flag -------------------------------------

test("handler: a repeated single-value flag is rejected (exit 64) via runOrExit", async () => {
  // accept has no command-specific single-value flags; it reads them all through
  // parseCommonBootstrapArgs inside runOrExit. A repeated common flag (here
  // --server-port) is therefore rejected with a clean usage error before
  // resolveAcceptPositionals/validateAccept run. runOrExit logs the message via
  // getLogger("accept").error; spying that method is robust because the guard
  // throws inside parseCommonBootstrapArgs, before setDefaultLevel could rebind
  // the logger's methods.
  const logErr = vi
    .spyOn(getLogger("accept"), "error")
    .mockImplementation(() => {});
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    await acceptHandler({
      _: [],
      $0: "psilink",
      args: ["sftp://host/drop", "INVITATION", "input.csv"],
      "server-port": [2222, 2223],
    } as unknown as Arguments);
    // Assert before restoring the spies: mockRestore clears the recorded calls.
    expect(exit).toHaveBeenCalledWith(64);
    expect(logErr).toHaveBeenCalledWith("--server-port may be given only once");
  } finally {
    logErr.mockRestore();
    exit.mockRestore();
  }
});

test("handler: a mistyped --flag exits 64 naming it, before decode/prompt/write", async () => {
  // accept sets unknown-options-as-args (so a `-`-leading invitation survives),
  // which also lands a mistyped --server-usernam in the positionals; it must be
  // rejected before the invitation decode, the confirmation prompt, or any file
  // write -- not absorbed as the invitation positional.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-accept-unknown-"));
  const configFile = path.join(dir, "psilink.yaml");
  const keyFile = path.join(dir, ".psilink.key");
  const errors: string[] = [];
  const logErr = vi
    .spyOn(getLogger("accept"), "error")
    .mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    const encoded = await encodeInvitation(
      sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
    );
    await acceptHandler({
      _: [],
      $0: "psilink",
      args: ["--server-usernam", "u", encoded, "input.csv"],
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "silent",
      record: false,
    } as unknown as Arguments);
    expect(exit).toHaveBeenCalledWith(64);
    expect(errors.join("\n")).toContain("--server-usernam");
    expect(promptConfirmMock).not.toHaveBeenCalled();
    expect(fs.existsSync(configFile)).toBe(false);
    expect(fs.existsSync(keyFile)).toBe(false);
  } finally {
    logErr.mockRestore();
    exit.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- handler: `--consent-to-terms` gates the confirmation prompt -------------

/** A temp dir with a satisfiable offline-accept input CSV and config/key paths. */
function offlineAcceptFixture(): {
  dir: string;
  input: string;
  configFile: string;
  keyFile: string;
} {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-accept-consent-"));
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  return {
    dir,
    input,
    configFile: path.join(dir, "psilink.yaml"),
    keyFile: path.join(dir, ".psilink.key"),
  };
}

test("handler: --consent-to-terms skips the confirmation prompt and writes the config and key", async () => {
  // With --consent-to-terms the prompt is never consulted (promptConfirm is not
  // called, so stdin is not read for a confirmation) and the offline acceptance
  // proceeds to write both files, on the recorded advance consent.
  const { dir, input, configFile, keyFile } = offlineAcceptFixture();
  // afterEach resets the shared mock, so it starts clean here; this test needs no
  // implementation because it asserts promptConfirm is never called.
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    const encoded = await encodeInvitation(
      sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
    );
    await acceptHandler({
      _: [],
      $0: "psilink",
      args: [encoded, input],
      "consent-to-terms": true,
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "silent",
      record: false,
    } as unknown as Arguments);
    expect(exit).not.toHaveBeenCalled();
    expect(promptConfirmMock).not.toHaveBeenCalled();
    expect(fs.existsSync(configFile)).toBe(true);
    expect(fs.existsSync(keyFile)).toBe(true);
  } finally {
    exit.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: without --consent-to-terms the prompt runs and a decline writes no files", async () => {
  // The unchanged default: the prompt runs, and a "no" (here the mocked decline,
  // which an EOF/non-TTY stdin also produces) leaves both files unwritten.
  const { dir, input, configFile, keyFile } = offlineAcceptFixture();
  // afterEach reset the mock to a clean slate; set the decline impl this test needs.
  promptConfirmMock.mockResolvedValue(false);
  // A prompting run at a level that drops info shows the terms at the prompt
  // regardless (the surface tests below measure that); capture stdio so they land
  // here rather than in the suite's own output.
  const stdio = captureStdio();
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    const encoded = await encodeInvitation(
      sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
    );
    await acceptHandler({
      _: [],
      $0: "psilink",
      args: [encoded, input],
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "silent",
      record: false,
    } as unknown as Arguments);
    expect(exit).not.toHaveBeenCalled();
    expect(promptConfirmMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(configFile)).toBe(false);
    expect(fs.existsSync(keyFile)).toBe(false);
  } finally {
    stdio.restore();
    exit.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- handler: the consent surface reaches wherever the prompt asks ------------

const SURFACE_HEADING = "Invitation details:";

// The first line the handler writes after the consent surface, one per path
// through the consent decision: the bypass note under --consent-to-terms, the
// decline note when the prompt answers no. What lies between the heading and
// whichever of these follows is the surface itself.
const POST_SURFACE_PREFIXES = [
  "--consent-to-terms given:",
  "invitation declined",
];

/**
 * Everything the run wrote to stderr, one entry per line, with the
 * `[ISO] [LEVEL] [context]` prefix stripped -- so a line the log put there and a
 * line written straight to the prompt's sink compare as the same line.
 */
function stderrLines(writes: ReadonlyArray<string>): Array<string> {
  const lines = writes.join("").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) =>
    line.replace(/^\[[^\]]*\] \[[A-Z]+\] \[[^\]]*\] /, ""),
  );
}

/**
 * The consent surface as stderr received it: the run of lines from the display's
 * heading to the first line the handler writes after it. Empty when the surface
 * never reached stderr at all.
 */
function surfaceOnStderr(writes: ReadonlyArray<string>): Array<string> {
  const lines = stderrLines(writes);
  const start = lines.indexOf(SURFACE_HEADING);
  if (start < 0) return [];
  const rest = lines.slice(start);
  const end = rest.findIndex(
    (line, index) =>
      index > 0 && POST_SURFACE_PREFIXES.some((p) => line.startsWith(p)),
  );
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * The consent surface the handler renders for `encoded` over the offline fixture,
 * produced by displayInvitation itself so an assertion compares the operator's
 * terminal against the whole surface rather than a few lines chosen for the test.
 * The fixture CSV discloses no payload columns -- pinned here, since a fixture
 * that started disclosing some would otherwise silently change what the handler
 * renders and leave every comparison below trivially true.
 */
async function expectedConsentSurface(
  encoded: string,
  promptFollows = true,
): Promise<Array<string>> {
  const lines: Array<string> = [];
  displayInvitation({
    token: await decodeAndValidateInvitation(encoded),
    ownOutboundSend: [],
    emit: (line) => lines.push(line),
    promptFollows,
  });
  expect(lines).toContain(
    `  ${OUTBOUND_SEND_LABEL}: (none) -- only matched records`,
  );
  expect(lines.length).toBeGreaterThan(20);
  return lines;
}

/**
 * Run the offline accept handler over `fixture` with `flags` folded into its
 * argv, capturing both standard streams -- so a test can assert what the terminal
 * received, and the mirrored surface never lands in the suite's own output.
 *
 * `onPrompt` answers the confirmation prompt and is handed everything stderr has
 * received at the instant it is called -- both routes to the operator in one
 * ordered transcript, since the log's own sink and the prompt's own writes land on
 * the same descriptor. That instant is the only place the "nothing intervenes
 * between the terms and the question" property can be read: by the time the
 * handler returns, its own post-decision lines have been written.
 */
async function runOfflineAcceptCapturingStdio(params: {
  encoded: string;
  fixture: ReturnType<typeof offlineAcceptFixture>;
  flags?: Record<string, unknown>;
  onPrompt?: (stderrWrites: ReadonlyArray<string>) => boolean;
}): Promise<{ stderrWrites: Array<string>; stdoutWrites: Array<string> }> {
  const { encoded, fixture, flags, onPrompt } = params;
  // A real invocation creates getLogger("accept") after applying --log-level, so
  // the command's logger carries the level the flag names. This suite runs many
  // invocations in one process, where that logger already exists and loglevel's
  // setDefaultLevel does not reach an existing named logger (driven against
  // loglevel 1.9.2: an existing logger keeps the level it was created with), so
  // the flag is applied to it here too and restored afterwards.
  const acceptLog = getLogger("accept");
  const priorLevel = acceptLog.getLevel();
  acceptLog.setLevel(
    ((flags?.["log-level"] as string | undefined) ??
      "info") as logLibrary.LogLevelDesc,
    false,
  );
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  const stdio = captureStdio();
  if (onPrompt !== undefined)
    promptConfirmMock.mockImplementation(() =>
      Promise.resolve(onPrompt(stdio.stderrWrites)),
    );
  try {
    await acceptHandler({
      _: [],
      $0: "psilink",
      args: [encoded, fixture.input],
      "config-file": fixture.configFile,
      "key-file": fixture.keyFile,
      record: false,
      ...flags,
    } as unknown as Arguments);
    expect(exit).not.toHaveBeenCalled();
    return {
      stderrWrites: [...stdio.stderrWrites],
      stdoutWrites: [...stdio.stdoutWrites],
    };
  } finally {
    stdio.restore();
    exit.mockRestore();
    acceptLog.setLevel(priorLevel, false);
  }
}

test("handler: nothing reaches the operator between the terms and the question", async () => {
  // The repeated decision block is the last thing printed, so the y/N is answered
  // against those facts rather than the tail of the key list. A line added between
  // displayInvitation and promptConfirm would push the block off a short terminal
  // with nothing turning red -- so the property is a check rather than a comment.
  //
  // It reads what the OPERATOR saw, not what one route emitted: the surface
  // reaches them through the log's own sink on the default routing, and through
  // the prompt's own stream where the log would miss it (--log-file), and both
  // land on stderr. A check watching only the logger would pass while a direct
  // prompt-stream write scrolled the block away. Both routings are driven here,
  // and in each the transcript is snapshotted at the instant the prompt is called.
  const fixture = offlineAcceptFixture();
  const logFile = path.join(fixture.dir, "accept.log");
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const surface = await expectedConsentSurface(encoded);
    // The repeated block with its heading: everything from the heading to the end
    // of the display. Taken from the renderer rather than restated, so the check
    // measures the block's whole length and not a line or two chosen for it.
    const repeated = surface.slice(surface.indexOf(REPEAT_HEADING));
    expect(repeated.length).toBeGreaterThan(1);
    for (const flags of [{}, { "log-file": logFile }]) {
      let atPrompt: Array<string> | undefined;
      await runOfflineAcceptCapturingStdio({
        encoded,
        fixture,
        flags,
        onPrompt: (stderrWrites) => {
          atPrompt = stderrLines([...stderrWrites]);
          return false;
        },
      });
      expect(promptConfirmMock).toHaveBeenCalledTimes(1);
      expect(atPrompt).toBeDefined();
      // The last thing on the operator's terminal when the question arrives is the
      // repeated block, entire and in order. Anything written in that window --
      // by either route -- lands after it and fails this.
      expect(atPrompt!.slice(-repeated.length)).toEqual(repeated);
      promptConfirmMock.mockReset();
    }
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("handler: --log-file records the terms and still shows them where the prompt asks", async () => {
  // The file sink replaces stderr outright, so the log's copy of the terms lands
  // nowhere near the terminal the question is asked on. Both destinations receive
  // them: the file for the operator's record, the terminal for the decision.
  const fixture = offlineAcceptFixture();
  const logFile = path.join(fixture.dir, "accept.log");
  promptConfirmMock.mockResolvedValue(false);
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const expected = await expectedConsentSurface(encoded);
    const { stderrWrites, stdoutWrites } = await runOfflineAcceptCapturingStdio(
      {
        encoded,
        fixture,
        flags: { "log-file": logFile },
      },
    );
    expect(promptConfirmMock).toHaveBeenCalledTimes(1);
    // The terminal the question is asked on received the whole surface, in order,
    // and plain: the prefix belongs to the log's record of it, not to text sitting
    // beside a prompt.
    expect(surfaceOnStderr(stderrWrites)).toEqual(expected);
    expect(stderrWrites.join("")).not.toContain("[INFO]");
    // stdout stays reserved for result data, the reason the prompt is on stderr.
    expect(stdoutWrites.join("")).toBe("");
    // The operator's chosen routing is untouched: the file still holds every line.
    const logged = fs.readFileSync(logFile, "utf8");
    for (const line of expected)
      expect(logged).toContain(`[INFO] [accept] ${line}\n`);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test.each(["warn", "error", "silent"])(
  "handler: --log-level %s still shows the terms where the prompt asks",
  async (level) => {
    // Each level that drops info drops the surface from the log; the prompt asks
    // either way, so the surface reaches the prompt's own sink either way.
    const fixture = offlineAcceptFixture();
    promptConfirmMock.mockResolvedValue(false);
    try {
      const encoded = await encodeInvitation(sampleToken(FUTURE()));
      const expected = await expectedConsentSurface(encoded);
      const { stderrWrites, stdoutWrites } =
        await runOfflineAcceptCapturingStdio({
          encoded,
          fixture,
          flags: { "log-level": level },
        });
      expect(promptConfirmMock).toHaveBeenCalledTimes(1);
      expect(surfaceOnStderr(stderrWrites)).toEqual(expected);
      // The level still governs the log itself: no info line was emitted.
      expect(stderrWrites.join("")).not.toContain("[INFO]");
      expect(stdoutWrites.join("")).toBe("");
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  },
);

test("handler: the default prompting path prints each line of the terms exactly once", async () => {
  // The default sink and level already put the log's own output where the prompt
  // asks, so mirroring there unconditionally would print the whole multi-screen
  // outline twice. Every line appears exactly as many times as the renderer
  // emitted it -- twice for the decision facts it deliberately repeats, once for
  // everything else.
  const fixture = offlineAcceptFixture();
  promptConfirmMock.mockResolvedValue(false);
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const expected = await expectedConsentSurface(encoded);
    const { stderrWrites, stdoutWrites } = await runOfflineAcceptCapturingStdio(
      {
        encoded,
        fixture,
      },
    );
    expect(stdoutWrites.join("")).toBe("");
    const lines = stderrLines(stderrWrites);
    for (const line of new Set(expected))
      expect(lines.filter((seen) => seen === line)).toHaveLength(
        expected.filter((rendered) => rendered === line).length,
      );
    expect(surfaceOnStderr(stderrWrites)).toEqual(expected);
    // The one copy is the log's: the default path's rendering is unchanged.
    expect(stderrWrites.join("")).toContain(
      `[INFO] [accept] ${SURFACE_HEADING}`,
    );
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("handler: --consent-to-terms leaves the terms in the --log-file, not on the terminal", async () => {
  // Nothing asks on the unattended path, so nothing is mirrored: the surface is
  // ordinary diagnostic output following the routing the operator chose.
  const fixture = offlineAcceptFixture();
  const logFile = path.join(fixture.dir, "accept.log");
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    // Rendered for the unattended path, which is the one the handler takes here:
    // no prompt follows, so the repeated decision block sits under a heading that
    // repeats rather than asks.
    const expected = await expectedConsentSurface(encoded, false);
    const { stderrWrites, stdoutWrites } = await runOfflineAcceptCapturingStdio(
      {
        encoded,
        fixture,
        flags: { "consent-to-terms": true, "log-file": logFile },
      },
    );
    expect(promptConfirmMock).not.toHaveBeenCalled();
    expect(surfaceOnStderr(stderrWrites)).toEqual([]);
    expect(stdoutWrites.join("")).toBe("");
    const logged = fs.readFileSync(logFile, "utf8");
    for (const line of expected)
      expect(logged).toContain(`[INFO] [accept] ${line}\n`);
    // The framing the prompting path uses never reaches an unattended run, where
    // there is nothing to accept and nothing to answer.
    expect(logged).not.toContain(REPEAT_HEADING);
    expect(logged).toContain(`[INFO] [accept] ${REPEAT_HEADING_UNATTENDED}\n`);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("handler: --consent-to-terms keeps --log-level silent silencing the terms", async () => {
  // The other half of the unattended path: a level that drops the surface still
  // drops it, on the terminal as well as in the log.
  const fixture = offlineAcceptFixture();
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const { stderrWrites, stdoutWrites } = await runOfflineAcceptCapturingStdio(
      {
        encoded,
        fixture,
        flags: { "consent-to-terms": true, "log-level": "silent" },
      },
    );
    expect(promptConfirmMock).not.toHaveBeenCalled();
    expect(stderrWrites.join("")).toBe("");
    expect(stdoutWrites.join("")).toBe("");
    expect(fs.existsSync(fixture.configFile)).toBe(true);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("handler: hostile terms stay printable ASCII on the prompt's own sink", async () => {
  // The mirror is a second route from partner-controlled text to the operator's
  // terminal, so the escaping claim the renderer's tests make through the log sink
  // is measured on this route too. --log-level silent leaves the mirrored copy as
  // the only thing on stderr, so every line asserted here came through it.
  const fixture = offlineAcceptFixture();
  promptConfirmMock.mockResolvedValue(false);
  try {
    const encoded = await encodeInvitation({
      ...sampleToken(FUTURE()),
      linkageTerms: {
        ...getDefaultLinkageTerms(`Inviter${ESC}[31mOrg${RLO}`),
        linkageKeys: [{ name: `ssn${BEL}`, elements: [{ field: "ssn" }] }],
      },
    });
    const { stderrWrites, stdoutWrites } = await runOfflineAcceptCapturingStdio(
      {
        encoded,
        fixture,
        flags: { "log-level": "silent" },
      },
    );
    expect(stdoutWrites.join("")).toBe("");
    const lines = stderrLines(stderrWrites);
    // Non-vacuous: the terms reached the terminal, and each hostile code point
    // arrived in its escaped form rather than never arriving at all.
    expect(lines.length).toBeGreaterThan(20);
    for (const hostile of [ESC, RLO, BEL])
      expect(
        lines.filter((line) => line.includes(sanitizeForDisplay(hostile)))
          .length,
      ).toBeGreaterThan(0);
    expect(lines.filter((line) => !PRINTABLE_ASCII.test(line))).toEqual([]);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// --- handler: online accept threads the token lock-in to the persistence layer

test("handler: online accept forwards the token's disclosed set to runOnlineBootstrap", async () => {
  // The one wiring this task adds on the accept side: the online handler must pass
  // token.disclosedPayloadColumns to runOnlineBootstrap as
  // expectedReceivedPayloadColumns, so the fresh config persists the consented
  // received-column lock-in (runOnlineBootstrap's own tests cover the write). It is
  // mocked here so no connection is opened; --consent-to-terms skips the prompt.
  const { dir, input, configFile, keyFile } = offlineAcceptFixture();
  const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
  runOnlineBootstrapMock.mockResolvedValue({ configWriteError: undefined });
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    const encoded = await encodeInvitation({
      ...sampleToken(FUTURE()),
      disclosedPayloadColumns: ["diagnosis", "notes"],
    });
    await acceptHandler({
      _: [],
      $0: "psilink",
      args: ["sftp://host/drop", encoded, input],
      "consent-to-terms": true,
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "silent",
      record: false,
    } as unknown as Arguments);
    expect(exit).not.toHaveBeenCalled();
    expect(runOnlineBootstrapMock).toHaveBeenCalledTimes(1);
    const passed = runOnlineBootstrapMock.mock.calls[0][0];
    expect(passed.expectedReceivedPayloadColumns).toEqual([
      "diagnosis",
      "notes",
    ]);
    // A fresh (non-reuse) config, so the lock-in is actually written.
    expect(passed.reuseExistingConfig).toBe(false);
  } finally {
    exit.mockRestore();
    // Module-level mock: reset so no later test inherits this call/impl.
    runOnlineBootstrapMock.mockReset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- handler: offline accept-reuse refreshes the received-payload lock-in -----

/**
 * Run the offline accept handler over a pre-existing config, with
 * --consent-to-terms so the confirmation prompt is skipped (its own tests cover
 * the prompt gate). The token carries `disclosed`, the disclosed subset the
 * operator consents to on this acceptance. Returns the config file's raw text and
 * the exit spy so the caller can assert the on-disk refresh.
 */
async function runOfflineAcceptReuse(params: {
  configFile: string;
  input: string;
  disclosed: string[] | undefined;
}): Promise<string> {
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    const encoded = await encodeInvitation({
      ...sampleToken(FUTURE()),
      disclosedPayloadColumns: params.disclosed,
    });
    await acceptHandler({
      _: [],
      $0: "psilink",
      args: [encoded, params.input],
      "consent-to-terms": true,
      "config-file": params.configFile,
      "key-file": path.join(path.dirname(params.configFile), ".psilink.key"),
      "log-level": "silent",
      record: false,
    } as unknown as Arguments);
    expect(exit).not.toHaveBeenCalled();
    return fs.readFileSync(params.configFile, "utf8");
  } finally {
    exit.mockRestore();
  }
}

test("handler: offline accept-reuse refreshes a stale lock-in, preserving operator content", async () => {
  // A reused config carrying an OLD consented set is re-accepted over an invitation
  // whose disclosed subset changed. The surgical refresh overwrites the stale
  // value, preserving the operator's connection block, linkage terms, and a
  // hand-authored comment.
  const { dir, input, configFile } = offlineAcceptFixture();
  try {
    // A config whose linkage terms agree with the invitation's defaults (so it
    // reconciles for reuse), then a hand-authored comment and a stale lock-in
    // appended so the surgical write has operator content to preserve.
    writeExistingConfig(configFile);
    fs.appendFileSync(
      configFile,
      "# operator-authored note\nexpected_payload_columns:\n  - old_col\n",
    );
    const raw = await runOfflineAcceptReuse({
      configFile,
      input,
      disclosed: ["diagnosis", "notes"],
    });
    // The operator's comment and connection block survive the surgical write.
    expect(raw).toContain("# operator-authored note");
    expect(raw).toContain("/mnt/share");
    expect(raw).not.toContain("old_col");
    const parsed = parseExchangeSpec(YAML.parse(raw));
    expect(parsed.expectedPayloadColumns).toEqual(["diagnosis", "notes"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: offline accept-reuse fixes the false-abort a stale lock-in would have caused", async () => {
  // The end-to-end failure this task closes. Before the refresh the config holds
  // the partner's OLD disclosed set; the partner now discloses a new set, so a
  // recurring exchange's reconcileReceivedPayload would abort the honest exchange.
  // After the re-accept the config holds the NEW set, so the same reconcile passes;
  // asserting the stale set would have thrown proves the config actually changed
  // the outcome.
  const { dir, input, configFile } = offlineAcceptFixture();
  try {
    writeExistingConfig(configFile);
    // Seed the stale lock-in the operator originally consented to.
    fs.appendFileSync(configFile, "expected_payload_columns:\n  - old_col\n");
    const staleSpec = parseExchangeSpec(
      YAML.parse(fs.readFileSync(configFile, "utf8")),
    );
    expect(staleSpec.expectedPayloadColumns).toEqual(["old_col"]);

    const raw = await runOfflineAcceptReuse({
      configFile,
      input,
      disclosed: ["diagnosis", "notes"],
    });
    const refreshedSpec = parseExchangeSpec(YAML.parse(raw));
    // What the partner actually transmits now: its new disclosed set.
    const partnerPayload = {
      columns: ["diagnosis", "notes"],
      rowIndices: [],
      rows: [],
    };
    // The refreshed lock-in matches the partner's transmission -> no abort.
    expect(() =>
      reconcileReceivedPayload(
        partnerPayload,
        refreshedSpec.expectedPayloadColumns,
      ),
    ).not.toThrow();
    // The stale lock-in would have aborted the same honest exchange.
    expect(() =>
      reconcileReceivedPayload(
        partnerPayload,
        staleSpec.expectedPayloadColumns,
      ),
    ).toThrow(/payload disclosure mismatch/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: offline accept-reuse removes the lock-in when the invitation carries no disclosed subset", async () => {
  // A re-accept whose invitation carried no disclosed subset (an older or
  // metadata-unknown mint) records no consented set: the prior lock-in is cleared
  // so the recurring exchange reconciles lazily, not left stale.
  const { dir, input, configFile } = offlineAcceptFixture();
  try {
    writeExistingConfig(configFile);
    fs.appendFileSync(configFile, "expected_payload_columns:\n  - old_col\n");
    const raw = await runOfflineAcceptReuse({
      configFile,
      input,
      disclosed: undefined,
    });
    expect(raw).not.toContain("expected_payload_columns");
    expect(raw).not.toContain("old_col");
    const parsed = parseExchangeSpec(YAML.parse(raw));
    expect(parsed.expectedPayloadColumns).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: offline accept-reuse writes an empty consented set verbatim (strict receive-nothing)", async () => {
  // An empty disclosed subset is a real consent ("receive nothing"), distinct from
  // absent: it must be written as an empty list so a later non-empty payload aborts.
  const { dir, input, configFile } = offlineAcceptFixture();
  try {
    writeExistingConfig(configFile);
    fs.appendFileSync(configFile, "expected_payload_columns:\n  - old_col\n");
    const raw = await runOfflineAcceptReuse({
      configFile,
      input,
      disclosed: [],
    });
    expect(raw).not.toContain("old_col");
    const parsed = parseExchangeSpec(YAML.parse(raw));
    expect(parsed.expectedPayloadColumns).toEqual([]);
    // Strict "receive nothing": any transmitted column aborts.
    expect(() =>
      reconcileReceivedPayload(
        { columns: ["diagnosis"], rowIndices: [], rows: [] },
        parsed.expectedPayloadColumns,
      ),
    ).toThrow(/payload disclosure mismatch/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
