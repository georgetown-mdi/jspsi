import type { Argv, Arguments } from "yargs";
import logLibrary from "loglevel";

import { getDefaultLinkageTerms, getLogger, UsageError } from "@psilink/core";

import { DEFAULT_CONFIG_PATH } from "../config";
import {
  detectFileConflicts,
  expandTilde,
  writeFileOwnerOnly,
} from "../fileUtils";
import { renderConfigTemplate } from "../configTemplate";
import type { TemplateDataSpec } from "../configTemplate";
import {
  configureLogFile,
  LOG_LEVELS,
  promptConfirm,
  singleValue,
} from "../util/cli";
import { buildDataSpec, loadInputRows, runOrExit } from "./bootstrap";

// The identity written into a fresh template when --identity is not given. A
// placeholder, like the connection's host/username -- init produces a scaffold to
// hand-edit, not a runnable config -- and non-empty so it satisfies the linkage
// terms schema (identity has a 1-character minimum).
const PLACEHOLDER_IDENTITY = "REPLACE_WITH_YOUR_IDENTITY";

export function builder(cmd: Argv): Argv {
  return (
    cmd
      // Capture positionals into `args` (rather than the global `_`) and treat an
      // unknown `-`-leading token as a positional, so a bare `-` (stdin) or an
      // input path is never swallowed or misread as a flag -- the same parsing the
      // invite/accept commands use for their positionals.
      .parserConfiguration({ "unknown-options-as-args": true })
      .positional("args", {
        type: "string",
        array: true,
        describe:
          "optional CSV [INPUT_FILE] to infer column metadata, linkage fields, " +
          "and standardizing transformations from; `-` reads it from stdin",
      })
      .option("config-file", {
        type: "string",
        describe: `where to write the template (default: ${DEFAULT_CONFIG_PATH})`,
      })
      .option("identity", {
        type: "string",
        describe: "identity string to pre-fill (name, org, contact)",
      })
      .option("log-level", {
        type: "string",
        describe: "silent, error, warn, info, debug, or trace (default: info)",
      })
      .option("log-file", {
        type: "string",
        describe: "append diagnostics to this file instead of the terminal",
      })
      .usage(
        "Usage:\n" +
          "  $0 init [options] [INPUT_FILE]\n\n" +
          "Write a commented psilink.yaml template -- every option documented\n" +
          "inline with defaults pre-filled -- then exit. No key file is created\n" +
          "and no exchange is run. With an INPUT_FILE, column metadata, linkage\n" +
          "fields, and standardizing transformations are inferred from it.\n\n" +
          "INPUT_FILE may be `-` to read the CSV from stdin.",
      )
  );
}

