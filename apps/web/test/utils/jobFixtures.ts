import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

import { getDefaultLinkageTerms } from "@psilink/core";
import { parse as parseYaml } from "yaml";

import { spawnExchangeJob, spawnZeroSetupJob } from "@jobs/cliDriver";

import type { CliRunControls, JobTerminalState } from "@jobs/cliDriver";
import type {
  JobFiledropExchangeIntent,
  JobInputFileReference,
  JobSftpExchangeIntent,
  JobZeroSetupFiledropIntent,
  JobZeroSetupSftpIntent,
} from "@jobs/intent";
import type { JobSftpServerEntry } from "@jobs/sftpServer";
import type { LinkageTerms } from "@psilink/core";

/** The stub CLI the driver tests point JOB_CLI_BINARY at. */
export const STUB_CLI_PATH = fileURLToPath(
  new URL("./stubCli.mjs", import.meta.url),
);

/** A base64url shared secret matching the CLI key-file shape (43 chars). */
export const VALID_SHARED_SECRET = "A".repeat(42) + "A";

/** A complete, schema-valid linkage-terms document for job intents. */
export function validLinkageTerms(): LinkageTerms {
  return {
    ...getDefaultLinkageTerms("test-org"),
    date: "2026-07-11",
  };
}

/** A valid filedrop job intent; overrides merge over the base. */
export function validIntent(
  overrides: Partial<JobFiledropExchangeIntent> = {},
): JobFiledropExchangeIntent {
  return {
    channel: "filedrop",
    linkageTerms: validLinkageTerms(),
    sharedSecret: VALID_SHARED_SECRET,
    inputCsv: "ssn,last_name,date_of_birth\n111223333,smith,1990-01-01\n",
    ...overrides,
  };
}

/** A static, schema-valid `inputFile` reference for the pure intent-schema tests
 * (no file on disk; the manager tests build a real one). */
export const SAMPLE_INPUT_FILE_REF: JobInputFileReference = {
  name: "input.csv",
};

/** A valid filedrop job intent driven by a mounted `inputFile` reference (no inline
 * `inputCsv`); overrides merge over the base. */
export function validInputFileIntent(
  inputFile: JobInputFileReference = SAMPLE_INPUT_FILE_REF,
  overrides: Partial<JobFiledropExchangeIntent> = {},
): JobFiledropExchangeIntent {
  return {
    channel: "filedrop",
    linkageTerms: validLinkageTerms(),
    sharedSecret: VALID_SHARED_SECRET,
    inputFile,
    ...overrides,
  };
}

/** A would-be remote-name string, used only by the tests that assert a sent
 * `remote` field is rejected as an unknown key (the sftp arm has none). */
export const TEST_SFTP_REMOTE_NAME = "prod_east";

/** A canonical-format host-key fingerprint (43 standard base64 chars). */
export const TEST_HOST_KEY_FINGERPRINT = `SHA256:${"A".repeat(43)}`;

/** A valid sftp job intent (no connection field); overrides merge over it. */
export function validSftpIntent(
  overrides: Partial<JobSftpExchangeIntent> = {},
): JobSftpExchangeIntent {
  return {
    channel: "sftp",
    linkageTerms: validLinkageTerms(),
    sharedSecret: VALID_SHARED_SECRET,
    inputCsv: "ssn,last_name,date_of_birth\n111223333,smith,1990-01-01\n",
    ...overrides,
  };
}

/** A sample SFTP server entry (an @path credential, a pinned fingerprint) for the
 * compose/argv tests that take an entry directly. */
export function testSftpServerEntry(): JobSftpServerEntry {
  return {
    host: "sftp.example.org",
    port: 2222,
    username: "linkage",
    path: "/exchange",
    password: "@/etc/psilink/prod-east-password",
    hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
  };
}

/** The same entry with a SPLIT remote directory (separate inbound and outbound
 * folders) in place of the single shared `path`. */
