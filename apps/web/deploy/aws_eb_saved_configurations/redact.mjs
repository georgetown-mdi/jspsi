// Rewrites an `aws elasticbeanstalk describe-configuration-settings` export
// into the form committed beside this file: the account id, the application
// and environment names, the notification endpoint and the EC2 key name --
// the last of these only when the export states one -- replaced with
// placeholders, the volatile members dropped, and the option settings sorted.
// Every other value is kept as exported. The procedure and the placeholder
// list are in README.md beside this file.

import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const VOLATILE_MEMBERS = ["DateCreated", "DateUpdated", "DeploymentStatus"];

const ACCOUNT_ID_PLACEHOLDER = "<account-id>";

// The account field of an ARN, which is where the account id appears in an
// export; collecting it from the document is what keeps the account id out of
// this file.
const ARN_ACCOUNT_ID = /arn:[^\s:]*:[^\s:]*:[^\s:]*:(\d{12}):/g;

const REDACTED_MEMBERS = [
  { member: "ApplicationName", placeholder: "<application-name>" },
  { member: "EnvironmentName", placeholder: "<environment-name>" },
];

const REDACTED_OPTIONS = [
  {
    namespace: "aws:elasticbeanstalk:sns:topics",
    optionName: "Notification Endpoint",
    placeholder: "<notification-endpoint>",
  },
  {
    namespace: "aws:autoscaling:launchconfiguration",
    optionName: "EC2KeyName",
    placeholder: "<ec2-key-name>",
    // An environment with no key pair states the option with no value, which is
    // the posture the deployment documents record: there is nothing to replace.
    absenceIsIntended: true,
  },
];

function* stringsIn(value) {
  if (typeof value === "string") yield value;
  else if (value !== null && typeof value === "object")
    for (const member of Object.values(value)) yield* stringsIn(member);
}

function accountIdsIn(value) {
  const accountIds = new Set();
  for (const text of stringsIn(value))
    for (const match of text.matchAll(ARN_ACCOUNT_ID)) accountIds.add(match[1]);
  return accountIds;
}

function optionValue(settings, namespace, optionName) {
  const option = settings.OptionSettings.find(
    (candidate) =>
      candidate.Namespace === namespace && candidate.OptionName === optionName,
  );
  return typeof option?.Value === "string" && option.Value.length > 0
    ? option.Value
    : undefined;
}

function replacementsFor(settings) {
  const replacements = [];
  for (const { member, placeholder } of REDACTED_MEMBERS) {
    const value = settings[member];
    if (typeof value !== "string" || value.length === 0)
      throw new Error(`the export states no ${member} to redact`);
    replacements.push({ value, placeholder });
  }
  for (const {
    namespace,
    optionName,
    placeholder,
    absenceIsIntended,
  } of REDACTED_OPTIONS) {
    const value = optionValue(settings, namespace, optionName);
    if (value === undefined) {
      if (absenceIsIntended) continue;
      throw new Error(
        `the export states no ${namespace} / ${optionName} value to redact`,
      );
    }
    replacements.push({ value, placeholder });
  }
  const accountIds = accountIdsIn(settings);
  if (accountIds.size === 0)
    throw new Error("the export states no ARN to read the account id from");
  for (const accountId of accountIds)
    replacements.push({
      value: accountId,
      placeholder: ACCOUNT_ID_PLACEHOLDER,
    });
  return replacements;
}

function redactStrings(value, replacements) {
  if (typeof value === "string") {
    let redacted = value;
    for (const { value: secret, placeholder } of replacements)
      redacted = redacted.split(secret).join(placeholder);
    return redacted;
  }
  if (Array.isArray(value))
    return value.map((member) => redactStrings(member, replacements));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [
        key,
        redactStrings(member, replacements),
      ]),
    );
  return value;
}

// Code-unit order rather than locale order, so two exports sorted on different
// machines diff against each other rather than against the collation.
function compareOptions(a, b) {
  const left = `${a.Namespace}\u0000${a.OptionName}`;
  const right = `${b.Namespace}\u0000${b.OptionName}`;
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/** Returns the committed form of a describe-configuration-settings document. */
export function redactConfigurationSettings(document) {
  const exported = document?.ConfigurationSettings;
  if (!Array.isArray(exported) || exported.length === 0)
    throw new Error("the export states no ConfigurationSettings");
  const replacements = [];
  for (const settings of exported) {
    if (!Array.isArray(settings?.OptionSettings))
      throw new Error("the export states no OptionSettings");
    replacements.push(...replacementsFor(settings));
  }
  return redactStrings(
    {
      ...document,
      ConfigurationSettings: exported.map((settings) => {
        const kept = Object.fromEntries(
          Object.entries(settings).filter(
            ([member]) => !VOLATILE_MEMBERS.includes(member),
          ),
        );
        kept.OptionSettings = [...settings.OptionSettings].sort(compareOptions);
        return kept;
      }),
    },
    // Longest first, so a value another one contains -- an environment name
    // beginning with the application name -- is replaced before its prefix is.
    replacements.sort((a, b) => b.value.length - a.value.length),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [path] = process.argv.slice(2);
  try {
    const source = readFileSync(
      path === undefined || path === "-" ? 0 : path,
      "utf8",
    );
    const redacted = redactConfigurationSettings(JSON.parse(source));
    process.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`redact.mjs: ${error.message}\n`);
    process.exit(1);
  }
}
