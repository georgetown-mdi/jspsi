import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import logLibrary from "loglevel";
import type { Arguments } from "yargs";
import YAML from "yaml";
import {
  encodeInvitation,
  EXCHANGE_KEYS_VERSION,
  EXCHANGE_RECORD_VERSION,
  generateSharedSecret,
  generateSigningIdentity,
  getDefaultLinkageTerms,
  getLogger,
  inferMetadata,
  operatorSuppliedSpans,
  sanitizeErrorForDisplay,
  serializeDualSignedRecord,
  SIGNED_RECEIPT_VERSION,
  signReceiptContent,
} from "@alcove/core";
import type {
  ConnectionEndpoint,
  ExchangeSpec,
  LinkageTerms,
  ReceiptContent,
} from "@alcove/core";

import {
  handler as acceptHandler,
  validateAccept,
} from "../../../src/commands/accept";
import { saveConfig } from "../../../src/config";
import {
  loadConfig,
  resolveSigningPersist,
  warnAndStripInjectedAuthFields,
} from "../../../src/commands/exchange";
import {
  handler as fingerprintHandler,
  readConfigHints,
  resolveSigningIdentity,
} from "../../../src/commands/fingerprint";
import {
  buildTemplateData,
  decideOverwrite,
  handler as initHandler,
} from "../../../src/commands/init";
import {
  handler as inviteHandler,
  offlineAbandonNotice,
  validateInvite,
} from "../../../src/commands/invite";
import { provisionConfigAndKey } from "../../../src/commands/provision";
import {
  pinnedFingerprintFrom,
  readConfigSigningBlock,
  readExchangeRecordFile,
  readSignedRecordFile,
  handler as verifyReceiptHandler,
  readVerifiableArtifact,
  readVerificationKeysFile,
} from "../../../src/commands/verifyReceipt";
import { finalizeBootstrap } from "../../../src/commands/zeroSetup";
import * as fileUtils from "../../../src/fileUtils";
import type { CommonBootstrapOptions } from "../../../src/optionDefinitions";
import { saveKeyFile } from "../../../src/keyFile";
import {
  captureStdio,
  snapshotDiagnosticSinkAndLevel,
} from "../../loggingTestSupport";
import { answeringTtyStream, withStdin } from "../../stdinStream";

// Every message these command modules compose about the OPERATOR's own path --
// a refusal, a warning, an informational line, a prompt -- marks that path, so
// the display sink renders it as they typed it instead of escaping every
// separator and handing back a path they cannot copy into a command
// (packages/core/src/utils/operatorSuppliedText.ts).
//
// Each case below drives one converted sink and reads the marked spans off what
// it produced: the spans on the error for a refusal, the rendered line for a
// log or prompt sink. The fixture path holds backslashes on every platform --
// native separators on Windows, and one file name spelling them off it, where a
// backslash is a legal filename character -- so the NATIVE-separator case runs
// on Windows alone while every sink is still exercised wherever the suite runs.

const TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const LINKAGE_TERMS = {
  version: "1.0.0",
  identity: "Test Party",
  date: "2025-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

const FILEDROP_CONFIG = {
  connection: { channel: "filedrop", path: "/mnt/share/drop" },
  linkageTerms: LINKAGE_TERMS,
};

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-operator-path-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A path under the fixture directory holding backslashes, its parent created. */
function backslashedPath(name: string): string {
  const full =
    process.platform === "win32"
      ? path.join(dir, "alcove", name)
      : path.join(dir, `C:\\alcove\\${name}`);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return full;
}

/** The same path as a fragment nobody marked reaches the operator. */
const escaped = (value: string): string => value.replaceAll("\\", "\\\\");

/** The fragments a refusal marks as the operator's own, read off the error. */
function markedFragments(thrown: unknown): string[] {
  const error = thrown as Error;
  return (operatorSuppliedSpans(error, error.message) ?? [])
    .filter((span) => span.operatorSupplied)
    .map((span) => span.text);
}

/**
 * One converted sink: what drives it, and a fragment of the copy it alone
 * writes, so a case that reached some other message fails rather than passing
 * on a path another line named.
 */
interface SinkCase<Outcome> {
  readonly name: string;
  readonly says: readonly string[];
  readonly drive: () => Promise<Outcome>;
  /**
   * The errno this message quotes names the path a second time, which nobody
   * marked and the sink therefore escapes. What the mark decides is the copy
   * the message itself composed, so that copy is what the case reads.
   */
  readonly relaysPathAgain?: boolean;
}

/** A refusal: the error the driver raised, plus the path it names. */
interface RefusalOutcome {
  readonly filePath: string;
  readonly thrown: unknown;
}

/** A log or prompt line: every line the driver emitted, plus the path. */
interface LineOutcome {
  readonly filePath: string;
  readonly lines: readonly string[];
}

/** Collect every line a logger emits at the levels these sinks use. */
function captureLines(logger: ReturnType<typeof getLogger>): string[] {
  const lines: string[] = [];
  const collect = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
  };
  vi.spyOn(logger, "info").mockImplementation(collect);
  vi.spyOn(logger, "warn").mockImplementation(collect);
  return lines;
}

