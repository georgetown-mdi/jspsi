import { UsageError } from "@psilink/core";

import { promptFreeText, writePromptLine } from "./util/cli";

/** How every refusal here tells the operator to supply the label. */
const IDENTITY_FLAG_HELP = '--identity "name, org, contact"';

/** Why an identity is never invented, stated once for both refusals. */
const PARTNER_READS_IT =
  "The identity is the name your partner reads in the agreed linkage terms";

/**
 * The placeholder `psilink init` writes into a fresh template when given no
 * `--identity`, and the one value no resolver here accepts. It sits beside
 * the resolvers rather than the template writer, so the written and refused
 * values share one definition.
 *
 * It must be non-empty for the template to parse -- the linkage-terms schema
 * gives identity a one-character minimum -- so no other check catches it;
 * only this exact string distinguishes it from a name the operator chose.
 */
export const PLACEHOLDER_IDENTITY = "REPLACE_WITH_YOUR_IDENTITY";

/**
 * Whether a value is that placeholder standing where a name belongs.
 *
 * The comparison is whole-string against the trimmed value, so a label that
 * merely contains this text, or differs from it in case, is a name like any
 * other: only the string the template writes, alone on the field, is refused.
 */
function isPlaceholderIdentity(identity: string): boolean {
  return identity.trim() === PLACEHOLDER_IDENTITY;
}

/**
 * The refusal every `--identity` path raises when the flag holds the template
 * placeholder rather than a name.
 */
export const IDENTITY_STILL_PLACEHOLDER =
  `"${PLACEHOLDER_IDENTITY}" is the placeholder psilink init writes where a ` +
  "name belongs, so it is refused exactly as no identity at all. " +
  `Pass ${IDENTITY_FLAG_HELP} naming this party. ` +
  `${PARTNER_READS_IT}, the invitation, and the disclosure record.`;

/**
 * Why a label typed at one invocation cannot stand in for a configured one --
 * the clause every refusal that reads a label out of a configuration file ends
 * on. The file persists unchanged and supplies the terms of every run under the
 * partnership, so a label given for this one invocation would name the party
 * here and leave it named otherwise everywhere after.
 */
const FLAG_CANNOT_STAND_IN =
  `${IDENTITY_FLAG_HELP} cannot stand in, because the configuration persists ` +
  "unchanged and is what every exchange under this partnership sends.";

/**
 * The refusal a command raises when no identity was supplied for a run that
 * authors its own linkage terms.
 */
export const IDENTITY_REQUIRED =
  `no identity for this party: pass ${IDENTITY_FLAG_HELP}. ` +
  `${PARTNER_READS_IT}, the invitation, and the disclosure record.`;

/**
 * The refusal {@link resolveInvitationIdentity} raises, naming the
 * configuration file expected to hold the label.
 *
 * The path composes RAW: `sanitizeErrorForDisplay` escapes the whole
 * rendered chain once at the CLI's display boundary, so escaping here too
 * would double-escape it. See CONTRIBUTING.md, Operator-facing escaping.
 */
export function configuredIdentityRequired(configPath: string): string {
  return (
    `no identity for this party: ${configPath} has no ` +
    `linkage_terms.identity, and it is the source of this invitation's terms. ` +
    `${PARTNER_READS_IT}, so set it there -- ${FLAG_CANNOT_STAND_IN}`
  );
}

/**
 * The refusal {@link resolveKeptConfigurationIdentity} raises, naming the
 * configuration this acceptance keeps as the file that was expected to hold
 * the label.
 *
 * The path composes RAW, for the reason and with the single escape
 * {@link configuredIdentityRequired} documents.
 */
export function keptConfigurationIdentityRequired(configPath: string): string {
  return (
    `no identity for this party: ${configPath} has no ` +
    "linkage_terms.identity, and this acceptance keeps that configuration " +
    `rather than writing one. ${PARTNER_READS_IT}, so set it there -- ` +
    FLAG_CANNOT_STAND_IN
  );
}

/**
 * The refusal both configured-label resolvers raise when the configuration
 * still holds the template placeholder, naming the field to edit and the
 * file it sits in. One wording serves both, since neither command can
 * replace the label from the command line.
 *
 * The path composes RAW, for the reason and with the single escape
 * {@link configuredIdentityRequired} documents.
 */
export function configuredIdentityStillPlaceholder(configPath: string): string {
  return (
    `linkage_terms.identity in ${configPath} is still ` +
    `"${PLACEHOLDER_IDENTITY}", the placeholder psilink init writes where a ` +
    "name belongs, so it is refused exactly as an absent one. " +
    `${PARTNER_READS_IT}, so replace it there with this party's name, ` +
    `organization, and contact -- ${FLAG_CANNOT_STAND_IN}`
  );
}

/**
 * This party's identity label for a command that authors its own linkage
 * terms: the `--identity` value, trimmed, and nothing else.
 *
 * There is no fallback: a run with no flag, or a blank value (e.g. an unset
 * `$ORG` in `--identity "$ORG"`), stops rather than defaulting to system
 * state such as the account psilink runs as, because the partner reads this
 * label as the operator's own chosen name.
 *
 * {@link PLACEHOLDER_IDENTITY} is refused alongside blank: the schema
 * accepts it as a label, but sending it would name this party with the
 * words asking for a name.
 */
export function resolveIdentity(identity: string | undefined): string {
  const chosen = identity?.trim() ?? "";
  if (chosen.length === 0) throw new UsageError(IDENTITY_REQUIRED);
  if (isPlaceholderIdentity(chosen))
    throw new UsageError(IDENTITY_STILL_PLACEHOLDER);
  return chosen;
}

