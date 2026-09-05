import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, test } from "vitest";

import { MAX_RECONNECT_ATTEMPTS, MAX_TIMEOUT_SECONDS } from "@psilink/core";

import {
  CONNECTION_TUNING_DEFAULT,
  SFTP_CONNECTION_TUNING,
  connectionTuningOptions,
  connectionTuningProblems,
} from "@console/connectionTuningModel";
import {
  EXCHANGE_FILES_DEFAULT,
  ZERO_SETUP_EXCHANGE_FILES,
  exchangeFilesOptions,
} from "@console/exchangeFilesModel";
import { resolveCliBinaryPath, spawnZeroSetupJob } from "@jobs/cliDriver";
import {
  zeroSetupFiledropArgv,
  zeroSetupOptionsArgv,
  zeroSetupSftpArgv,
} from "@jobs/intentArgv";

import {
  awaitJobTerminalState,
  captureExchangeArgv,
  captureZeroSetupArgv,
  tempDataRoot,
  testSplitSftpServerEntry,
} from "../utils/jobFixtures";

// The console's authoring cards and the CLI's own parser, met where they touch:
// the argv the console drives -- the zero-setup form throughout, and the exchange
// form for the per-run controls both hold. The tokens under test are produced by
// the cards' models and the intent's argv builder, spawned through the production
// driver, and handed to the real built CLI -- never compared against a hand-written
// token list (CLAUDE.md: settle a question about an external tool by driving it).
//
// apps/web must not import apps/cli (apps consume packages, not each other), so the
// parser is reached the way the console reaches it: as a subprocess of the built
// binary.

/** The built CLI the console spawns in production -- resolved through the driver's
 * own resolver, so this suite drives the exact entry a console run would. */
const CLI_ENTRY = resolveCliBinaryPath({});

/** The repo root, from the resolved `apps/cli/dist/index.js`. */
const REPO_ROOT = path.resolve(path.dirname(CLI_ENTRY), "..", "..", "..");

const CLI_SOURCE_DIR = path.join(REPO_ROOT, "apps", "cli", "src");

const BUILD_ARGS = ["run", "build", "-w", "apps/cli"];

/** The CLI's usage exit (EX_USAGE), which its parser takes on an unknown option. */
const EXIT_USAGE = 64;

/** The connection portion of a filedrop zero-setup argv. A directory that does not
 * exist is by design: every case here fails at the input file, before the CLI opens
 * a transport, so no case can reach a network or a rendezvous. */
const RENDEZVOUS_URL = "file:///srv/jobs/abc/rendezvous";

/** The wait for a spawned child's terminal state here: generous next to the stub's
 * near-instant exit, because the same bound covers the real CLI's cold start. */
const CHILD_EXIT_TIMEOUT_MS = 60_000;

/**
 * The budget for every test below: vitest's 5s default is the wrong scale,
 * since each spawns up to two sequential real node children -- the stub, then
 * the built CLI, whose ~1MB bundle every spawn parses afresh -- where a
 * sibling unit test only calls a function. Sized above the sum both spawns of
 * one test may legitimately take, so a stalled child's own
 * {@link CHILD_EXIT_TIMEOUT_MS} always fires and names it, set on the suite
 * rather than each test so a test added later cannot silently fall back to
 * the 5s default.
 */
const SPAWNS_PER_TEST = 2;
const SPAWN_TEST_TIMEOUT_MS = SPAWNS_PER_TEST * CHILD_EXIT_TIMEOUT_MS + 10_000;

/** The newest mtime under `dir`, so a dist built before the last source edit is
 * rebuilt rather than silently parsed as though it were current. */
function newestMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const at = entry.isDirectory()
      ? newestMtimeMs(full)
      : fs.statSync(full).mtimeMs;
    if (at > newest) newest = at;
  }
  return newest;
}

/**
 * Build the CLI when its dist is absent or older than its sources. Building here
 * rather than gating on the artifact keeps this suite from turning into a silent
 * skip: a run without the built CLI would otherwise report a pass with the parser
 * -- the whole point of the file -- never driven.
 *
 * The budget here is the build's, and sized for one: a from-scratch rollup of the
 * CLI runs to a minute or more on a loaded machine. It buys the tests nothing --
 * vitest bounds a hook separately from the tests it precedes, so the first spawn
 * below answers to {@link SPAWN_TEST_TIMEOUT_MS} like every other.
 */
