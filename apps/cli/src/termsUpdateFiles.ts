/**
 * The two files `psilink update` and `psilink apply` read: the established
 * partnership's configuration and the key file holding the shared secret a
 * terms update is authenticated under. Neither command writes the key file.
 */

import fs from "node:fs";

import {
  keepOperatorSuppliedText,
  messageWithOperatorText,
  operatorSuppliedText,
  parseExchangeSpec,
  UsageError,
} from "@psilink/core";
import type { ExchangeSpec } from "@psilink/core";

import {
  configWithNamedRuleSetRules,
  describeConfigSchemaError,
  loadConfigLinkageSource,
  type ConfigLinkageSource,
} from "./config";
import { checkKeyFileExpiry, loadKeyFile } from "./keyFile";
import { parseSensitiveYaml } from "./sensitiveFile";

/** A refusal naming an operator's file, the path marked as theirs. */
function refusalAbout(
  lead: string,
  filePath: string,
  rest: string,
): UsageError {
  const message = messageWithOperatorText`${lead}${operatorSuppliedText(
    filePath,
  )}${rest}`;
  return keepOperatorSuppliedText(new UsageError(message.text), message);
}

/**
 * What a terms update needs an established partnership to have, stated where
 * one of its two files is missing.
 */
const ESTABLISHED_PARTNERSHIP_REMEDY =
  " A terms update changes a partnership already set up with 'psilink " +
  "invite' and 'psilink accept'; run it where that partnership's " +
  "configuration and key file are, or name them with --config-file and " +
  "--key-file.";

/**
 * The linkage terms, metadata, and standardization of the partnership's
 * configuration at `configPath`, read as an invitation minted from it reads
 * them (`loadConfigLinkageSource`).
 *
 * @throws {UsageError} where no file is there or it does not load.
 */
export function readPartnershipTermsSource(
  configPath: string,
): ConfigLinkageSource {
  const source = loadConfigLinkageSource(configPath);
  if (source === undefined)
    throw refusalAbout(
      "no configuration file at ",
      configPath,
      "." + ESTABLISHED_PARTNERSHIP_REMEDY,
    );
  return source;
}

/**
 * The partnership's configuration at `configPath`, read as `psilink exchange`
 * reads it: through the sensitive-file parse, with a rule set it names taken
 * from that set, and validated against the exchange schema.
 *
 * @throws {UsageError} where no file is there or it does not load.
 */
export function readPartnershipConfig(configPath: string): ExchangeSpec {
  if (!fs.existsSync(configPath))
    throw refusalAbout(
      "no configuration file at ",
      configPath,
      "." + ESTABLISHED_PARTNERSHIP_REMEDY,
    );
  const parsed = parseSensitiveYaml(
    fs.readFileSync(configPath, "utf8"),
    messageWithOperatorText`config file ${operatorSuppliedText(configPath)}`,
  );
  try {
    return parseExchangeSpec(configWithNamedRuleSetRules(parsed, configPath));
  } catch (err) {
    throw refusalAbout(
      "config file ",
      configPath,
      ` could not be loaded: ${describeConfigSchemaError(err)}. Fix it and ` +
        "run the command again.",
    );
  }
}

/**
 * The shared secret in the key file at `keyPath`, the one both parties hold
 * and a terms update is authenticated under.
 *
 * @throws {UsageError} where no key file is there, it is malformed, or its
 *   secret has expired: an expired secret is one no exchange can use, so the
 *   partnership is re-established rather than updated.
 */
export function readPartnershipSecret(keyPath: string): string {
  let keyFile;
  try {
    keyFile = loadKeyFile(keyPath);
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw refusalAbout(
      "key file at ",
      keyPath,
      ` is malformed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (keyFile === undefined)
    throw refusalAbout(
      "no key file at ",
      keyPath,
      "." + ESTABLISHED_PARTNERSHIP_REMEDY,
    );
  if (checkKeyFileExpiry(keyFile, Date.now()) === "expired")
    throw refusalAbout(
      "the shared secret in ",
      keyPath,
      ` expired at ${keyFile.expires ?? "(unknown)"}, so it cannot ` +
        "authenticate a terms update. Re-establish the partnership instead: " +
        "remove the key file on both sides, then one party runs 'psilink " +
        "invite' and the other 'psilink accept'.",
    );
  return keyFile.sharedSecret;
}