export async function handler(argv: Arguments): Promise<void> {
  let logFileSink: ReturnType<typeof configureLogFile> | undefined;
  try {
    await runOrExit("init", async () => {
      // Resolve the log level before creating the logger (loglevel binds a
      // logger's level at creation) and inside runOrExit, so an unrecognized
      // value is a clean usage error (exit 64) on the same path as everything
      // else.
      const rawLogLevel = (
        (singleValue(argv, "log-level") as string | undefined) || "info"
      ).toLowerCase();
      const logLevel = LOG_LEVELS[rawLogLevel];
      if (logLevel === undefined)
        throw new UsageError(`unrecognized log-level: ${argv["log-level"]}`);
      // Redirect logging to the file (if requested) before the level is applied
      // and any logger is created, so getLogger("init") below inherits the file
      // sink. A missing parent directory is a UsageError -> exit 64 here.
      const logFile = singleValue(argv, "log-file") as string | undefined;
      if (logFile !== undefined) logFileSink = configureLogFile(logFile);
      logLibrary.setDefaultLevel(logLevel);
      const log = getLogger("init");

      const configFile =
        expandTilde(singleValue(argv, "config-file") as string | undefined) ??
        DEFAULT_CONFIG_PATH;
      const identity =
        (singleValue(argv, "identity") as string | undefined) ??
        PLACEHOLDER_IDENTITY;
      const input = resolveInitInput(
        (argv["args"] as Array<string> | undefined) ?? [],
      );

      // Decide whether to (over)write before reading the input, so a `-` stdin CSV
      // is never consumed when the answer is "fail-closed" or "leave it" -- the
      // overwrite prompt and a stdin CSV both want stdin, the same conflict accept
      // resolves by refusing `-`.
      const decision = await decideOverwrite(configFile, {
        interactive: process.stdin.isTTY === true && input !== "-",
        confirm: () => promptConfirm(`Overwrite ${configFile}?`),
      });
      if (decision === "skip") {
        log.info(`left the existing file at ${configFile} unchanged.`);
        return;
      }

      const data = await buildTemplateData(input, identity, log);
      const template = renderConfigTemplate(data);
      try {
        writeFileOwnerOnly(configFile, template);
      } catch (err) {
        // init performs no network activity, so every failure is a local,
        // operator-fixable problem -- classify a write failure as a usage error
        // (exit 64) rather than letting runOrExit's transport-failure default (69)
        // misclassify it.
        throw new UsageError(
          `could not write ${configFile}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }

      log.info(
        `wrote a configuration template to ${configFile}. No key file was ` +
          "created and no exchange was run. Edit the file -- at least the " +
          "connection block and the identity -- then run 'psilink invite' or " +
          "'psilink accept' to set up an exchange.",
      );
    });
  } finally {
    // Close the log-file descriptor on the normal exit path. Writes are
    // synchronous and already durable, so the error path's process.exit (which
    // bypasses this finally) loses nothing -- this is only descriptor cleanup.
    logFileSink?.close();
  }
}

/**
 * Resolve the optional INPUT_FILE positional. `init` takes at most one (the CSV,
 * or `-` for stdin); a second positional is a mistake -- most likely an
 * OUTPUT_FILE copied from another command, which `init` does not take -- so it is
 * rejected as a usage error rather than silently ignored.
 *
 * @internal exported for testing
 */
export function resolveInitInput(
  positionals: Array<unknown>,
): string | undefined {
  if (positionals.length > 1)
    throw new UsageError(
      "init takes at most one INPUT_FILE; usage: psilink init [INPUT_FILE]",
    );
  return positionals[0] !== undefined ? String(positionals[0]) : undefined;
}

/**
 * Resolve the exchange-data sections of the template: the inferred metadata,
 * linkage fields, and standardization when an input CSV is given, or just the
 * default linkage terms when it is not. Reuses `buildDataSpec` -- the same
 * inference `invite`/`accept`/zero-setup run -- so the template's terms match
 * what those commands would author from the same file.
 *
 * @internal exported for testing
 */
export async function buildTemplateData(
  input: string | undefined,
  identity: string,
  log: ReturnType<typeof getLogger>,
): Promise<TemplateDataSpec> {
  if (input === undefined)
    return { linkageTerms: getDefaultLinkageTerms(identity) };

  let rows;
  try {
    rows = await loadInputRows(input, { allowStdin: true });
  } catch (err) {
    // openInputSource's stdin-specific rejections (`-` disallowed, `-` at a bare
    // TTY) are already UsageErrors with actionable wording -- keep them. A missing
    // or unreadable file throws a plain Error (carrying exitCode 69 for the
    // network commands); init has no transport, so reclassify it as a usage error
    // (exit 64) naming the file.
    if (err instanceof UsageError) throw err;
    throw new UsageError(
      `could not read input file ${input}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  const { dataSpec, warnings } = buildDataSpec({ identity, rows });
  for (const w of warnings) log.warn(w);
  return dataSpec;
}

/**
 * Decide whether `init` should write the template, asking for confirmation when
 * a file already exists at `configPath`. Returns `"write"` when the path is free
 * or the user confirms the overwrite, `"skip"` when the user declines. When a
 * file exists but no interactive confirmation is possible (no terminal, or a `-`
 * stdin CSV already owns stdin), fails closed with a {@link UsageError} rather
 * than silently overwriting -- the same conservative default the host-key and
 * key-file non-interactive paths use.
 *
 * @internal exported for testing
 */
export async function decideOverwrite(
  configPath: string,
  opts: { interactive: boolean; confirm: () => Promise<boolean> },
): Promise<"write" | "skip"> {
  // detectFileConflicts (lstat, not existsSync) so a dangling symlink at the
  // path is treated as occupied and still prompts -- existsSync resolves it to
  // false yet a write would follow it, the same fail-closed reasoning the
  // provisioning conflict gate uses.
  if (detectFileConflicts([configPath]).length === 0) return "write";
  if (!opts.interactive)
    throw new UsageError(
      `a file already exists at ${configPath}; refusing to overwrite it ` +
        "without an interactive confirmation. Delete it, or pass --config-file " +
        "to write the template elsewhere.",
    );
  return (await opts.confirm()) ? "write" : "skip";
}