beforeAll(() => {
  const built = fs.existsSync(CLI_ENTRY)
    ? fs.statSync(CLI_ENTRY).mtimeMs
    : undefined;
  if (built !== undefined && built >= newestMtimeMs(CLI_SOURCE_DIR)) return;
  execFileSync("npm", BUILD_ARGS, {
    cwd: REPO_ROOT,
    stdio: "pipe",
    // npm is a .cmd shim on Windows, which execFile cannot launch directly.
    shell: process.platform === "win32",
  });
  if (!fs.existsSync(CLI_ENTRY))
    throw new Error(
      `npm ${BUILD_ARGS.join(" ")} produced no CLI at ${CLI_ENTRY}`,
    );
}, 300_000);

const dirs: Array<string> = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

/** A scratch directory for one spawn, removed after the test. */
function scratchDir(label: string): string {
  const dir = tempDataRoot(label);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

/**
 * The zero-setup file-sync tokens the console emits for an operator who switched
 * retain mode on and named this party, taken through the card's own model
 * ({@link exchangeFilesOptions}) and the intent's builder
 * ({@link zeroSetupOptionsArgv}) rather than written out here.
 */
function retainModeFileSyncArgs(): Array<string> {
  return zeroSetupOptionsArgv(
    exchangeFilesOptions(
      { ...EXCHANGE_FILES_DEFAULT, retainFiles: true, peerId: "clinic-a" },
      ZERO_SETUP_EXCHANGE_FILES,
    ),
  );
}

/**
 * The zero-setup connection-tuning tokens the console emits for an operator who
 * tuned every setting the card offers, taken through the card's own model
 * ({@link connectionTuningOptions}) and the intent's builder
 * ({@link zeroSetupOptionsArgv}) rather than written out here. The units are the
 * card's, not this file's: whether a millisecond poll interval and a
 * seconds-scaled timeout are grammars the CLI's own duration flags accept is
 * exactly what the parse below decides.
 */
function tunedOptionArgs(): Array<string> {
  return zeroSetupOptionsArgv(
    connectionTuningOptions(
      {
        ...CONNECTION_TUNING_DEFAULT,
        pollInterval: { magnitude: "10", unit: "m" },
        peerTimeout: { magnitude: "2", unit: "h" },
        serverConnectTimeout: { magnitude: "45", unit: "s" },
        maxReconnectAttempts: "12",
        connectionPerPoll: true,
      },
      SFTP_CONNECTION_TUNING,
    ),
  );
}

/**
 * Capture the argv the driver spawns a filedrop zero-setup run with, in a fresh
 * scratch directory the parse step below then runs the real CLI in.
 */
async function captureFiledropArgv(
  optionArgs: Array<string>,
): Promise<{ argv: Array<string>; dir: string }> {
  const dir = scratchDir("zs-argv");
  const argv = await captureZeroSetupArgv({
    workdir: dir,
    connectionArgs: [RENDEZVOUS_URL],
    optionArgs,
    eventStream: true,
    timeoutMs: CHILD_EXIT_TIMEOUT_MS,
  });
  return { argv, dir };
}

/**
 * The connection portion of a split-directory sftp zero-setup argv, built by the
 * intent's own {@link zeroSetupSftpArgv}, plus the scratch directory it is run
 * in. The credential `@path` points at a file written there: the CLI resolves an
 * `@`-reference during config assembly, so an entry pointing at a missing file
 * ends the run before the parser verdict these tests are after. The host is
 * `.invalid` (RFC 6761) and no case reaches a transport, so nothing dials.
 */
function splitSftpConnection(): { dir: string; connectionArgs: Array<string> } {
  const dir = scratchDir("zs-split");
  const credentialPath = path.join(dir, "server-password");
  fs.writeFileSync(credentialPath, "not-used-by-a-parse\n");
  return {
    dir,
    connectionArgs: zeroSetupSftpArgv({
      ...testSplitSftpServerEntry(),
      host: "sftp.partner.invalid",
      password: `@${credentialPath}`,
    }),
  };
}

/** Run the real CLI over `argv` and report what its parser did with it. */
function parseWithRealCli(
  argv: Array<string>,
  cwd: string,
): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...argv], {
    cwd,
    encoding: "utf8",
    timeout: CHILD_EXIT_TIMEOUT_MS,
  });
  return { status: result.status, stderr: result.stderr };
}