/**
 * This party's identity label for a run that may go unnamed: the
 * `--identity` value, trimmed, or `undefined` where the flag names nothing.
 *
 * A blank value (e.g. an unset `$ORG` in `--identity "$ORG"`) is absence,
 * not a label -- the terms simply hold no identity.
 * {@link PLACEHOLDER_IDENTITY} is refused rather than treated as absence:
 * unlike blank, it is a value the operator typed believing it named them,
 * so silently dropping it would unname a run behind their back.
 */
export function optionalIdentity(
  identity: string | undefined,
): string | undefined {
  const chosen = identity?.trim() ?? "";
  if (chosen.length === 0) return undefined;
  if (isPlaceholderIdentity(chosen))
    throw new UsageError(IDENTITY_STILL_PLACEHOLDER);
  return chosen;
}

/**
 * The line shown above either identity question, stating what the label is for.
 * It is the sentence both refusals above end on, so the operator who is asked
 * and the operator who is refused read the same account of it.
 */
export const IDENTITY_PROMPT_PREAMBLE = `${PARTNER_READS_IT}, the invitation, and the disclosure record.`;

/**
 * The question `psilink init` asks. It states what a blank answer does, because
 * blank is not a refusal here: the template is a scaffold to hand-edit, so an
 * operator who has not settled the wording yet gets {@link PLACEHOLDER_IDENTITY}
 * to replace, exactly as a run with no terminal to ask at does.
 */
export const INIT_IDENTITY_QUESTION =
  "Identity for this party (name, organization, contact), or blank to fill in " +
  "by hand later:";

/**
 * The question `psilink accept` asks. It has no blank-answer note because
 * blank is absence and an acceptance will not proceed unnamed
 * ({@link IDENTITY_REQUIRED}): it authors a durable partnership the partner
 * reads a name off.
 */
export const ACCEPT_IDENTITY_QUESTION =
  "Identity for this party (name, organization, contact):";

/**
 * Ask for this party's identity at the terminal and return the raw answer.
 *
 * Both lines go to the prompt stream rather than through a logger, so the
 * question and the reason for it are on the terminal whatever `--log-level` and
 * `--log-file` are set to -- the routing the consent surface already takes
 * wherever a prompt follows it. Whether asking is possible at all is the
 * caller's to decide; this only asks.
 */
export function askIdentityAtPrompt(question: string): Promise<string> {
  writePromptLine(IDENTITY_PROMPT_PREAMBLE);
  return promptFreeText(question);
}

/**
 * This party's label from `--identity`, or from a question at the terminal
 * when the flag held none: the trimmed value, or `undefined` where neither
 * source named this party.
 *
 * Both sources take {@link optionalIdentity}'s treatment -- blank read as
 * absence, {@link PLACEHOLDER_IDENTITY} refused -- so an operator cannot
 * reach a laxer path by typing at the prompt instead of passing the flag.
 *
 * `ask` is the caller's whole interactivity decision: `undefined` means no
 * prompt runs and the flag's answer stands alone. The flag is read first
 * either way, so supplying it is what skips the question.
 */
export async function identityFromFlagOrPrompt(
  identity: string | undefined,
  ask: (() => Promise<string>) | undefined,
): Promise<string | undefined> {
  const supplied = optionalIdentity(identity);
  if (supplied !== undefined || ask === undefined) return supplied;
  return optionalIdentity(await ask());
}

/**
 * This party's identity label for an invitation minted from a saved
 * configuration: the `linkage_terms.identity` that configuration holds.
 *
 * Inviting authors a durable partnership, so it will not proceed unnamed,
 * and `--identity` is not an alternative: the configuration persists and
 * supplies every later run's terms. Whitespace-only and
 * {@link PLACEHOLDER_IDENTITY} are refused for the same reason blank and
 * the placeholder are refused elsewhere in this module.
 *
 * The value comes back VERBATIM: a certificate authorizes an exact
 * identity string, and every later `psilink exchange` reads the
 * configuration's own bytes, so a trimmed copy would name the partnership
 * differently in the invitation than in the runs under it.
 */
export function resolveInvitationIdentity(
  configuredIdentity: string | undefined,
  configPath: string,
): string {
  return resolveConfiguredIdentity(
    configuredIdentity,
    configPath,
    configuredIdentityRequired,
  );
}

/**
 * This party's identity label for an acceptance that keeps the
 * configuration already at the path: that file's own
 * `linkage_terms.identity`.
 *
 * Such an acceptance writes no configuration, so the label has to be the
 * kept file's own: under `signing.mode: certificate` the agreed terms'
 * label is what a receipt is verified against, so a run under any other
 * label would name this party one way for the acceptance and another for
 * the partnership it belongs to. `--identity` is not an alternative, for
 * the same reason it is not one when inviting from a configuration.
 *
 * Blank and {@link PLACEHOLDER_IDENTITY} are refused, and the value comes
 * back VERBATIM, exactly as {@link resolveInvitationIdentity} treats them
 * and for the reasons recorded there.
 */
export function resolveKeptConfigurationIdentity(
  configuredIdentity: string | undefined,
  configPath: string,
): string {
  return resolveConfiguredIdentity(
    configuredIdentity,
    configPath,
    keptConfigurationIdentityRequired,
  );
}

/**
 * The body both configured-label resolvers share. `required` is the whole
 * difference between them: why THIS command reads the label out of a file rather
 * than off the command line, which is what its refusal has to say.
 */
function resolveConfiguredIdentity(
  configuredIdentity: string | undefined,
  configPath: string,
  required: (configPath: string) => string,
): string {
  if (configuredIdentity === undefined || configuredIdentity.trim() === "")
    throw new UsageError(required(configPath));
  if (isPlaceholderIdentity(configuredIdentity))
    throw new UsageError(configuredIdentityStillPlaceholder(configPath));
  return configuredIdentity;
}