/** A logger stub for the functions that take one, with the lines it collected. */
function stubLog(): { log: ReturnType<typeof getLogger>; lines: string[] } {
  const lines: string[] = [];
  const collect = (message: string): void => {
    lines.push(message);
  };
  return {
    lines,
    log: { info: collect, warn: collect } as unknown as ReturnType<
      typeof getLogger
    >,
  };
}

/**
 * Assert that the sink the case is about wrote the operator's path as they
 * typed it: the copy it alone writes is there, the path is there unescaped, and
 * no line the drive produced holds the escaped form.
 */
function expectPathAsTyped(
  outcome: LineOutcome,
  says: readonly string[],
  relaysPathAgain = false,
): void {
  const text = outcome.lines.join("\n");
  for (const phrase of says) expect(text).toContain(phrase);
  expect(text).toContain(outcome.filePath);
  if (relaysPathAgain) {
    expect(text).toContain(`${says[0]} ${outcome.filePath}`);
    return;
  }
  expect(text).not.toContain(escaped(outcome.filePath));
}

/** Run `act`, returning what it threw. */
async function raised(act: () => unknown): Promise<unknown> {
  try {
    await act();
  } catch (err: unknown) {
    return err;
  }
  throw new Error("the driver raised nothing");
}

/** Write a config file the exchange loader parses cleanly. */
function writeFiledropConfig(configFile: string): void {
  fs.writeFileSync(configFile, YAML.stringify(FILEDROP_CONFIG));
}

function sampleSpec(): ExchangeSpec {
  return {
    connection: { channel: "filedrop", path: "/mnt/share" },
    linkageTerms: getDefaultLinkageTerms("Test Party"),
  };
}

// --- refusals ----------------------------------------------------------------

