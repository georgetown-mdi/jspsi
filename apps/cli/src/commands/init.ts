import type { Argv, Arguments } from "yargs";

import {
  DEFAULT_LINKAGE_RULE_SET,
  inferDateInputFormatFromSource,
  keepOperatorSuppliedText,
  linkageTermsFromRuleSet,
  messageWithOperatorText,
  operatorSuppliedText,
  redactAndRenderOperatorSuppliedText,
  UsageError,
} from "@alcove/core";
import type { BuiltInLinkageRuleSet } from "@alcove/core";

import { DEFAULT_CONFIG_PATH } from "../config";
import {
  detectFileConflicts,
  expandTilde,
  FileExistsError,
  writeFileOwnerOnly,
} from "../fileUtils";
import { renderConfigTemplate } from "../configTemplate";
import type { TemplateDataSpec } from "../configTemplate";
import { openInputSource } from "../util/dataIo";
import { runOrExit } from "../util/exit";
import {
  assertNoUnknownOptions,
  csvDelimiterFlag,
  singleValue,
} from "../util/flags";
import { configureLogging, logLevelFlag } from "../util/logging";
import { promptConfirm } from "../util/prompt";
import { addCsvDelimiterOption, addLoggingOptions } from "../optionDefinitions";
import { buildDataSpec, warnSanitizedColumns } from "../onlineBootstrap";
import {
  askIdentityAtPrompt,
  identityFromFlagOrPrompt,
  INIT_IDENTITY_QUESTION,
  PLACEHOLDER_IDENTITY,
} from "../partyIdentity";

export function builder(cmd: Argv): Argv {
  const withoutLogging = addCsvDelimiterOption(cmd)
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
    });
  return addLoggingOptions(withoutLogging).usage(
    "Usage:\n" +
      "  $0 init [options] [INPUT_FILE]\n\n" +
      "Write a commented alcove.yaml template -- every option documented\n" +
      "inline with defaults pre-filled -- then exit. No key file is created\n" +
      "and no exchange is run. With an INPUT_FILE, column metadata, linkage\n" +
      "fields, and standardizing transformations are inferred from it.\n\n" +
      "INPUT_FILE may be `-` to read the CSV from stdin.",
  );
}

