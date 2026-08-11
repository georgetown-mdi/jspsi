import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, test } from "vitest";

import {
  EXCHANGE_FILES_DEFAULT,
  ZERO_SETUP_EXCHANGE_FILES,
  exchangeFilesOptions,
} from "@bench/exchangeFilesModel";
import { resolveCliBinaryPath, spawnZeroSetupJob } from "@jobs/cliDriver";
import { zeroSetupFileSyncArgv } from "@jobs/intent";

import { STUB_CLI_PATH, tempDataRoot } from "../utils/jobFixtures";

import type { JobTerminalState } from "@jobs/cliDriver";

// The console's file-handling card and the CLI's own parser, met at the one place
// they touch: the zero-setup argv. The tokens under test are produced by the card's
// model and the intent's argv builder, spawned through the production driver, and
// then handed to the REAL built CLI -- never compared against a hand-written token
// list, which would only assert that this file and the emitter agree about flags the
// CLI may not have (CLAUDE.md: settle a question about an external tool by driving
// it).
//
// apps/web must not import apps/cli (apps consume packages, not each other), so the
// parser is reached the way the appliance reaches it: as a subprocess of the built
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
 * exist is deliberate: every case here fails at the input file, before the CLI opens
 * a transport, so no case can reach a network or a rendezvous. */
const RENDEZVOUS_URL = "file:///srv/jobs/abc/rendezvous";

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

function workdir(label: string): string {
  const dir = tempDataRoot(label);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

/**
 * The zero-setup file-sync tokens the console emits for an operator who switched
 * retain mode on and named this party, taken through the card's own model
 * ({@link exchangeFilesOptions}) and the intent's builder
 * ({@link zeroSetupFileSyncArgv}) rather than written out here.
 */
function retainModeFileSyncArgs(): Array<string> {
  return zeroSetupFileSyncArgv(
    exchangeFilesOptions(
      { ...EXCHANGE_FILES_DEFAULT, retainFiles: true, peerId: "clinic-a" },
      ZERO_SETUP_EXCHANGE_FILES,
    ),
  );
}

/** Await a spawned job's terminal state. */
async function terminalOf(
  spawn: (onTerminal: (state: JobTerminalState) => void) => void,
): Promise<JobTerminalState> {
  const terminalRef: { current: JobTerminalState | null } = { current: null };
  spawn((state) => {
    terminalRef.current = state;
  });
  const deadline = Date.now() + 60_000;
  while (terminalRef.current === null) {
    if (Date.now() > deadline) throw new Error("the child did not exit");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return terminalRef.current;
}

/**
 * Spawn a zero-setup job through the production driver, capturing the exact argv it
 * invoked the child with (the stub's STUB_ARGV_FILE) once the child has exited.
 */
async function captureZeroSetupArgv(
  fileSyncArgs: Array<string>,
): Promise<{ argv: Array<string>; dir: string }> {
  const dir = workdir("zs-argv");
  const argvFile = path.join(dir, "argv.json");
  await terminalOf((onTerminal) =>
    spawnZeroSetupJob({
      binaryPath: STUB_CLI_PATH,
      connectionArgs: [RENDEZVOUS_URL],
      fileSyncArgs,
      inputPath: path.join(dir, "input.csv"),
      outputPath: path.join(dir, "output.csv"),
      recordPath: path.join(dir, "record.json"),
      workdir: dir,
      eventStream: true,
      extraEnv: { STUB_ARGV_FILE: argvFile, STUB_EXIT_CODE: "0" },
      handlers: {
        onEvent: () => undefined,
        onDegraded: () => undefined,
        onTerminal,
      },
    }),
  );
  // argv[0] is node, argv[1] the CLI entry; the driven arguments follow.
  const argv = (
    JSON.parse(fs.readFileSync(argvFile, "utf8")) as Array<string>
  ).slice(2);
  return { argv, dir };
}

/** Run the real CLI over `argv` and report what its parser did with it. */
function parseWithRealCli(
  argv: Array<string>,
  cwd: string,
): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...argv], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, stderr: result.stderr };
}

describe("the console's zero-setup argv is accepted by the CLI's own parser", () => {
  test("every emitted file-sync token survives a real parse", async () => {
    const fileSyncArgs = retainModeFileSyncArgs();
    // The card's model resolves retain mode's implications, so the emitted set is
    // the trio plus the party name -- the argv the appliance really builds.
    expect(fileSyncArgs.length).toBe(4);
    const { argv, dir } = await captureZeroSetupArgv(fileSyncArgs);

    // Where the driver put them: after the connection positional and ahead of the
    // record flag and the trailing input/output positionals.
    expect(argv[0]).toBe(RENDEZVOUS_URL);
    expect(argv.slice(1, 1 + fileSyncArgs.length)).toEqual(fileSyncArgs);
    expect(argv[argv.length - 2].endsWith("input.csv")).toBe(true);
    expect(argv[argv.length - 1].endsWith("output.csv")).toBe(true);

    const parsed = parseWithRealCli(argv, dir);
    // The parser took every token: no unknown-option refusal, and not the usage
    // exit it takes on one (the negative control below drives that path).
    expect(parsed.stderr).not.toContain("Unknown argument");
    expect(parsed.status).not.toBe(EXIT_USAGE);
    // Parsing ran to completion rather than short-circuiting: the run reached the
    // input file, which this argv deliberately does not create.
    expect(parsed.stderr).toContain("input.csv does not exist");
  });

  test("a token the parser does not know is refused, so the check above discriminates", async () => {
    const fileSyncArgs = retainModeFileSyncArgs();
    const { argv, dir } = await captureZeroSetupArgv(fileSyncArgs);
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
    // `unexpected_files` only where a configuration document carries it, and a
    // zero-setup run composes none. Were it emitted anyway, the run would not
    // silently drop the operator's choice -- the CLI would refuse the command.
    const { argv, dir } = await captureZeroSetupArgv([
      ...retainModeFileSyncArgs(),
      "--unexpected-files=warn",
    ]);
    const parsed = parseWithRealCli(argv, dir);
    expect(parsed.status).toBe(EXIT_USAGE);
    expect(parsed.stderr).toContain("Unknown arguments: unexpected-files");
  });

  test("the production driver's own spawn of the built CLI parses", async () => {
    const dir = workdir("zs-real");
    const terminal = await terminalOf((onTerminal) =>
      spawnZeroSetupJob({
        binaryPath: CLI_ENTRY,
        connectionArgs: [RENDEZVOUS_URL],
        fileSyncArgs: retainModeFileSyncArgs(),
        inputPath: path.join(dir, "input.csv"),
        outputPath: path.join(dir, "output.csv"),
        recordPath: path.join(dir, "record.json"),
        workdir: dir,
        eventStream: true,
        handlers: {
          onEvent: () => undefined,
          onDegraded: () => undefined,
          onTerminal,
        },
      }),
    );
    // No stub in the middle: the driver assembled the argv and the built CLI
    // parsed it. A rejected token would have exited usage instead.
    expect(terminal.exitCode).not.toBe(EXIT_USAGE);
    expect(terminal.outcome).toBe("failed");
  });
});
