import type { Argv, Arguments } from "yargs";

import {
  decodeTermsUpdate,
  disclosedColumnNames,
  keepOperatorSuppliedText,
  messageWithOperatorText,
  operatorSuppliedText,
  redactAndRenderOperatorSuppliedText,
  redactAndSanitizeForDisplay,
  stripInvitationWhitespace,
  TermsUpdateRefusedError,
  UsageError,
} from "@alcove/core";
import type { ExchangeSpec, TermsUpdate } from "@alcove/core";

import {
  deriveAcceptedInvitationTerms,
  termsUpdateWrite,
  type AcceptedInvitationTerms,
} from "../acceptedTermsRecords";
import {
  DEFAULT_CONFIG_PATH,
  diffLinkageTerms,
  persistTermsUpdate,
} from "../config";
import { assertConfigTermsRunnable } from "../configTermsGuards";
import {
  consentSurfaceSink,
  displayInvitation,
  type ConsentSurfaceSink,
} from "../invitationDisplay";
import { DEFAULT_KEY_PATH } from "../keyFile";
import { addLoggingOptions, keyFileFlag } from "../optionDefinitions";
import { resolveTermsUpdateIdentity } from "../partyIdentity";
import {
  readPartnershipConfig,
  readPartnershipSecret,
} from "../termsUpdateFiles";
import { resolveAtSignRefs } from "../util/atSignRefs";
import { runOrExit } from "../util/exit";
import { assertNoUnknownOptions, singleValue } from "../util/flags";
import { configureLogging, logLevelFlag } from "../util/logging";
import { promptConfirm } from "../util/prompt";

export function builder(cmd: Argv): Argv {
  return addLoggingOptions(
    cmd
      // A terms update is base64url and may begin with `-`, so an unknown
      // `-`-leading token is taken as the positional, as accept takes an
      // invitation; a mistyped `--flag` is then refused by the handler.
      .parserConfiguration({ "unknown-options-as-args": true })
      .positional("args", {
        type: "string",
        array: true,
        describe: "UPDATE: the terms update, or an @path to a file holding it",
      })
      .usage(
        "Usage: $0 apply [options] UPDATE\n\n" +
          "Apply a terms update your partner made with 'alcove update' to\n" +
          "this party's configuration. The update is checked against the\n" +
          "shared secret in the key file, its terms are shown, and nothing is\n" +
          "written unless you confirm. The key file and the connection block\n" +
          "are not changed.",
      )
      .option("config-file", {
        type: "string",
        describe: `this partnership's configuration, whose linkage terms the update replaces (default: ${DEFAULT_CONFIG_PATH})`,
      })
      .option("key-file", {
        type: "string",
        describe: `this partnership's key file, read and not changed (default: ${DEFAULT_KEY_PATH})`,
      }),
  );
}