export async function handler(argv: Arguments): Promise<void> {
  let closeLogging: (() => void) | undefined;
  try {
    await runOrExit("init", async () => {
      // Resolve the log level before creating the logger (loglevel binds a
      // logger's level at creation) and inside runOrExit, so an unrecognized
      // value is a clean usage error (exit 64) on the same path as everything
      // else.
      const logLevel = logLevelFlag(argv);
      // Install the sink, apply the level, and build getLogger("init") through the
      // shared configureLogging helper (in that order, so the logger inherits the
      // sink): the file sink when --log-file is given, otherwise the default stderr
      // sink so stdout holds only result data. A missing parent directory
      // (configureLogFile) or a repeated --log-file (singleValue) is a UsageError
      // -> exit 64, mapped here by the enclosing runOrExit.
      const { log, close } = configureLogging({
        logLevel,
        logFile: singleValue(argv, "log-file") as string | undefined,
        name: "init",
      });
      closeLogging = close;

      const configFile =
        expandTilde(singleValue(argv, "config-file") as string | undefined) ??
        DEFAULT_CONFIG_PATH;
      // Read here, with the other flags, so a repeated --identity is a usage
      // error before any question is asked or any file is written; what the
      // value means is decided below, once it is known whether this run can ask
      // for one instead.
      const identityFlag = singleValue(argv, "identity") as string | undefined;
      // Read with the other flags so a malformed value is a usage error before
      // anything is read or written. It reads the input file below AND is
      // written into the template, so the next run against that file needs no
      // flag of its own.
      const csvDelimiter = csvDelimiterFlag(argv);
      const positionals = (argv["args"] as Array<string> | undefined) ?? [];
      // This command sets unknown-options-as-args (so a bare `-` stdin token
      // survives as a positional), which also lets a mistyped `--flag` reach the
      // positionals rather than the top-level strictOptions; reject it here,
      // before any input read or file write.
      assertNoUnknownOptions(positionals);
      const input = resolveInitInput(positionals);

      // One interactivity decision serves both questions this command can ask:
      // a terminal is there to answer, and stdin is not already spoken for by a
      // `-` CSV. stdin is single-use, so a second rule here would be a way for
      // the two questions to disagree about who owns it.
      const interactive = process.stdin.isTTY === true && input !== "-";

      // Decide whether to (over)write before reading the input, so a `-` stdin CSV
      // is never consumed when the answer is "fail-closed" or "leave it" -- the
      // overwrite prompt and a stdin CSV both want stdin, the same conflict accept
      // resolves by refusing `-`.
      const decision = await decideOverwrite(configFile, {
        interactive,
        confirm: () =>
          promptConfirm(
            `Overwrite ${redactAndRenderOperatorSuppliedText(
              operatorSuppliedText(configFile),
            )}?`,
          ),
      });
      if (decision === "skip") {
        log.info(
          `left the existing file at ${redactAndRenderOperatorSuppliedText(
            operatorSuppliedText(configFile),
          )} unchanged.`,
        );
        return;
      }

      // Asked after the overwrite decision, so a run that leaves the existing
      // file alone asks nothing: there is no file being written for the answer
      // to be remembered in, and Alcove remembers an answer nowhere else.
      // Absent both the flag and an answer, the template holds the
      // placeholder, like the connection's host and username: init produces a
      // scaffold to hand-edit, not a runnable config.
      const identity =
        (await identityFromFlagOrPrompt(
          identityFlag,
          interactive
            ? () => askIdentityAtPrompt(INIT_IDENTITY_QUESTION)
            : undefined,
        )) ?? PLACEHOLDER_IDENTITY;

      const data = await buildTemplateData(
        input,
        identity,
        DEFAULT_LINKAGE_RULE_SET,
        csvDelimiter,
      );
      const template = renderConfigTemplate(data);
      try {
        // Exclusive on the "create" path (the path was free at the check): if a
        // file appeared between the check and this write -- a window a `-` stdin
        // CSV can hold open arbitrarily long -- fail closed rather than silently
        // clobber it, re-asserting the never-overwrite-unprompted contract at the
        // write the way provisionConfigAndKey re-gates. On the "overwrite" path
        // the operator already confirmed, so the write replaces in place.
        writeFileOwnerOnly(configFile, template, {
          exclusive: decision === "create",
        });
      } catch (err) {
        // init performs no network activity, so every failure is a local,
        // operator-fixable problem -- classify a write failure as a usage error
        // (exit 64) rather than letting runOrExit's transport-failure default (69)
        // misclassify it.
        if (err instanceof FileExistsError) {
          const appeared = messageWithOperatorText`a file appeared at ${operatorSuppliedText(
            configFile,
          )} after the overwrite check; refusing to overwrite it unprompted. Re-run to decide.`;
          throw keepOperatorSuppliedText(
            new UsageError(appeared.text),
            appeared,
          );
        }
        const message = messageWithOperatorText`could not write ${operatorSuppliedText(
          configFile,
        )}: ${err instanceof Error ? err.message : String(err)}`;
        throw keepOperatorSuppliedText(new UsageError(message.text), message);
      }

      log.info(
        `wrote a configuration template to ${redactAndRenderOperatorSuppliedText(
          operatorSuppliedText(configFile),
        )}. No key file was ` +
          "created and no exchange was run. Edit the file -- at least the " +
          "connection block and the identity -- then run 'alcove invite' or " +
          "'alcove accept' to set up an exchange.",
      );
    });
  } finally {
    // Restore the loglevel factory (and close the log-file descriptor, for the
    // file sink) on the normal exit path. Writes are synchronous and already
    // durable, so the error path's process.exit (which bypasses this finally)
    // loses nothing -- this is only factory/descriptor cleanup.
    closeLogging?.();
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
      "init takes at most one INPUT_FILE; usage: alcove init [INPUT_FILE]",
    );
  return positionals[0] !== undefined ? String(positionals[0]) : undefined;
}