const REFUSALS: readonly SinkCase<RefusalOutcome>[] = [
  {
    name: "exchange: a config file that does not exist",
    says: ["does not exist; to create one"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      return {
        filePath,
        thrown: await raised(() =>
          loadConfig({ configFile: filePath, keyFile: backslashedPath("k") }),
        ),
      };
    },
  },
  {
    name: "exchange: a config file that cannot be read",
    says: ["could not be read"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      fs.mkdirSync(filePath);
      return {
        filePath,
        thrown: await raised(() =>
          loadConfig({ configFile: filePath, keyFile: backslashedPath("k") }),
        ),
      };
    },
  },
  {
    name: "exchange: a config file that is not a valid exchange spec",
    says: ["is not a valid exchange spec"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      fs.writeFileSync(filePath, YAML.stringify({ connection: {} }));
      return {
        filePath,
        thrown: await raised(() =>
          loadConfig({ configFile: filePath, keyFile: backslashedPath("k") }),
        ),
      };
    },
  },
  {
    name: "exchange: a malformed key file",
    says: ["is malformed"],
    drive: async () => {
      const configFile = backslashedPath("alcove.yaml");
      writeFiledropConfig(configFile);
      const filePath = backslashedPath(".alcove.key");
      fs.writeFileSync(filePath, JSON.stringify({ version: "nonsense" }));
      return {
        filePath,
        thrown: await raised(() =>
          loadConfig({ configFile, keyFile: filePath }),
        ),
      };
    },
  },
  {
    name: "exchange: a key file that does not exist",
    says: ["does not exist. Create one with"],
    drive: async () => {
      const configFile = backslashedPath("alcove.yaml");
      writeFiledropConfig(configFile);
      const filePath = backslashedPath(".alcove.key");
      return {
        filePath,
        thrown: await raised(() =>
          loadConfig({ configFile, keyFile: filePath }),
        ),
      };
    },
  },
  {
    name: "exchange: a shared secret that has expired",
    says: ["expired at"],
    drive: async () => {
      const configFile = backslashedPath("alcove.yaml");
      writeFiledropConfig(configFile);
      const filePath = backslashedPath(".alcove.key");
      saveKeyFile(filePath, {
        sharedSecret: TOKEN,
        expires: "2020-01-01T00:00:00.000Z",
      });
      return {
        filePath,
        thrown: await raised(() =>
          loadConfig({ configFile, keyFile: filePath }),
        ),
      };
    },
  },
  {
    name: "exchange: a signing identity file that is not there",
    says: ["no signing identity was found at"],
    drive: async () => {
      const filePath = backslashedPath("identity.json");
      return {
        filePath,
        thrown: await raised(() =>
          resolveSigningPersist(
            { mode: "certificate", identityFile: filePath },
            "Test Party",
            backslashedPath("alcove.yaml"),
          ),
        ),
      };
    },
  },
  {
    name: "init: a file already at the path with no terminal to confirm",
    says: ["refusing to overwrite it without an interactive confirmation"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      fs.writeFileSync(filePath, "");
      return {
        filePath,
        thrown: await raised(() =>
          decideOverwrite(filePath, {
            interactive: false,
            confirm: () => Promise.resolve(false),
          }),
        ),
      };
    },
  },
  {
    name: "provision: a reused config removed since it was reconciled",
    says: ["no longer exists"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      return {
        filePath,
        thrown: await raised(() =>
          provisionConfigAndKey(
            sampleSpec(),
            { sharedSecret: TOKEN },
            { configPath: filePath, keyPath: backslashedPath(".alcove.key") },
            { reuseExistingConfig: true },
          ),
        ),
      };
    },
  },
  {
    name: "verify-receipt: a record file that cannot be read",
    says: ["could not be read"],
    drive: async () => {
      const filePath = backslashedPath("record.json");
      fs.mkdirSync(filePath);
      return {
        filePath,
        thrown: await raised(() => readExchangeRecordFile(filePath)),
      };
    },
  },
  {
    name: "verify-receipt: a record file of an unrecognized version",
    says: ["has an unrecognized version"],
    drive: async () => {
      const filePath = backslashedPath("record.json");
      fs.writeFileSync(filePath, JSON.stringify({ version: "alcove/nope" }));
      return {
        filePath,
        thrown: await raised(() => readVerifiableArtifact(filePath)),
      };
    },
  },
  {
    name: "verify-receipt: a record file that is not a valid exchange record",
    says: ["is not a valid exchange record"],
    drive: async () => {
      const filePath = backslashedPath("record.json");
      fs.writeFileSync(
        filePath,
        JSON.stringify({ version: EXCHANGE_RECORD_VERSION }),
      );
      return {
        filePath,
        thrown: await raised(() => readExchangeRecordFile(filePath)),
      };
    },
  },
  {
    name: "verify-receipt: a signed-record file that is not a dual-signed record",
    says: ["is not a valid dual-signed record"],
    drive: async () => {
      const filePath = backslashedPath("signed.json");
      fs.writeFileSync(
        filePath,
        JSON.stringify({ version: SIGNED_RECEIPT_VERSION }),
      );
      return {
        filePath,
        thrown: await raised(() => readSignedRecordFile(filePath)),
      };
    },
  },
  {
    name: "verify-receipt: a verification-keys file of an unrecognized version",
    says: ["has an unrecognized version"],
    drive: async () => {
      const filePath = backslashedPath("keys.json");
      fs.writeFileSync(filePath, JSON.stringify({ version: "alcove/nope" }));
      return {
        filePath,
        thrown: await raised(() => readVerificationKeysFile(filePath)),
      };
    },
  },
  {
    name: "verify-receipt: a verification-keys file that is not valid",
    says: ["is not valid"],
    drive: async () => {
      const filePath = backslashedPath("keys.json");
      fs.writeFileSync(
        filePath,
        JSON.stringify({ version: EXCHANGE_KEYS_VERSION }),
      );
      return {
        filePath,
        thrown: await raised(() => readVerificationKeysFile(filePath)),
      };
    },
  },
  {
    name: "verify-receipt: a named config file that does not exist",
    says: ["does not exist"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      return {
        filePath,
        thrown: await raised(() => readConfigSigningBlock(filePath, true)),
      };
    },
  },
  {
    name: "verify-receipt: a config file that cannot be read",
    says: ["could not be read"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      fs.mkdirSync(filePath);
      return {
        filePath,
        thrown: await raised(() => readConfigSigningBlock(filePath, true)),
      };
    },
  },
  {
    name: "fingerprint: a named config file that does not exist",
    says: ["config file", "does not exist"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      return {
        filePath,
        thrown: await raised(() => readConfigHints(filePath, true)),
      };
    },
  },
  {
    name: "fingerprint: a config file that cannot be read",
    says: ["config file", "could not be read"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      fs.mkdirSync(filePath);
      return {
        filePath,
        thrown: await raised(() => readConfigHints(filePath, true)),
      };
    },
  },
  {
    name: "init: an input file it could not read",
    says: ["could not read input file"],
    drive: async () => {
      // A directory at the path: the read fails past the existence check that
      // would otherwise refuse first, and the errno quotes no path of its own.
      const filePath = backslashedPath("input.csv");
      fs.mkdirSync(filePath);
      return {
        filePath,
        thrown: await raised(() => buildTemplateData(filePath, "Test Party")),
      };
    },
  },
  {
    name: "verify-receipt: a pinned fingerprint that is not a fingerprint",
    says: ["signing.partner_fingerprint"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      fs.writeFileSync(
        filePath,
        YAML.stringify({ signing: { partner_fingerprint: "not-a-digest" } }),
      );
      return {
        filePath,
        thrown: await raised(() =>
          pinnedFingerprintFrom(readConfigSigningBlock(filePath, true)),
        ),
      };
    },
  },
];

for (const { name, says, drive } of REFUSALS)
  test(`${name} names the path as the operator typed it`, async () => {
    const { thrown, filePath } = await drive();

    expect(thrown).toBeInstanceOf(Error);
    expect(markedFragments(thrown)).toEqual([filePath]);
    const rendered = sanitizeErrorForDisplay(thrown);
    // The refusal under test is the one that fired, so a case cannot pass on
    // some other message that happens to name the same path.
    for (const phrase of says) expect(rendered).toContain(phrase);
    expect(rendered).toContain(filePath);
    expect(rendered).not.toContain(escaped(filePath));
  });

// --- log and prompt lines ----------------------------------------------------

