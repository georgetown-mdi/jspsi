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
  DEDUPLICATE_ACCEPTOR_SIDE_NOTE,
  DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT,
  DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT,
  encodeInvitation,
  getDefaultLinkageTerms,
  getLogger,
  parseExchangeSpec,
  reconcileReceivedPayload,
  sanitizeForDisplay,
  summarizeInvitation,
  UNRECOGNIZED_TRANSFORM_NOTE,
  UsageError,
} from "@psilink/core";
import {
  BEL,
  CONSENT_PROBE_TERMS,
  COUNT_ONLY_PROBE_TERMS,
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
  LinkageStrategy,
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
  handler as acceptHandler,
  resolveAcceptPositionals,
  validateAccept,
} from "../../src/commands/accept";
import { decodeAndValidateInvitation } from "../../src/invitationDecode";
import {
  displayInvitation,
  logDecisionFacts,
} from "../../src/invitationDisplay";
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

// A token whose one linkage key splits its element's value into several match
// candidates: the shape that raises a fan-out consent fact, in whichever of the
// two registers the strategy puts it.
function splittingKeyToken(
  expires: string,
  linkageStrategy: LinkageStrategy,
): InvitationToken {
  const token = sampleToken(expires);
  return {
    ...token,
    linkageTerms: {
      ...token.linkageTerms,
      linkageStrategy,
      linkageKeys: [
        {
          name: "last name",
          elements: [
            {
              field: token.linkageTerms.linkageFields[0].name,
              transform: [{ function: "split_on", params: { delimiter: " " } }],
            },
          ],
        },
      ],
    },
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

test("validateAccept: a deduplicating invitation leaves this party one-to-one", async () => {
  // The hostile-flip guard at the CLI accept entry point. validateAccept derives
  // the acceptor's own terms (deriveAcceptedLinkageTerms) ahead of reading the
  // input, opening any connection, or prompting, and that derivation sets this
  // party's own deduplicate rather than adopting the invitation's -- so what the
  // inviter declares, or goes on to present at the terms exchange, cannot make
  // this party the "many" side. What it does agree to is the invitation's own
  // side, which the consent surface states.
  const base = sampleToken(new Date(Date.now() + 3_600_000).toISOString());
  const encoded = await encodeInvitation({
    ...base,
    linkageTerms: { ...base.linkageTerms, deduplicate: true },
  });
  const ready = await validateAccept({
    resolved: { mode: "offline", invitation: encoded },
    options: testOptions(),
    log: silentLog,
  });
  expect(ready.dataSpec.linkageTerms?.deduplicate).toBe(false);
  expect(ready.token.linkageTerms.deduplicate).toBe(true);
});

test("validateAccept: online retains the invitation's declared deduplicate for the run", async () => {
  // The other half of that guard. This party's own side is derived, so the
  // invitation's declaration for the INVITING party's side is what the consent
  // surface stated and what the exchange must hold its partner to -- and it
  // survives nowhere in the derived terms. The acceptance records it on the
  // prepared exchange, where runExchange refuses a partner presenting anything
  // else before a key or payload moves.
  for (const declared of [false, true]) {
    const base = sampleToken(FUTURE());
    const { error, ready } = await acceptWarnings({
      token: {
        ...base,
        linkageTerms: { ...base.linkageTerms, deduplicate: declared },
      },
      columns: LINKAGE_COLUMNS,
      loggerName: `accept-declared-deduplicate-${declared}`,
      mode: "online",
    });
    expect(error).toBeUndefined();
    const prepared = (
      ready as { prepared: { expectedPartnerDeduplicate?: boolean } }
    ).prepared;
    expect(prepared.expectedPartnerDeduplicate).toBe(declared);
  }
});

test("validateAccept: a deduplicating single-pass invitation is refused before the prompt", async () => {
  // The pair the exchange refuses, caught where the operator is still deciding:
  // validateAccept derives the acceptor's terms ahead of the input, the
  // connection, and the consent display, so an invitation the run cannot honor
  // never reaches a screen that would state what its grouping discloses.
  const base = sampleToken(new Date(Date.now() + 3_600_000).toISOString());
  const encoded = await encodeInvitation({
    ...base,
    linkageTerms: {
      ...base.linkageTerms,
      deduplicate: true,
      linkageStrategy: "single-pass",
    },
  });
  await expect(
    validateAccept({
      resolved: { mode: "offline", invitation: encoded },
      options: testOptions(),
      log: silentLog,
    }),
  ).rejects.toThrow(/deduplicated matching is not yet implemented/);
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
  // The partially satisfiable input resolves a spec exactly as a fully satisfiable
  // one does -- metadata and standardization inferred and written alongside the
  // terms, the unsatisfied fields simply carrying no transformation -- which is
  // what docs/CLI.md states and what the consent display reads its outbound set
  // off.
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
    expect(ready.dataSpec.metadata).toBeDefined();
    expect(ready.dataSpec.standardization).toBeDefined();
    // The satisfiable fields are bound; the unsatisfied ssn fields are absent
    // rather than the whole standardization being withheld.
    const outputs = (ready.dataSpec.standardization ?? []).map((t) => t.output);
    expect(outputs).toContain("date_of_birth");
    expect(outputs).not.toContain("ssn");
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(input, { force: true });
  }
});

// --- the disclosure the invitation will not accept ---------------------------

// The columns satisfying the sample invitation's linkage keys, none of which is
// disclosed to the partner (inferMetadata gives a recognized linkage alias
// is_payload: false), so a CSV of these alone sends nothing.
const LINKAGE_COLUMNS = ["first_name", "last_name", "dob", "ssn"];

// The distinctive clause of the warning under test, kept apart from the remedies
// and the column list the assertions check separately.
const REFUSED_DISCLOSURE_CLAUSE = "will accept no payload columns";

/**
 * An invitation whose inviter declares `receive` -- what it will accept FROM the
 * acceptor. deriveAcceptedLinkageTerms mirrors it onto the acceptor's own
 * `payload.send`, which is what the acceptance writes and what
 * assertPayloadSendDisclosed holds the acceptor's metadata to. `output` overrides
 * the inviter's output direction; the acceptor's `shareWithPartner` is the mirror
 * of the inviter's `expectsOutput`, so it is what decides whether this party's
 * disclosure actually crosses.
 */
function tokenDeclaringReceive(
  receive: Array<{ name: string }> | undefined,
  output?: LinkageTerms["output"],
): InvitationToken {
  const base = sampleToken(FUTURE());
  return {
    ...base,
    linkageTerms: {
      ...base.linkageTerms,
      ...(output !== undefined ? { output } : {}),
      payload: { receive },
    },
  };
}

/** Every message an acceptance of `token` over `columns` warns with, plus
 * whatever it threw (online acceptance meets the refusal itself). */
async function acceptWarnings(params: {
  token: InvitationToken;
  columns: string[];
  loggerName: string;
  mode?: "online" | "offline";
  options?: CommonBootstrapOptions;
}): Promise<{ warnings: string[]; error: unknown; ready: unknown }> {
  const { token, columns, loggerName, mode = "offline" } = params;
  const options = params.options ?? testOptions();
  const input = writeInputCSV(columns);
  const log = getLogger(loggerName);
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  let error: unknown;
  let ready: unknown;
  try {
    const encoded = await encodeInvitation(token);
    ready = await validateAccept({
      resolved:
        mode === "online"
          ? {
              mode: "online",
              url: new URL("sftp://host/drop"),
              invitation: encoded,
              input,
            }
          : { mode: "offline", invitation: encoded, input },
      options,
      log,
    });
  } catch (err) {
    error = err;
  }
  const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
  warnSpy.mockRestore();
  fs.rmSync(input, { force: true });
  return { warnings, error, ready };
}

/** The one refused-disclosure warning in `warnings`, asserted to be exactly one. */
function refusedDisclosureWarning(warnings: string[]): string {
  const refused = warnings.filter((m) => m.includes(REFUSED_DISCLOSURE_CLAUSE));
  expect(refused).toHaveLength(1);
  return refused[0];
}

// --- the count-only shape, at the accept boundary ----------------------------

/** An invitation in exactly the count-only shape the specification admits: the
 * default terms narrowed to one linkage key, which is the only one of the five
 * rules the defaults break. */
function countOnlyToken(): InvitationToken {
  const base = sampleToken(FUTURE());
  return {
    ...base,
    linkageTerms: {
      ...base.linkageTerms,
      algorithm: "psi-c",
      linkageKeys: base.linkageTerms.linkageKeys.slice(0, 1),
    },
  };
}

test("validateAccept: refuses a count-only invitation whose own columns would send one", async () => {
  // The count-only rule this party's own metadata carries: `diagnosis` is an
  // unrecognized column, which inferMetadata marks for transmission, and a
  // count-only exchange moves no data column in either direction. Refused at the
  // accept boundary, naming what to clear -- not left to the algorithm gate,
  // which says only that no count-only run path exists yet.
  const { error, ready } = await acceptWarnings({
    token: countOnlyToken(),
    columns: [...LINKAGE_COLUMNS, "diagnosis"],
    loggerName: "accept-count-only-transmits",
  });
  expect(ready).toBeUndefined();
  expect(error).toBeInstanceOf(UsageError);
  expect((error as Error).message).toMatch(/transmits no data columns/);
  // Named by the rule rather than by the column, matching every other refusal
  // composed beside a partner's document.
  expect((error as Error).message).not.toContain("diagnosis");
});

test("validateAccept: online refuses the same arrangement, writing nothing", async () => {
  const options = testOptions();
  const { error } = await acceptWarnings({
    token: countOnlyToken(),
    columns: [...LINKAGE_COLUMNS, "diagnosis"],
    loggerName: "accept-count-only-transmits-online",
    mode: "online",
    options,
  });
  expect(error).toBeInstanceOf(UsageError);
  expect((error as Error).message).toMatch(/transmits no data columns/);
  expect(fs.existsSync(options.configFile)).toBe(false);
  expect(fs.existsSync(options.keyFile)).toBe(false);
});

test("validateAccept: a count-only invitation over a file that sends nothing is not refused here", async () => {
  // The rule reads what this party's marks would transmit, not the algorithm
  // alone: a file of recognized linkage columns discloses nothing, so acceptance
  // completes and the count-only algorithm meets only the run-side gate.
  const { error, ready } = await acceptWarnings({
    token: countOnlyToken(),
    columns: LINKAGE_COLUMNS,
    loggerName: "accept-count-only-sends-nothing",
  });
  expect(error).toBeUndefined();
  expect((ready as { mode: string }).mode).toBe("offline");
});

test("validateAccept: a crafted count-only invitation outside the shape is refused at the decode", async () => {
  // The four terms-carried rules, on the partner's document: minting one is
  // refused by the same schema, so it reaches this party only as a crafted token
  // -- and the decode is where the acceptance meets it, before the prompt.
  const base = countOnlyToken();
  const crafted = await encodeRaw({
    ...base,
    linkageTerms: {
      ...base.linkageTerms,
      linkageStrategy: "single-pass",
    },
  });
  const err = await decodeAndValidateInvitation(crafted).catch(
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toMatch(/linkage strategy to "cascade"/);
});

test("validateAccept: warns when the input discloses columns the invitation accepts none of", async () => {
  // An explicit empty receive is the inviter declaring it takes no payload column,
  // while inferMetadata defaults every unrecognized column to is_payload: true --
  // so the configuration this acceptance writes cannot run (prepareForExchange
  // refuses it before any data is sent). One warning, however many columns, naming them
  // and both remedies, while the operator can still decline.
  const hostile = `notes${ESC}[0m`;
  const { warnings, ready } = await acceptWarnings({
    token: tokenDeclaringReceive([]),
    columns: [...LINKAGE_COLUMNS, "diagnosis", hostile],
    loggerName: "accept-refused-disclosure-warn",
  });
  expect((ready as { mode: string }).mode).toBe("offline");
  const refused = refusedDisclosureWarning(warnings);
  expect(refused).toContain("is_payload: false");
  expect(refused).toContain("ask your partner for an invitation");
  // One entry per line, the rendering both consent surfaces use, so a name
  // carrying the list separator cannot be read as two entries.
  expect(refused).toContain("\n  - diagnosis");
  expect(refused).toContain(`\n  - ${sanitizeForDisplay(hostile)}`);
  // The names are the operator's own file's and reach the log sink without ever
  // becoming an Error, so the sink is where they are escaped.
  expect(refused).not.toContain(ESC);
  // Offline acceptance completes, so it says where the refusal actually arrives.
  expect(refused).toContain("psilink exchange");
});

test("validateAccept: online states that the acceptance itself stops, and it does", async () => {
  // prepareForOnlineExchange runs inside validateAccept, so the refusal the
  // warning names aborts the acceptance itself rather than waiting for a later
  // command -- a configuration error, before the terms display and before any
  // file is written.
  const options = testOptions();
  const { warnings, error } = await acceptWarnings({
    token: tokenDeclaringReceive([]),
    columns: [...LINKAGE_COLUMNS, "diagnosis"],
    loggerName: "accept-refused-disclosure-online",
    mode: "online",
    options,
  });
  const refused = refusedDisclosureWarning(warnings);
  expect(refused).toContain("exit 64");
  expect(refused).not.toContain("psilink exchange");
  expect(error).toBeInstanceOf(UsageError);
  // The refusal the warning describes, not some other usage error on the path.
  expect((error as Error).message).toContain("payload.send");
  expect(fs.existsSync(options.configFile)).toBe(false);
  expect(fs.existsSync(options.keyFile)).toBe(false);
});

test("validateAccept: stays silent where the disclosure and the invitation can agree", async () => {
  // An ABSENT receive is not a mismatch: the inviter left the direction lazy and
  // reconciles against this party's own disclosure when the exchange runs.
  expect(
    (
      await acceptWarnings({
        token: tokenDeclaringReceive(undefined),
        columns: [...LINKAGE_COLUMNS, "diagnosis"],
        loggerName: "accept-refused-disclosure-absent",
      })
    ).warnings,
  ).not.toContainEqual(expect.stringContaining(REFUSED_DISCLOSURE_CLAUSE));

  // An empty receive against a file that discloses nothing is already agreed: the
  // acceptance writes a configuration that sends nothing and runs.
  expect(
    (
      await acceptWarnings({
        token: tokenDeclaringReceive([]),
        columns: LINKAGE_COLUMNS,
        loggerName: "accept-refused-disclosure-nothing-sent",
      })
    ).warnings,
  ).not.toContainEqual(expect.stringContaining(REFUSED_DISCLOSURE_CLAUSE));

  // A non-empty receive that disagrees with the disclosed set is a different
  // comparison with different remedies, and is not what this warning covers.
  expect(
    (
      await acceptWarnings({
        token: tokenDeclaringReceive([{ name: "dose" }]),
        columns: [...LINKAGE_COLUMNS, "diagnosis"],
        loggerName: "accept-refused-disclosure-nonempty",
      })
    ).warnings,
  ).not.toContainEqual(expect.stringContaining(REFUSED_DISCLOSURE_CLAUSE));
});

test("validateAccept: stays silent, and the display stays consistent, when the inviting party receives no result", async () => {
  // The refusal is gated on the direction, so this pair is not refused: the
  // inviting party is entitled to no result, the payload step transmits nothing
  // to it whatever the metadata discloses, and the exchange runs. Warning here
  // would put "the exchange refuses to run" directly above a consent line reading
  // that no payload is sent.
  const token = tokenDeclaringReceive([], {
    expectsOutput: false,
    shareWithPartner: true,
  });
  const { warnings, error } = await acceptWarnings({
    token,
    columns: [...LINKAGE_COLUMNS, "diagnosis"],
    loggerName: "accept-refused-disclosure-no-inviter-output",
  });
  expect(error).toBeUndefined();
  expect(warnings).not.toContainEqual(
    expect.stringContaining(REFUSED_DISCLOSURE_CLAUSE),
  );
  // The line the warning would have contradicted, on the same invitation.
  const log = getLogger("accept-refused-disclosure-no-inviter-output-display");
  log.setLevel("silent");
  expect(renderDisplayInvitation(log, token, ["diagnosis"])).toContain(
    "no payload is sent",
  );
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

// --- the WebRTC peer-addressing role -----------------------------------------

test("validateAccept: offline stamps role: acceptor onto a seeded webrtc connection", async () => {
  // The accepting side derives its WebRTC rendezvous peer id from the `acceptor`
  // label, and the persisted connection block is the only place a later
  // `psilink exchange` can learn which side it is on -- the operator never
  // authors it.
  const input = writeInputCSV(["first_name", "last_name", "dob", "ssn"]);
  const endpoint: ConnectionEndpoint = {
    channel: "webrtc",
    host: "peer.example.org",
    path: "/psi",
  };
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE(), endpoint));
    const ready = await validateAccept({
      resolved: { mode: "offline", invitation: encoded, input },
      options: testOptions(),
      log: silentLog,
    });
    expect(ready.mode).toBe("offline");
    if (ready.mode !== "offline") return;
    if (ready.connection.channel !== "webrtc")
      throw new Error("expected webrtc");
    expect(ready.connection.role).toBe("acceptor");
    // The stamp rides along with the seeded locator rather than replacing it.
    expect(ready.connection.server.host).toBe("peer.example.org");
    expect(ready.connection.server.path).toBe("/psi");
  } finally {
    fs.rmSync(input, { force: true });
  }
});

test("validateAccept: offline leaves a non-webrtc connection without a role", async () => {
  // `role` is a WebRTC-only field, so an sftp acceptance (here the placeholder
  // block an endpoint-less invitation seeds) carries no such key at all.
  const input = writeInputCSV(["first_name", "last_name", "dob", "ssn"]);
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const ready = await validateAccept({
      resolved: { mode: "offline", invitation: encoded, input },
      options: testOptions(),
      log: silentLog,
    });
    expect(ready.mode).toBe("offline");
    if (ready.mode !== "offline") return;
    expect(ready.connection.channel).toBe("sftp");
    expect(Object.keys(ready.connection)).not.toContain("role");
  } finally {
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
  // The empty set is a bare "(none)", with nothing after it: the line renders only
  // for a declared direction (the absent case below prints no line at all), so the
  // reader of a "(none)" is already looking at an explicit declaration, and the
  // enforcement register is what the label's marker carries. What the declaration
  // commits its party to is stated at length in docs/CLI.md, not on the prompt.
  expect(lines({ ...base, disclosedPayloadColumns: [] }).split("\n")).toContain(
    "  columns you will receive (enforced): (none)",
  );
  expect(lines({ ...base, disclosedPayloadColumns: undefined })).not.toContain(
    "columns you will receive",
  );
});

test("displayInvitation: the received-columns marker follows what the invitation carried, not what it declared", () => {
  // The same line has two sources and they do not rest on the same thing. The
  // carried subset is the set an acceptance locks in and reconciles the received
  // payload against; an authored payload.send with no carried subset locks in
  // nothing, so an inviter that declares one set and transmits another is not
  // stopped on the online run. Marking that case "enforced" would announce a check
  // that does not run, so the marker is keyed on what was carried.
  const log = getLogger("accept-display-receive-basis-test");
  log.setLevel("silent");
  const base = sampleToken(FUTURE());
  // One terms document for both renderings, authoring the columns the carried
  // subset also names, so the only difference between the two is whether the token
  // carries the subset.
  const linkageTerms: LinkageTerms = {
    ...base.linkageTerms,
    payload: { send: [{ name: "diagnosis" }, { name: "notes" }] },
  };
  const authored = renderDisplayInvitation(log, { ...base, linkageTerms });
  const carried = renderDisplayInvitation(log, {
    ...base,
    linkageTerms,
    disclosedPayloadColumns: ["diagnosis", "notes"],
  });
  expect(authored).toContain("columns you will receive (your partner's word):");
  expect(authored).toContain("\n    - diagnosis");
  expect(authored).toContain("\n    - notes");
  expect(authored).not.toContain("columns you will receive (enforced)");
  expect(carried).toContain("columns you will receive (enforced):");
  expect(carried).not.toContain(
    "columns you will receive (your partner's word)",
  );
  // The marker is the whole of the difference: the same columns are listed either
  // way, so nothing else about the surface moves with the basis.
  expect(
    authored.replace(
      "columns you will receive (your partner's word)",
      "columns you will receive (enforced)",
    ),
  ).toBe(carried);
  // An authored EMPTY send is not a declaration at all -- it carries no subset and
  // prints no line -- so a rendered "(none)" is always the carried, enforced case.
  expect(
    renderDisplayInvitation(log, {
      ...base,
      linkageTerms: { ...base.linkageTerms, payload: { send: [] } },
    }),
  ).not.toContain("columns you will receive");
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
  // The mirror of the line above, and bare for the same reason: only a declared
  // direction prints, so "(none)" is the inviter asking for no column rather than
  // the lazy case, which prints nothing.
  expect(lines(withReceive([])).split("\n")).toContain(
    "  columns the inviting party requests from you (your partner's word): (none)",
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
  // known rather than claiming any count -- and names what actually settles it,
  // including the confirmation the run stops for and the refusal an unattended run
  // gets instead. The forward reference is only honest while that checkpoint
  // exists, so it is pinned here beside the acceptance that records it as pending.
  const unknown = renderDisplayInvitation(log, base, undefined);
  expect(unknown).toContain(`${OUTBOUND_SEND_LABEL}: not yet known`);
  expect(unknown).toContain(
    "    Determined from your input file when the exchange runs, which shows " +
      "the columns and asks you to confirm them before anything is sent; a run " +
      "with no terminal to ask on refuses instead of sending them.",
  );
  expect(unknown).not.toContain("(none)");
  expect(outboundSendEntries(unknown.split("\n"))).toEqual([]);
});

test("displayInvitation: an inviting party that receives no result is sent nothing, whatever the acceptor's own set is", () => {
  // The payload step transmits nothing at all to a partner not entitled to the
  // result, so a listed column set would name a disclosure that does not happen --
  // under the marker that says the run holds it. The direction answers the line for
  // every value of the acceptor's own set: a resolved set is not listed, the
  // not-yet-known forward reference does not run (the input file it names cannot
  // change this answer), and the empty case's "only matched records" tail gives way
  // to the reason that holds however the operator's file changes.
  const log = getLogger("accept-display-outbound-one-sided-test");
  log.setLevel("silent");
  const base = sampleToken(FUTURE());
  const oneSided: InvitationToken = {
    ...base,
    linkageTerms: {
      ...base.linkageTerms,
      output: { expectsOutput: false, shareWithPartner: true },
    },
  };
  for (const own of [["diagnosis", "medication"], [], undefined]) {
    const rendered = renderDisplayInvitation(log, oneSided, own);
    expect(rendered.split("\n")).toContain(
      `  ${OUTBOUND_SEND_LABEL}: (none) -- the inviting party receives no ` +
        "result, so no payload is sent",
    );
    expect(outboundSendEntries(rendered.split("\n"))).toEqual([]);
    expect(rendered).not.toContain("diagnosis");
    expect(rendered).not.toContain("only matched records");
    expect(rendered).not.toContain("not yet known");
  }
  // The direction is the whole of the gate: the same acceptor set is listed in full
  // when the inviting party does receive the result.
  const twoSided = renderDisplayInvitation(log, base, [
    "diagnosis",
    "medication",
  ]);
  expect(outboundSendEntries(twoSided.split("\n"))).toEqual([
    "diagnosis",
    "medication",
  ]);
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

test("displayInvitation: states what a splitting key does, in the register its strategy puts it in", () => {
  // A key element that splits its value is matched on each candidate, which is
  // both a widening and a disclosure -- and under a strategy that matches one
  // value per record it is a refusal instead. The sentence for each case comes
  // from core's shared classification, so this prompt and the web consent screen
  // state the consequence in the same words rather than two accounts of it.
  const log = getLogger("accept-display-fan-out-test");
  log.setLevel("silent");

  const matched = renderDisplayInvitation(
    log,
    splittingKeyToken(FUTURE(), "single-pass"),
  );
  expect(matched).toContain("several values per record (enforced):");
  expect(matched).toContain(CONSENT_FACTS.fanOutCandidates.note);
  expect(matched).toContain("(multiple)");

  const refused = renderDisplayInvitation(
    log,
    splittingKeyToken(FUTURE(), "cascade"),
  );
  expect(refused).toContain("several values per record (enforced):");
  expect(refused).toContain(CONSENT_FACTS.fanOutRefused.note);
  expect(refused).toContain("(not supported)");

  // Silent for terms that declare no split, so the line is not a fixture of the
  // prompt itself.
  expect(renderDisplayInvitation(log, sampleToken(FUTURE()))).not.toContain(
    "several values per record",
  );
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

  // A term whose variant turns on a disclosure carries the sentence stating it in
  // the classification, and both surfaces are held to that one string: moving the
  // output is not enough where an acceptor is entitled to read what the setting
  // costs. Asserted absent from the base too, so the pin measures the setting
  // rather than a sentence the prompt always prints.
  const pinned = probes.filter(
    (probe) =>
      probe.requiredVariantCopy !== undefined &&
      probe.unrepresented.cli === undefined,
  );
  expect(pinned.length).toBeGreaterThan(0);
  for (const probe of pinned) {
    // Per probe, not only over the set: an entry carrying an empty list would
    // otherwise satisfy the loop below by rendering nothing at all.
    const copies = probe.requiredVariantCopy ?? [];
    expect(copies.length, probe.label).toBeGreaterThan(0);
    for (const copy of copies) {
      expect(render(probe.variant), probe.label).toContain(copy);
      expect(render(probe.base), probe.label).not.toContain(copy);
    }
    // And the other half of a term measured under several document shapes: the
    // sentence another shape owes must be absent here, or one sentence rendered
    // for every shape would satisfy the pin above while stating a disclosure this
    // shape's run does not make.
    for (const copy of probe.forbiddenVariantCopy ?? [])
      expect(render(probe.variant), probe.label).not.toContain(copy);
  }
  // Non-vacuous: at least one term is measured under shapes that owe different
  // sentences, so the loop above is a check rather than an empty pass.
  expect(
    pinned.filter((probe) => (probe.forbiddenVariantCopy ?? []).length > 0)
      .length,
  ).toBeGreaterThan(0);
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

test("displayInvitation: a deduplicating term states what it discloses and whose records pay it", () => {
  // The run honors deduplicate, so the line is a plain fact -- and a deduplicating
  // match discloses grouping a one-to-one match does not, which the acceptor is
  // consenting to. The statement is shared wording, printed under the headline it
  // qualifies rather than one block away. The direction note sits with it at the
  // same level: the setting is the inviting party's own, this party's own side
  // being derived as false at accept.
  const log = getLogger("accept-display-deduplicate-test");
  log.setLevel("silent");
  const base = sampleToken(FUTURE());
  const render = (overrides: Partial<LinkageTerms>): string =>
    renderDisplayInvitation(log, {
      ...base,
      linkageTerms: { ...base.linkageTerms, ...overrides },
    });

  const oneToOne = render({});
  expect(oneToOne).toContain(
    "duplicate matches (enforced): each of the inviting party's records " +
      "matches at most one of the accepting party's records",
  );
  // A one-to-one exchange discloses no grouping at all, so neither sentence must
  // reach it: their presence below is the setting's doing rather than the
  // fixture's.
  expect(oneToOne).not.toContain(
    DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT,
  );
  expect(oneToOne).not.toContain(
    DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT,
  );
  expect(oneToOne).not.toContain(DEDUPLICATE_ACCEPTOR_SIDE_NOTE);

  const deduplicating = render({ deduplicate: true });
  expect(deduplicating).toContain(
    "duplicate matches (enforced): more than one of the inviting party's " +
      "records may match a single one of the accepting party's records",
  );
  expect(deduplicating).toContain(
    `    ${DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT}`,
  );
  // Same indent as the statement it follows, so the acceptor reads what the
  // setting discloses and whose file is grouped to disclose it in one place
  // rather than a screen apart.
  expect(deduplicating).toContain(`    ${DEDUPLICATE_ACCEPTOR_SIDE_NOTE}`);
  // The sample token shares the result with this party, so the sole-receiver
  // sentence must not reach it.
  expect(deduplicating).not.toContain(
    DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT,
  );
});

test("displayInvitation: a sole-receiver deduplicating term states psilink presents the acceptor no grouping when the inviter alone receives", () => {
  // The other output shape a deduplicating invitation can take: the inviting
  // party receives the result and shares none of it, so this party is sent no
  // table and is presented no grouping. The shared-result sentence would tell it
  // what it learns about the inviting party's groups, which this client shows it
  // not at all -- so the shape selects the other statement, and the direction
  // note stays, its widening applying to either shape.
  const log = getLogger("accept-display-deduplicate-sole-receiver-test");
  log.setLevel("silent");
  const base = sampleToken(FUTURE());
  const soleReceiver = renderDisplayInvitation(log, {
    ...base,
    linkageTerms: {
      ...base.linkageTerms,
      deduplicate: true,
      output: { expectsOutput: true, shareWithPartner: false },
    },
  });

  expect(soleReceiver).toContain(
    `    ${DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT}`,
  );
  expect(soleReceiver).toContain(`    ${DEDUPLICATE_ACCEPTOR_SIDE_NOTE}`);
  expect(soleReceiver).not.toContain(
    DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT,
  );
});

test("displayInvitation: a deduplicating term the run refuses states no disclosure at all", () => {
  // single-pass matches no deduplicating cardinality, so acceptance refuses the
  // pair before this surface is reached (assertDeduplicateImplemented). The
  // renderer holds the same line from its own side: stating what the grouping
  // discloses would describe a run that cannot happen. The headline still
  // reports the term the invitation declares.
  const log = getLogger("accept-display-deduplicate-refused-test");
  log.setLevel("silent");
  const base = sampleToken(FUTURE());
  const refused = renderDisplayInvitation(log, {
    ...base,
    linkageTerms: {
      ...base.linkageTerms,
      deduplicate: true,
      linkageStrategy: "single-pass",
    },
  });

  expect(refused).toContain(
    "duplicate matches (enforced): more than one of the inviting party's " +
      "records may match a single one of the accepting party's records",
  );
  expect(refused).not.toContain(DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT);
  expect(refused).not.toContain(DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT);
  expect(refused).not.toContain(DEDUPLICATE_ACCEPTOR_SIDE_NOTE);
});

test("displayInvitation: the retain line is printed at both decision blocks, and only where retention is disclosed", () => {
  const log = getLogger("accept-display-retain-test");
  log.setLevel("silent");
  const base = sampleToken(FUTURE());
  const RETAIN_LABEL = "  exchange files (enforced): ";

  // The declaration is a decision fact: what outlives the run is exactly what an
  // operator must have in front of them when the y/N question is asked, and the
  // terms are far longer than a screen, so it prints at BOTH decision blocks --
  // heading the terms and again above the prompt -- like every other fact there.
  const retaining = renderDisplayInvitation(log, {
    ...base,
    inviterRetainsFiles: true,
  });
  const retainLines = retaining
    .split("\n")
    .filter((line) => line.startsWith(RETAIN_LABEL));
  expect(retainLines).toHaveLength(2);
  expect(retainLines[0]).toBe(
    `${RETAIN_LABEL}kept as a permanent transcript, not deleted after the run`,
  );
  expect(retaining).toContain(`    ${CONSENT_FACTS.retainedFiles.note}`);

  // Neither absence renders anything, and the two are not alike by accident: an
  // invitation minted before the field existed made no claim, and one declaring
  // delete mode is claiming a cleanup this transport does not promise (a run
  // killed outright, or one failing after the handshake, leaves files in either
  // mode). Both would mislead as a stated fact, so both print nothing.
  for (const declaration of [{}, { inviterRetainsFiles: false }]) {
    const rendered = renderDisplayInvitation(log, { ...base, ...declaration });
    expect(rendered).not.toContain("exchange files");
    expect(rendered).not.toContain(CONSENT_FACTS.retainedFiles.note);
  }
});

test("displayInvitation: a split-directory endpoint states the retention with no declaration", () => {
  // The seeded sub-case: this accept builds its connection from the endpoint and
  // is put in retain mode by its shape (a split pair cannot be configured
  // without it), so a prompt gated on the declaration alone would take consent to
  // a permanent transcript in silence. Both the seeding and this line read
  // core's endpointRequiresRetainedFiles, so the endpoint that seeds the mode is
  // the endpoint that states it.
  const log = getLogger("accept-display-retain-endpoint-test");
  log.setLevel("silent");
  const split: ConnectionEndpoint = {
    channel: "filedrop",
    inboundPath: "/mnt/share/in",
    outboundPath: "/mnt/share/out",
  };
  const rendered = renderDisplayInvitation(log, sampleToken(FUTURE(), split));
  expect(rendered).toContain(
    "  exchange files (enforced): kept as a permanent transcript, not deleted " +
      "after the run",
  );
  expect(rendered).toContain(`    ${CONSENT_FACTS.retainedFiles.note}`);

  // And the shape test does not widen to "carries an endpoint": a single shared
  // directory seeds no options, and its acceptor sets its own mode, so an
  // invitation naming one and declaring nothing states nothing here.
  const shared: ConnectionEndpoint = {
    channel: "filedrop",
    path: "/mnt/share",
  };
  const sharedRendered = renderDisplayInvitation(
    log,
    sampleToken(FUTURE(), shared),
  );
  expect(sharedRendered).not.toContain("exchange files");
  expect(sharedRendered).not.toContain(CONSENT_FACTS.retainedFiles.note);
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
  // The count-only tier is the third rendering, because its caveats are the ones no
  // `psi` invitation raises: a table entry the renderer never reaches is exactly
  // what this test exists to catch, so the tier has to be rendered here rather than
  // exempted from the sweep.
  //
  // The retain declaration is the fourth, and for the same reason one step further
  // out: it is carried on the TOKEN rather than in the terms, so no variation of
  // `output`, `payload`, or `algorithm` above can raise its caveat.
  const retaining = renderDisplayInvitation(log, {
    ...sampleToken(FUTURE()),
    inviterRetainsFiles: true,
  });
  // The fan-out pair is the fifth and sixth, for the same reason again: both are
  // raised by a linkage key that splits its element's value, and which of the two
  // follows the strategy, so no variation above reaches either.
  const fanOutMatched = renderDisplayInvitation(
    log,
    splittingKeyToken(FUTURE(), "single-pass"),
  );
  const fanOutRefused = renderDisplayInvitation(
    log,
    splittingKeyToken(FUTURE(), "cascade"),
  );
  const rendered = [
    acceptorWithheld,
    inviterWithheld,
    renderCountOnlyFacts(),
    retaining,
    fanOutMatched,
    fanOutRefused,
  ].join("\n");

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
  expect(inviterWithheld).toContain(
    "  you will receive the result (enforced): yes",
  );
  // The partner's receipt line is marked by its VALUE, not by the line: a partner
  // that receives is one the run delivers to, and only its use of the result rests
  // on the agreement; a partner that does not receive rests on the agreement for
  // the whole fact.
  expect(acceptorWithheld).toContain(
    "  the inviting party will receive the result (enforced): yes",
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
  // The mode agreement is what the run holds, so the marker is the enforced one;
  // what becomes of the transcript afterwards rides the caveat swept above.
  expect(retaining).toContain(
    "  exchange files (enforced): kept as a permanent transcript, not deleted " +
      "after the run",
  );
});

// The two count-only sentences spelled out rather than read from the shared table,
// for the reason the refusal caveat below is spelled out: an acceptor can ACT on
// either -- the first states the guarantee, the second states what it does not
// cover -- so an edit to either has to be made here as well, on this surface,
// rather than followed. The tier's remaining wording is read from the table, where
// a surface restating it on its own is what fails.
const COUNT_ONLY_STATEMENT =
  "Only the number of records you have in common is revealed, not which " +
  "records match.";
const COUNT_ONLY_INPUT_CHOICE_BOUND =
  "Not enforced against your partner's choice of input: a count-only exchange " +
  "bounds what psilink hands your partner, not what they can learn by choosing " +
  "which records to ask about. A crafted list, or a second run differing by one " +
  "record, turns a count into an answer about one person.";

/**
 * The five tier sentences, read from the shared table by this surface and by the
 * web consent screen. The algorithm is what makes them one class: a psi-c
 * invitation reaches every one of them on BOTH surfaces and a `psi` invitation
 * reaches none, so an assertion over this list states a cross-surface invariant.
 *
 * COUNT_ONLY_STATEMENT is deliberately not in it. That sentence is shared wording
 * with a different placement on each surface -- the web renders it as its
 * matching-method headline, this prompt beneath the algorithm it names -- so its
 * placement is a fact about this prompt alone and is asserted as one.
 */
const COUNT_ONLY_TIER_NOTES = [
  CONSENT_FACTS.countOnlyResult.note,
  CONSENT_FACTS.countOnlyRoundDisclosures.note,
  CONSENT_FACTS.countOnlyReportedCount.note,
  CONSENT_FACTS.countOnlyInputChoice.note,
  CONSENT_FACTS.countOnlyNoPayload.note,
];

/**
 * The decision block for a count-only exchange, over the output direction, the
 * acceptor's own resolved outbound set, and the declared payload each case needs.
 * Rendered from the real shared summary, so what is measured is this renderer's
 * own reading of the algorithm and the words it puts behind it.
 */
function renderCountOnlyFacts(
  output: LinkageTerms["output"] = {
    expectsOutput: true,
    shareWithPartner: true,
  },
  ownOutboundSend: ReadonlyArray<string> = [],
  payload: LinkageTerms["payload"] = COUNT_ONLY_PROBE_TERMS.payload,
): string {
  const block: Array<string> = [];
  logDecisionFacts(
    (line) => {
      block.push(line);
    },
    summarizeInvitation({
      ...sampleToken(FUTURE()),
      linkageTerms: { ...COUNT_ONLY_PROBE_TERMS, output, payload },
    }),
    ownOutboundSend,
  );
  return block.join("\n");
}

test("the count-only tier reaches the prompt, on both surfaces, from one terms document", () => {
  // The exchange conducts a count-only run, so what an acceptor reads for a psi-c
  // invitation is the tier stating what it discloses -- never a caveat saying the
  // algorithm is refused, and never the psi consequence that matched identifiers
  // are revealed.
  //
  // apps/web/test/browser/invitationTermsCountOnly pins the same sentences against
  // the same terms document, so the pair cannot drift apart silently.
  const log = getLogger("accept-display-psi-c-test");
  log.setLevel("silent");
  const shaped = renderDisplayInvitation(log, {
    ...sampleToken(FUTURE()),
    linkageTerms: COUNT_ONLY_PROBE_TERMS,
  });
  expect(shaped).toContain("PSI algorithm (enforced): psi-c");
  for (const copy of COUNT_ONLY_TIER_NOTES) expect(shaped).toContain(copy);
  expect(shaped).not.toContain(
    "the shared identifiers of matched records are still revealed",
  );
  expect(shaped).not.toContain("does not yet apply it");
  // The headline is the other class: shared wording each surface places for
  // itself, which this prompt prints beneath the algorithm it names. Asserted for
  // this surface only, so the list above keeps stating the invariant both surfaces
  // hold rather than one this one alone does.
  expect(shaped).toContain(`    ${COUNT_ONLY_STATEMENT}`);
  // Non-vacuous the other way: a `psi` invitation reaches no sentence of the tier,
  // so the presence above is the algorithm's doing.
  const revealing = renderDisplayInvitation(log, {
    ...sampleToken(FUTURE()),
    linkageTerms: CONSENT_PROBE_TERMS,
  });
  for (const copy of COUNT_ONLY_TIER_NOTES)
    expect(revealing).not.toContain(copy);
  expect(revealing).not.toContain(COUNT_ONLY_STATEMENT);
});

test("a one-sided count-only invitation states no honest-helper membership disclosure", () => {
  // The membership fact is scoped by the ALGORITHM: by the role rule the
  // non-receiving party of a count-only run is the sender, which computes nothing
  // from the round and is sent no count-report frame, so it learns no membership of
  // its own records. The web consent screen pins the same pair.
  const log = getLogger("accept-display-count-only-membership-test");
  log.setLevel("silent");
  const partnerWithheld: LinkageTerms["output"] = {
    expectsOutput: false,
    shareWithPartner: true,
  };
  const countOnly = renderDisplayInvitation(log, {
    ...sampleToken(FUTURE()),
    linkageTerms: { ...COUNT_ONLY_PROBE_TERMS, output: partnerWithheld },
  });
  expect(countOnly).toContain("PSI algorithm (enforced): psi-c");
  expect(countOnly).not.toContain("what your partner learns either way");
  expect(countOnly).not.toContain(
    CONSENT_FACTS.partnerLearnsOwnMembership.note,
  );
  // Not the whole block going missing: the line the membership fact sits beneath is
  // still stated, on the register it belongs to.
  expect(countOnly).toContain(
    "  the inviting party will receive the result (your partner's word): no",
  );
  // What replaces it, from docs/spec/PROTOCOL.md's PSI-C learn-basis rows rather
  // than from a softened version of the claim: the enforced half that hands neither
  // party a pairing, and what the rounds disclose beside the count.
  expect(countOnly).toContain(`    ${CONSENT_FACTS.countOnlyResult.note}`);
  expect(countOnly).toContain(
    `    ${CONSENT_FACTS.countOnlyRoundDisclosures.note}`,
  );
  // Non-vacuous the other way: the same one-sided pair under `psi` -- the algorithm
  // the fact is true of -- carries it in full, so the absence above is the
  // algorithm's doing and not the output pair's.
  const revealing = renderDisplayInvitation(log, {
    ...sampleToken(FUTURE()),
    linkageTerms: {
      ...CONSENT_PROBE_TERMS,
      output: partnerWithheld,
      payload: { ...CONSENT_PROBE_TERMS.payload, receive: [] },
    },
  });
  expect(revealing).toContain(
    "  what your partner learns either way (enforced):",
  );
  expect(revealing).toContain(
    `    ${CONSENT_FACTS.partnerLearnsOwnMembership.note}`,
  );
});

test("a count-only exchange states its disclosure tier on the register the protocol assigns each half", () => {
  // Each line's marker is the one docs/spec/PROTOCOL.md's PSI-C section assigns
  // that row: a party's own
  // count-only outcome and its view of what the partner receives are held by the
  // run, the count a both-entitled party did not compute is the other's report,
  // and the protection a chosen input set defeats rests on the partner
  // contributing a genuine dataset. Marking any of the three the other way is the
  // error the vocabulary exists to prevent.
  const block = renderCountOnlyFacts();
  expect(block).toContain("  PSI algorithm (enforced): psi-c");
  expect(block).toContain(`    ${COUNT_ONLY_STATEMENT}`);
  expect(block).not.toContain("does not yet apply it");
  expect(block).toContain(
    "  what a count-only exchange still discloses (enforced):",
  );
  expect(block).toContain(
    "  how the count reaches each of you (your partner's word):",
  );
  expect(block).toContain(
    "  what a count-only exchange does not bound (your partner's word):",
  );
  expect(block).toContain(`    ${COUNT_ONLY_INPUT_CHOICE_BOUND}`);
  // The acceptor's own outbound line, answered by the algorithm rather than by who
  // receives the count: both parties are entitled here, so the entitlement-driven
  // sentence would have listed columns instead.
  expect(block).toContain("  columns you will send (enforced): (none)");
  expect(block).toContain(`    ${CONSENT_FACTS.countOnlyNoPayload.note}`);
  expect(block).not.toContain("the inviting party receives no result");
});

test("a count-only rendering refuses a resolved outbound set rather than state (none) over it", () => {
  // The "(none)" line states a precondition -- psi-c admits no payload in either
  // direction -- rather than a set the renderer read. This set is this party's own
  // resolved metadata, so a column in it is one the accept path already refused
  // (assertCountOnlyTransmitsNoColumn); this throw is the render-side backstop
  // behind it, since printing "(none)" over a column would take the operator's
  // consent to a disclosure that happens, on the one screen where the disclosure IS
  // the decision. Driven with a column in the set, so the check is measured firing
  // rather than assumed.
  expect(() => renderCountOnlyFacts(undefined, ["risk_score"])).toThrow(
    /no payload in either direction/,
  );
  // Non-vacuous the other way: the same call with an empty set renders the line, so
  // the throw above is the column's doing.
  expect(renderCountOnlyFacts()).toContain(
    "  columns you will send (enforced): (none)",
  );
  // And the check is the count-only branch's alone: a psi invitation resolving the
  // same set lists it, which is what makes the refusal a statement about psi-c.
  const log = getLogger("accept-display-count-only-outbound-test");
  log.setLevel("silent");
  expect(
    renderDisplayInvitation(
      log,
      { ...sampleToken(FUTURE()), linkageTerms: CONSENT_PROBE_TERMS },
      ["risk_score"],
    ),
  ).toContain("  columns you will send (enforced):\n    - risk_score");
});

test("a count-only rendering refuses terms that declare a payload column", () => {
  // The mirror of the check above, on the partner's side of it: the invitation is
  // partner-controlled, and a psi-c document declaring a send or a receive is one
  // the spec refuses (docs/spec/PROTOCOL.md, PSI-C). Printed, the tier's no-payload
  // sentence would stand above this same prompt's blocks listing the columns that
  // invitation will send or asks for -- a guarantee stated over the declaration
  // contradicting it. Driven on each direction with the flag forced on, so the check
  // is measured firing rather than assumed.
  expect(() =>
    renderCountOnlyFacts(undefined, [], {
      send: [{ name: "risk_score" }],
      receive: [],
    }),
  ).toThrow(/declare a payload column/);
  expect(() =>
    renderCountOnlyFacts(undefined, [], {
      send: [],
      receive: [{ name: "risk_score" }],
    }),
  ).toThrow(/declare a payload column/);
  // Non-vacuous the other way: the conforming document -- the empty pair psi-c
  // requires -- renders the sentence, so the throws above are the declaration's
  // doing and not the flag's.
  expect(renderCountOnlyFacts()).toContain(
    `    ${CONSENT_FACTS.countOnlyNoPayload.note}`,
  );
  // And the check is the count-only branch's alone: a psi invitation declaring the
  // same columns prints them.
  const log = getLogger("accept-display-count-only-declared-payload-test");
  log.setLevel("silent");
  expect(
    renderDisplayInvitation(log, {
      ...sampleToken(FUTURE()),
      linkageTerms: {
        ...CONSENT_PROBE_TERMS,
        payload: { send: [], receive: [{ name: "risk_score" }] },
      },
    }),
  ).toContain("    - risk_score");
});

test("the count a party did not compute is caveated only where both parties are entitled to one", () => {
  // Where exactly one party is entitled to the count, that party is the receiver by
  // the role rule and computes its own, so no report crosses and a line saying one
  // does would name a frame the run does not send. The bound on the guarantee is
  // not conditional in the same way and stays.
  const oneSided = renderCountOnlyFacts({
    expectsOutput: false,
    shareWithPartner: true,
  });
  expect(oneSided).not.toContain("how the count reaches each of you");
  expect(oneSided).not.toContain(CONSENT_FACTS.countOnlyReportedCount.note);
  expect(oneSided).toContain("  what a count-only exchange does not bound");
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
  expect(unrecognized).toContain(`            ${UNRECOGNIZED_TRANSFORM_NOTE}`);
  // A recognized function carries its plain-language consequence and no marker, so
  // the marker tells the two apart rather than decorating both.
  const recognized = render([{ function: "to_upper_case" }]);
  expect(recognized).toContain(
    "            Upper-cases the value before matching, so values differing only in letter case can match.",
  );
  expect(recognized).not.toContain(UNRECOGNIZED_TRANSFORM_NOTE);
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
    { linkageTerms: COUNT_ONLY_PROBE_TERMS, ownOutboundSend: [] },
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
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  // Read the rejection where the operator does, at a level that keeps it: the
  // handler applies --log-level to every logger, so `silent` drops this message
  // like any other, and a logger method spied before the run is replaced by the
  // one the level installs.
  const { stderrWrites, restore } = captureStdio();
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
      "log-level": "error",
      record: false,
    } as unknown as Arguments);
    expect(exit).toHaveBeenCalledWith(64);
    expect(stderrWrites.join("")).toContain("--server-usernam");
    expect(promptConfirmMock).not.toHaveBeenCalled();
    expect(fs.existsSync(configFile)).toBe(false);
    expect(fs.existsSync(keyFile)).toBe(false);
  } finally {
    restore();
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

test("handler: an accepted webrtc invitation writes role: acceptor into the config", async () => {
  // What reaches disk is what the later `psilink exchange` reads, so assert the
  // written file rather than the in-memory connection: the field has to survive
  // the spec's snake_case serialization and parse back off the schema.
  const { dir, input, configFile, keyFile } = offlineAcceptFixture();
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    const encoded = await encodeInvitation(
      sampleToken(new Date(Date.now() + 3_600_000).toISOString(), {
        channel: "webrtc",
        host: "peer.example.org",
        path: "/psi",
      }),
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
    const raw = fs.readFileSync(configFile, "utf8");
    const parsed = parseExchangeSpec(YAML.parse(raw));
    expect(parsed.connection.channel).toBe("webrtc");
    if (parsed.connection.channel !== "webrtc")
      throw new Error("expected webrtc");
    expect(parsed.connection.role).toBe("acceptor");
    expect(raw).toContain("role: acceptor");
  } finally {
    exit.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: an accepted sftp invitation writes no role", async () => {
  // The complement of the webrtc case: `role` belongs to the WebRTC channel
  // alone, so a file-sync acceptance's connection block carries none.
  const { dir, input, configFile, keyFile } = offlineAcceptFixture();
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    const encoded = await encodeInvitation(
      sampleToken(new Date(Date.now() + 3_600_000).toISOString(), {
        channel: "sftp",
        host: "sftp.example.org",
        path: "/exchange",
      }),
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
    const raw = fs.readFileSync(configFile, "utf8");
    // Read the connection block itself: `metadata` carries a `role` of its own
    // (the column's linkage/payload role), so a whole-file search would confuse
    // the two.
    const written = YAML.parse(raw) as {
      connection: Record<string, unknown>;
    };
    expect(written.connection["channel"]).toBe("sftp");
    expect(Object.keys(written.connection)).not.toContain("role");
  } finally {
    exit.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: a declared inviterRetainsFiles does not reach the acceptor's own connection options", async () => {
  // FILE_SYNC.md states this boundary as load-bearing: a declared flag on the
  // invitation stays disclosure-only, and an accept path that reads it into the
  // acceptor's own configuration -- even to pre-fill it -- has crossed from
  // disclosure into adaptation. Pin it on a non-split sftp endpoint (a single
  // `path`, no inbound/outbound pair), so the endpoint-shape seed -- which does
  // legitimately write the retain trio, derived from the endpoint's SHAPE rather
  // than from the declared flag -- never fires and cannot confound the assertion.
  const endpoint: ConnectionEndpoint = {
    channel: "sftp",
    host: "sftp.example.org",
    path: "/exchange",
  };
  const base = sampleToken(
    new Date(Date.now() + 3_600_000).toISOString(),
    endpoint,
  );

  async function acceptAndReadConnection(
    token: InvitationToken,
  ): Promise<Record<string, unknown>> {
    const { dir, input, configFile, keyFile } = offlineAcceptFixture();
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      const encoded = await encodeInvitation(token);
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
      const raw = fs.readFileSync(configFile, "utf8");
      const written = YAML.parse(raw) as {
        connection: Record<string, unknown>;
      };
      return written.connection;
    } finally {
      exit.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const declaring = await acceptAndReadConnection({
    ...base,
    inviterRetainsFiles: true,
  });
  const silent = await acceptAndReadConnection(base);

  expect(Object.keys(declaring)).not.toContain("options");
  expect(declaring).toEqual(silent);
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
  // The accept-side wiring: the online handler must pass
  // token.disclosedPayloadColumns to runOnlineBootstrap as the acceptance's
  // receivedPayloadLockIn, so the config records the consented received-column
  // lock-in (runOnlineBootstrap's own tests cover the write). It is mocked here so
  // no connection is opened; --consent-to-terms skips the prompt.
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
    expect(passed.receivedPayloadLockIn).toEqual({
      consentedColumns: ["diagnosis", "notes"],
    });
    // A fresh (non-reuse) config, so the lock-in is actually written.
    expect(passed.reuseExistingConfig).toBe(false);
  } finally {
    exit.mockRestore();
    // Module-level mock: reset so no later test inherits this call/impl.
    runOnlineBootstrapMock.mockReset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: online accept-reuse forwards the lock-in the kept config must be refreshed to", async () => {
  // A re-accept over a config that reconciles for reuse still carries this
  // acceptance's consented set to the persistence layer, which refreshes the kept
  // config's field in place -- the reuse branch must not be a no-op, or the next
  // recurring exchange would enforce the previous acceptance's set against an
  // honest partner. A subset-less invitation forwards the decision with no columns,
  // which removes the stale field rather than leaving it.
  const { dir, input, configFile, keyFile } = offlineAcceptFixture();
  const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
  runOnlineBootstrapMock.mockResolvedValue({ configWriteError: undefined });
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    // A config whose linkage terms and connection agree with the invitation and the
    // URL below, so reconciliation keeps it.
    writeExistingConfig(configFile, {
      connection: { channel: "filedrop", path: "/mnt/share" },
    });
    for (const disclosed of [["diagnosis", "notes"], undefined]) {
      runOnlineBootstrapMock.mockClear();
      const encoded = await encodeInvitation({
        ...sampleToken(FUTURE()),
        disclosedPayloadColumns: disclosed,
      });
      await acceptHandler({
        _: [],
        $0: "psilink",
        args: ["file:///mnt/share", encoded, input],
        "consent-to-terms": true,
        "config-file": configFile,
        "key-file": keyFile,
        "log-level": "silent",
        record: false,
      } as unknown as Arguments);
      expect(exit).not.toHaveBeenCalled();
      expect(runOnlineBootstrapMock).toHaveBeenCalledTimes(1);
      const passed = runOnlineBootstrapMock.mock.calls[0][0];
      expect(passed.reuseExistingConfig).toBe(true);
      // Strict: the subset-less case must forward the DECISION with no columns,
      // which removes the field, not an absent decision, which leaves it standing.
      expect(passed.receivedPayloadLockIn).toStrictEqual({
        consentedColumns: disclosed,
      });
    }
  } finally {
    exit.mockRestore();
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
  input?: string;
  disclosed: string[] | undefined;
  token?: InvitationToken;
}): Promise<string> {
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    const encoded = await encodeInvitation({
      ...(params.token ?? sampleToken(FUTURE())),
      disclosedPayloadColumns: params.disclosed,
    });
    await acceptHandler({
      _: [],
      $0: "psilink",
      args: params.input !== undefined ? [encoded, params.input] : [encoded],
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

// --- accept-reuse warns when the re-acceptance drops the lock-in -------------

// The distinctive clause of the removal warning, kept apart from the column list
// and the remedy the assertions check separately.
const DROPPED_LOCK_IN_CLAUSE =
  "removes the received-payload lock-in recorded in";

/**
 * Every warning a reuse acceptance emits over a config recording `recorded` as
 * its received-payload lock-in, re-accepted from an invitation carrying
 * `disclosed`. Both accept-reuse paths reconcile the same kept config, so `mode`
 * drives either through one fixture; the saved connection agrees with the online
 * URL, so the reuse verdict carries no connection warning of its own.
 */
async function reuseLockInWarnings(params: {
  recorded: string[] | undefined;
  disclosed: string[] | undefined;
  loggerName: string;
  mode?: "online" | "offline";
}): Promise<string[]> {
  const { recorded, disclosed, loggerName, mode = "offline" } = params;
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-accept-lockin-"));
  const configFile = path.join(dir, "psilink.yaml");
  const keyFile = path.join(dir, ".psilink.key");
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  saveConfig(configFile, {
    connection: { channel: "sftp", server: { host: "host" } },
    linkageTerms: getDefaultLinkageTerms("Acceptor Org"),
    ...(recorded !== undefined ? { expectedPayloadColumns: recorded } : {}),
  });
  const log = getLogger(loggerName);
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    const encoded = await encodeInvitation({
      ...sampleToken(FUTURE()),
      disclosedPayloadColumns: disclosed,
    });
    const ready = await validateAccept({
      resolved:
        mode === "online"
          ? {
              mode: "online",
              url: new URL("sftp://host"),
              invitation: encoded,
              input,
            }
          : { mode: "offline", invitation: encoded, input },
      options: testOptions({ configFile, keyFile }),
      log,
    });
    // Every case here is a reuse: a warning about the kept config's lock-in is
    // meaningless if the config was not kept.
    expect(ready.reuseExistingConfig).toBe(true);
    return warnSpy.mock.calls.map((c) => String(c[0]));
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The one dropped-lock-in warning in `warnings`, asserted to be exactly one. */
function droppedLockInWarning(warnings: string[]): string {
  const dropped = warnings.filter((m) => m.includes(DROPPED_LOCK_IN_CLAUSE));
  expect(dropped).toHaveLength(1);
  return dropped[0];
}

test("validateAccept: offline reuse warns, naming the columns, when the re-acceptance drops the lock-in", async () => {
  // The kept config records what the operator consented to receive; this
  // invitation carries no disclosed subset, so accepting it removes that record
  // and leaves the next exchange reconciling lazily. One warning, naming the
  // columns being given up, while the operator can still decline.
  const warnings = await reuseLockInWarnings({
    recorded: ["diagnosis", "notes"],
    disclosed: undefined,
    loggerName: "accept-lockin-drop-offline",
  });
  const dropped = droppedLockInWarning(warnings);
  // One column per line, so a name carrying the list separator cannot be misread
  // as two entries.
  expect(dropped).toContain("\n  - diagnosis");
  expect(dropped).toContain("\n  - notes");
  expect(dropped).toContain("accepts whatever columns the partner transmits");
});

test("validateAccept: online reuse warns when the re-acceptance drops the lock-in", async () => {
  // The second accept-reuse path: the online acceptance refreshes the same kept
  // config, so the same removal must be visible there -- and it lands before any
  // network activity, so the operator sees it at the same prompt.
  const warnings = await reuseLockInWarnings({
    recorded: ["diagnosis"],
    disclosed: undefined,
    loggerName: "accept-lockin-drop-online",
    mode: "online",
  });
  expect(droppedLockInWarning(warnings)).toContain("\n  - diagnosis");
});

test("validateAccept: reuse stays silent when the acceptance records a lock-in of its own", async () => {
  // Nothing is dropped when this acceptance consents to a set: an unchanged set
  // leaves the record as it stands, and a changed one is a refresh the operator
  // just consented to. Neither loses the check, so neither warns.
  const unchanged = await reuseLockInWarnings({
    recorded: ["diagnosis"],
    disclosed: ["diagnosis"],
    loggerName: "accept-lockin-unchanged",
  });
  expect(unchanged.filter((m) => m.includes(DROPPED_LOCK_IN_CLAUSE))).toEqual(
    [],
  );
  const changed = await reuseLockInWarnings({
    recorded: ["diagnosis"],
    disclosed: ["notes"],
    loggerName: "accept-lockin-changed",
  });
  expect(changed.filter((m) => m.includes(DROPPED_LOCK_IN_CLAUSE))).toEqual([]);
});

test("validateAccept: reuse stays silent when the acceptance newly sets the lock-in", async () => {
  // A kept config that recorded no lock-in loses nothing by gaining one.
  const warnings = await reuseLockInWarnings({
    recorded: undefined,
    disclosed: ["diagnosis"],
    loggerName: "accept-lockin-newly-set",
  });
  expect(warnings.filter((m) => m.includes(DROPPED_LOCK_IN_CLAUSE))).toEqual(
    [],
  );
});

test("validateAccept: reuse warns that a recorded receive-nothing consent is dropped", async () => {
  // The strictest lock-in of all -- an empty recorded set, which aborts on any
  // transmitted column -- has no column names to list, so the warning has to name
  // the consent itself rather than fall silent on an empty list.
  const warnings = await reuseLockInWarnings({
    recorded: [],
    disclosed: undefined,
    loggerName: "accept-lockin-drop-empty",
  });
  expect(droppedLockInWarning(warnings)).toContain(
    "no columns at all (a strict receive-nothing consent)",
  );
});

test("validateAccept: the dropped lock-in's column names are escaped for display", async () => {
  // The recorded set is the partner's namespace, carried into the config by an
  // earlier acceptance, so a name planted with a terminal escape must not reach
  // the operator raw when this warning reads it back out.
  const hostile = `notes${ESC}[0m`;
  const warnings = await reuseLockInWarnings({
    recorded: [hostile],
    disclosed: undefined,
    loggerName: "accept-lockin-drop-escaping",
  });
  const dropped = droppedLockInWarning(warnings);
  expect(dropped).toContain(sanitizeForDisplay(hostile));
  expect(dropped).not.toContain(ESC);
});

// --- handler: the acceptance records consent to its OWN outbound set ---------

// The acceptor's outbound column set is authored by no party: the invitation
// authors the inviter's send, the mirror leaves the acceptor's own send absent,
// and the set comes from its input columns. These pin that the acceptance records
// what it showed, in each of the three shapes an acceptance can be in, so a later
// run has something to hold itself to.

/** An offline-accept CSV whose header discloses one payload column. */
function fixtureWithPayloadColumn(): ReturnType<typeof offlineAcceptFixture> {
  const fixture = offlineAcceptFixture();
  fs.writeFileSync(
    fixture.input,
    "first_name,last_name,dob,ssn,diagnosis\n" +
      "Alice,Smith,1990-01-02,123456789,A\n",
  );
  return fixture;
}

/**
 * Run the offline accept handler on a fresh config (no pre-existing file), with
 * --consent-to-terms so the confirmation prompt is skipped, and return the written
 * config's text. `input` is omitted for the accept-with-no-input-file case.
 */
async function runOfflineAcceptFresh(params: {
  configFile: string;
  keyFile: string;
  input?: string;
  token?: InvitationToken;
}): Promise<string> {
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    const encoded = await encodeInvitation(
      params.token ?? sampleToken(FUTURE()),
    );
    await acceptHandler({
      _: [],
      $0: "psilink",
      args: params.input !== undefined ? [encoded, params.input] : [encoded],
      "consent-to-terms": true,
      "config-file": params.configFile,
      "key-file": params.keyFile,
      "log-level": "silent",
      record: false,
    } as unknown as Arguments);
    expect(exit).not.toHaveBeenCalled();
    return fs.readFileSync(params.configFile, "utf8");
  } finally {
    exit.mockRestore();
  }
}

test("handler: an acceptance that resolves its outbound set records it as confirmed", async () => {
  // The set is resolvable here, so what the display showed is what is recorded --
  // and it is the disclosed set, not every column in the file: the four linkage
  // columns are not transmitted, diagnosis is.
  const { dir, input, configFile, keyFile } = fixtureWithPayloadColumn();
  try {
    const raw = await runOfflineAcceptFresh({ configFile, keyFile, input });
    expect(parseExchangeSpec(YAML.parse(raw)).outboundPayloadConsent).toEqual({
      status: "confirmed",
      columns: ["diagnosis"],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: an acceptance with no input file records the set as pending", async () => {
  // The case the display forward-references: nothing here can resolve the set, so
  // the record says so rather than being absent (which would leave the run lazy)
  // or guessing a set. The first run that can resolve it asks.
  const { dir, configFile, keyFile } = offlineAcceptFixture();
  try {
    const raw = await runOfflineAcceptFresh({ configFile, keyFile });
    expect(parseExchangeSpec(YAML.parse(raw)).outboundPayloadConsent).toEqual({
      status: "pending",
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: an acceptance that transmits nothing records no consent", async () => {
  // An invitation that gives the inviting party no result: the payload step
  // transmits nothing whatever the input holds, so there is no disclosure to
  // consent to and no record to enforce -- matching the display, which names no
  // column set for this shape either.
  const { dir, input, configFile, keyFile } = fixtureWithPayloadColumn();
  try {
    const base = sampleToken(FUTURE());
    const raw = await runOfflineAcceptFresh({
      configFile,
      keyFile,
      input,
      token: {
        ...base,
        linkageTerms: {
          ...base.linkageTerms,
          output: { expectsOutput: false, shareWithPartner: true },
        },
      },
    });
    expect(raw).not.toContain("outbound_payload_consent");
    expect(
      parseExchangeSpec(YAML.parse(raw)).outboundPayloadConsent,
    ).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: offline accept-reuse refreshes the outbound consent, preserving operator content", async () => {
  // A re-acceptance is a fresh consent to a freshly displayed set, so the kept
  // config's record is rewritten to it rather than left at a prior acceptance's
  // value -- the same reasoning as the received-payload lock-in beside it, and the
  // same surgical write.
  const { dir, input, configFile } = fixtureWithPayloadColumn();
  try {
    writeExistingConfig(configFile);
    fs.appendFileSync(
      configFile,
      "# operator-authored note\n" +
        "outbound_payload_consent:\n  status: confirmed\n  columns:\n" +
        "    - stale_col\n",
    );
    const raw = await runOfflineAcceptReuse({
      configFile,
      input,
      disclosed: undefined,
    });
    expect(raw).toContain("# operator-authored note");
    expect(raw).not.toContain("stale_col");
    expect(parseExchangeSpec(YAML.parse(raw)).outboundPayloadConsent).toEqual({
      status: "confirmed",
      columns: ["diagnosis"],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: a no-output invitation cannot strip the record from a kept config that shares", async () => {
  // The partner-controlled shape the reuse derivation exists for: reconciliation
  // compares no output field, so an invitation carrying expects_output: false
  // reconciles as matching a kept config that still shares. The mirror then
  // yields no record -- and deleting the existing one would leave the later run
  // ungated (the gate no-ops on an absent record). The record falls to pending
  // instead: nothing about the outbound set was displayed or confirmed for a
  // config that will transmit.
  const { dir, input, configFile } = fixtureWithPayloadColumn();
  try {
    writeExistingConfig(configFile);
    fs.appendFileSync(
      configFile,
      "outbound_payload_consent:\n  status: confirmed\n  columns:\n" +
        "    - stale_col\n",
    );
    const base = sampleToken(FUTURE());
    const raw = await runOfflineAcceptReuse({
      configFile,
      input,
      disclosed: undefined,
      token: {
        ...base,
        linkageTerms: {
          ...base.linkageTerms,
          output: { expectsOutput: false, shareWithPartner: true },
        },
      },
    });
    expect(parseExchangeSpec(YAML.parse(raw)).outboundPayloadConsent).toEqual({
      status: "pending",
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: the record is removed on reuse only where the kept config does not share", async () => {
  // The inert case: the kept config's own terms admit no transmission, so a
  // leftover record describes nothing the run can send and is removed as
  // hygiene rather than left stale.
  const { dir, input, configFile } = fixtureWithPayloadColumn();
  try {
    const terms = getDefaultLinkageTerms("Acceptor Org");
    writeExistingConfig(configFile, {
      terms: {
        ...terms,
        output: { ...terms.output, shareWithPartner: false },
      },
    });
    fs.appendFileSync(
      configFile,
      "outbound_payload_consent:\n  status: confirmed\n  columns:\n" +
        "    - stale_col\n",
    );
    const base = sampleToken(FUTURE());
    const raw = await runOfflineAcceptReuse({
      configFile,
      input,
      disclosed: undefined,
      token: {
        ...base,
        linkageTerms: {
          ...base.linkageTerms,
          output: { expectsOutput: false, shareWithPartner: true },
        },
      },
    });
    expect(raw).not.toContain("outbound_payload_consent");
    expect(
      parseExchangeSpec(YAML.parse(raw)).outboundPayloadConsent,
    ).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: offline accept-reuse without an input file overwrites a confirmed record with pending", async () => {
  // The unresolvable shape through the reuse writer: this acceptance displayed no
  // set, so a prior acceptance's confirmed columns must not stand as if they were
  // confirmed here -- pending makes the first resolving run show and ask.
  const { dir, configFile } = fixtureWithPayloadColumn();
  try {
    writeExistingConfig(configFile);
    fs.appendFileSync(
      configFile,
      "outbound_payload_consent:\n  status: confirmed\n  columns:\n" +
        "    - stale_col\n",
    );
    const raw = await runOfflineAcceptReuse({
      configFile,
      disclosed: undefined,
    });
    expect(parseExchangeSpec(YAML.parse(raw)).outboundPayloadConsent).toEqual({
      status: "pending",
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: online accept forwards its own outbound consent to runOnlineBootstrap", async () => {
  // The online sibling of the offline write: the set is known before the handshake
  // (it is what the display showed), so it rides the acceptance's first config
  // write. runOnlineBootstrap is mocked here so no connection is opened; its own
  // tests cover the write.
  const { dir, input, configFile, keyFile } = fixtureWithPayloadColumn();
  const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
  runOnlineBootstrapMock.mockResolvedValue({ configWriteError: undefined });
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
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
    expect(
      runOnlineBootstrapMock.mock.calls[0][0].outboundPayloadConsent,
    ).toEqual({ status: "confirmed", columns: ["diagnosis"] });
  } finally {
    exit.mockRestore();
    runOnlineBootstrapMock.mockReset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: online accept whose config write failed keeps exit 73 and says so", async () => {
  // The unattended half of the outcome: a wrapper gating on exit status must not
  // read a rotated key with no configuration as a completed setup. The
  // persistence-loss code is set where the write failed (runProtocol's hook
  // handling), so the mocked runOnlineBootstrap stands in for that run by
  // leaving 73 behind, and what is asserted here is that the handler carries it
  // through untouched -- a summary that assigned the exit code itself would
  // overwrite exactly this. No connection is opened; --log-level error is the
  // level the summary is written at, and the level the underlying error it
  // points back to is shown at.
  const { dir, input, configFile, keyFile } = offlineAcceptFixture();
  const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
  runOnlineBootstrapMock.mockImplementation(async () => {
    process.exitCode = 73;
    return { configWriteError: new Error("permission denied") };
  });
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  const stdio = captureStdio();
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    await acceptHandler({
      _: [],
      $0: "psilink",
      args: ["sftp://host/drop", encoded, input],
      "consent-to-terms": true,
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "error",
      record: false,
    } as unknown as Arguments);
    // Read before the finally block restores the exit code and the stdio spies.
    const exitCode = process.exitCode;
    const stderr = stdio.stderrWrites.join("");
    expect(exit).not.toHaveBeenCalled();
    expect(runOnlineBootstrapMock).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(73);
    // The operator is told which half landed, at error level: the key is saved,
    // the config is not.
    expect(stderr).toContain("[ERROR] [accept] ");
    expect(stderr).toContain(`could not be written to ${configFile}`);
    expect(stderr).toContain(`rotated key was saved to ${keyFile}`);
  } finally {
    process.exitCode = previousExitCode;
    stdio.restore();
    exit.mockRestore();
    runOnlineBootstrapMock.mockReset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: a clean config write leaves the exchange's own exit 73 in place", async () => {
  // The exchange completed but could not write an audit artifact, so runProtocol
  // left the persistence-loss code behind; the config write that followed then
  // succeeded. The outcome summary moves no process state, so the run an
  // unattended supervisor sees still reports the lost record rather than a clean
  // 0. runOnlineBootstrap stands in for that exchange, setting the exit code the
  // way runProtocol does and reporting a written config.
  const { dir, input, configFile, keyFile } = offlineAcceptFixture();
  const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
  runOnlineBootstrapMock.mockImplementation(async () => {
    process.exitCode = 73;
    return { configWriteError: undefined };
  });
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  const stdio = captureStdio();
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    await acceptHandler({
      _: [],
      $0: "psilink",
      args: ["sftp://host/drop", encoded, input],
      "consent-to-terms": true,
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "info",
      record: true,
    } as unknown as Arguments);
    // Read before the finally block restores the exit code and the stdio spies.
    const exitCode = process.exitCode;
    const stderr = stdio.stderrWrites.join("");
    expect(exit).not.toHaveBeenCalled();
    expect(runOnlineBootstrapMock).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(73);
    // The setup summary is still reported; only the clean exit code is withheld.
    expect(stderr).toContain(`saved config to ${configFile}`);
  } finally {
    process.exitCode = previousExitCode;
    stdio.restore();
    exit.mockRestore();
    runOnlineBootstrapMock.mockReset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
