import type { Argv, Arguments } from "yargs";
import logLibrary from "loglevel";

import { UsageError, redactAndSanitizeForDisplay } from "@psilink/core";

import { runMountChecks } from "../doctor/mount";
import { runProbe } from "../doctor/probe";
import { readSmbMountInput, readSmbProbeInput } from "../doctor/smbEnvironment";
import type { DoctorReport } from "../doctor/verdict";
import {
  DOCTOR_EXIT_CODE,
  overallOf,
  verdictJson,
  verdictLines,
} from "../doctor/verdict";
import {
  configureLogging,
  exitWithError,
  logLevelFlag,
  parseOrExit,
  singleValue,
} from "../util/cli";

// `psilink doctor` answers "why did the file drop not work" before an exchange
// is attempted: `doctor probe` checks over the network as smbclient sees it,
// `doctor mount` through the kernel as a mounted folder. Connection inputs come
// from the SMB_* environment, never flags, so a password never becomes an argv
// value. Full behavior and the `--json` verdict contract: docs/CLI.md,
// "Checking a network file drop", and docs/spec/CLI_DOCTOR.md.

function commonOptions(cmd: Argv): Argv {
  return cmd
    .option("json", {
      type: "boolean",
      default: false,
      describe:
        "print the machine-readable verdict on stdout instead of the " +
        "human-readable check lines",
    })
    .option("log-level", {
      type: "string",
      describe: "silent | error | warn | info | debug | trace; default=info",
    })
    .option("log-file", {
      type: "string",
      describe:
        "append all log output to this file instead of the terminal; the " +
        "parent directory must already exist",
    });
}

/** Handler for `psilink doctor probe`. */
export function probeHandler(argv: Arguments): Promise<void> {
  return runDoctor(argv, "probe");
}

/** Handler for `psilink doctor mount DIRECTORY`. */
export function mountHandler(argv: Arguments): Promise<void> {
  return runDoctor(argv, "mount");
}

export function builder(cmd: Argv): Argv {
  return cmd
    .usage("Usage: $0 doctor <probe | mount DIRECTORY> [options]")
    .command(
      "probe",
      "Check the file drop over the network, without mounting it",
      (probe) => commonOptions(probe).usage("Usage: $0 doctor probe [options]"),
      probeHandler,
    )
    .command(
      "mount <directory>",
      "Check an already-mounted file-drop directory",
      (mount) =>
        commonOptions(mount)
          .usage("Usage: $0 doctor mount DIRECTORY [options]")
          .positional("directory", {
            type: "string",
            describe: "the mounted file-drop directory to check",
            demandOption: true,
          }),
      mountHandler,
    )
    .demandCommand(
      1,
      "specify which checks to run: `doctor probe` or `doctor mount DIRECTORY`",
    );
}

async function runDoctor(
  argv: Arguments,
  mode: "probe" | "mount",
): Promise<void> {
  const logLevel = parseOrExit(() => logLevelFlag(argv));
  const {
    log,
    writePlainLine,
    close: closeLogging,
  } = parseOrExit(() =>
    configureLogging({
      logLevel,
      logFile: singleValue(argv, "log-file") as string | undefined,
      name: `doctor-${mode}`,
    }),
  );

  try {
    const report =
      mode === "probe"
        ? await runProbe(readSmbProbeInput(process.env))
        : runMountChecks(
            // Backslashes are folded on ingestion, the convention every
            // operator-supplied local path in the CLI follows.
            (singleValue(argv, "directory") as string).replace(/\\/g, "/"),
            readSmbMountInput(process.env),
          );
    emit(report, argv["json"] === true, log, writePlainLine);
    // Not process.exit: the verdict may still be draining to a pipe, and the
    // exit code is the caller's whole machine-readable answer when --json is
    // not in use.
    process.exitCode = DOCTOR_EXIT_CODE[overallOf(report)];
  } catch (err) {
    // A malformed input is a usage error (64); anything else escaping the
    // checks -- they classify a tool failure rather than throwing -- is an
    // availability failure (69), the same mapping the other commands apply.
    exitWithError(log, err, err instanceof UsageError ? 64 : 69);
  } finally {
    closeLogging();
  }
}

/**
 * Write the verdict: the `--json` document goes to stdout alone (one line,
 * `console.log`); the human check lines go to the logger's destination
 * unprefixed, gated the same as any `info` log line, and escaped here since
 * they contain server-controlled bytes (an NT_STATUS token, smbclient's own
 * output). Full contract for both forms, including the JSON line's own ASCII
 * encoder: docs/spec/CLI_DOCTOR.md.
 */
function emit(
  report: DoctorReport,
  json: boolean,
  log: { getLevel: () => logLibrary.LogLevelNumbers },
  writePlainLine: (line: string) => void,
): void {
  if (json) {
    console.log(verdictJson(report));
    return;
  }
  if (log.getLevel() > logLibrary.levels.INFO) return;
  for (const line of verdictLines(report))
    writePlainLine(redactAndSanitizeForDisplay(line));
}