/**
 * Resolve the exchange-data sections of the template: the inferred metadata,
 * linkage fields, and standardization when an input CSV is given, or just the
 * default linkage terms when it is not. Reuses `buildDataSpec` -- the same
 * inference `invite`/`accept`/zero-setup run -- so the template matches what
 * those commands would author from the same file. Reads only the header plus
 * a bounded DOB sample via {@link inferDateInputFormatFromSource}, which
 * yields the same format as a full read.
 *
 * That read applies core's header sanitation like every other, so it states the
 * positions it changed through the same warning line the exchange reads use: the
 * config this writes names the sanitized column, not the header as typed.
 *
 * `ruleSet` is the built-in rule set the terms are drawn from, the default set
 * unless one is chosen. The template cites whichever it was, so the file this
 * writes states where its rules came from and a later load resolves that
 * citation to the same rules.
 *
 * `csvDelimiter` reads the input by that field delimiter and is written into
 * the template, so the exchange the template governs runs it without a flag.
 *
 * @internal exported for testing
 */
export async function buildTemplateData(
  input: string | undefined,
  identity: string,
  ruleSet: BuiltInLinkageRuleSet = DEFAULT_LINKAGE_RULE_SET,
  csvDelimiter?: string,
): Promise<TemplateDataSpec> {
  const delimiterSection = csvDelimiter !== undefined ? { csvDelimiter } : {};
  if (input === undefined)
    return {
      linkageTerms: linkageTermsFromRuleSet(ruleSet, identity),
      ...delimiterSection,
    };

  let inferred;
  try {
    inferred = await inferDateInputFormatFromSource(
      openInputSource(input, { allowStdin: true }),
      undefined,
      csvDelimiter,
    );
  } catch (err) {
    // openInputSource's stdin-specific rejections (`-` disallowed, `-` at a bare
    // TTY) are already UsageErrors with actionable wording -- keep them. A missing
    // or unreadable file throws a plain Error (exitCode 69, the network commands'
    // default); init has no transport, so reclassify it as a usage error (exit
    // 64) naming the file.
    if (err instanceof UsageError) throw err;
    const message = messageWithOperatorText`could not read input file ${operatorSuppliedText(
      input,
    )}: ${err instanceof Error ? err.message : String(err)}`;
    throw keepOperatorSuppliedText(new UsageError(message.text), message);
  }

  warnSanitizedColumns(inferred.sanitizedColumnPositions);

  return {
    ...buildDataSpec({
      identity,
      ruleSet,
      rows: {
        rawRows: [],
        columns: inferred.columns,
        sanitizedColumnPositions: inferred.sanitizedColumnPositions,
      },
      ...(inferred.dateInputFormat !== undefined
        ? { dateInputFormat: inferred.dateInputFormat }
        : {}),
    }),
    ...delimiterSection,
  };
}

/** What {@link decideOverwrite} states behind the occupied path. */
const UNCONFIRMED_OVERWRITE_REMEDY =
  "; refusing to overwrite it without an interactive confirmation. Delete " +
  "it, or pass --config-file to write the template elsewhere.";

/**
 * Decide what `init` should do about the output path. Returns `"create"` when
 * the path is free (the caller then writes exclusively, so a file that appears
 * before the write fails closed rather than being clobbered), `"overwrite"` when
 * a file exists and the user confirms replacing it, and `"skip"` when the user
 * declines. When a file exists but no interactive confirmation is possible (no
 * terminal, or a `-` stdin CSV already owns stdin), fails closed with a
 * {@link UsageError} rather than silently overwriting -- the same conservative
 * default the host-key and key-file non-interactive paths use.
 *
 * @internal exported for testing
 */
export async function decideOverwrite(
  configPath: string,
  opts: { interactive: boolean; confirm: () => Promise<boolean> },
): Promise<"create" | "overwrite" | "skip"> {
  // detectFileConflicts (lstat, not existsSync) so a dangling symlink at the
  // path is treated as occupied and still prompts -- existsSync resolves it to
  // false yet a write would follow it, the same fail-closed reasoning the
  // provisioning conflict gate uses.
  if (detectFileConflicts([configPath]).length === 0) return "create";
  if (!opts.interactive) {
    const message = messageWithOperatorText`a file already exists at ${operatorSuppliedText(
      configPath,
    )}${UNCONFIRMED_OVERWRITE_REMEDY}`;
    throw keepOperatorSuppliedText(new UsageError(message.text), message);
  }
  return (await opts.confirm()) ? "overwrite" : "skip";
}