/** The update argument, read from an `@path` where it names one. */
function readUpdateArgument(raw: string): string {
  let resolved: unknown;
  try {
    resolved = resolveAtSignRefs(raw);
  } catch (err) {
    throw new UsageError(
      `could not read the terms update from ${raw}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (typeof resolved !== "string")
    throw new UsageError("the terms update must be a string");
  return stripInvitationWhitespace(resolved);
}

/**
 * The refusal an update the decode refused is reported as, naming the check
 * that refused it and what to do.
 */
function refusalOf(err: TermsUpdateRefusedError, keyPath: string): UsageError {
  const unchanged = " Nothing was changed.";
  switch (err.check) {
    case "format":
      return new UsageError(
        `the terms update could not be read: ${err.message}.${unchanged} ` +
          "Ask your partner to run 'alcove update' again and send you its " +
          "whole output.",
      );
    case "partnership": {
      const message = messageWithOperatorText`the terms update was refused by the partnership check: it was made under a shared secret other than the one in ${operatorSuppliedText(
        keyPath,
      )}, so it is for a different partnership, or an exchange between you has replaced the secret since it was made.${unchanged} Ask your partner to run 'alcove update' again from the configuration and key file they use with you.`;
      return keepOperatorSuppliedText(new UsageError(message.text), message);
    }
    case "authentication":
      return new UsageError(
        "the terms update was refused by the MAC check: it names this " +
          "partnership, but its content was changed after your partner " +
          `made it.${unchanged} Ask your partner to send it again.`,
      );
  }
}

/** A column list as the change summary shows it, one escaped name a line. */
function columnLines(
  label: string,
  columns: ReadonlyArray<string> | undefined,
): string[] {
  if (columns === undefined)
    return [
      `    ${label}: not stated -- the next exchange takes whatever columns ` +
        "your partner sends",
    ];
  if (columns.length === 0) return [`    ${label}: (none)`];
  return [
    `    ${label}:`,
    ...columns.map((column) => `      ${redactAndSanitizeForDisplay(column)}`),
  ];
}

function sameColumns(
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((column, i) => column === b[i]);
}

/**
 * The linkage-terms fields the update changes, by the name each has in the
 * configuration. The agreed fields come from the reconciliation an acceptance
 * runs over a kept configuration; the two fields each party holds for itself
 * are compared here.
 */
function changedTermsFields(
  existing: ExchangeSpec,
  accepted: AcceptedInvitationTerms,
): string[] {
  const fields = diffLinkageTerms(
    existing.linkageTerms,
    accepted.linkageTerms,
  ).conflicts.map((diff) => diff.field);
  const before = existing.linkageTerms.output;
  const after = accepted.linkageTerms.output;
  if (
    before.expectsOutput !== after.expectsOutput ||
    before.shareWithPartner !== after.shareWithPartner
  )
    fields.push("output");
  if (
    existing.expectedPartnerDeduplicate !== accepted.expectedPartnerDeduplicate
  )
    fields.push("your partner's deduplicate");
  return fields;
}

/**
 * State what the update changes in the configuration, ahead of the terms it
 * adopts: the linkage terms and the columns this party receives are separate
 * lines, so a change to what the partner discloses is never read as part of a
 * terms change.
 */
function displayChanges(
  emit: ConsentSurfaceSink,
  configPath: string,
  existing: ExchangeSpec,
  accepted: AcceptedInvitationTerms,
): void {
  emit(
    `Changes this update makes to ${redactAndRenderOperatorSuppliedText(
      operatorSuppliedText(configPath),
    )}:`,
  );
  const fields = changedTermsFields(existing, accepted);
  emit(
    fields.length === 0
      ? "  linkage terms: no change"
      : `  linkage terms: ${fields.join(", ")} change (the new terms follow)`,
  );
  const before = existing.expectedPayloadColumns;
  const after = accepted.expectedPayloadColumns;
  if (sameColumns(before, after)) {
    emit("  columns you will receive: no change");
    return;
  }
  emit("  columns you will receive: change");
  for (const line of columnLines("before", before)) emit(line);
  for (const line of columnLines("after", after)) emit(line);
}

export async function handler(argv: Arguments): Promise<void> {
  let closeLogging: (() => void) | undefined;
  try {
    await runOrExit("apply", async () => {
      const logFile = singleValue(argv, "log-file") as string | undefined;
      const { log, close } = configureLogging({
        logLevel: logLevelFlag(argv),
        logFile,
        name: "apply",
      });
      closeLogging = close;
      const positionals = (
        (argv["args"] as Array<unknown> | undefined) ?? []
      ).map(String);
      assertNoUnknownOptions(positionals);
      if (positionals.length !== 1)
        throw new UsageError(
          "alcove apply takes exactly one argument, the terms update; " +
            "usage: alcove apply [options] UPDATE",
        );
      const configPath =
        (singleValue(argv, "config-file") as string | undefined) ??
        DEFAULT_CONFIG_PATH;
      const keyPath = keyFileFlag(argv);

      const existing = readPartnershipConfig(configPath);
      const identity = resolveTermsUpdateIdentity(
        existing.linkageTerms.identity,
        configPath,
      );
      const sharedSecret = readPartnershipSecret(keyPath);
      const encoded = readUpdateArgument(positionals[0] as string);

      // Verified before anything the update holds is shown or acted on.
      let update: TermsUpdate;
      try {
        update = await decodeTermsUpdate(encoded, sharedSecret);
      } catch (err) {
        if (err instanceof TermsUpdateRefusedError)
          throw refusalOf(err, keyPath);
        throw err;
      }
      if (update.linkageTerms.identity === identity)
        throw new UsageError(
          "this terms update names your own identity as the party that " +
            `made it ("${identity}"), so it was made from your own ` +
            "configuration and applying it would swap your side of the " +
            "terms for your partner's. Nothing was changed. Send it to " +
            "your partner to apply instead.",
        );

      // This party's own side of the cardinality is kept: the update states
      // the sending party's side, recorded as expected_partner_deduplicate.
      const accepted = deriveAcceptedInvitationTerms(
        update,
        identity,
        existing.linkageTerms.deduplicate,
      );
      assertConfigTermsRunnable(accepted.linkageTerms, existing);
      const write = termsUpdateWrite(accepted, existing);

      const consentSurface = consentSurfaceSink({
        log,
        logFile,
        toPromptStream: true,
      });
      displayChanges(consentSurface, configPath, existing, accepted);
      displayInvitation({
        token: update,
        ownOutboundSend:
          existing.metadata !== undefined
            ? disclosedColumnNames(existing.metadata)
            : undefined,
        emit: consentSurface,
        promptFollows: true,
        surface: "update",
      });
      const confirmed = await promptConfirm(
        `Apply this update to ${redactAndRenderOperatorSuppliedText(
          operatorSuppliedText(configPath),
        )}?`,
      );
      if (!confirmed) {
        consentSurface("update declined; the configuration was not changed");
        return;
      }

      persistTermsUpdate(configPath, write);
      log.info(
        `applied the terms update to ${redactAndRenderOperatorSuppliedText(
          operatorSuppliedText(configPath),
        )}: its linkage terms and the records that follow from them were ` +
          "rewritten, and its connection block and the key file were not " +
          "changed. Your next 'alcove exchange' with this partner runs on " +
          "the new terms.",
      );
    });
  } finally {
    closeLogging?.();
  }
}