describe(
  "the console's zero-setup argv is accepted by the CLI's own parser",
  { timeout: SPAWN_TEST_TIMEOUT_MS },
  () => {
    test("every emitted file-sync token survives a real parse", async () => {
      const optionArgs = retainModeFileSyncArgs();
      // The card's model resolves retain mode's implications, so the emitted set is
      // the trio plus the party name -- the argv the console really builds.
      expect(optionArgs.length).toBe(4);
      const { argv, dir } = await captureFiledropArgv(optionArgs);

      // Where the driver put them: after the connection positional and ahead of the
      // record flag and the trailing input/output positionals.
      expect(argv[0]).toBe(RENDEZVOUS_URL);
      expect(argv.slice(1, 1 + optionArgs.length)).toEqual(optionArgs);
      expect(argv[argv.length - 2].endsWith("input.csv")).toBe(true);
      expect(argv[argv.length - 1].endsWith("output.csv")).toBe(true);

      const parsed = parseWithRealCli(argv, dir);
      // The parser took every token: no unknown-option refusal, and not the usage
      // exit it takes on one (the negative control below drives that path).
      expect(parsed.stderr).not.toContain("Unknown argument");
      expect(parsed.status).not.toBe(EXIT_USAGE);
      // Parsing ran to completion rather than short-circuiting: the run reached the
      // input file, which this argv does not create.
      expect(parsed.stderr).toContain("input.csv does not exist");
    });

    test("the diagnostic-run and sweep tokens survive a real parse on the exchange form too", async () => {
      // The per-run controls ride BOTH invocation forms, and the two commands
      // declare their options separately, so the exchange form gets the same
      // verdict from the same parser rather than inheriting the zero-setup one.
      const dir = scratchDir("ex-diag");
      const logFilePath = path.join(dir, "run.log");
      const argv = await captureExchangeArgv({
        workdir: dir,
        eventStream: true,
        runControls: { sweepExchangeFiles: true, logFilePath },
        timeoutMs: CHILD_EXIT_TIMEOUT_MS,
      });
      expect(argv[0]).toBe("exchange");

      const parsed = parseWithRealCli(argv, dir);
      expect(parsed.stderr).not.toContain("Unknown argument");
      // Parsing ran to completion: the run reached the config file this argv
      // does not create, and reported it into the log file the diagnostic
      // tokens pointed the CLI at rather than to stderr.
      expect(fs.readFileSync(logFilePath, "utf8")).toContain(
        "psilink.yaml does not exist",
      );
    });

    test("the diagnostic-run and sweep tokens survive a real parse", async () => {
      // The per-run controls reach the child as CLI flags and nothing else, so
      // whether `--log-level=debug --verbose --log-file=<path>` and
      // `--sweep-exchange-files` are tokens this command accepts is the tool's
      // answer to give. The log file is written where a real diagnostic run
      // writes it: inside the job's own workdir, which this scratch dir stands
      // for.
      const dir = scratchDir("zs-diag");
      const logFilePath = path.join(dir, "run.log");
      const argv = await captureZeroSetupArgv({
        workdir: dir,
        connectionArgs: [RENDEZVOUS_URL],
        eventStream: true,
        runControls: { sweepExchangeFiles: true, logFilePath },
        timeoutMs: CHILD_EXIT_TIMEOUT_MS,
      });
      expect(argv).toContain("--sweep-exchange-files");
      expect(argv).toContain("--log-level=debug");
      expect(argv).toContain("--verbose");
      expect(argv).toContain(`--log-file=${logFilePath}`);
      // Never the escalation past the retain guard: the console has no control
      // that can produce it, so no argv it builds can hold it.
      expect(argv).not.toContain("--force-retain-sweep");

      const parsed = parseWithRealCli(argv, dir);
      expect(parsed.stderr).not.toContain("Unknown argument");
      expect(parsed.status).not.toBe(EXIT_USAGE);
      // The run reached the input file, so every token parsed -- and the CLI
      // opened the log file it was pointed at rather than refusing the path.
      expect(fs.existsSync(logFilePath)).toBe(true);
      expect(fs.readFileSync(logFilePath, "utf8")).toContain(
        "input.csv does not exist",
      );
    });

    test("every emitted connection-tuning token survives a real parse", async () => {
      // The console composes durations in the units its own controls offer; the
      // CLI's duration flags have two different grammars (only the poll interval
      // takes a millisecond suffix). Whether what the card emits is in each
      // flag's grammar is the tool's answer to give, not this file's.
      const optionArgs = tunedOptionArgs();
      expect(optionArgs).toEqual([
        "--polling-frequency=600000ms",
        "--peer-timeout=7200s",
        "--connection-timeout=45s",
        "--max-reconnect-attempts=12",
        "--connection-per-poll",
      ]);
      const { dir, connectionArgs } = splitSftpConnection();
      const argv = await captureZeroSetupArgv({
        workdir: dir,
        connectionArgs,
        // The split connection the sftp arm authors needs retain mode, which the
        // CLI's own guard enforces, so both cards' tokens ride together here.
        optionArgs: [...retainModeFileSyncArgs(), ...optionArgs],
        eventStream: true,
        timeoutMs: CHILD_EXIT_TIMEOUT_MS,
      });

      const parsed = parseWithRealCli(argv, dir);
      expect(parsed.stderr).not.toContain("Unknown argument");
      expect(parsed.status).not.toBe(EXIT_USAGE);
      // Parsing ran to completion: every duration value was in its flag's
      // grammar, so the run reached the input file this argv does not create.
      expect(parsed.stderr).toContain("input.csv does not exist");
    });

    test("a millisecond value on a coarse duration flag is refused, which is why the schema holds those to whole seconds", async () => {
      // The zero-setup arms refuse a timeout that is not a whole number of
      // seconds because this is what the tool does with the alternative: the
      // coarse grammar has no millisecond unit, so a faithful emission is
      // impossible rather than merely inconvenient.
      const { dir, connectionArgs } = splitSftpConnection();
      const argv = await captureZeroSetupArgv({
        workdir: dir,
        connectionArgs,
        optionArgs: [...retainModeFileSyncArgs(), "--peer-timeout=1500ms"],
        eventStream: true,
        timeoutMs: CHILD_EXIT_TIMEOUT_MS,
      });
      const parsed = parseWithRealCli(argv, dir);
      expect(parsed.status).toBe(EXIT_USAGE);
      expect(parsed.stderr).toContain("--peer-timeout");
    });

    test("the longest wait the card admits survives a real parse", async () => {
      // The console holds its two timeout fields to core's MAX_TIMEOUT_SECONDS
      // because the CLI caps the flags they ride at it. That the ceiling itself
      // is admissible -- the cap being inclusive -- is the tool's answer, not
      // this file's.
      const optionArgs = zeroSetupOptionsArgv(
        connectionTuningOptions(
          {
            ...CONNECTION_TUNING_DEFAULT,
            peerTimeout: {
              magnitude: String(MAX_TIMEOUT_SECONDS / 3600),
              unit: "h",
            },
          },
          SFTP_CONNECTION_TUNING,
        ),
      );
      expect(optionArgs).toEqual([`--peer-timeout=${MAX_TIMEOUT_SECONDS}s`]);
      const { dir, connectionArgs } = splitSftpConnection();
      const argv = await captureZeroSetupArgv({
        workdir: dir,
        connectionArgs,
        optionArgs: [...retainModeFileSyncArgs(), ...optionArgs],
        eventStream: true,
        timeoutMs: CHILD_EXIT_TIMEOUT_MS,
      });

      const parsed = parseWithRealCli(argv, dir);
      expect(parsed.status).not.toBe(EXIT_USAGE);
      expect(parsed.stderr).toContain("input.csv does not exist");
    });

    test.each([
      ["a poll interval of 1ms, the schema's floor", "--polling-frequency=1ms"],
      [
        "a poll interval at Number.MAX_SAFE_INTEGER ms, the schema's ceiling",
        `--polling-frequency=${Number.MAX_SAFE_INTEGER}ms`,
      ],
      ["a retry budget of 0, the schema's floor", "--max-reconnect-attempts=0"],
      [
        "a retry budget of 604800, the schema's ceiling",
        `--max-reconnect-attempts=${MAX_RECONNECT_ATTEMPTS}`,
      ],
    ])(
      // Pins the schema's extreme admitted values against the real parser, so
      // a drift between the schema's bound and the flag grammar's own would
      // show here rather than only at a boundary neither suite drives.
      "%s parses past flag validation",
      async (_label, flag) => {
        const { dir, connectionArgs } = splitSftpConnection();
        const argv = await captureZeroSetupArgv({
          workdir: dir,
          connectionArgs,
          optionArgs: [...retainModeFileSyncArgs(), flag],
          eventStream: true,
          timeoutMs: CHILD_EXIT_TIMEOUT_MS,
        });
        const parsed = parseWithRealCli(argv, dir);
        expect(parsed.stderr).not.toContain("Unknown argument");
        expect(parsed.status).not.toBe(EXIT_USAGE);
        expect(parsed.stderr).toContain("input.csv does not exist");
      },
    );

    test("an hour past that ceiling is a usage error, which is why the card refuses it", async () => {
      // The refusal the console makes at authoring time, driven at the boundary
      // it is about: the card emits no such token, so the over-ceiling one is
      // placed on the argv here to see what the tool does with it.
      const { dir, connectionArgs } = splitSftpConnection();
      const argv = await captureZeroSetupArgv({
        workdir: dir,
        connectionArgs,
        optionArgs: [
          ...retainModeFileSyncArgs(),
          `--peer-timeout=${MAX_TIMEOUT_SECONDS + 3600}s`,
        ],
        eventStream: true,
        timeoutMs: CHILD_EXIT_TIMEOUT_MS,
      });
      const parsed = parseWithRealCli(argv, dir);
      expect(parsed.status).toBe(EXIT_USAGE);
      expect(parsed.stderr).toContain("--peer-timeout");

      // And the console refuses the same value while the operator can still
      // change it, rather than creating a job whose child exits on it.
      const past = {
        ...CONNECTION_TUNING_DEFAULT,
        peerTimeout: {
          magnitude: String(MAX_TIMEOUT_SECONDS / 3600 + 1),
          unit: "h" as const,
        },
      };
      expect(connectionTuningProblems(past).length).toBe(1);
      expect(
        connectionTuningOptions(past, SFTP_CONNECTION_TUNING),
      ).toBeUndefined();
    });

    test("a token the parser does not know is refused, so the check above discriminates", async () => {
      const optionArgs = retainModeFileSyncArgs();
      const { argv, dir } = await captureFiledropArgv(optionArgs);
      const mistyped = argv.map((token) =>
        token === "--retain-files" ? "--retain-file" : token,
      );
      expect(mistyped).not.toEqual(argv);

      const parsed = parseWithRealCli(mistyped, dir);
      expect(parsed.status).toBe(EXIT_USAGE);
      expect(parsed.stderr).toContain("Unknown arguments: retain-file");
    });

    test("the foreign-file policy has no flag, which is why zero-setup withholds it", async () => {
      // The capabilities gate's reason, driven rather than asserted: the card offers
      // `unexpected_files` only where a configuration document holds it, and a
      // zero-setup run composes none. Were it emitted anyway, the run would not
      // silently drop the operator's choice -- the CLI would refuse the command.
      const { argv, dir } = await captureFiledropArgv([
        ...retainModeFileSyncArgs(),
        "--unexpected-files=warn",
      ]);
      const parsed = parseWithRealCli(argv, dir);
      expect(parsed.status).toBe(EXIT_USAGE);
      expect(parsed.stderr).toContain("Unknown arguments: unexpected-files");
    });

    test("a split-directory sftp argv survives a real parse under retain mode", async () => {
      // The console's split-directory mapping, driven rather than asserted: the
      // authored inbound directory rides the URL and the outbound one rides
      // `--outbound-path`, which is what the CLI's own override reads them as.
      const { dir, connectionArgs } = splitSftpConnection();
      expect(connectionArgs[0]).toContain("/exchange/in");
      expect(connectionArgs).toContain("--outbound-path=/exchange/out");

      const argv = await captureZeroSetupArgv({
        workdir: dir,
        connectionArgs,
        optionArgs: retainModeFileSyncArgs(),
        eventStream: true,
        timeoutMs: CHILD_EXIT_TIMEOUT_MS,
      });
      const parsed = parseWithRealCli(argv, dir);
      // The parser took every token, and the run got past the connection
      // overrides to the input file this argv does not create.
      expect(parsed.stderr).not.toContain("Unknown argument");
      expect(parsed.status).not.toBe(EXIT_USAGE);
      expect(parsed.stderr).toContain("input.csv does not exist");
    });

    test("the CLI itself refuses the same split without retain mode", async () => {
      // Why the console states the retain precondition while the operator is
      // still at the controls: the tool's own guard is a hard refusal, and it
      // arrives only once the run has been launched.
      const { dir, connectionArgs } = splitSftpConnection();
      const argv = await captureZeroSetupArgv({
        workdir: dir,
        connectionArgs,
        eventStream: true,
        timeoutMs: CHILD_EXIT_TIMEOUT_MS,
      });
      const parsed = parseWithRealCli(argv, dir);
      expect(parsed.status).toBe(EXIT_USAGE);
      expect(parsed.stderr).toContain("requires retain mode");
    });

    test("a split-directory filedrop argv survives a real parse under retain mode", async () => {
      // The console's split-rendezvous mapping, driven rather than asserted: the
      // inbound mount rides the file:// positional and the outbound one rides
      // `--outbound-path` as a plain absolute directory, which is what the CLI's
      // own override reads them as.
      const dir = scratchDir("zs-filedrop-split");
      const connectionArgs = zeroSetupFiledropArgv(
        path.join(dir, "from-partner"),
        path.join(dir, "to-partner"),
      );
      const argv = await captureZeroSetupArgv({
        workdir: dir,
        connectionArgs,
        optionArgs: retainModeFileSyncArgs(),
        eventStream: true,
        timeoutMs: CHILD_EXIT_TIMEOUT_MS,
      });
      const parsed = parseWithRealCli(argv, dir);
      // The parser took every token, and the run got past the connection
      // overrides to the input file this argv does not create.
      expect(parsed.stderr).not.toContain("Unknown argument");
      expect(parsed.status).not.toBe(EXIT_USAGE);
      expect(parsed.stderr).toContain("input.csv does not exist");
    });

    test("the CLI itself refuses the same filedrop split without retain mode", async () => {
      // Why the console states the retain precondition while the operator is
      // still at the controls: the tool's own guard is a hard refusal, and it
      // arrives only once the run has been launched.
      const dir = scratchDir("zs-filedrop-split-delete");
      const argv = await captureZeroSetupArgv({
        workdir: dir,
        connectionArgs: zeroSetupFiledropArgv(
          path.join(dir, "from-partner"),
          path.join(dir, "to-partner"),
        ),
        eventStream: true,
        timeoutMs: CHILD_EXIT_TIMEOUT_MS,
      });
      const parsed = parseWithRealCli(argv, dir);
      expect(parsed.status).toBe(EXIT_USAGE);
      expect(parsed.stderr).toContain("requires retain mode");
    });

    test("the production driver's own spawn of the built CLI parses", async () => {
      const dir = scratchDir("zs-real");
      const terminal = await awaitJobTerminalState(
        (onTerminal) =>
          spawnZeroSetupJob({
            binaryPath: CLI_ENTRY,
            connectionArgs: [RENDEZVOUS_URL],
            optionArgs: retainModeFileSyncArgs(),
            inputPath: path.join(dir, "input.csv"),
            outputPath: path.join(dir, "output.csv"),
            recordPath: path.join(dir, "record.json"),
            workdir: dir,
            eventStream: true,
            runControls: {
              sweepExchangeFiles: false,
              logFilePath: undefined,
            },
            handlers: {
              onEvent: () => undefined,
              onDegraded: () => undefined,
              onTerminal,
            },
          }),
        CHILD_EXIT_TIMEOUT_MS,
      );
      // No stub in the middle: the driver assembled the argv and the built CLI
      // parsed it. A rejected token would have exited usage instead.
      expect(terminal.exitCode).not.toBe(EXIT_USAGE);
      expect(terminal.outcome).toBe("failed");
    });
  },
);