const LINES: readonly SinkCase<LineOutcome>[] = [
  {
    name: "exchange: an injected authentication field it ignores",
    says: ["is set and will be ignored"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      const { log, lines } = stubLog();
      warnAndStripInjectedAuthFields({ shared_secret: "x" }, filePath, log);
      return { filePath, lines };
    },
  },
  {
    name: "exchange: the spec it loaded",
    says: ["loaded exchange spec from"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      writeFiledropConfig(filePath);
      const keyFile = backslashedPath(".alcove.key");
      saveKeyFile(keyFile, { sharedSecret: TOKEN });
      const lines = captureLines(getLogger("exchange"));
      loadConfig({ configFile: filePath, keyFile });
      return { filePath, lines };
    },
  },
  {
    name: "fingerprint: an existing identity --force could not read",
    says: ["--force"],
    drive: async () => {
      const filePath = backslashedPath("identity.json");
      fs.writeFileSync(filePath, "{ not json");
      const { log, lines } = stubLog();
      await resolveSigningIdentity({
        identityPath: filePath,
        identityArg: "Test Party",
        force: true,
        log,
      });
      return { filePath, lines };
    },
  },
  {
    name: "invite: the key file that withdraws an offline invitation",
    says: ["To withdraw this invitation"],
    drive: async () => {
      const filePath = backslashedPath(".alcove.key");
      return { filePath, lines: [offlineAbandonNotice(filePath)] };
    },
  },
  {
    name: "zero-setup: the config and key file both parties saved",
    says: ["established a shared secret with your partner"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      const { log, lines } = stubLog();
      finalizeBootstrap({
        save: true,
        bootstrap: { sharedSecret: TOKEN, partnerSaveIntent: true },
        spec: sampleSpec(),
        configFile: filePath,
        keyFile: backslashedPath(".alcove.key"),
        log,
      });
      return { filePath, lines };
    },
  },
  {
    name: "zero-setup: the config saved with no shared secret",
    says: ["your partner did not also choose to save"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      const { log, lines } = stubLog();
      finalizeBootstrap({
        save: true,
        bootstrap: { partnerSaveIntent: false },
        spec: sampleSpec(),
        configFile: filePath,
        keyFile: backslashedPath(".alcove.key"),
        log,
      });
      return { filePath, lines };
    },
  },
];

for (const { name, says, drive } of LINES)
  test(`${name} names the path as the operator typed it`, async () => {
    expectPathAsTyped(await drive(), says);
  });

// --- sinks a command drive reaches -------------------------------------------

// The sinks above sit behind an exported step; the ones below are written where
// the command runs, so each case drives the command itself and reads the lines
// it put on stderr -- where every diagnostic and every prompt goes, stdout being
// reserved for a command's result.

snapshotDiagnosticSinkAndLevel();

const LINKAGE_COLUMNS = ["first_name", "last_name", "dob", "ssn"];
const SAMPLE_CSV = `${LINKAGE_COLUMNS.join(",")}\nAlice,Smith,1990-01-02,123456789\n`;
const FUTURE = (): string => new Date(Date.now() + 3_600_000).toISOString();

const sampleTerms = (identity: string): LinkageTerms =>
  getDefaultLinkageTerms(identity, inferMetadata(LINKAGE_COLUMNS, []));

/** An input CSV under the fixture directory, at an ordinary path. */
function writeInput(): string {
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(input, SAMPLE_CSV);
  return input;
}

/** An invitation the acceptor can decode, optionally seeding a connection. */
async function encodedInvitation(
  connectionEndpoint?: ConnectionEndpoint,
  disclosedPayloadColumns?: string[],
): Promise<string> {
  return encodeInvitation({
    version: "1",
    linkageTerms: sampleTerms("Inviter Org"),
    sharedSecret: generateSharedSecret(),
    expires: FUTURE(),
    connectionEndpoint,
    disclosedPayloadColumns,
  });
}

/** Options naming fresh config and key paths, as the bootstrap commands take. */
function bootstrapOptions(
  overrides: Partial<CommonBootstrapOptions> = {},
): CommonBootstrapOptions {
  return {
    configFile: path.join(dir, "alcove.yaml"),
    keyFile: path.join(dir, ".alcove.key"),
    identity: "Agency B",
    record: false,
    eventStream: false,
    logLevel: logLibrary.levels.SILENT,
    verbosity: 0,
    ...overrides,
  };
}

/** A silent logger of its own, so a drive's warnings reach the spy alone. */
function silentLogger(name: string): ReturnType<typeof getLogger> {
  const log = getLogger(name);
  log.setLevel("silent");
  return log;
}

