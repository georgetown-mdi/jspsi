import type { Argv, Arguments } from "yargs";

import {
  disclosedColumnNames,
  encodeTermsUpdate,
  operatorSuppliedText,
  redactAndRenderOperatorSuppliedText,
  UsageError,
} from "@psilink/core";

import { writeTermsRecord } from "../acceptedTermsRecords";
import {
  DEFAULT_CONFIG_PATH,
  persistOutboundPayloadConsent,
  warnOnLinkageRuleSetCitationDrift,
} from "../config";
import { assertConfigTermsRunnable } from "../configTermsGuards";
import { DEFAULT_KEY_PATH } from "../keyFile";
import { addLoggingOptions } from "../optionDefinitions";
import { resolveTermsUpdateIdentity } from "../partyIdentity";
import {
  readPartnershipSecret,
  readPartnershipTermsSource,
} from "../termsUpdateFiles";
import { runOrExit } from "../util/exit";
import { singleValue } from "../util/flags";
import { configureLogging, logLevelFlag } from "../util/logging";

export function builder(cmd: Argv): Argv {
  return addLoggingOptions(
    cmd
      .usage(
        "Usage: $0 update [options]\n\n" +
          "Make a terms update from this party's configuration: its linkage\n" +
          "terms and the columns it discloses, authenticated under the shared\n" +
          "secret in the key file. The update is printed to stdout; your\n" +
          "partner applies it with 'psilink apply'. The key file and the\n" +
          "connection block are not changed.",
      )
      .option("config-file", {
        type: "string",
        describe: `this partnership's configuration, with the linkage terms to send (default: ${DEFAULT_CONFIG_PATH})`,
      })
      .option("key-file", {
        type: "string",
        describe: `this partnership's key file, read and not changed (default: ${DEFAULT_KEY_PATH})`,
      }),
  );
}

export async function handler(argv: Arguments): Promise<void> {
  let closeLogging: (() => void) | undefined;
  try {
    await runOrExit("update", async () => {
      const { log, close } = configureLogging({
        logLevel: logLevelFlag(argv),
        logFile: singleValue(argv, "log-file") as string | undefined,
        name: "update",
      });
      closeLogging = close;
      const positionals = ((argv["_"] as Array<unknown> | undefined) ?? [])
        .slice(1)
        .map(String);
      if (positionals.length > 0)
        throw new UsageError(
          "psilink update takes no positional arguments; it reads the " +
            "configuration named by --config-file.",
        );
      const configPath =
        (singleValue(argv, "config-file") as string | undefined) ??
        DEFAULT_CONFIG_PATH;
      const keyPath =
        (singleValue(argv, "key-file") as string | undefined) ??
        DEFAULT_KEY_PATH;

      const source = readPartnershipTermsSource(configPath);
      const terms = source.linkageTerms;
      warnOnLinkageRuleSetCitationDrift(
        terms,
        configPath,
        log,
        source.linkageTermsStanding,
        "author-fresh-terms",
      );
      resolveTermsUpdateIdentity(terms.identity, configPath);
      assertConfigTermsRunnable(terms, source);
      const sharedSecret = readPartnershipSecret(keyPath);

      // Undefined where the configuration declares no metadata: the columns
      // are then known only from the input file, which this command does not
      // read, and the partner reconciles them at the first exchange.
      const disclosedPayloadColumns =
        source.metadata !== undefined
          ? disclosedColumnNames(source.metadata)
          : undefined;
      const update = await encodeTermsUpdate(
        { linkageTerms: terms, disclosedPayloadColumns },
        sharedSecret,
      );

      // The same two records an invitation minted from this configuration
      // refreshes, before the update is printed so a failed write never
      // follows sending it: the commitment the partner will hold this party
      // to, and the removal of an acceptance-side consent the commitment
      // replaces.
      writeTermsRecord(configPath, {
        record: "disclosed_payload_columns",
        columns: disclosedPayloadColumns,
      });
      persistOutboundPayloadConsent(configPath, undefined);

      log.info(
        "Send this terms update to your partner. It holds your linkage " +
          "terms and the names of the columns you disclose, and no secret:",
      );
      console.log(update);
      log.info(
        "Your partner applies it with:\n  psilink apply <UPDATE>\nwhere " +
          "<UPDATE> is the update printed above. Until they have applied it, " +
          "an exchange between you is refused wherever your terms and theirs " +
          "differ. " +
          `The key file and the connection block in ${redactAndRenderOperatorSuppliedText(
            operatorSuppliedText(configPath),
          )} were not changed.`,
      );
    });
  } finally {
    closeLogging?.();
  }
}
