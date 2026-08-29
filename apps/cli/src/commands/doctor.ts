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
// is attempted, in the two places the answer can differ: over the network as
// smbclient sees it (`doctor probe`), and through the kernel as a mounted folder
// (`doctor mount`). Its `--json` verdict is a stable contract, not a formatted
// log -- the host-side launchers loop on the check ids and the overall verdict,
// so a check keeps its id and a caller reads `version` before anything else. The
// Windows setup script consumes the other half of the same contract: it prints
// the human check lines as they are written and branches on the exit code alone.
//
// Its connection inputs come from the SMB_* environment, never flags: the
// password must not become an argv value every `ps` on the machine can read, and
// splitting the rest onto the command line would leave the credential the odd
// one out. Anything malformed is a usage error (exit 64) with no verdict
// printed, because the checks never ran.

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
            // Backslashes are folded on ingestion so a Windows-shaped path
            // names the intended directory, the convention every operator-
            // supplied local path in the CLI follows.
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
    // batteries -- they classify a tool failure rather than throwing -- is an
    // availability failure (69), the same mapping the other commands apply.
    exitWithError(log, err, err instanceof UsageError ? 64 : 69);
  } finally {
    closeLogging();
  }
}

/**
 * Write the verdict. The `--json` document is the command's result, so it goes
 * to stdout (one line, `console.log`), keeping a capture or pipe clean; the
 * human check lines go to the logger's own destination -- stderr, or a
 * `--log-file` -- but as a rendering rather than log records, so they carry no
 * `[ISO] [LEVEL] [CONTEXT]` prefix: an operator reads them in an 80-column
 * console, and a host-side setup launcher collects and re-prints them there, so
 * roughly 50 columns of prefix wraps every line of the verdict they are asked to
 * pass on. They carry server-controlled bytes -- an NT_STATUS token and
 * smbclient's own output -- so they are escaped and redacted here, at the
 * composition: the plain-line sink bypasses core's prefixer, so the per-argument
 * private-key strip does not run behind this call. The JSON form withholds the
 * tool output (verdictOf drops summary and detail) but carries each check's
 * meaning and action, and takes its own encoder, `verdictJson`'s
 * `asciiSafeJsonLine`: bare JSON string encoding leaves DEL, the C1 range and
 * U+2028/U+2029 intact, so the line is made printable ASCII there rather than
 * here. Its consumer re-validates at its own boundary either way.
 *
 * Dropping the prefix does not exempt them from `--log-level`: they are written
 * only when the level admits the `info` they were logged at, so `--log-level
 * silent` still leaves the exit code as the whole answer, and a level that
 * suppresses them suppresses the whole rendering rather than half of it.
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