export function testSplitSftpServerEntry(): JobSftpServerEntry {
  const { path: _shared, ...rest } = testSftpServerEntry();
  return {
    ...rest,
    inboundPath: "/exchange/in",
    outboundPath: "/exchange/out",
  };
}

/** A valid filedrop zero-setup intent (no shared secret, no linkage terms);
 * overrides merge over the base. */
export function validZeroSetupIntent(
  overrides: Partial<JobZeroSetupFiledropIntent> = {},
): JobZeroSetupFiledropIntent {
  return {
    mode: "zeroSetup",
    channel: "filedrop",
    inputCsv: "ssn,last_name,date_of_birth\n111223333,smith,1990-01-01\n",
    ...overrides,
  };
}

/** A valid sftp zero-setup intent (no connection field, no secret/terms);
 * overrides merge over it. */
export function validZeroSetupSftpIntent(
  overrides: Partial<JobZeroSetupSftpIntent> = {},
): JobZeroSetupSftpIntent {
  return {
    mode: "zeroSetup",
    channel: "sftp",
    inputCsv: "ssn,last_name,date_of_birth\n111223333,smith,1990-01-01\n",
    ...overrides,
  };
}

/** A throwaway data-root directory path unique per call (not created here). */
export function tempDataRoot(label: string): string {
  return path.join(
    process.env.TMPDIR ?? "/tmp",
    `psilink-jobs-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

/**
 * The composed psilink.yaml's `connection.server` block, read as data.
 *
 * Parsed rather than string-matched because the emitter folds a long scalar
 * across lines: a credential ref rooted under a long TMPDIR -- macOS hands out
 * `/var/folders/<...>/T`, where these fixtures put their temp dirs -- is written
 * with a line break mid-path, so `toContain(ref)` fails on a config that is in
 * fact correct. Parsing also makes the assertion exact, where a substring match
 * would accept the value appearing anywhere under any key. Assertions that a
 * secret does NOT appear should stay on the raw text, where a leak anywhere in
 * the file is what matters.
 */
export function composedServer(composed: string): Record<string, unknown> {
  const parsed = parseYaml(composed) as {
    connection?: { server?: Record<string, unknown> };
  };
  const server = parsed.connection?.server;
  if (server === undefined)
    throw new Error("composed psilink.yaml has no connection.server");
  return server;
}

/** The `connection` block of a composed `psilink.yaml`, for the filedrop channel's
 * assertions (which hold their directories at the top level rather than under a
 * `server` block). */
export function composedConnection(composed: string): Record<string, unknown> {
  const parsed = parseYaml(composed) as {
    connection?: Record<string, unknown>;
  };
  const connection = parsed.connection;
  if (connection === undefined)
    throw new Error("composed psilink.yaml has no connection");
  return connection;
}

/** How long {@link awaitJobTerminalState} waits for a spawned child to exit. The
 * stub exits in milliseconds; a caller driving the real built CLI, whose startup
 * dominates, passes a longer bound. */
const CHILD_EXIT_TIMEOUT_MS = 5_000;

/**
 * Await the terminal state of a job spawned through a `cliDriver` entry point.
 *
 * `spawn` is handed the driver's `onTerminal` callback and is expected to start
 * the child synchronously; the promise resolves once the driver reconciles the
 * exit. Past `timeoutMs` the wait fails rather than hanging the suite.
 */
export async function awaitJobTerminalState(
  spawn: (onTerminal: (state: JobTerminalState) => void) => void,
  timeoutMs: number = CHILD_EXIT_TIMEOUT_MS,
): Promise<JobTerminalState> {
  // A wrapper object, not a bare local: the terminal is set from the driver's
  // callback, which TypeScript's control-flow analysis would otherwise narrow a
  // local `null` past, making the poll condition read as always-true.
  const terminalRef: { current: JobTerminalState | null } = { current: null };
  spawn((state) => {
    terminalRef.current = state;
  });
  const deadline = Date.now() + timeoutMs;
  while (terminalRef.current === null) {
    if (Date.now() > deadline) throw new Error("the child did not exit");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return terminalRef.current;
}

/**
 * The {@link captureZeroSetupArgv} counterpart for the exchange invocation: spawn
 * the stub CLI through {@link spawnExchangeJob} and return the exact argv the
 * driver invoked it with.
 */
export async function captureExchangeArgv(args: {
  workdir: string;
  eventStream: boolean;
  runControls?: CliRunControls;
  timeoutMs?: number;
}): Promise<Array<string>> {
  const { workdir } = args;
  const argvFile = path.join(workdir, "argv.json");
  await awaitJobTerminalState(
    (onTerminal) =>
      spawnExchangeJob({
        binaryPath: STUB_CLI_PATH,
        configPath: path.join(workdir, "psilink.yaml"),
        keyPath: path.join(workdir, ".psilink.key"),
        inputPath: path.join(workdir, "input.csv"),
        outputPath: path.join(workdir, "output.csv"),
        recordPath: path.join(workdir, "record.json"),
        workdir,
        eventStream: args.eventStream,
        runControls: args.runControls ?? {
          sweepExchangeFiles: false,
          logFilePath: undefined,
        },
        extraEnv: { STUB_ARGV_FILE: argvFile, STUB_EXIT_CODE: "0" },
        handlers: {
          onEvent: () => undefined,
          onDegraded: () => undefined,
          onTerminal,
        },
      }),
    args.timeoutMs,
  );
  return (JSON.parse(fs.readFileSync(argvFile, "utf8")) as Array<string>).slice(
    2,
  );
}

/**
 * Spawn the stub CLI through {@link spawnZeroSetupJob} and return the exact argv
 * the driver invoked it with, read back from the stub's `STUB_ARGV_FILE` once the
 * child has exited -- so a test asserts the driven argv rather than a
 * hand-written one.
 *
 * `workdir` is the caller's scratch directory: the child's cwd, the home of the
 * input/output/record paths and of the argv file, and the caller's to remove.
 */
export async function captureZeroSetupArgv(args: {
  workdir: string;
  connectionArgs: Array<string>;
  optionArgs?: Array<string>;
  eventStream: boolean;
  identity?: string;
  linkageStrategy?: "cascade" | "single-pass";
  /** The run's diagnostic/recovery controls; defaults to neither, the shape
   * every caller predating them drives. */
  runControls?: CliRunControls;
  timeoutMs?: number;
}): Promise<Array<string>> {
  const { workdir } = args;
  const argvFile = path.join(workdir, "argv.json");
  await awaitJobTerminalState(
    (onTerminal) =>
      spawnZeroSetupJob({
        binaryPath: STUB_CLI_PATH,
        connectionArgs: args.connectionArgs,
        optionArgs: args.optionArgs ?? [],
        inputPath: path.join(workdir, "input.csv"),
        outputPath: path.join(workdir, "output.csv"),
        recordPath: path.join(workdir, "record.json"),
        workdir,
        eventStream: args.eventStream,
        runControls: args.runControls ?? {
          sweepExchangeFiles: false,
          logFilePath: undefined,
        },
        ...(args.identity !== undefined ? { identity: args.identity } : {}),
        ...(args.linkageStrategy !== undefined
          ? { linkageStrategy: args.linkageStrategy }
          : {}),
        extraEnv: { STUB_ARGV_FILE: argvFile, STUB_EXIT_CODE: "0" },
        handlers: {
          onEvent: () => undefined,
          onDegraded: () => undefined,
          onTerminal,
        },
      }),
    args.timeoutMs,
  );
  // argv[0] is node, argv[1] the CLI entry; the driven arguments follow.
  return (JSON.parse(fs.readFileSync(argvFile, "utf8")) as Array<string>).slice(
    2,
  );
}