/** Run a command, returning every line it wrote where the operator reads. */
async function stderrLinesOf(act: () => Promise<void>): Promise<string[]> {
  const exit = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${String(code)}`);
  }) as never);
  const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  const stdio = captureStdio();
  try {
    await act();
  } catch (err: unknown) {
    if (!(err instanceof Error) || !err.message.startsWith("exit:")) throw err;
  } finally {
    stdio.restore();
    stdout.mockRestore();
    exit.mockRestore();
  }
  return stdio.stderrWrites.join("").split("\n");
}

/** The argv a command handler reads, with the lines it emits kept. */
function argvOf(overrides: Record<string, unknown>): Arguments {
  return {
    _: [],
    $0: "alcove",
    "log-level": "info",
    record: false,
    ...overrides,
  } as unknown as Arguments;
}

const COMMAND_LINES: readonly SinkCase<LineOutcome>[] = [
  {
    name: "accept: a pre-existing config that is not valid YAML",
    says: ["is not valid YAML"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      fs.writeFileSync(filePath, "a:\n\tb: 1\n");
      const invitation = await encodedInvitation();
      const thrown = await raised(() =>
        validateAccept({
          resolved: { mode: "offline", invitation },
          options: bootstrapOptions({ configFile: filePath }),
          log: silentLogger("accept-marks-yaml"),
        }),
      );
      return { filePath, lines: [sanitizeErrorForDisplay(thrown)] };
    },
  },
  {
    name: "accept: a pre-existing config that is not a valid exchange spec",
    says: ["could not be parsed to compare against"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      fs.writeFileSync(filePath, YAML.stringify({ connection: {} }));
      const invitation = await encodedInvitation();
      const thrown = await raised(() =>
        validateAccept({
          resolved: { mode: "offline", invitation },
          options: bootstrapOptions({ configFile: filePath }),
          log: silentLogger("accept-marks-spec"),
        }),
      );
      return { filePath, lines: [sanitizeErrorForDisplay(thrown)] };
    },
  },
  {
    name: "accept: a kept config whose recorded received set this acceptance clears",
    says: ["recorded in"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      saveConfig(filePath, {
        connection: { channel: "filedrop", path: "/mnt/share" },
        linkageTerms: sampleTerms("Acceptor Org"),
        expectedPayloadColumns: ["diagnosis"],
      });
      const log = silentLogger("accept-marks-cleared");
      const warn = vi.spyOn(log, "warn");
      await validateAccept({
        resolved: { mode: "offline", invitation: await encodedInvitation() },
        options: bootstrapOptions({ configFile: filePath }),
        log,
      });
      return {
        filePath,
        lines: warn.mock.calls.map((call) => String(call[0])),
      };
    },
  },
  {
    name: "accept: a kept config the invitation agrees with",
    says: ["matches the invitation"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      saveConfig(filePath, {
        connection: { channel: "filedrop", path: "/mnt/share" },
        linkageTerms: sampleTerms("Acceptor Org"),
      });
      const log = silentLogger("accept-marks-kept");
      const info = vi.spyOn(log, "info");
      await validateAccept({
        resolved: { mode: "offline", invitation: await encodedInvitation() },
        options: bootstrapOptions({ configFile: filePath }),
        log,
      });
      return {
        filePath,
        lines: info.mock.calls.map((call) => String(call[0])),
      };
    },
  },
  {
    name: "accept: a kept config whose connection differs from the URL's",
    says: [
      "they apply to this exchange only",
      "the connection differences above",
    ],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      saveConfig(filePath, {
        connection: {
          channel: "sftp",
          server: { host: "host", port: 2222 },
        },
        linkageTerms: sampleTerms("Acceptor Org"),
      });
      const log = silentLogger("accept-marks-connection");
      const lines: string[] = [];
      vi.spyOn(log, "warn").mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
      vi.spyOn(log, "info").mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
      await validateAccept({
        resolved: {
          mode: "online",
          url: new URL("sftp://host:2223"),
          invitation: await encodedInvitation(),
          input: writeInput(),
        },
        options: bootstrapOptions({ configFile: filePath }),
        log,
      });
      return { filePath, lines };
    },
  },
  {
    name: "accept: the config it reused",
    says: ["reused the existing configuration at"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      saveConfig(filePath, {
        connection: { channel: "filedrop", path: "/mnt/share" },
        linkageTerms: sampleTerms("Acceptor Org"),
      });
      const invitation = await encodedInvitation();
      const input = writeInput();
      const lines = await stderrLinesOf(() =>
        acceptHandler(
          argvOf({
            identity: "Agency B",
            args: [invitation, input],
            "consent-to-terms": true,
            "config-file": filePath,
            "key-file": path.join(dir, ".alcove.key"),
          }),
        ),
      );
      return { filePath, lines };
    },
  },
  {
    name: "accept: the config and key file it wrote with no endpoint to seed",
    says: ["fill in the connection block before"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      fs.rmSync(filePath, { force: true });
      const invitation = await encodedInvitation();
      const input = writeInput();
      const lines = await stderrLinesOf(() =>
        acceptHandler(
          argvOf({
            identity: "Agency B",
            args: [invitation, input],
            "consent-to-terms": true,
            "config-file": filePath,
            "key-file": backslashedPath(".alcove.key"),
          }),
        ),
      );
      return { filePath, lines };
    },
  },
  {
    name: "accept: the key file it wrote",
    says: ["wrote key file to"],
    drive: async () => {
      const filePath = backslashedPath(".alcove.key");
      const invitation = await encodedInvitation();
      const input = writeInput();
      const lines = await stderrLinesOf(() =>
        acceptHandler(
          argvOf({
            identity: "Agency B",
            args: [invitation, input],
            "consent-to-terms": true,
            "config-file": backslashedPath("alcove.yaml"),
            "key-file": filePath,
          }),
        ),
      );
      return { filePath, lines };
    },
  },
  {
    name: "accept: the config it seeded from a webrtc endpoint",
    says: ["it needs no credentials of your own"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      // No input file: an acceptance that names one runs the exchange through
      // the endpoint instead of writing a configuration to run later.
      const invitation = await encodedInvitation({
        channel: "webrtc",
        host: "peers.example.org",
        path: "/psi",
      });
      const lines = await stderrLinesOf(() =>
        acceptHandler(
          argvOf({
            identity: "Agency B",
            args: [invitation],
            "consent-to-terms": true,
            "config-file": filePath,
            "key-file": path.join(dir, ".alcove.key"),
          }),
        ),
      );
      return { filePath, lines };
    },
  },
  {
    name: "accept: the config it seeded from an sftp endpoint",
    says: ["review it and add your own credentials"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      const invitation = await encodedInvitation({
        channel: "sftp",
        host: "sftp.example.org",
        path: "/drop",
      });
      const input = writeInput();
      const lines = await stderrLinesOf(() =>
        acceptHandler(
          argvOf({
            identity: "Agency B",
            args: [invitation, input],
            "consent-to-terms": true,
            "config-file": filePath,
            "key-file": path.join(dir, ".alcove.key"),
          }),
        ),
      );
      return { filePath, lines };
    },
  },
];

for (const { name, says, drive } of COMMAND_LINES)
  test(`${name} names the path as the operator typed it`, async () => {
    expectPathAsTyped(await drive(), says);
  });

/** A dual-signed record between two parties, written under the fixture dir. */
async function writeSignedRecord(filePath: string): Promise<void> {
  const content: ReceiptContent = {
    termsHash: "dGVybXNIYXNo",
    initiatorToResponderPayload: "aTJyUGF5bG9hZA",
    responderToInitiatorPayload: "cjJpUGF5bG9hZA",
    binder: "YmluZGVy",
  };
  const initiator = await generateSigningIdentity("Party A");
  const responder = await generateSigningIdentity("Party B");
  fs.writeFileSync(
    filePath,
    serializeDualSignedRecord({
      version: SIGNED_RECEIPT_VERSION,
      content,
      initiator: {
        certificate: initiator.certificate,
        signature: await signReceiptContent(initiator, content, "initiator"),
      },
      responder: {
        certificate: responder.certificate,
        signature: await signReceiptContent(responder, content, "responder"),
      },
    }),
  );
}

/** Verify a dual-signed record against a config naming `identityFile`. */
async function verifyReceiptWithConfiguredIdentity(
  identityFile: string,
): Promise<string[]> {
  const configFile = path.join(dir, "alcove.yaml");
  fs.writeFileSync(
    configFile,
    YAML.stringify({ signing: { identity_file: identityFile } }),
  );
  const record = path.join(dir, "receipt.json");
  await writeSignedRecord(record);
  return await stderrLinesOf(() =>
    verifyReceiptHandler(argvOf({ record, "config-file": configFile })),
  );
}

const MORE_COMMAND_LINES: readonly SinkCase<LineOutcome>[] = [
  {
    name: "fingerprint: an identity file created and removed under it",
    says: ["is being created and removed concurrently"],
    drive: async () => {
      // A dangling symlink holds the condition the retry bound answers: the
      // exclusive create refuses the link as a name already taken, while the
      // read through it finds nothing.
      const filePath = backslashedPath("identity.json");
      fs.symlinkSync(path.join(dir, "gone.json"), filePath);
      const thrown = await raised(() =>
        resolveSigningIdentity({
          identityPath: filePath,
          identityArg: "Test Party",
          force: false,
          log: stubLog().log,
        }),
      );
      return { filePath, lines: [sanitizeErrorForDisplay(thrown)] };
    },
  },
  {
    name: "fingerprint: the identity file it wrote",
    says: ["signing identity"],
    drive: async () => {
      const filePath = backslashedPath("identity.json");
      const lines = await stderrLinesOf(() =>
        fingerprintHandler(
          argvOf({
            "identity-file": filePath,
            identity: "Test Party",
            force: false,
          }),
        ),
      );
      return { filePath, lines };
    },
  },
  {
    name: "fingerprint: an --export-certificate path that is the identity file",
    says: ["is the signing identity file itself"],
    drive: async () => {
      const filePath = backslashedPath("identity.json");
      const lines = await stderrLinesOf(() =>
        fingerprintHandler(
          argvOf({
            "identity-file": filePath,
            "export-certificate": filePath,
            identity: "Test Party",
            force: false,
          }),
        ),
      );
      return { filePath, lines };
    },
  },
  {
    name: "fingerprint: an --export-certificate path it could not write",
    says: ["could not write certificate to"],
    relaysPathAgain: true,
    drive: async () => {
      const filePath = backslashedPath("exported");
      fs.mkdirSync(filePath);
      const lines = await stderrLinesOf(() =>
        fingerprintHandler(
          argvOf({
            "identity-file": backslashedPath("identity.json"),
            "export-certificate": filePath,
            identity: "Test Party",
            force: false,
          }),
        ),
      );
      return { filePath, lines };
    },
  },
  {
    name: "invite: a --linkage-strategy the config's own terms override",
    says: ["Edit linkage_strategy in"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      saveConfig(filePath, {
        connection: { channel: "filedrop", path: "/mnt/share" },
        linkageTerms: sampleTerms("Agency A"),
      });
      const { log, lines } = stubLog();
      await validateInvite({
        resolved: { mode: "offline", input: writeInput() },
        options: bootstrapOptions({
          identity: "Agency A",
          configFile: filePath,
          keyFile: path.join(dir, ".alcove.key"),
        }),
        acceptTimeout: 900,
        linkageStrategy: "single-pass",
        log,
      });
      return { filePath, lines };
    },
  },
  {
    name: "invite: the config an input is checked against",
    says: ["checking the input file"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      saveConfig(filePath, {
        connection: { channel: "filedrop", path: "/mnt/share" },
        linkageTerms: sampleTerms("Agency A"),
      });
      const { log, lines } = stubLog();
      await validateInvite({
        resolved: { mode: "offline", input: writeInput() },
        options: bootstrapOptions({
          identity: "Agency A",
          configFile: filePath,
          keyFile: path.join(dir, ".alcove.key"),
        }),
        acceptTimeout: 900,
        log,
      });
      return { filePath, lines };
    },
  },
  {
    name: "invite: the config the terms come from with no input named",
    says: ["deriving the invitation's linkage terms from it."],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      saveConfig(filePath, {
        connection: { channel: "filedrop", path: "/mnt/share" },
        linkageTerms: sampleTerms("Agency A"),
      });
      const { log, lines } = stubLog();
      await validateInvite({
        resolved: { mode: "offline", input: undefined },
        options: bootstrapOptions({
          identity: "Agency A",
          configFile: filePath,
          keyFile: path.join(dir, ".alcove.key"),
        }),
        acceptTimeout: 900,
        log,
      });
      return { filePath, lines };
    },
  },
  {
    name: "invite: the config and key file an offline mint wrote",
    says: ["wrote config to", "fill in the connection block in"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      const input = writeInput();
      const lines = await stderrLinesOf(() =>
        inviteHandler(
          argvOf({
            identity: "Agency A",
            args: [input],
            "config-file": filePath,
            "key-file": backslashedPath(".alcove.key"),
          }),
        ),
      );
      return { filePath, lines };
    },
  },
  {
    name: "invite: the key file an offline mint wrote beside a kept config",
    says: [
      "derived the invitation's linkage terms from",
      "ensure the connection block in",
    ],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      saveConfig(filePath, {
        connection: { channel: "filedrop", path: "/mnt/share" },
        linkageTerms: sampleTerms("Agency A"),
      });
      const input = writeInput();
      const lines = await stderrLinesOf(() =>
        inviteHandler(
          argvOf({
            identity: "Agency A",
            args: [input],
            "config-file": filePath,
            "key-file": backslashedPath(".alcove.key"),
          }),
        ),
      );
      return { filePath, lines };
    },
  },
  {
    name: "init: the file it left alone at the prompt",
    says: ["Overwrite", "left the existing file at"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      fs.writeFileSync(filePath, "");
      const lines = await stderrLinesOf(() =>
        withStdin(answeringTtyStream("n"), () =>
          initHandler(argvOf({ "config-file": filePath })),
        ),
      );
      return { filePath, lines };
    },
  },
  {
    name: "init: the template it wrote",
    says: ["wrote a configuration template to"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      const lines = await stderrLinesOf(() =>
        initHandler(argvOf({ "config-file": filePath })),
      );
      return { filePath, lines };
    },
  },
  {
    name: "verify-receipt: a --config-file that does not exist",
    says: ["config file", "does not exist"],
    drive: async () => {
      const filePath = backslashedPath("alcove.yaml");
      const record = path.join(dir, "receipt.json");
      await writeSignedRecord(record);
      const lines = await stderrLinesOf(() =>
        verifyReceiptHandler(argvOf({ record, "config-file": filePath })),
      );
      return { filePath, lines };
    },
  },
  {
    name: "verify-receipt: a --partner-terms file that does not exist",
    says: ["partner-terms file", "does not exist"],
    drive: async () => {
      const filePath = backslashedPath("partner.yaml");
      const record = path.join(dir, "receipt.json");
      await writeSignedRecord(record);
      const lines = await stderrLinesOf(() =>
        verifyReceiptHandler(argvOf({ record, "partner-terms": filePath })),
      );
      return { filePath, lines };
    },
  },
  {
    name: "verify-receipt: a --partner-terms file defining no linkage terms",
    says: ["defines no linkage_terms"],
    drive: async () => {
      const filePath = backslashedPath("partner.yaml");
      fs.writeFileSync(filePath, YAML.stringify({ connection: {} }));
      const record = path.join(dir, "receipt.json");
      await writeSignedRecord(record);
      const lines = await stderrLinesOf(() =>
        verifyReceiptHandler(argvOf({ record, "partner-terms": filePath })),
      );
      return { filePath, lines };
    },
  },
  {
    name: "verify-receipt: an --identity-file that does not exist",
    says: ["signing identity file", "does not exist"],
    drive: async () => {
      const filePath = backslashedPath("identity.json");
      const record = path.join(dir, "receipt.json");
      await writeSignedRecord(record);
      const lines = await stderrLinesOf(() =>
        verifyReceiptHandler(argvOf({ record, "identity-file": filePath })),
      );
      return { filePath, lines };
    },
  },
  {
    name: "verify-receipt: a configured signing identity that does not exist",
    says: ["named by the configuration's signing.identity_file", "anchors no"],
    drive: async () => {
      const filePath = backslashedPath("identity.json");
      return {
        filePath,
        lines: await verifyReceiptWithConfiguredIdentity(filePath),
      };
    },
  },
  {
    name: "verify-receipt: a configured signing identity it could not read",
    says: ["could not be read, so it anchors"],
    drive: async () => {
      const filePath = backslashedPath("identity.json");
      fs.writeFileSync(filePath, "{ not json");
      return {
        filePath,
        lines: await verifyReceiptWithConfiguredIdentity(filePath),
      };
    },
  },
  {
    name: "verify-receipt: a dual-signed record named beside --signed-record",
    says: ["is already a dual-signed record"],
    drive: async () => {
      const filePath = backslashedPath("receipt.json");
      await writeSignedRecord(filePath);
      const lines = await stderrLinesOf(() =>
        verifyReceiptHandler(
          argvOf({ record: filePath, "signed-record": filePath }),
        ),
      );
      return { filePath, lines };
    },
  },
  {
    name: "verify-receipt: a dual-signed record named beside --keys",
    says: ["which commits to no data"],
    drive: async () => {
      const filePath = backslashedPath("receipt.json");
      await writeSignedRecord(filePath);
      const lines = await stderrLinesOf(() =>
        verifyReceiptHandler(
          argvOf({
            record: filePath,
            keys: path.join(dir, "keys.json"),
            "input-file": path.join(dir, "input.csv"),
            "result-file": path.join(dir, "result.csv"),
          }),
        ),
      );
      return { filePath, lines };
    },
  },
];

for (const { name, says, drive, relaysPathAgain } of MORE_COMMAND_LINES)
  test(`${name} names the path as the operator typed it`, async () => {
    expectPathAsTyped(await drive(), says, relaysPathAgain);
  });

// --- a marker in the path, at a log sink -------------------------------------

// The two warnings about the configured signing identity compose the path ahead
// of the guidance that tells the operator what it cost them, and the log sink's
// private-key strip fails closed from a BEGIN marker to the end of the argument
// it is redacting. Marking the path redacts it where it is composed, so a
// marker the operator spelled in their own path is confined to the path and the
// guidance behind it still arrives.

const DANGLING_MARKER = "-----BEGIN OPENSSH PRIVATE KEY-----";
const REDACTED = "[redacted private key]";

const MARKER_IN_PATH: readonly SinkCase<LineOutcome>[] = [
  {
    name: "verify-receipt: a configured signing identity that does not exist",
    says: ["named by the configuration's signing.identity_file"],
    drive: async () => {
      const filePath = backslashedPath(`${DANGLING_MARKER}identity.json`);
      return {
        filePath,
        lines: await verifyReceiptWithConfiguredIdentity(filePath),
      };
    },
  },
  {
    name: "verify-receipt: a configured signing identity it could not read",
    says: ["could not be read, so it anchors"],
    drive: async () => {
      const filePath = backslashedPath(`${DANGLING_MARKER}identity.json`);
      fs.writeFileSync(filePath, "{ not json");
      return {
        filePath,
        lines: await verifyReceiptWithConfiguredIdentity(filePath),
      };
    },
  },
];

for (const { name, says, drive } of MARKER_IN_PATH)
  test(`${name} keeps its guidance behind a marker in the path`, async () => {
    const { lines } = await drive();
    const text = lines.join("\n");

    expect(text).toContain(REDACTED);
    expect(text).not.toContain("OPENSSH");
    for (const phrase of says) expect(text).toContain(phrase);
  });

const INIT_WRITE_FAILURES: readonly SinkCase<LineOutcome>[] = [
  {
    name: "init: a template path it could not write",
    says: ["could not write"],
    drive: async () => {
      // A write that fails where no earlier check could have seen it: the path
      // held nothing when the overwrite decision was taken.
      const filePath = backslashedPath("alcove.yaml");
      vi.spyOn(fileUtils, "writeFileOwnerOnly").mockImplementationOnce(() => {
        throw new Error("EROFS: read-only file system");
      });
      const lines = await stderrLinesOf(() =>
        initHandler(argvOf({ "config-file": filePath })),
      );
      return { filePath, lines };
    },
  },
  {
    name: "init: a file that appeared after the overwrite check",
    says: ["a file appeared at"],
    drive: async () => {
      // The write finds a file the overwrite decision did not: nothing was at
      // the path when that decision was taken.
      const filePath = backslashedPath("alcove.yaml");
      vi.spyOn(fileUtils, "writeFileOwnerOnly").mockImplementationOnce(() => {
        throw new fileUtils.FileExistsError(filePath);
      });
      const lines = await stderrLinesOf(() =>
        initHandler(argvOf({ "config-file": filePath })),
      );
      return { filePath, lines };
    },
  },
];

for (const { name, says, drive } of INIT_WRITE_FAILURES)
  test(`${name} names the path as the operator typed it`, async () => {
    expectPathAsTyped(await drive(), says);
  });
